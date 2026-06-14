// Vercel Cron: bridge rainbow-rentals <-> mikesmoney. Daily.
//  B1 (income reconcile): aggregate mikesmoney 'rental' income by month (+ by property
//      where the deposit carries one) and write rentalData/incomeActuals into
//      rainbow-rentals so RentReconciliation can show recorded-vs-deposited.
//  B2 (expense match-and-enrich, NO duplicates): for each expense Liam logged in
//      rainbow-rentals, find the matching Citi-card transaction in mikesmoney by
//      amount+date and TAG it (propertyId/category/rental class + reason) — never
//      creates a second expense. Unmatched expenses are flagged 'pending'.
//  Reimbursements (BOA->Liam transfers) are already category 'transfer' via mikesmoney's
//  classifier, so they're excluded from spend — no double count.
// env: CRON_SECRET, FIREBASE_SA_RAINBOW, FIREBASE_SA_MONEY
import { initializeApp, cert, getApps, getApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const ET = 'America/New_York';
const ymd = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: ET, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

// mikesmoney property ids/nicknames (mirror of mikes-money/src/data/properties.js).
const MONEY_PROPS = [
  { id: 'north-elm', nick: 'n. elm', toks: ['elm', 'magnolia'] },
  { id: 'green-crest', nick: 'green crest', toks: ['green crest', 'greencrest'] },
  { id: 'prairie-trail', nick: '2 prairie trail', toks: ['prairie'] },
  { id: 'hillcrest', nick: 'hillcrest', toks: ['hillcrest'] },
  { id: 'n-church', nick: 'n. church', toks: ['church'] },
  { id: 'brookhurst', nick: 'brookhurst', toks: ['brookhurst'] },
];
const moneyPropIdFor = (name) => {
  const n = (name || '').toLowerCase();
  const hit = MONEY_PROPS.find((p) => p.toks.some((t) => n.includes(t)));
  return hit ? hit.id : null;
};
const firstArray = (obj) => { for (const v of Object.values(obj || {})) if (Array.isArray(v)) return v; return []; };

export default async function handler(req, res) {
  if (process.env.CRON_SECRET && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    if (!process.env.FIREBASE_SA_RAINBOW) return res.status(503).json({ error: 'no FIREBASE_SA_RAINBOW' });
    if (!process.env.FIREBASE_SA_MONEY) return res.status(503).json({ error: 'no FIREBASE_SA_MONEY' });
    let rApp; try { rApp = getApp('rainbow'); } catch { rApp = initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SA_RAINBOW)) }, 'rainbow'); }
    let mApp; try { mApp = getApp('money'); } catch { mApp = initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SA_MONEY)) }, 'money'); }
    const rDb = getFirestore(rApp); const mDb = getFirestore(mApp);

    const cutoff = ymd(new Date(Date.now() - 90 * 86400 * 1000));

    // ---- load mikesmoney accounts (find Citi) + recent transactions ----
    const acctSnap = await mDb.collection('accounts').get();
    const citiIds = new Set();
    acctSnap.forEach((d) => { const a = d.data(); const nm = `${a.name || ''} ${a.officialName || ''} ${a.institution || ''}`.toLowerCase(); if (/citi/.test(nm)) citiIds.add(d.id); });

    const txSnap = await mDb.collection('transactions').where('date', '>=', cutoff).get();
    const txns = txSnap.docs.map((d) => ({ _id: d.id, ...d.data() }));

    // ---- B1: income reconcile ----
    const months = {};
    for (const t of txns) {
      if (t.category === 'rental' && Number(t.amount) > 0) {
        const m = String(t.date || '').slice(0, 7); if (!m) continue;
        months[m] = months[m] || { total: 0, byProperty: {} };
        months[m].total += Number(t.amount);
        if (t.propertyId) months[m].byProperty[t.propertyId] = (months[m].byProperty[t.propertyId] || 0) + Number(t.amount);
      }
    }
    await rDb.doc('rentalData/incomeActuals').set({ months, updatedAt: new Date().toISOString(), note: 'Actual deposits from mikesmoney (category=rental). Per-property only where the deposit names a property.' }, { merge: true });

    // ---- B2: expense match-and-enrich ----
    const expDocRef = rDb.doc('rentalData/expenses');
    const expDoc = (await expDocRef.get()).data() || {};
    const expenses = Array.isArray(expDoc.expenses) ? expDoc.expenses : [];
    const usedTxn = new Set(txns.filter((t) => t.rrExpenseId).map((t) => t.rrExpenseId));
    let matched = 0, pending = 0, changed = false;

    for (const e of expenses) {
      if (e.moneyTxnId) continue;                       // already linked
      const amt = Math.abs(Number(e.amount) || 0);
      if (!amt) continue;
      const eDate = new Date((e.date || '') + 'T12:00:00').getTime();
      // candidate Citi outflows within $0.50 and +/-4 days, not already linked to another expense
      const cands = txns.filter((t) => citiIds.has(t.accountId) && Number(t.amount) < 0 && !t.rrExpenseId && !usedTxn.has(e.id)
        && Math.abs(Math.abs(Number(t.amount)) - amt) <= 0.5
        && Math.abs((new Date((t.date || '') + 'T12:00:00').getTime() - eDate) / 86400000) <= 4);
      cands.sort((a, b) => Math.abs(new Date(a.date) - eDate) - Math.abs(new Date(b.date) - eDate));
      const m = cands[0];
      if (m) {
        const propId = moneyPropIdFor(e.propertyName);
        await mDb.collection('transactions').doc(m._id).set({
          category: 'maintenance', txClass: 'rental', categorizedBy: 'liam', classBy: 'liam',
          ...(propId ? { propertyId: propId, propertyBy: 'liam' } : {}),
          rrExpenseId: e.id, memo: (e.description || e.category || 'rental expense') + (e.propertyName ? ` — ${e.propertyName}` : ''),
        }, { merge: true });
        e.moneyTxnId = m._id; e.moneyMatch = 'matched'; usedTxn.add(e.id); matched++; changed = true;
      } else if (e.moneyMatch !== 'pending') { e.moneyMatch = 'pending'; pending++; changed = true; }
    }
    if (changed) await expDocRef.set({ expenses, lastUpdated: new Date().toISOString(), updatedBy: 'rupert-bridge' }, { merge: true });

    return res.status(200).json({ ok: true, citiAccounts: citiIds.size, txnsScanned: txns.length, incomeMonths: Object.keys(months).length, expensesMatched: matched, expensesPending: pending });
  } catch (e) {
    console.error('cron-rentals-bridge', e);
    return res.status(500).json({ error: e.message });
  }
}
