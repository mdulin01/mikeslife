// Instant "Liam finished the rental updates" push to Mike.
// Called by rainbow-rentals right after Liam taps "Done & send" (which writes
// rainbow-rentals rentalData/liamWeekly). We read that doc as the source of truth
// (so this can't be spammed to push arbitrary messages), confirm it's THIS ISO week
// and not already delivered, then push Mike via his real mikeslife FCM tokens and
// flip mikeNotified=true (which also stops the daily cron-rentals-nudge backstop).
// env: FIREBASE_SERVICE_ACCOUNT (mikeslife — Mike's tokens), FIREBASE_SA_RAINBOW (rainbow liamWeekly)
import { initializeApp, cert, getApps, getApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';
import { dataPush } from './_push.js';

const OWNER_UID = process.env.OWNER_UID || 'F8QJ8dCk0CV5yX7yHu7AHPd6QS32';
const LINK = 'https://rainbowrentals.app/?source=push';

function isoWeekId(d = new Date()) {
  const dt = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (dt.getUTCDay() + 6) % 7; dt.setUTCDate(dt.getUTCDate() - dayNum + 3);
  const firstThu = new Date(Date.UTC(dt.getUTCFullYear(), 0, 4));
  const weekNo = 1 + Math.round(((dt - firstThu) / 86400000 - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
  return `${dt.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

export default async function handler(req, res) {
  // CORS so the rainbow-rentals PWA can call it from the browser.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try {
    if (!process.env.FIREBASE_SERVICE_ACCOUNT) return res.status(503).json({ error: 'no FIREBASE_SERVICE_ACCOUNT' });
    if (!process.env.FIREBASE_SA_RAINBOW) return res.status(503).json({ error: 'no FIREBASE_SA_RAINBOW' });
    if (!getApps().length) initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
    let rApp; try { rApp = getApp('rainbow'); } catch { rApp = initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SA_RAINBOW)) }, 'rainbow'); }
    const mlDb = getFirestore();
    const rDb = getFirestore(rApp);

    const ref = rDb.doc('rentalData/liamWeekly');
    const weekly = (await ref.get()).data() || {};
    const thisWeek = isoWeekId(new Date());
    if (weekly.week !== thisWeek) return res.status(200).json({ ok: false, reason: 'no done-this-week record', thisWeek });
    if (weekly.mikeNotified === true) return res.status(200).json({ ok: true, alreadyNotified: true });

    const d = (await mlDb.doc(`lifeos/${OWNER_UID}`).get()).data() || {};
    const tokens = [...new Set([d.fcmToken, ...(d.fcmTokens || [])].filter(Boolean))];
    if (!tokens.length) return res.status(200).json({ ok: false, reason: 'no mikeslife tokens — enable notifications in mikeslife' });

    const c = weekly.counts || {};
    const body = `${c.rentsRecorded != null ? c.rentsRecorded + ' rents' : 'Rents'}${c.todosOpen ? `, ${c.todosOpen} to-dos` : ''} recorded — remember to pay Liam.`;
    let pushed = 0; const stale = [];
    for (const token of tokens) {
      try {
        await getMessaging().send(dataPush(token, '✅ Liam finished the rental updates', body, LINK));
        pushed++;
      } catch (e) {
        if (/registration-token-not-registered|invalid-argument|invalid-registration/.test(e.code || e.message || '')) stale.push(token);
      }
    }
    if (stale.length) {
      const keep = tokens.filter((t) => !stale.includes(t));
      await mlDb.doc(`lifeos/${OWNER_UID}`).set({ fcmTokens: keep, fcmToken: keep[keep.length - 1] || null }, { merge: true });
    }
    if (pushed > 0) await ref.set({ mikeNotified: true, mikeNotifiedAt: new Date().toISOString() }, { merge: true });
    return res.status(200).json({ ok: pushed > 0, pushed, tokens: tokens.length, pruned: stale.length });
  } catch (e) {
    console.error('liam-done', e);
    return res.status(500).json({ error: e.message });
  }
}
