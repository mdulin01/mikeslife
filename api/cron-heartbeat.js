// Vercel Cron: the watchdog. Once a day it checks that the pipeline actually ran —
// Google sync, the three context syncs, and today's brief — and pushes ONE alert if
// anything is stale (>26h, or the brief didn't run today). This is the missing
// observability: a silent failure (dead push token, expired Google auth, a sync
// erroring) now pings Mike instead of going unnoticed for weeks.
// Idempotent per Eastern day. env: CRON_SECRET, FIREBASE_SERVICE_ACCOUNT.

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';
import { inQuietHours } from './_prefs.js';

const OWNER_UID = process.env.OWNER_UID || 'F8QJ8dCk0CV5yX7yHu7AHPd6QS32';
const STALE_H = Number(process.env.HEARTBEAT_STALE_HOURS || 26);
const easternYMD = (dt = new Date()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(dt);

export default async function handler(req, res) {
  if (process.env.CRON_SECRET && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    if (!process.env.FIREBASE_SERVICE_ACCOUNT) return res.status(503).json({ error: 'not-configured' });
    if (!getApps().length) initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
    const ref = getFirestore().doc(`lifeos/${OWNER_UID}`);
    const d = (await ref.get()).data() || {};
    const today = easternYMD();
    const now = Date.now();

    const ageH = (iso) => (iso ? (now - new Date(iso).getTime()) / 3600000 : Infinity);
    const checks = [
      ['Google (calendar+email)', ageH(d.googleSyncedAt)],
      ['Fitness context', ageH(d.fitnessUpdatedAt)],
      ['Finance context', ageH(d.financeUpdatedAt)],
      ['Health context', ageH(d.healthUpdatedAt)],
    ];
    const stale = checks.filter(([, h]) => h > STALE_H).map(([name, h]) => `${name}: ${h === Infinity ? 'never' : Math.round(h) + 'h ago'}`);
    const briefStale = (d.todayBrief && d.todayBrief.date) !== today;
    if (briefStale) stale.unshift("Morning brief didn't run today");

    if (!stale.length) return res.status(200).json({ ok: true, healthy: true });

    // One heartbeat alert per Eastern day — don't nag.
    const already = (d.alerts || []).some((a) => a.type === 'heartbeat' && easternYMD(new Date(a.at)) === today);
    if (already) return res.status(200).json({ ok: true, stale, skipped: 'already alerted today' });

    const at = new Date().toISOString();
    const text = '⚠️ Pipeline check found stale data:\n- ' + stale.join('\n- ') + '\n\nLikely causes: expired Google auth (visit /api/google-auth), a cron error, or a dead push token.';
    const alertId = 'a' + Date.now();
    await ref.set({
      alerts: [{ id: alertId, type: 'heartbeat', title: '⚠️ Sync health check', text, at, feedback: null }, ...(d.alerts || [])].slice(0, 120),
    }, { merge: true });

    let pushed = 0;
    const tokens = inQuietHours(d.settings) ? [] : [d.fcmToken || (d.fcmTokens || []).slice(-1)[0]].filter(Boolean);
    const link = `https://mikeslife.app/?source=push&alert=${alertId}`;
    for (const token of tokens) {
      try {
        await getMessaging().send({
          token,
          notification: { title: '⚠️ Mike\'s Life — a sync is stale', body: stale[0] },
          data: { url: link },
          webpush: { notification: { icon: 'https://mikeslife.app/icon-192.png' }, fcmOptions: { link } },
        });
        pushed++;
      } catch (e) { console.error('push failed:', e.message); }
    }
    return res.status(200).json({ ok: true, stale, pushed });
  } catch (e) {
    console.error('cron-heartbeat error', e);
    return res.status(500).json({ error: e.message || 'error' });
  }
}
