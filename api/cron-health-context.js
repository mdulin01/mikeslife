// Vercel Cron: curate a healthContext from mikeshealth (labs, problems, preventive
// care, biology snapshot) and write it to lifeos/{uid}.healthContext. Cloud port of
// rupert/notify/sync-health-context.mjs.
//
// Reads:  mikeshealth (Firebase project mikeshealth-ad213) via FIREBASE_SA_HEALTH
// Writes: mikeslife   (mikeslife-963c6) via FIREBASE_SERVICE_ACCOUNT (default app)
// Required env: CRON_SECRET, FIREBASE_SERVICE_ACCOUNT, FIREBASE_SA_HEALTH
//   ⚠ FIREBASE_SA_HEALTH must be added to mikeslife Vercel env (admin SA JSON for
//   mikeshealth-ad213); until then this returns 503 and the mini script remains the source.
import { initializeApp, cert, getApps, getApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const OWNER_UID = process.env.OWNER_UID || 'F8QJ8dCk0CV5yX7yHu7AHPd6QS32';

export default async function handler(req, res) {
  if (process.env.CRON_SECRET && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    if (!process.env.FIREBASE_SERVICE_ACCOUNT) return res.status(503).json({ error: 'no FIREBASE_SERVICE_ACCOUNT' });
    if (!process.env.FIREBASE_SA_HEALTH) return res.status(503).json({ error: 'no FIREBASE_SA_HEALTH (add the mikeshealth reader admin key to mikeslife Vercel env)' });

    if (!getApps().some((a) => a.name === '[DEFAULT]')) initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
    let healthApp; try { healthApp = getApp('health'); } catch { healthApp = initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SA_HEALTH)) }, 'health'); }
    const healthDb = getFirestore(healthApp);
    const lifeDb = getFirestore();

    const lines = [];

    try {
      const bio = (await healthDb.doc('biology/bio').get()).data();
      if (bio) {
        const m = bio.metrics || {};
        lines.push(`Biology snapshot (${bio.date || '?'}): score ${bio.score ?? '?'}/100.`
          + (m.weightLb ? ` Weight ${m.weightLb} lb (goal 185).` : '')
          + (m.bfPct ? ` Body fat ${m.bfPct}% (goal 18-20%).` : ''));
      }
    } catch (e) { console.error('biology read failed:', e.message); }

    try {
      const KEY = ['eGFR', 'eGFR (Cystatin C)', 'Creatinine', 'ApoB', 'LDL-C', 'Lp(a)', 'Homocysteine', 'HbA1c', 'PSA', 'hs-CRP'];
      const labs = (await healthDb.collection('labs').get()).docs.map((d) => d.data());
      const picked = KEY.map((k) => labs.find((l) => l.name === k)).filter(Boolean);
      if (picked.length) {
        lines.push('Key labs: ' + picked.map((l) =>
          `${l.name} ${l.value}${l.unit ? ' ' + l.unit : ''}${l.flag && l.flag !== 'ok' ? ' ⚠' + l.flag : ''} (${l.date || '?'})`).join(' · '));
      }
    } catch (e) { console.error('labs read failed:', e.message); }

    try {
      const probs = (await healthDb.collection('problems').get()).docs.map((d) => d.data())
        .filter((p) => p.status && !/resolved/i.test(p.status));
      if (probs.length) lines.push('Active problems: ' + probs.map((p) => `${p.name} [${p.status}]${p.metrics ? ' — ' + p.metrics : ''}`).join(' | '));
    } catch (e) { console.error('problems read failed:', e.message); }

    try {
      const soon = new Date(Date.now() + 60 * 86400 * 1000).toISOString().slice(0, 10);
      const prev = (await healthDb.collection('preventive').get()).docs.map((d) => d.data())
        .filter((p) => p.dueDate && p.dueDate <= soon)
        .sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)));
      if (prev.length) lines.push('Preventive care due soon: ' + prev.map((p) => `${p.name} (due ${p.dueDate})`).join(' · '));
    } catch (e) { console.error('preventive read failed:', e.message); }

    const healthContext = lines.join('\n') || 'No health data found.';
    await lifeDb.doc(`lifeos/${OWNER_UID}`).set({ healthContext, healthUpdatedAt: new Date().toISOString() }, { merge: true });
    return res.status(200).json({ ok: true, lines: lines.length });
  } catch (e) {
    console.error('cron-health-context', e);
    return res.status(500).json({ error: e.message });
  }
}
