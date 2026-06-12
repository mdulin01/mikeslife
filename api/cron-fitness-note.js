// Vercel Cron: the mikesfitness Rupert banner — CLOUD replacement for the mini's
// sync-fitness-note.mjs (which only counted the manual exerciseLog and told Mike
// "no workouts" while his Watch said otherwise). Counts manual log entries AND
// Apple Watch days (dailyMetrics.activity.exerciseMinutes ≥ 20) for the current
// Eastern week, then writes rupert/note in the fitness project.
// Runs nightly AFTER the mini's 6:10pm write so this one wins until the mini
// plist is unloaded. env: CRON_SECRET, FIREBASE_SA_FITNESS.

import { initializeApp, cert, getApps, getApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const WEEKLY_GOAL = Number(process.env.WEEKLY_GOAL || 3);

function appFor(name, saJson) {
  if (!getApps().find((a) => a.name === name)) initializeApp({ credential: cert(JSON.parse(saJson)) }, name);
  return getFirestore(getApp(name));
}
const ymd = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const obj = (x) => (x && typeof x === 'object' && !Array.isArray(x) ? x : {});

export default async function handler(req, res) {
  if (process.env.CRON_SECRET && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    if (!process.env.FIREBASE_SA_FITNESS) return res.status(200).json({ ok: true, skipped: 'FIREBASE_SA_FITNESS not set' });
    const db = appFor('fitness', process.env.FIREBASE_SA_FITNESS);

    // Monday of the current Eastern week.
    const now = new Date();
    const dow = new Date(ymd(now) + 'T12:00:00').getDay();
    const monday = new Date(now); monday.setDate(now.getDate() - ((dow + 6) % 7));
    const weekStart = ymd(monday);

    const h = (await db.doc('mikesfitness/mike-health').get()).data() || {};
    const dates = new Set();
    let lastType = '';
    for (const [date, items] of Object.entries(obj(h.exerciseLog))) {
      if (date >= weekStart) {
        dates.add(date);
        const wk = (Array.isArray(items) ? items : [])[0];
        if (wk) lastType = wk.exerciseName || wk.type || wk.name || lastType;
      }
    }
    // Apple Watch days — HAE-ingested dailyMetrics, ≥20 exercise minutes = a session.
    const dm = await db.collection('dailyMetrics').where('date', '>=', weekStart).get();
    let watchDays = 0;
    for (const d of dm.docs) {
      const m = d.data() || {};
      const mins = m.activity?.exerciseMinutes || 0;
      if (mins >= 20 && !dates.has(d.id)) {
        dates.add(d.id); watchDays++;
        lastType = (m.activity?.swimDistanceMeters > 0) ? 'a swim (Watch)' : `a Watch workout (${Math.round(mins)} min)`;
      }
    }
    const sessions = dates.size;

    const priorities = [];
    let text;
    if (sessions >= WEEKLY_GOAL) {
      text = `Nice — ${sessions} workout day${sessions > 1 ? 's' : ''} this week (incl. your Watch), goal met. 🎉${lastType ? ` Last was ${lastType}.` : ''}`;
      priorities.push('Protect one easy aerobic day');
    } else if (sessions > 0) {
      text = `${sessions} of ${WEEKLY_GOAL} workout days in — ${WEEKLY_GOAL - sessions} to go. Watch days count.`;
      priorities.push(`Get ${WEEKLY_GOAL - sessions} more session${WEEKLY_GOAL - sessions > 1 ? 's' : ''} in`);
    } else {
      text = 'No workouts logged or detected yet this week — an easy zone-2 session is a great restart.';
      priorities.push('Start the week with a zone-2 session');
    }
    const plan = (Array.isArray(h.trainingPlans) ? h.trainingPlans : []).find((p) => p.active) || (h.trainingPlans || [])[0];
    if (plan) priorities.push(`Plan: ${plan.name || plan.title || 'training'}`);

    const note = { text, signals: [], priorities: priorities.slice(0, 4), updatedAt: new Date().toISOString(), app: 'mikesfitness' };
    await db.doc('rupert/note').set(note, { merge: false });
    return res.status(200).json({ ok: true, sessions, watchDays, weekStart, text });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
