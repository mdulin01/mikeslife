// Vercel Cron: curate a short finance summary from mikes-money and write it to
// lifeos/{uid}.financeContext. Cloud port of rupert/notify/sync-finance-context.mjs.
//
// Reads:  mikes-money (Firebase project mikesmoney-91595) via FIREBASE_SA_MONEY
// Writes: mikeslife   (mikeslife-963c6) via FIREBASE_SERVICE_ACCOUNT (default app)
// Required env: CRON_SECRET, FIREBASE_SERVICE_ACCOUNT, FIREBASE_SA_MONEY
import { initializeApp, cert, getApps, getApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const OWNER_UID = process.env.OWNER_UID || 'F8QJ8dCk0CV5yX7yHu7AHPd6QS32';
const money = (n) => (typeof n === 'number' ? '$' + Math.round(n).toLocaleString() : 'n/a');
const pctv = (n) => (typeof n === 'number' ? Math.round(n * 100) + '%' : 'n/a');

export default async function handler(req, res) {
  if (process.env.CRON_SECRET && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    if (!process.env.FIREBASE_SERVICE_ACCOUNT) return res.status(503).json({ error: 'no FIREBASE_SERVICE_ACCOUNT' });
    if (!process.env.FIREBASE_SA_MONEY) return res.status(503).json({ error: 'no FIREBASE_SA_MONEY (add the mikes-money reader admin key to mikeslife Vercel env)' });

    if (!getApps().some((a) => a.name === '[DEFAULT]')) initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
    let moneyApp; try { moneyApp = getApp('money'); } catch { moneyApp = initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SA_MONEY)) }, 'money'); }
    const moneyDb = getFirestore(moneyApp);
    const lifeDb = getFirestore();

    const snaps = await moneyDb.collection('dashboardSnapshots').get();
    if (snaps.empty) return res.status(200).json({ ok: false, error: 'no dashboardSnapshots' });
    const latest = snaps.docs.sort((a, b) => b.id.localeCompare(a.id))[0].data();

    const lines = [];
    if (latest.netWorth != null) lines.push(`Net worth: ${money(latest.netWorth)}`);
    if (latest.investmentsTotal != null) lines.push(`Investable: ${money(latest.investmentsTotal)}`);
    if (latest.avgMonthlySpend != null) lines.push(`Normal monthly burn: ${money(latest.avgMonthlySpend)} (excl. taxes)`);
    if (latest.cashRunwayMonths != null) lines.push(`Cash runway: ${Number(latest.cashRunwayMonths).toFixed(1)} months`);
    if (latest.savingsRate != null) lines.push(`Savings rate (mo): ${pctv(latest.savingsRate)}`);
    if (latest.retirementSuccess != null) lines.push(`Retirement success: ${pctv(latest.retirementSuccess)}`);
    const topInsight = Array.isArray(latest.insights) ? latest.insights.find((i) => i.severity === 'warn') : null;
    if (topInsight) lines.push(`Top flag: ${topInsight.title}`);

    const financeContext = lines.join('\n') || 'No finance snapshot available.';
    await lifeDb.doc(`lifeos/${OWNER_UID}`).set({ financeContext, financeUpdatedAt: new Date().toISOString() }, { merge: true });
    return res.status(200).json({ ok: true, lines: lines.length });
  } catch (e) {
    console.error('cron-finance-context', e);
    return res.status(500).json({ error: e.message });
  }
}
