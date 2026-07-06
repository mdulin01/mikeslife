// Vercel Cron: curate a short fitness summary from mikesfitness and write it to
// lifeos/{uid}.fitnessContext so Rupert's brief/brain knows Mike's training without
// guessing. REWRITTEN 2026-07-06 for the Build-15 training engine: reads the NEW
// fitnessSessions + fitnessPlans collections and dailyMetrics (Apple Health).
// The old mikesfitness/mike-health arrays (exerciseLog/runEntries/vo2Entries)
// went stale after the 07-01 overhaul — Rupert was citing an April run and a
// VO2max of 38.6 while the app showed 46.4.
//
// Reads:  mikesfitness (Firebase project trip-planner-5cc84) via FIREBASE_SA_FITNESS
// Writes: mikeslife    (mikeslife-963c6) via FIREBASE_SERVICE_ACCOUNT (default app)
// Required env: CRON_SECRET, FIREBASE_SERVICE_ACCOUNT, FIREBASE_SA_FITNESS
import { initializeApp, cert, getApps, getApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const OWNER_UID = process.env.OWNER_UID || 'F8QJ8dCk0CV5yX7yHu7AHPd6QS32';
const ymd = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const addDays = (dateStr, n) => { const d = new Date(dateStr + 'T12:00:00'); d.setDate(d.getDate() + n); return ymd(d); };
// newest dailyMetrics value at a dotted path, e.g. 'fitness.vo2max'
const latest = (dm, path) => {
  for (const [date, m] of Object.entries(dm).sort((a, b) => (a[0] < b[0] ? 1 : -1))) {
    let v = m; for (const k of path.split('.')) v = v?.[k];
    if (typeof v === 'number') return { date, v };
  }
  return null;
};

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

    const today = ymd(new Date());
    const dow = new Date(today + 'T12:00:00').getDay(); // 0 Sun..6 Sat
    const weekStart = addDays(today, -((dow + 6) % 7)); // Monday
    const lines = [];

    // ---- Logged sessions (Build-15 engine), last 14 days ----
    const sessSnap = await fitDb.collection('fitnessSessions').where('date', '>=', addDays(today, -14)).get();
    const sessions = sessSnap.docs.map((d) => d.data()).sort((a, b) => (a.date < b.date ? 1 : -1));
    if (sessions.length) {
      lines.push('Recent sessions (14d): ' + sessions.slice(0, 8).map((s) => {
        const bits = [s.date, s.title || s.type].filter(Boolean).join(' ');
        const extra = [
          s.durationMin && `${s.durationMin}min`,
          s.distance && `${s.distance}${s.type === 'swim' ? 'm' : 'mi'}`,
        ].filter(Boolean).join(', ');
        return bits + (extra ? ` (${extra})` : '');
      }).join(' | '));
      const prs = sessions.flatMap((s) => (s.prs || []).map((p) => `${p.name} ${p.weight}x${p.reps} (${s.date})`));
      if (prs.length) lines.push('Recent PRs: ' + prs.slice(0, 5).join(', '));
    }

    // ---- This week's plan ----
    const plan = (await fitDb.doc(`fitnessPlans/${weekStart}`).get()).data();
    if (plan && Array.isArray(plan.days) && plan.days.length) {
      const t = plan.days.find((d) => d.date === today);
      if (t) lines.push(`Today's planned session: ${t.title || t.type} [${t.status || 'planned'}]`);
      const done = plan.days.filter((d) => d.status === 'done').length;
      lines.push(`Week plan (Mon ${weekStart}, ${done}/${plan.days.length} done): `
        + plan.days.map((d) => `${String(d.date || '').slice(5)} ${d.title || d.type}${d.status === 'done' ? ' ✓' : ''}`).join(', '));
    }

    // ---- Apple Health dailyMetrics: body + recovery + Watch-only workout days ----
    const dmSnap = await fitDb.collection('dailyMetrics').where('date', '>=', addDays(today, -30)).get();
    const dm = {}; dmSnap.docs.forEach((d) => { dm[d.id] = d.data(); });
    const vo2 = latest(dm, 'fitness.vo2max');
    if (vo2) lines.push(`Latest VO2max: ${vo2.v} (${vo2.date})`);
    const wt = latest(dm, 'vitals.weightLbs');
    if (wt) lines.push(`Latest weight: ${Math.round(wt.v * 10) / 10} lb (${wt.date})`);
    const rhr = latest(dm, 'vitals.heartRateRest');
    const hrv = latest(dm, 'vitals.hrv');
    if (rhr || hrv) lines.push(`Recovery: RHR ${rhr ? Math.round(rhr.v) : '?'}${hrv ? `, HRV ${Math.round(hrv.v)}` : ''} (${(rhr || hrv).date})`);
    const logged = new Set(sessions.map((s) => s.date));
    const watch = Object.entries(dm)
      .filter(([date, m]) => !logged.has(date) && (m.activity?.exerciseMinutes || 0) >= 20)
      .sort((a, b) => (a[0] < b[0] ? 1 : -1)).slice(0, 5)
      .map(([date, m]) => `${date} (${Math.round(m.activity.exerciseMinutes)}min${m.activity?.swimDistanceMeters > 0 ? ', swim' : ''})`);
    if (watch.length) lines.push('Watch-only workout days (not logged in app): ' + watch.join(', '));

    // ---- Legacy fallback: only if the new engine has nothing at all ----
    if (!sessions.length && !plan) {
      const h = (await fitDb.doc('mikesfitness/mike-health').get()).data() || {};
      const runs = (Array.isArray(h.runEntries) ? h.runEntries : []).slice(-3).map((r) => `${r.date || '?'} ${r.distance || r.miles || '?'}mi`);
      if (runs.length) lines.push('Recent runs (LEGACY log, may be stale): ' + runs.join(', '));
    }

    const fitnessContext = lines.join('\n') || 'No recent training data found.';
    await lifeDb.doc(`lifeos/${OWNER_UID}`).set({ fitnessContext, fitnessUpdatedAt: new Date().toISOString() }, { merge: true });
    return res.status(200).json({ ok: true, lines: lines.length, preview: lines.slice(0, 3) });
  } catch (e) {
    console.error('cron-fitness-context', e);
    return res.status(500).json({ error: e.message });
  }
}
