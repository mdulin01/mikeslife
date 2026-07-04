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
import { dataPush } from './_push.js';

const OWNER_UID = process.env.OWNER_UID || 'F8QJ8dCk0CV5yX7yHu7AHPd6QS32';
const THRESHOLD = Number(process.env.LARGE_TXN_THRESHOLD || 500);
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

    // ── GMA monthly accrual (1st of month ET): 1.5% of outstanding balance + $75 ──
    // Writes the fee entry into mikes-money's Business ledger (business.gma.entries)
    // and drops a finance alert. Idempotent: one fee entry per month.
    let gmaAccrued = null;
    try {
      const today = easternYMD();
      if (today.slice(8) === '01') {
        const finRef = moneyDb.doc('finances/user-money-data');
        const fin = (await finRef.get()).data() || {};
        const biz = fin.business || {};
        const entries = (biz.gma && biz.gma.entries) || [];
        const bal = Math.round(entries.reduce((s, e) => s + (e.type === 'payment' ? -e.amount : e.amount), 0) * 100) / 100;
        const month = today.slice(0, 7);
        const already = entries.some((e) => e.type === 'fee' && (e.date || '').startsWith(month));
        if (bal > 0 && !already) {
          const fee = Math.round(bal * 1.5) / 100 + 75; // cents-precise 1.5% + $75 (matches invoice schedule)
          const entry = { id: 'gma-accrual-' + month, date: today, type: 'fee', amount: fee, note: 'Auto late fee: 1.5% of $' + bal.toLocaleString('en-US', { minimumFractionDigits: 2 }) + ' + $75' };
          await finRef.set({ business: { ...biz, gma: { entries: [...entries, entry] } } }, { merge: true });
          gmaAccrued = { fee, balance: Math.round((bal + fee) * 100) / 100 };
          const lifeRef = lifeDb.doc('lifeos/' + OWNER_UID);
          const d0 = (await lifeRef.get()).data() || {};
          await lifeRef.set({ alerts: [
            { id: 'a' + Date.now(), type: 'finance', title: '💰 GMA late fee accrued', text: '+$' + fee.toFixed(2) + ' late fee added — balance now $' + gmaAccrued.balance.toLocaleString('en-US', { minimumFractionDigits: 2 }) + '. Send the updated invoice from the Business tab.', at: new Date().toISOString(), feedback: null, appUrl: 'https://www.mikesmoney.app/business' },
            ...(d0.alerts || []),
          ].slice(0, 120) }, { merge: true });
        }
      }
    } catch (e) { console.error('gma accrual failed:', e.message); }

    const ref = lifeDb.doc(`lifeos/${OWNER_UID}`);
    const d = (await ref.get()).data() || {};
    if (d.alertPrefs && d.alertPrefs.finance === false) {
      return res.status(200).json({ ok: true, skipped: 'finance alerts muted', gmaAccrued });
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

    if (!lines.length) return res.status(200).json({ ok: true, skipped: 'nothing over threshold', gmaAccrued });

    const at = new Date().toISOString();
    const text = lines.join('\n') + `\n\nReview in mikes-money → Transactions (⚠ Large filter).`;
    await ref.set({
      financeSeen: [...seen].slice(-200),
      alerts: [
        { id: 'a' + Date.now(), type: 'finance', title: `💰 Money watch — ${lines.length} item${lines.length > 1 ? 's' : ''}`, text, at, feedback: null, appUrl: MONEY_APP },
        ...(d.alerts || []),
      ].slice(0, 120),
    }, { merge: true });

    const tokens = [d.fcmToken || (d.fcmTokens || []).slice(-1)[0]].filter(Boolean);
    let pushed = 0;
    for (const token of tokens) {
      try {
        await getMessaging().send(dataPush(token, '💰 Money watch', lines[0].slice(0, 180), MONEY_APP));
        pushed++;
      } catch (e) { console.error('push failed:', e.message); }
    }
    return res.status(200).json({ ok: true, items: lines.length, pushed, gmaAccrued });
  } catch (e) {
    console.error('cron-finance error', e);
    return res.status(500).json({ error: e.message || 'error' });
  }
}
