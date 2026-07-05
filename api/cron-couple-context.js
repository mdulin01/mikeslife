// Vercel Cron: curate a "joint life" summary from mikeandadam (shared hub tasks,
// GSO Half training adherence, upcoming events/trips, memory recency) and
//   1) write it to lifeos/{uid}.coupleContext so the morning brief + Rupert chat
//      cover Mike & Adam's shared world, and
//   2) write a deterministic banner into trip-planner-5cc84 rupert/coupleNote,
//      which the RupertBanner in mikeandadam renders for BOTH Mike and Adam.
//      (coupleNote, not note — mikesfitness shares this Firebase project and
//      owns rupert/note.)
//
// Reads:  mikeandadam (Firebase project trip-planner-5cc84) via FIREBASE_SA_FITNESS
// Writes: lifeos (mikeslife-963c6) via FIREBASE_SERVICE_ACCOUNT + rupert/coupleNote back into trip-planner-5cc84
// Required env: CRON_SECRET, FIREBASE_SERVICE_ACCOUNT, FIREBASE_SA_FITNESS
import { initializeApp, cert, getApps, getApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const OWNER_UID = process.env.OWNER_UID || 'F8QJ8dCk0CV5yX7yHu7AHPd6QS32';
const APP_URL = 'https://mikeandadam.app';
const arr = (x) => (Array.isArray(x) ? x : []);

const ET = 'America/New_York';
const etNow = () => new Date(new Date().toLocaleString('en-US', { timeZone: ET }));
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (s, n) => { const d = new Date(s + 'T12:00:00'); d.setDate(d.getDate() + n); return ymd(d); };
const tripStart = (t) => t?.dates?.start || t?.start;

export default async function handler(req, res) {
  if (process.env.CRON_SECRET && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    if (!process.env.FIREBASE_SERVICE_ACCOUNT) return res.status(503).json({ error: 'no FIREBASE_SERVICE_ACCOUNT' });
    if (!process.env.FIREBASE_SA_FITNESS) return res.status(503).json({ error: 'no FIREBASE_SA_FITNESS' });

    if (!getApps().some((a) => a.name === '[DEFAULT]')) initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
    let maApp; try { maApp = getApp('fitness'); } catch { maApp = initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SA_FITNESS)) }, 'fitness'); }
    const maDb = getFirestore(maApp);
    const lifeDb = getFirestore();

    const today = ymd(etNow());
    const lines = [];
    const bannerBits = [];

    // ── Tasks (subcollection first, legacy array fallback) ──
    let tasks = [];
    const taskCol = await maDb.collection('tripData/sharedHub/tasks').get().catch(() => null);
    if (taskCol && !taskCol.empty) tasks = taskCol.docs.map((d) => d.data());
    else {
      const hub = await maDb.doc('tripData/sharedHub').get();
      tasks = hub.exists ? arr(hub.data().tasks) : [];
    }
    const open = tasks.filter((t) => t.status !== 'done');
    const overdue = open.filter((t) => t.dueDate && t.dueDate < today);
    const dueSoon = open.filter((t) => t.dueDate && t.dueDate >= today && t.dueDate <= addDays(today, 7));
    if (open.length) {
      const top = [...overdue, ...dueSoon].slice(0, 5)
        .map((t) => `${t.title}${t.dueDate ? ` (${t.dueDate})` : ''}${t.assignedTo ? ` [${t.assignedTo}]` : ''}`);
      lines.push(`Open joint tasks: ${open.length} (${overdue.length} overdue). Soonest: ${top.join('; ') || '—'}`);
      bannerBits.push(`${open.length} open task${open.length === 1 ? '' : 's'}${overdue.length ? ` (${overdue.length} overdue)` : ''}`);
    }

    // ── Training (GSO Half plan adherence, current week) ──
    const fit = await maDb.doc('tripData/fitness').get();
    if (fit.exists) {
      const { trainingPlans = {}, events = [] } = fit.data();
      for (const [planId, weeks] of Object.entries(trainingPlans)) {
        const ev = events.find((e) => e.id === planId);
        if (ev && ev.status === 'completed') continue;
        const week = arr(weeks).find((w) => w.startDate <= today && today <= w.endDate);
        if (!week) {
          const first = arr(weeks)[0];
          if (first && first.startDate > today) {
            const days = Math.round((new Date(first.startDate + 'T12:00:00') - new Date(today + 'T12:00:00')) / 86400000);
            if (days <= 21) {
              lines.push(`${ev?.name || planId}: plan starts ${first.startDate} (in ${days}d).`);
              bannerBits.push(`${ev?.name || 'training'} starts in ${days}d`);
            }
          }
          continue;
        }
        const runs = arr(week.runs);
        const doneMike = runs.filter((r) => r.mike).length;
        const doneAdam = runs.filter((r) => r.adam).length;
        lines.push(`${ev?.name || planId} wk${week.weekNumber} (${week.totalMiles} mi): Mike ${doneMike}/${runs.length}, Adam ${doneAdam}/${runs.length} runs done.${week.weekNotes ? ` Note: ${week.weekNotes}` : ''}`);
        bannerBits.push(`wk${week.weekNumber}: Mike ${doneMike}/${runs.length} · Adam ${doneAdam}/${runs.length} runs`);
      }
    }

    // ── Upcoming trips + events (14 days) ──
    const shared = await maDb.doc('tripData/shared').get();
    const sharedData = shared.exists ? shared.data() : {};
    const horizon = addDays(today, 14);
    for (const t of arr(sharedData.trips)) {
      const s = tripStart(t);
      if (s && s >= today && s <= horizon) lines.push(`Trip soon: ${t.destination || t.name} ${s}${t.dates?.end ? `–${t.dates.end}` : ''}.`);
    }
    const pe = await maDb.doc('tripData/partyEvents').get();
    for (const e of arr(pe.exists ? pe.data().events : [])) {
      if (e.date && e.date >= today && e.date <= horizon) lines.push(`Event soon: ${e.name || e.title} ${e.date}.`);
    }

    // ── Memory recency (subcollection first) ──
    let lastMemoryDate = null;
    const memCol = await maDb.collection('tripData/shared/memories').orderBy('date', 'desc').limit(1).get().catch(() => null);
    if (memCol && !memCol.empty) lastMemoryDate = memCol.docs[0].data().date;
    else {
      const dates = arr(sharedData.memories).map((m) => m.date).filter(Boolean).sort();
      lastMemoryDate = dates[dates.length - 1] || null;
    }
    if (lastMemoryDate) {
      const days = Math.floor((etNow() - new Date(lastMemoryDate + 'T12:00:00')) / 86400000);
      lines.push(`Last memory logged: ${lastMemoryDate} (${days}d ago).`);
      if (days >= 10) bannerBits.push(`${days}d since your last memory 📸`);
    }

    // ── 1) lifeos slice ──
    const coupleContext = lines.join('\n') || 'No joint data found.';
    await lifeDb.doc(`lifeos/${OWNER_UID}`).set({ coupleContext, coupleUpdatedAt: new Date().toISOString() }, { merge: true });

    // ── 2) banner back into mikeandadam (rupert/coupleNote) ──
    const text = bannerBits.length
      ? `Rupert's couple check: ${bannerBits.join(' · ')}`
      : `Rupert's couple check: all quiet — enjoy each other today. 💛`;
    await maDb.doc('rupert/coupleNote').set({
      text,
      signals: [
        { label: '🏠 Hub', href: `${APP_URL}/home` },
        { label: '🏃 Training', href: `${APP_URL}/fitness` },
        { label: '💝 Memories', href: `${APP_URL}/memories` },
      ],
      updatedAt: new Date().toISOString(),
    });

    return res.status(200).json({ ok: true, lines: lines.length, banner: text });
  } catch (e) {
    console.error('cron-couple-context', e);
    return res.status(500).json({ error: e.message });
  }
}
