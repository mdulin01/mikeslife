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
        if (runs.length === 0) continue; // leftover/degenerate weeks (e.g. old mikesfitness plans)
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

    // ── Shared Google calendar → tripData/calendar in mikeandadam ──
    // Uses the same OAuth as cron-google (secrets/google refresh token).
    // Prefers calendars whose name mentions both Mike and Adam (the shared
    // couple calendar); falls back to ALL calendars if none match.
    let calendarStatus = 'skipped';
    try {
      const sec = (await lifeDb.doc('secrets/google').get()).data();
      if (sec?.refreshToken && process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
        const tr = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            refresh_token: sec.refreshToken,
            client_id: process.env.GOOGLE_CLIENT_ID,
            client_secret: process.env.GOOGLE_CLIENT_SECRET,
            grant_type: 'refresh_token',
          }),
        }).then((r) => r.json());
        const at = tr.access_token;
        if (!at) throw new Error('token refresh failed');
        const gFetch = async (url) => {
          const r = await fetch(url, { headers: { Authorization: `Bearer ${at}` } });
          if (!r.ok) throw new Error(`${url.split('?')[0]} → ${r.status}`);
          return r.json();
        };
        const cals = (await gFetch('https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=15')).items || [];
        const coupleRe = /(mike.*adam|adam.*mike|m\s*&\s*a)/i;
        let picked = cals.filter((c) => coupleRe.test(c.summary || ''));
        const source = picked.length ? picked.map((c) => c.summary).join(', ') : 'all-calendars';
        if (!picked.length) picked = cals.slice(0, 10);

        const fmtET = (d, opts) => new Date(d).toLocaleString('en-US', { timeZone: ET, ...opts });
        const now = new Date();
        const horizonMs = new Date(Date.now() + 14 * 86400 * 1000);
        const dayMap = {};
        for (const cal of picked) {
          const ev = await gFetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal.id)}/events?` + new URLSearchParams({
            timeMin: now.toISOString(), timeMax: horizonMs.toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: '50',
          }));
          for (const e of ev.items || []) {
            if (e.status === 'cancelled' || !e.summary) continue;
            const startIso = e.start?.dateTime || (e.start?.date ? e.start.date + 'T12:00:00' : null);
            if (!startIso) continue;
            const d = new Date(startIso);
            const key = `${fmtET(d, { year: 'numeric' })}-${fmtET(d, { month: '2-digit' })}-${fmtET(d, { day: '2-digit' })}`;
            const label = fmtET(d, { weekday: 'short', month: 'numeric', day: 'numeric' });
            const time = e.start?.dateTime ? fmtET(d, { hour: 'numeric', minute: '2-digit' }) : '';
            if (!dayMap[key]) dayMap[key] = { date: key, label, events: [] };
            if (dayMap[key].events.length < 8) {
              dayMap[key].events.push({ time, title: String(e.summary).slice(0, 80), calendar: source === 'all-calendars' ? (cal.summary || '').slice(0, 20) : '' });
            }
          }
        }
        const days = Object.values(dayMap).sort((a, b) => a.date.localeCompare(b.date));
        await maDb.doc('tripData/calendar').set({ days, source, updatedAt: new Date().toISOString() });
        calendarStatus = `${days.length} days from ${source}`;
        const nextEv = days[0]?.events?.[0];
        if (nextEv) lines.push(`Next on shared calendar: ${days[0].label} ${nextEv.time || ''} ${nextEv.title}.`);
      }
    } catch (e) {
      console.warn('couple calendar sync failed:', e.message);
      calendarStatus = `error: ${e.message}`;
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

    return res.status(200).json({ ok: true, lines: lines.length, banner: text, calendar: calendarStatus });
  } catch (e) {
    console.error('cron-couple-context', e);
    return res.status(500).json({ error: e.message });
  }
}
