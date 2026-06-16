// Vercel Cron: curate a short fitness summary from mikesfitness and write it to
// lifeos/{uid}.fitnessContext so Rupert's brief/brain knows Mike's training without
// guessing. Cloud port of rupert/notify/sync-fitness-context.mjs so the brief no
// longer depends on the Mac mini being awake.
//
// Reads:  mikesfitness (Firebase project trip-planner-5cc84) via FIREBASE_SA_FITNESS
// Writes: mikeslife    (mikeslife-963c6) via FIREBASE_SERVICE_ACCOUNT (default app)
// Required env: CRON_SECRET, FIREBASE_SERVICE_ACCOUNT, FIREBASE_SA_FITNESS
import { initializeApp, cert, getApps, getApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const OWNER_UID = process.env.OWNER_UID || 'F8QJ8dCk0CV5yX7yHu7AHPd6QS32';
const arr = (x) => (Array.isArray(x) ? x : []);
const obj = (x) => (x && typeof x === 'object' && !Array.isArray(x) ? x : {});
const byDateDesc = (a, b) => String(b.date || b.createdAt || '').localeCompare(String(a.date || a.createdAt || ''));
const recent = (list, n = 6) => arr(list).slice().sort(byDateDesc).slice(0, n);

export default async function handler(req, res) {
  if (process.env.CRON_SECRET && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    if (!process.env.FIREBASE_SERVICE_ACCOUNT) return res.status(503).json({ error: 'no FIREBASE_SERVICE_ACCOUNT' });
    if (!process.env.FIREBASE_SA_FITNESS) return res.status(503).json({ error: 'no FIREBASE_SA_FITNESS (add the mikesfitness reader admin key to mikeslife Vercel env)' });

    if (!getApps().some((a) => a.name === '[DEFAULT]')) initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
    let fitApp; try { fitApp = getApp('fitness'); } catch { fitApp = initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SA_FITNESS)) }, 'fitness'); }
    const fitDb = getFirestore(fitApp);
    const lifeDb = getFirestore();

    const snap = await fitDb.doc('mikesfitness/mike-health').get();
    if (!snap.exists) return res.status(200).json({ ok: false, error: 'mikesfitness/mike-health not found' });
    const h = snap.data();
    const lines = [];

    // recent workouts — both sources are date-keyed OBJECTS, not arrays.
    const byDate = new Map();
    const addWorkout = (date, label) => {
      if (!date || !label) return;
      if (!byDate.has(date)) byDate.set(date, new Set());
      byDate.get(date).add(label);
    };
    for (const [date, items] of Object.entries(obj(h.exerciseLog))) {
      for (const wk of arr(items)) addWorkout(date, wk.exerciseName || wk.type || wk.name);
    }
    for (const days of Object.values(obj(h.workoutDetails))) {
      for (const items of Object.values(obj(days))) {
        for (const wk of arr(items)) {
          const date = wk.date || (wk.id ? new Date(wk.id).toISOString().slice(0, 10) : null);
          addWorkout(date, wk.type || wk.name);
        }
      }
    }
    // Apple Watch days from dailyMetrics (≥20 exercise min) — Mike often skips manual logging.
    try {
      const dmSnap = await fitDb.collection('dailyMetrics').orderBy('date', 'desc').limit(10).get();
      for (const dm of dmSnap.docs) {
        const m = dm.data() || {};
        const mins = m.activity?.exerciseMinutes || 0;
        if (mins >= 20) addWorkout(dm.id, m.activity?.swimDistanceMeters > 0 ? `swim (Watch, ${Math.round(mins)}m)` : `Watch workout (${Math.round(mins)}m)`);
      }
    } catch (e) { console.warn('dailyMetrics read failed:', e.message); }

    const workouts = [...byDate.entries()].sort((a, b) => b[0].localeCompare(a[0])).slice(0, 6)
      .map(([date, set]) => `${date}: ${[...set].join(', ')}`);
    if (workouts.length) lines.push('Recent workouts: ' + workouts.join(' | '));

    const runs = recent(h.runEntries, 3).map((r) => `${r.date || '?'} ${r.distance || r.miles || ''}${r.distance ? 'mi' : ''}`);
    if (runs.length) lines.push('Recent runs: ' + runs.join(', '));
    const w = recent(h.weightEntries, 1)[0];
    if (w) lines.push(`Latest weight: ${w.weight ?? w.value ?? '?'} (${w.date || '?'})`);
    const vo2 = recent(h.vo2Entries, 1)[0];
    if (vo2) lines.push(`Latest VO2max: ${vo2.vo2max ?? vo2.vo2 ?? vo2.value ?? '?'} (${vo2.date || '?'})`);
    const plan = arr(h.trainingPlans).find((p) => p.active) || arr(h.trainingPlans)[0];
    if (plan) lines.push(`Current plan: ${plan.name || plan.title || 'unnamed'}`);

    const fitnessContext = lines.join('\n') || 'No recent training data found.';
    await lifeDb.doc(`lifeos/${OWNER_UID}`).set({ fitnessContext, fitnessUpdatedAt: new Date().toISOString() }, { merge: true });
    return res.status(200).json({ ok: true, lines: lines.length });
  } catch (e) {
    console.error('cron-fitness-context', e);
    return res.status(500).json({ error: e.message });
  }
}
