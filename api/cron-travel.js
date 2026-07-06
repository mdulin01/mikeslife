// Vercel Cron: the travel inbox — Rupert reads Mike's Gmail for flight/hotel/
// ferry/car confirmations, extracts structured segments (same prompt as
// mikestravel's /api/parse-itinerary), and files them into the matching trip
// in the mikestravel Firestore. Phase 2 of "Rupert parses them straight from
// confirmation emails."
//
//   1. Gmail search (last 3 days) for confirmation-looking emails
//   2. LLM-extract segments from each unseen message body
//   3. Match to a trip by date window (start-1d … end+1d), else by destination text
//   4. Dedupe by conf # / (type+title+date), append with source:'gmail'
//   5. Push "✈️ Added N segments" + lifeos travel alert; write travelContext slice
//
// Dedupe across runs: lifeos.travelSeen (capped list of Gmail message ids).
// Required env: CRON_SECRET, FIREBASE_SERVICE_ACCOUNT, GOOGLE_CLIENT_ID,
//   GOOGLE_CLIENT_SECRET, OPENAI_API_KEY, FIREBASE_SA_TRAVEL (admin JSON for
//   the mikestravel-29da2 project — same drill as FIREBASE_SA_NUTRITION).
// Without FIREBASE_SA_TRAVEL the job no-ops politely.

