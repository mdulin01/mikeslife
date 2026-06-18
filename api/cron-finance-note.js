// Vercel Cron: the mikes-money Rupert banner — CLOUD replacement for the mini's
// sync-finance-note.mjs. Reads the mikesmoney project (net worth / runway from the
// latest dashboardSnapshot + brokerage moves this week) and writes rupert/note,
// which the mikes-money app renders as the Rupert banner on every page.
// Runs nightly so it wins until the mini plist is unloaded.
// env: CRON_SECRET, FIREBASE_SA_MONEY.

import { initializeApp, cert, getApps, getApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

function appFor(name, saJson) {
  if (!getApps().find((a) => a.name === name)) initializeApp({ credential: cert(JSON.parse(saJson)) }, name);
  return getFirestore(getApp(name));
}
const num = (v) => (typeof v === 'number' ? v : parseFloat(v)) || 0;
const ymd = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const eastern = () => Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', hour12: false }).formatToParts(new Date()).map((p) => [p.type, p.value]));

export default async function handler(req, res) {
  if (process.env.CRON_SECRET && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    if (!process.env.FIREBASE_SA_MONEY) return res.status(200).json({ ok: true, skipped: 'FIREBASE_SA_MONEY not set' });
    const db = appFor('money', process.env.FIREBASE_SA_MONEY);

    const signals = [];
    const priorities = [];
    let text = '';

    // Latest dashboard snapshot → headline + runway-driven priority.
    try {
      const snaps = await db.collection('dashboardSnapshots').get();
      if (!snaps.empty) {
        const latest = snaps.docs.sort((a, b) => b.id.localeCompare(a.id))[0].data();
        const nw = latest.netWorth ?? latest.totalNetWorth;
        const runway = latest.cashRunwayMonths ?? latest.runwayMonths;
        if (nw != null) text = `Net worth ${'$' + Math.round(num(nw)).toLocaleString()}.`;
        if (runway != null) {
          const r = num(runway);
          text += ` Cash runway ~${r.toFixed(1)} months.`;
          if (r < 3) priorities.push('Rebuild cash buffer');
        }
      }
    } catch (e) { console.error('snapshot:', e.message); }

    // Brokerage moves in the last 7 days → "you made trades" signal.
    try {
      const since = ymd(new Date(Date.now() - 7 * 86400 * 1000));
      const tx = await db.collection('transactions').where('date', '>=', since).get().catch(() => null)
        || await db.collection('transactions').get();
      let trades = 0;
      tx.forEach((d) => {
        const t = d.data();
        const dt = (t.date || '').slice(0, 10);
        if (dt && dt < since) return;
        const blob = `${t.category || ''} ${t.name || ''} ${t.merchantName || ''} ${t.plaidCategory || ''} ${t.plaidDetail || ''}`.toLowerCase();
        if (/\b(invest|brokerage|vanguard|fidelity|schwab|tiaa|robinhood|etrade|merrill)\b/.test(blob)) trades += 1;
      });
      if (trades > 0) signals.push({ label: `You made ${trades} investment move${trades > 1 ? 's' : ''} this week`, href: '/allocation' });
    } catch (e) { console.error('trades:', e.message); }

    // Friday after work → log consulting time (invoicing now lives in mikes-money /business).
    const { weekday, hour } = eastern();
    if (weekday === 'Fri' && parseInt(hour, 10) >= 16) {
      signals.push({ label: 'It’s Friday — log this week’s consulting hours for invoicing', href: '/business' });
    }

    priorities.push('Stay ahead of estimated taxes');
    if (!text) text = 'Here’s where your money stands.';

    const note = { text, signals, priorities: priorities.slice(0, 4), updatedAt: new Date().toISOString(), app: 'mikes-money' };
    await db.doc('rupert/note').set(note, { merge: false });
    return res.status(200).json({ ok: true, text, signals: signals.length });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
