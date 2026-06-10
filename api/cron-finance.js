// Vercel Cron: the finance watch — Rupert's replacement for per-institution alerts.
//   1. Large transactions (≥ $500 by default) from mikes-money's Plaid data
//   2. Big day-over-day portfolio moves (from dashboardSnapshots)
// → 💰 finance alerts in mikeslife (push + history + deep link to mikesmoney).
//
// Needs env FIREBASE_SA_MONEY = a mikesmoney-91595 reader service-account JSON
// (same drill as FIREBASE_SA_FITNESS). Without it, the job no-ops politely.
// Dedupe: lifeos.financeSeen (capped list of alerted txn ids).
// Required env: CRON_SECRET, FIREBASE_SERVICE_ACCOUNT · optional FIREBASE_SA_MONEY, LARGE_TXN_THRESHOLD

import { initializeApp, cert, getApps, getApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';

const OWNER_UID = process.env.OWNER_UID || 'F8QJ8dCk0CV5yX7yHu7AHPd6QS32';
const THRESHOLD = Number(process.env.LARGE_TXN_THRESHOLD || 500);
const LINK = 'https://mikeslife.app/?source=push&focus=content';
const MONEY_APP = 'https://www.mikesmoney.app/transactions';

const easternYMD = (dt = new Date()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(dt);

function appFor(name, saJson) {
  if (!getApps().find((a) => a.name === name)) initializeApp({ credential: cert(JSON.parse(saJson)) }, name);
  return getFirestore(getApp(name));
}

const fmt = (n) => '$' + Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 0 });

export default async function handler(req, res) {
  if (process.env.CRON_SECRET && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    if (!process.env.FIREBASE_SERVICE_ACCOUNT) return res.status(503).json({ error: 'not-configured' });
    if (!process.env.FIREBASE_SA_MONEY) {
      return res.status(200).json({ ok: true, skipped: 'add FIREBASE_SA_MONEY (mikesmoney reader SA JSON) to enable the finance watch' });
    }
    const lifeDb = getFirestore(getApps().find((a) => a.name === '[DEFAULT]') ? getApp() : initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) }));
    const moneyDb = appFor('money', process.env.FIREBASE_SA_MONEY);

    const ref = lifeDb.doc(`lifeos/${OWNER_UID}`);
    const d = (await ref.get()).data() || {};
    if (d.alertPrefs && d.alertPrefs.finance === false) {
      return res.status(200).json({ ok: true, skipped: 'finance alerts muted' });
    }
    const seen = new Set(d.financeSeen || []);
    const lines = [];

    // ── 1. Large transactions from the last 3 days not yet alerted ──
    const cutoff = easternYMD(new Date(Date.now() - 3 * 86400 * 1000));
    try {
      const snap = await moneyDb.collection('transactions').where('date', '>=', cutoff).get();
      const txns = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }))
        .filter((t) => Math.abs(t.amount || 0) >= THRESHOLD && !seen.has(t.id) && !t.pending)
        .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))
        .slice(0, 8);
      for (const t of txns) {
        const dir = (t.amount || 0) > 0 ? 'out' : 'in';
        lines.push(`${dir === 'out' ? '🔻' : '🔺'} ${fmt(t.amount)} ${dir} — ${(t.merchantName || t.name || 'unknown').slice(0, 40)} (${t.date}${t.category ? ' · ' + t.category : ''})`);
        seen.add(t.id);
      }
    } catch (e) { console.error('txn read failed:', e.message); }

    // ── 2. Big day-over-day portfolio move (latest two snapshots) ──
    try {
      const snaps = await moneyDb.collection('dashboardSnapshots').orderBy('__name__', 'desc').limit(2).get();
      if (snaps.docs.length === 2) {
        const [cur, prev] = snaps.docs.map((doc) => doc.data());
        const a = Number(cur.netWorth ?? cur.totalNetWorth ?? cur.investments ?? NaN);
        const b = Number(prev.netWorth ?? prev.totalNetWorth ?? prev.investments ?? NaN);
        if (isFinite(a) && isFinite(b) && b !== 0) {
          const pct = ((a - b) / Math.abs(b)) * 100;
          if (Math.abs(pct) >= 2) lines.push(`${pct > 0 ? '📈' : '📉'} Portfolio moved ${pct.toFixed(1)}% day-over-day (${fmt(a - b)}).`);
        }
      }
    } catch (e) { console.error('snapshot read failed:', e.message); }

    if (!lines.length) return res.status(200).json({ ok: true, skipped: 'nothing over threshold' });

    const at = new Date().toISOString();
    const text = lines.join('\n') + `\n\nReview in mikes-money → Transactions (⚠ Large filter).`;
    await ref.set({
      financeSeen: [...seen].slice(-200),
      alerts: [
        { id: 'a' + Date.now(), type: 'finance', title: `💰 Money watch — ${lines.length} item${lines.length > 1 ? 's' : ''}`, text, at, feedback: null, appUrl: MONEY_APP },
        ...(d.alerts || []),
      ].slice(0, 120),
    }, { merge: true });

    const tokens = Array.from(new Set([...(d.fcmTokens || []), d.fcmToken].filter(Boolean)));
    let pushed = 0;
    for (const token of tokens) {
      try {
        await getMessaging().send({
          token,
          notification: { title: '💰 Money watch', body: lines[0].slice(0, 180) },
          data: { url: LINK },
          webpush: { notification: { icon: 'https://mikeslife.app/icon-192.png', badge: 'https://mikeslife.app/icon-192.png' }, fcmOptions: { link: LINK } },
        });
        pushed++;
      } catch (e) { console.error('push failed:', e.message); }
    }
    return res.status(200).json({ ok: true, items: lines.length, pushed });
  } catch (e) {
    console.error('cron-finance error', e);
    return res.status(500).json({ error: e.message || 'error' });
  }
}
