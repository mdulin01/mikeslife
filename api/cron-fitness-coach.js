// Vercel Cron: Rupert as fitness COACH — Phase C of the mikesfitness training
// engine (Build 15). Reads the new fitnessSessions + fitnessPlans collections
// plus dailyMetrics recovery data, asks the model for a short daily coach note
// (and a week note on Mondays), and writes mikesfitness/coach in the fitness
// project. The app renders `note` on Home and `weekNote` on the Plan page.
// Distinct from cron-fitness-note.js, which writes the rupert/note banner.
// Runs 10:58 UTC daily — after the context syncs, before the 11:15 brief.
// env: CRON_SECRET, FIREBASE_SA_FITNESS, OPENAI_API_KEY (via _llm.js).

import { initializeApp, cert, getApps, getApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { llmChat, pickProvider } from './_llm.js';

function appFor(name, saJson) {
  if (!getApps().find((a) => a.name === name)) initializeApp({ credential: cert(JSON.parse(saJson)) }, name);
  return getFirestore(getApp(name));
}
const ymd = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const addDays = (dateStr, n) => { const d = new Date(dateStr + 'T12:00:00'); d.setDate(d.getDate() + n); return ymd(d); };
const median = (arr) => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

export default async function handler(req, res) {
  if (process.env.CRON_SECRET && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    if (!process.env.FIREBASE_SA_FITNESS) return res.status(200).json({ ok: true, skipped: 'FIREBASE_SA_FITNESS not set' });
    const db = appFor('fitness', process.env.FIREBASE_SA_FITNESS);

    const today = ymd(new Date());
    const force = 'force' in (req.query || {});
    const coachRef = db.doc('mikesfitness/coach');
    const existing = (await coachRef.get()).data() || {};
    if (!force && String(existing.updatedAt || '').slice(0, 10) === today) {
      return res.status(200).json({ ok: true, skipped: 'already wrote today' });
    }

    const dow = new Date(today + 'T12:00:00').getDay(); // 0 Sun..6 Sat
    const weekStart = addDays(today, -((dow + 6) % 7)); // Monday
    const isMonday = dow === 1;

    // ---- Sessions, last 14 days ----
    const since = addDays(today, -14);
    const sessSnap = await db.collection('fitnessSessions').where('date', '>=', since).get();
    const sessions = sessSnap.docs.map((d) => d.data()).sort((a, b) => (a.date < b.date ? 1 : -1));
    const sessLines = sessions.slice(0, 20).map((s) => {
      const bits = [s.date, s.type, s.title].filter(Boolean).join(' · ');
      const extra = [
        s.durationMin && `${s.durationMin}min`,
        s.distance && `${s.distance}${s.type === 'swim' ? 'm' : 'mi'}`,
        s.effort && `effort ${s.effort}/5`,
        s.prs?.length && `PRs: ${s.prs.map((p) => `${p.name} ${p.weight}x${p.reps}`).join(', ')}`,
        s.notes && `"${String(s.notes).slice(0, 80)}"`,
      ].filter(Boolean).join(', ');
      return `- ${bits}${extra ? ` (${extra})` : ''}`;
    });

    // ---- This week's plan ----
    const plan = (await db.doc(`fitnessPlans/${weekStart}`).get()).data();
    const planLines = (plan?.days || []).map((d) =>
      `- ${d.day} ${d.date}: ${d.title} [${d.status}]${d.date === today ? ' ← TODAY' : ''}`);
    const todayPlan = (plan?.days || []).find((d) => d.date === today);

    // ---- Recovery: dailyMetrics last 8 days + 30d baselines ----
    const dmSnap = await db.collection('dailyMetrics').where('date', '>=', addDays(today, -30)).get();
    const dm = {}; dmSnap.docs.forEach((d) => { dm[d.id] = d.data(); });
    const rhrBase = median(Object.values(dm).map((m) => m.vitals?.heartRateRest).filter(Boolean));
    const hrvBase = median(Object.values(dm).map((m) => m.vitals?.hrv).filter(Boolean));
    const recLines = [];
    for (let i = 0; i < 7; i++) {
      const date = addDays(today, -i);
      const m = dm[date]; if (!m) continue;
      recLines.push(`- ${date}: sleep ${m.sleep?.hoursTotal ?? '?'}h, RHR ${m.vitals?.heartRateRest ?? '?'}, HRV ${m.vitals?.hrv ? Math.round(m.vitals.hrv) : '?'}, steps ${m.activity?.steps ?? '?'}, exercise ${m.activity?.exerciseMinutes ?? 0}min`);
    }
    const latestWeight = Object.entries(dm).sort((a, b) => (a[0] < b[0] ? 1 : -1)).map(([, m]) => m.vitals?.weightLbs).find(Boolean);

    // ---- Ask the model ----
    const system = `You are Rupert, the personal fitness coach for Mike — a 59-year-old physician transforming his health now that he works only 2 days/week. His goals: strength for longevity (185 lb @ 20% body fat targets), triathlon endurance (Wrightsville Beach sprint tri 2026-09-27), VO2max, and durability/mobility. His program: 3 strength days (double progression 8-12 reps), zone-2 + VO2max interval days, a long fun day, daily mobility.
Write like a sharp, warm coach who knows the data: specific, encouraging, honest about lagging areas, never generic. No greetings, no sign-offs.`;
    const user = `Today is ${today} (${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dow]}).
Baselines (30d): resting HR ${rhrBase ?? '?'}, HRV ${hrvBase ? Math.round(hrvBase) : '?'}. Latest weight: ${latestWeight ? Math.round(latestWeight) : '?'} lb.

RECOVERY (last 7 days):
${recLines.join('\n') || '- no Apple Health data'}

THIS WEEK'S PLAN (Mon ${weekStart}):
${planLines.join('\n') || '- not seeded yet'}

RECENT SESSIONS (14 days):
${sessLines.join('\n') || '- none logged yet'}

Reply with STRICT JSON, no code fences:
{"note": "2-3 sentences for TODAY — react to last night's recovery + what's planned today (${todayPlan ? todayPlan.title : 'nothing planned'}), reference one concrete number from the data", ${isMonday ? '"weekNote": "2-3 sentences framing the week ahead — what to emphasize given last week\'s adherence and any PRs or misses",' : ''} "focus": "one short imperative phrase for today"}`;

    let note = null; let weekNote = existing.weekNote || null; let focus = null;
    try {
      const raw = await llmChat({ provider: pickProvider(null), system, messages: [{ role: 'user', content: user }], maxTokens: 500 });
      const j = JSON.parse(raw.replace(/^```(json)?|```$/g, '').trim());
      note = j.note || null;
      if (isMonday && j.weekNote) weekNote = j.weekNote;
      focus = j.focus || null;
    } catch (e) {
      // Deterministic fallback so the card never goes stale silently.
      const done = (plan?.days || []).filter((d) => d.status === 'done').length;
      note = todayPlan
        ? `${todayPlan.title} today. ${done} session${done === 1 ? '' : 's'} done this week — log it in Train and the plan progresses itself.`
        : 'No plan seeded for today yet — open the Train tab and this week will build itself.';
      focus = 'Show up, log it';
      console.error('coach LLM fallback:', e.message);
    }

    const doc = {
      note, weekNote, focus,
      updatedAt: new Date().toISOString(),
      weekStart,
      generatedBy: 'cron-fitness-coach',
    };
    await coachRef.set(doc, { merge: true });
    return res.status(200).json({ ok: true, today, isMonday, note, focus, weekNote: isMonday ? weekNote : '(kept)' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