import OpenAI from 'openai';
import { createHash } from 'node:crypto';
import { initializeApp, cert, getApps, getApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';
import { dataPush } from './_push.js';

const OWNER_UID = process.env.OWNER_UID || 'F8QJ8dCk0CV5yX7yHu7AHPd6QS32';
const OWNER_EMAIL = 'mdulin@gmail.com';
const ADAM_EMAIL = 'adamjosephbritten@gmail.com';
const MAA_APP = 'https://mikeandadam.app';
const MODEL = process.env.OPENAI_MODEL || 'gpt-5.5';
const TRAVEL_APP = 'https://www.mikestravel.app';

// Confirmation-looking mail from the last 3 days. Keyword-broad on purpose —
// the LLM pass returns [] for false positives, which just costs one small call.
const GMAIL_Q =
  'newer_than:3d (subject:(itinerary OR reservation OR confirmation OR booking OR "e-ticket" OR "boarding pass" OR "your trip" OR "your stay" OR "your flight" OR ferry OR "check-in") ' +
  'OR from:(tripit.com OR expedia OR aa.com OR delta.com OR united.com OR southwest.com OR jetblue.com OR marriott.com OR hilton.com OR airbnb.com OR vrbo.com OR hotels.com OR booking.com OR cityexperiences.com OR amtrak.com OR hertz.com OR enterprise.com OR national.com))';

const SYS = `Extract travel segments from the email text. Return ONLY a JSON array (no prose). Each item:
{ "type": "flight"|"hotel"|"car"|"activity"|"food"|"note",
  "title": short label (e.g. "AA 1153 CLT→BOS" or "Boatslip — Harbor View Queen"),
  "date": "YYYY-MM-DD" (departure/check-in date; infer the year from context, else omit),
  "time": "HH:MM" 24h if present else "",
  "conf": confirmation/record-locator if present else "",
  "location": airport codes / city / address if present else "",
  "notes": seat, balance due, room type, terminal, etc. else "" }
One segment per leg (each flight leg separate; check-in and check-out can be one hotel segment). Ferries are "activity". Marketing/newsletter/receipt-for-past-purchase content is NOT a segment. If nothing parseable, return [].`;

const b64 = (s) => Buffer.from(String(s || ''), 'base64url').toString('utf8');
function bodyText(payload) {
  // Prefer text/plain, fall back to de-tagged text/html, walking nested parts.
  let plain = '', html = '';
  const walk = (p) => {
    if (!p) return;
    if (p.mimeType === 'text/plain' && p.body?.data) plain += b64(p.body.data) + '\n';
    else if (p.mimeType === 'text/html' && p.body?.data) html += b64(p.body.data) + '\n';
    (p.parts || []).forEach(walk);
  };
  walk(payload);
  const t = plain.trim() || html.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  return t.slice(0, 15000);
}

async function gFetch(url, token) {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`${url.split('?')[0]} → ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

const TYPES = new Set(['flight', 'hotel', 'car', 'activity', 'food', 'note']);
const clean = (g, i) => ({
  id: 'sg' + Date.now() + '_' + i,
  type: TYPES.has(g.type) ? g.type : 'note',
  title: String(g.title || '').slice(0, 120),
  date: /^\d{4}-\d{2}-\d{2}$/.test(g.date || '') ? g.date : '',
  time: /^\d{1,2}:\d{2}$/.test(g.time || '') ? g.time : '',
  conf: String(g.conf || '').slice(0, 40),
  location: String(g.location || '').slice(0, 80),
  notes: String(g.notes || '').slice(0, 200),
  source: 'gmail',
});

const addDays = (ymd, n) => {
  const d = new Date(ymd + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

// Match a segment to a trip: date inside [start-1d, end+1d] wins (tightest
// window first); otherwise a destination/name substring hit on location/title.
function matchTrip(seg, trips) {
  const dated = trips
    .filter((t) => t.start && seg.date && seg.date >= addDays(t.start, -1) && seg.date <= addDays(t.end || t.start, 1))
    .sort((a, b) => ((a.end || a.start) + a.start).localeCompare((b.end || b.start) + b.start));
  if (dated.length) return dated[0];
  const hay = (seg.location + ' ' + seg.title).toLowerCase();
  return trips.find((t) => {
    const words = ((t.destination || '') + ' ' + (t.name || '')).toLowerCase().split(/[\s,·—-]+/).filter((w) => w.length > 3);
    return words.some((w) => hay.includes(w));
  }) || null;
}

const isDupe = (seg, existing) => existing.some((s) =>
  (seg.conf && s.conf && seg.conf === s.conf && s.type === seg.type) ||
  (s.type === seg.type && s.date === seg.date && s.title.toLowerCase() === seg.title.toLowerCase()));

export default async function handler(req, res) {
  if (process.env.CRON_SECRET && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    if (!process.env.OPENAI_API_KEY) return res.status(503).json({ error: 'no OPENAI_API_KEY' });
    if (!process.env.FIREBASE_SA_TRAVEL) return res.status(200).json({ ok: false, skipped: 'no FIREBASE_SA_TRAVEL (add the mikestravel admin key to mikeslife Vercel env)' });

    if (!getApps().length) initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
    const lifeDb = getFirestore();
    let tApp; try { tApp = getApp('travel'); } catch { tApp = initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SA_TRAVEL)) }, 'travel'); }
    const tDb = getFirestore(tApp);

    const lifeRef = lifeDb.doc(`lifeos/${OWNER_UID}`);
    const life = (await lifeRef.get()).data() || {};
    const seen = new Set(life.travelSeen || []);

    // ── Gmail: refresh token → access token → search ──
    const sec = (await lifeDb.doc('secrets/google').get()).data();
    if (!sec?.refreshToken) return res.status(503).json({ error: 'not-connected', message: 'Visit /api/google-auth first.' });
    const tr = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ refresh_token: sec.refreshToken, client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, grant_type: 'refresh_token' }),
    });
    const tok = await tr.json();
    if (!tr.ok) return res.status(502).json({ error: 'refresh-failed', detail: tok });
    const at = tok.access_token;

    const list = await gFetch('https://gmail.googleapis.com/gmail/v1/users/me/messages?' + new URLSearchParams({ q: GMAIL_Q, maxResults: '15' }), at);
    const fresh = (list.messages || []).filter((m) => !seen.has(m.id));
    // NOTE: no early return here — pre-trip alerts + the mikeandadam mirror
    // below must run every cycle even when there's no new mail.

    // ── Trips this account can file into ──
    const tripsSnap = await tDb.collection('trips').where('members', 'array-contains', OWNER_EMAIL).get();
    const trips = tripsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, ...(process.env.OPENAI_BASE_URL ? { baseURL: process.env.OPENAI_BASE_URL } : {}) });
    const added = {};   // tripId → [segment titles]
    const unmatched = [];

    for (const m of fresh.slice(0, 8)) {   // cap LLM calls per run
      seen.add(m.id);
      try {
        const full = await gFetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=full`, at);
        const hdr = (n) => full.payload?.headers?.find((h) => h.name.toLowerCase() === n)?.value || '';
        const text = `From: ${hdr('from')}\nSubject: ${hdr('subject')}\nDate: ${hdr('date')}\n\n${bodyText(full.payload)}`;
        if (text.length < 120) continue;

        const c = await openai.chat.completions.create({
          model: MODEL, max_completion_tokens: 3000,
          messages: [{ role: 'system', content: SYS }, { role: 'user', content: text }],
        });
        let segs; try { segs = JSON.parse((c.choices?.[0]?.message?.content || '').replace(/```json|```/g, '').trim()); } catch { continue; }
        if (!Array.isArray(segs) || !segs.length) continue;
        segs = segs.slice(0, 12).map(clean).filter((g) => g.title);

        for (const seg of segs) {
          const trip = matchTrip(seg, trips);
          if (!trip) { unmatched.push(seg.title + (seg.date ? ' (' + seg.date + ')' : '')); continue; }
          if (isDupe(seg, trip.segments || [])) continue;
          trip.segments = [...(trip.segments || []), seg];   // local, so later segs dedupe too
          await tDb.doc('trips/' + trip.id).set({ segments: trip.segments }, { merge: true });
          (added[trip.id] = added[trip.id] || { name: trip.name, titles: [] }).titles.push(seg.title);
        }
      } catch (e) { console.error('msg ' + m.id + ' failed:', e.message); }
    }

    // ── travelContext slice for the brief/Rupert ──
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); // Eastern, per house rule

    const upcoming = trips.filter((t) => (t.end || t.start) >= today).sort((a, b) => a.start.localeCompare(b.start)).slice(0, 4);
    const travelContext = upcoming.map((t) => {
      const segs = (t.segments || []).filter((s) => s.date >= today).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time)).slice(0, 6);
      return `${t.name} (${t.start}→${t.end || t.start}, ${t.destination || 'TBD'}): ` + (segs.map((s) => `${s.date} ${s.title}${s.time ? ' @' + s.time : ''}`).join('; ') || 'no segments yet');
    }).join('\n');

    // ── Pre-trip alert: ≤2 days out — check-in nudge + day-1 agenda (once per trip) ──
    const preSeen = new Set(life.travelPreTripSeen || []);
    let preTrip = null;
    for (const t of upcoming) {
      const key = t.id + ':' + t.start;
      if (!t.start || t.start < today || preSeen.has(key)) continue;
      const days = Math.round((new Date(t.start + 'T12:00:00Z') - new Date(today + 'T12:00:00Z')) / 86400000);
      if (days > 2) continue;
      const day1 = (t.segments || []).filter((s) => s.date === t.start).sort((a, b) => (a.time || '99').localeCompare(b.time || '99'));
      preTrip = {
        key,
        title: `🧳 ${t.name} — ${days === 0 ? 'today' : days === 1 ? 'tomorrow' : 'in 2 days'}!`,
        text: [
          day1.length ? 'Day 1: ' + day1.map((s) => (s.time ? s.time + ' ' : '') + s.title).join(' → ') : 'No day-1 segments yet — check the plan.',
          (t.segments || []).some((s) => s.type === 'flight') ? 'Flight check-in opens 24h out. Pack tonight.' : 'Confirm reservations + pack.',
        ].join('\n'),
      };
      preSeen.add(key);
      break; // at most one pre-trip push per run
    }

    // ── Mirror Adam-shared trips → mikeandadam tripData/shared (+ notify Adam) ──
    // Reuses FIREBASE_SA_FITNESS: mikesfitness and mikeandadam share project
    // trip-planner-5cc84. One-way mirror — mikestravel stays canonical; mirrored
    // trips carry source:'mikestravel' and native mikeandadam trips are untouched.
    let maaSync = 'skipped (no FIREBASE_SA_FITNESS)', adamPush = 'none';
    const sharedTrips = trips.filter((t) => (t.members || []).includes(ADAM_EMAIL) && (t.end || t.start) >= today);
    if (process.env.FIREBASE_SA_FITNESS) {
      try {
        let maaApp; try { maaApp = getApp('maa'); } catch { maaApp = initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SA_FITNESS)) }, 'maa'); }
        const maaDb = getFirestore(maaApp);
        const sharedRef = maaDb.doc('tripData/shared');
        const cur = (await sharedRef.get()).data() || {};

        const mirrors = sharedTrips.map((t) => ({
          id: 'mt-' + t.id, source: 'mikestravel',
          destination: t.destination || t.name, emoji: t.emoji || '✈️',
          dates: { start: t.start, end: t.end || t.start },
          color: 'from-cyan-400 to-sky-500', accent: 'bg-cyan-400',
          isWishlist: false, guests: [], special: '', coverImage: '',
          transportMode: (t.segments || []).some((s) => s.type === 'flight') ? 'air' : 'ground',
          notes: (t.notes ? t.notes + ' · ' : '') + '🔄 Synced from mikestravel.app — edit there',
        }));
        const details = { ...(cur.tripDetails || {}) };
        for (const k of Object.keys(details)) if (k.startsWith('mt-') && !mirrors.some((m) => m.id === k)) delete details[k];
        for (const t of sharedTrips) {
          const segs = t.segments || [];
          const prev = details['mt-' + t.id] || {};
          details['mt-' + t.id] = {
            flights: segs.filter((s) => s.type === 'flight').map((s, i) => ({ id: 'ms' + i, addedBy: 'Mike', airline: '', flightNo: s.title, date: s.date, depart: s.time || '', arrive: '', confirmation: s.conf || '' })),
            hotels: segs.filter((s) => s.type === 'hotel').map((s, i) => ({ id: 'mh' + i, addedBy: 'Mike', name: s.title, address: s.location || '', checkIn: s.date, checkOut: '' })),
            events: segs.filter((s) => ['activity', 'food', 'note'].includes(s.type)).map((s, i) => ({ id: 'me' + i, addedBy: 'Mike', name: s.title + (s.notes ? ' — ' + s.notes : ''), date: s.date, time: s.time || '', location: s.location || '' })),
            // Verbatim segments (2026-07-06): mikeandadam renders a mikestravel-style
            // day-by-day itinerary from these; the legacy arrays above stay for old UI bits.
            segments: segs.map((g) => ({ id: g.id || '', type: g.type || 'note', title: g.title || '', date: g.date || '', time: g.time || '', conf: g.conf || '', location: g.location || '', notes: g.notes || '', link: g.link || '' })),
            links: prev.links || [], packingList: prev.packingList || [], budget: prev.budget || { total: 0, expenses: [] }, photos: prev.photos || [], notes: prev.notes || [],
          };
        }
        const mirrorHash = createHash('sha256').update(JSON.stringify({ m: mirrors, d: Object.fromEntries(Object.entries(details).filter(([k]) => k.startsWith('mt-'))) })).digest('hex');
        if (mirrorHash !== life.maaTravelMirrorHash) {
          // Absorb native duplicates: a native mikeandadam trip that matches a
          // mirrored trip (name overlap + date overlap) is dropped, its
          // tripDetails merged into the mirror's (mirror fields win when both
          // exist; user-curated arrays like packing/photos are unioned).
          const norm = (x) => String(x || '').toLowerCase();
          const tStart = (t) => t.dates?.start || t.start || '';
          const tEnd = (t) => t.dates?.end || t.end || tStart(t);
          const isDup = (nat, mir) => {
            const a = norm(nat.destination), b = norm(mir.destination);
            const nameHit = a && b && (a.includes(b.split(' — ')[0].split(',')[0]) || b.includes(a.split(' — ')[0].split(',')[0]));
            const dateHit = tStart(nat) && tStart(mir) && tStart(nat) <= tEnd(mir) && tStart(mir) <= tEnd(nat);
            return nameHit && dateHit;
          };
          const native = [];
          for (const nat of (cur.trips || []).filter((t) => t.source !== 'mikestravel')) {
            const mir = mirrors.find((m) => isDup(nat, m));
            if (!mir) { native.push(nat); continue; }
            const natD = (cur.tripDetails || {})[nat.id] || {};
            const mirD = details[mir.id] || {};
            for (const key of ['links', 'packingList', 'photos', 'notes']) {
              mirD[key] = [...(mirD[key] || []), ...(natD[key] || []).filter((x) => !(mirD[key] || []).some((y) => JSON.stringify(y) === JSON.stringify(x)))];
            }
            if ((!mirD.budget || !(mirD.budget.expenses || []).length) && natD.budget) mirD.budget = natD.budget;
            details[mir.id] = mirD;
            // merge:true deep-merges maps — a plain JS delete never reaches
            // Firestore. FieldValue.delete() actually removes the stale key.
            details[nat.id] = FieldValue.delete();
            console.log('cron-travel: absorbed native duplicate trip', nat.id, '→', mir.id);
          }
          await sharedRef.set({ trips: [...native, ...mirrors], tripDetails: details, lastUpdated: new Date().toISOString(), updatedBy: 'Rupert' }, { merge: true });
          maaSync = 'updated (' + mirrors.length + ' mirrored)';
        } else maaSync = 'unchanged';

        // Notify Adam only when NEW segments were filed into a shared trip this run.
        const adamWorthy = Object.entries(added).filter(([id]) => sharedTrips.some((t) => t.id === id));
        if (adamWorthy.length) {
          const toks = (await maaDb.doc('tripData/fcmTokens').get()).data() || {};
          if (toks.adam) {
            try {
              await getMessaging(maaApp).send({
                token: toks.adam,
                notification: { title: '✈️ Trip updated — ' + adamWorthy.map(([, v]) => v.name).join(', '), body: adamWorthy.map(([, v]) => v.titles.join(' · ')).join('\n').slice(0, 180) },
                data: { url: MAA_APP },
                webpush: { notification: { icon: MAA_APP + '/icon-192.png', badge: MAA_APP + '/icon-192.png' } },
              });
              adamPush = 'sent';
            } catch (e) { adamPush = 'failed: ' + e.message; console.error('adam push failed:', e.message); } // likely IAM: SA needs FCM send permission
          } else adamPush = 'no adam token registered';
        }
        if (mirrorHash !== life.maaTravelMirrorHash) life.maaTravelMirrorHash = mirrorHash; // carried into patch below
      } catch (e) { maaSync = 'failed: ' + e.message; console.error('maa mirror failed:', e.message); }
    }

    // ── Persist dedupe lists + alerts, push if anything happened ──
    const tripNames = Object.values(added);
    const total = tripNames.reduce((n, t) => n + t.titles.length, 0);
    const patch = {
      travelSeen: [...seen].slice(-300), travelContext, travelContextAt: new Date().toISOString(),
      travelPreTripSeen: [...preSeen].slice(-60), maaTravelMirrorHash: life.maaTravelMirrorHash || '',
    };
    const newAlerts = [];
    const muted = life.alertPrefs && life.alertPrefs.travel === false;
    if (total || unmatched.length) {
      const title = total ? `✈️ ${total} segment${total > 1 ? 's' : ''} filed → ${tripNames.map((t) => t.name).join(', ')}` : '✈️ Travel email needs a trip';
      const text = [
        ...tripNames.map((t) => `${t.name}: ${t.titles.join(' · ')}`),
        ...(unmatched.length ? ['No matching trip (add one, then re-run): ' + unmatched.join(' · ')] : []),
      ].join('\n');
      newAlerts.push({ id: 'a' + Date.now(), type: 'travel', title, text, at: new Date().toISOString(), feedback: null, appUrl: TRAVEL_APP });
      if (life.fcmToken && !muted) {
        try { await getMessaging().send(dataPush(life.fcmToken, title, text.slice(0, 160), TRAVEL_APP)); } catch (e) { console.error('push failed:', e.message); }
      }
    }
    if (preTrip) {
      newAlerts.push({ id: 'a' + Date.now() + 'p', type: 'travel', title: preTrip.title, text: preTrip.text, at: new Date().toISOString(), feedback: null, appUrl: TRAVEL_APP });
      if (life.fcmToken && !muted) {
        try { await getMessaging().send(dataPush(life.fcmToken, preTrip.title, preTrip.text.slice(0, 160), TRAVEL_APP)); } catch (e) { console.error('pre-trip push failed:', e.message); }
      }
    }
    if (newAlerts.length) patch.alerts = [...newAlerts, ...(life.alerts || [])].slice(0, 120);
    await lifeRef.set(patch, { merge: true });

    return res.status(200).json({ ok: true, checked: (list.messages || []).length, new: fresh.length, filed: total, unmatched, preTrip: preTrip?.title || null, maaSync, adamPush });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
}
