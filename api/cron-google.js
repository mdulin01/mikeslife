// Vercel Cron: the Google sync — reads Mike's calendars (week ahead) + recent
// email headers and writes them into lifeos for the app (live Calendar/Email
// tabs) and the brain (calendarText/emailText feed the brief + Rupert chat).
// Runs daily before the brief. Refresh token lives in Firestore secrets/google
// (stored by /api/google-callback).
// Required env: CRON_SECRET, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, FIREBASE_SERVICE_ACCOUNT

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';

const OWNER_UID = process.env.OWNER_UID || 'F8QJ8dCk0CV5yX7yHu7AHPd6QS32';
const EASTERN = 'America/New_York';

const etParts = (dt) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: EASTERN, weekday: 'short', hour: 'numeric', minute: '2-digit', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(dt).map((x) => [x.type, x.value]));
  return p;
};
const DAY_IDX = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

// Pillar color by calendar/event keywords (matches the app's CSS vars).
function colorFor(calName, title) {
  const s = (calName + ' ' + title).toLowerCase();
  if (/fitness|health|workout|gym|run|ride|train|swim|yoga|pt\b/.test(s)) return '--emerald';
  if (/adam|family|dinner|date|birthday|friend|personal/.test(s)) return '--rose';
  if (/trip|travel|flight|vacation|hike/.test(s)) return '--sky';
  if (/invoice|tax|bank|finance|rent/.test(s)) return '--amber';
  return '--violet'; // work/consulting default
}

// Emails that deserve a PUSH (not just a passive signal row): trade confirmations,
// large-transaction notices, brokerage insights.
const TRADE_RE = /trade (confirmation|executed|alert)|order (executed|filled|placed)|your (trade|order)|transaction (alert|notice)|large (transaction|purchase|withdrawal)|wire transfer|insight|market (update|commentary)/i;
const FIN_SENDER_RE = /vanguard|fidelity|schwab|tiaa|fifth third|53\.com|chase|amex|robinhood|etrade|merrill/i;

function tagFor(from, subject) {
  const s = (from + ' ' + subject).toLowerCase();
  if (/flight|trip|travel|hotel|rail|airline|airfare|vacation|tour/.test(s)) return ['✈️ TRAVEL', '--sky', 'Travel signal → ', 'review'];
  if (/recruit|opportunit|position|role|cmo|interview|linkedin/.test(s)) return ['🎯 CAREER', '--violet', 'Inbound opportunity → ', 'screen in People'];
  if (/invoice|statement|payment|bank|tax|irs|bill|due/.test(s)) return ['💰 FINANCE', '--amber', 'Money → ', 'check mikes-money'];
  if (/appointment|lab|doctor|clinic|results|rx|pharmacy/.test(s)) return ['🫀 HEALTH', '--emerald', 'Health → ', 'check mikeshealth'];
  if (/shipp|out for delivery|on its way|tracking|delivered|fedex|ups\b|usps|dhl|package|order (confirm|shipped)/.test(s)) return ['📦 DELIVERY', '--sky', 'Delivery → ', 'track'];
  return ['📬 INBOX', '--mut', 'FYI → ', 'triage'];
}

async function gFetch(url, token) {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`${url.split('?')[0]} → ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

export default async function handler(req, res) {
  if (process.env.CRON_SECRET && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    if (!getApps().length) initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
    const db = getFirestore();
    const lifeRef = db.doc(`lifeos/${OWNER_UID}`);
    const d0 = (await lifeRef.get()).data() || {};
    const sec = (await db.doc('secrets/google').get()).data();
    if (!sec || !sec.refreshToken) return res.status(503).json({ error: 'not-connected', message: 'Visit /api/google-auth first.' });

    // Refresh token → access token.
    const tr = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        refresh_token: sec.refreshToken,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        grant_type: 'refresh_token',
      }),
    });
    const tok = await tr.json();
    if (!tr.ok) return res.status(502).json({ error: 'refresh-failed', detail: tok });
    const at = tok.access_token;

    // ── Calendar: a 2-week agenda across all calendars (today → +13d) ──
    // Date-keyed so the app can show real dates and swipe earlier/later; the old
    // weekday-bucketed weekEvents is kept for back-compat with cached app builds.
    const now = new Date();
    const horizon = new Date(Date.now() + 14 * 86400 * 1000);
    // All-day academic-calendar clutter Mike doesn't want on his agenda (UNCC etc.).
    const NOISE = /\bno classes?\b|final exam|reading day|spring break|fall break|winter break|summer session|first day of|last day of|classes (begin|end|resume)|commencement|registration|add\/drop|midterm|semester|graduation ceremony|university (closed|holiday)/i;
    const ymd = (p) => `${p.year}-${p.month}-${p.day}`;
    const cals = (await gFetch('https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=10', at)).items || [];
    const weekEvents = { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };
    const dayMap = {}; // 'YYYY-MM-DD' -> { date, label, events: [{t,c}] }
    const calLines = [];
    for (const cal of cals.slice(0, 10)) {
      const ev = await gFetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal.id)}/events?` + new URLSearchParams({
        timeMin: now.toISOString(), timeMax: horizon.toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: '60',
      }), at);
      for (const e of ev.items || []) {
        if (e.status === 'cancelled' || !e.summary) continue;
        const allDay = !e.start?.dateTime;
        if (allDay && NOISE.test(e.summary)) continue; // drop "No Classes", "Final Examinations", etc.
        const start = e.start?.dateTime || (e.start?.date ? e.start.date + 'T12:00:00' : null);
        if (!start) continue;
        const dt = new Date(start);
        const p = etParts(dt);
        const key = ymd(p);
        const time = e.start?.dateTime ? `${p.hour}:${p.minute} ` : '';
        const item = { t: (time + e.summary).slice(0, 30), c: colorFor(cal.summary || '', e.summary) };
        // New date-keyed agenda.
        if (!dayMap[key]) dayMap[key] = { date: key, label: `${p.weekday} ${+p.month}/${+p.day}`, events: [] };
        if (dayMap[key].events.length < 6) dayMap[key].events.push(item);
        // Legacy weekday buckets (best-effort; collides across weeks, hence the rewrite).
        const idx = DAY_IDX[p.weekday];
        if (idx !== undefined && weekEvents[idx].length < 5) weekEvents[idx].push(item);
        calLines.push(`${p.weekday} ${p.month}/${p.day}${e.start?.dateTime ? ' ' + p.hour + ':' + p.minute : ''} — ${e.summary} [${cal.summary || 'cal'}]`);
      }
    }
    // Continuous window today → +13d (include empty days so the swipe feels like a calendar).
    const todayKey = ymd(etParts(now));
    const days = [];
    for (let i = 0; i < 14; i++) {
      const p = etParts(new Date(Date.now() + i * 86400 * 1000));
      const key = ymd(p);
      days.push(dayMap[key] || { date: key, label: `${p.weekday} ${+p.month}/${+p.day}`, events: [] });
    }
    void todayKey;

    // ── Gmail: recent inbox (wider window + snippets) → signals + brief text ──
    // Two passes: (1) the primary 3-day inbox minus social/forums/promotions, and
    // (2) a dedicated 6-day shipping sweep across Updates/Promotions so deliveries
    // (which Gmail tucks into those tabs) still surface. Snippets give the brief the
    // substance it needs to mine specifics (RSVPs, due dates, tracking, amounts).
    const shortDate = (val) => { try { const p = etParts(new Date(val)); return `${p.weekday} ${p.month}/${p.day}`; } catch { return ''; } };
    const clean = (v) => (v || '').replace(/\s+/g, ' ').trim();

    const PRIMARY_Q = 'newer_than:3d -category:social -category:forums -category:promotions';
    const SHIP_Q = 'newer_than:6d (shipped OR "out for delivery" OR "on its way" OR tracking OR delivered OR "order confirmed" OR "has shipped")';
    const [list, shipList] = await Promise.all([
      gFetch('https://gmail.googleapis.com/gmail/v1/users/me/messages?' + new URLSearchParams({ q: PRIMARY_Q, maxResults: '30' }), at),
      gFetch('https://gmail.googleapis.com/gmail/v1/users/me/messages?' + new URLSearchParams({ q: SHIP_Q, maxResults: '10' }), at),
    ]);
    const primaryIds = (list.messages || []).map((m) => m.id);
    const primarySet = new Set(primaryIds);
    const shipIds = (shipList.messages || []).map((m) => m.id).filter((id) => !primarySet.has(id));

    const getMeta = (id) => gFetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`, at);
    const [primaryMsgs, shipMsgs] = await Promise.all([
      Promise.all(primaryIds.map((id) => getMeta(id).catch(() => null))),
      Promise.all(shipIds.map((id) => getMeta(id).catch(() => null))),
    ]);

    const parse = (msg) => {
      const h = Object.fromEntries((msg.payload?.headers || []).map((x) => [x.name, x.value]));
      return {
        from: clean((h.From || '').replace(/<.*>/, '').replace(/"/g, '')).slice(0, 32),
        subject: clean(h.Subject || '(no subject)').slice(0, 90),
        snippet: clean(msg.snippet || '').slice(0, 160),
        date: shortDate(h.Date),
        fromRaw: h.From || '',
      };
    };

    const emailSignals = [];
    const mailLines = [];
    const tradeHits = [];
    const mailSeen = new Set(d0.financeMailSeen || []);
    for (let i = 0; i < primaryMsgs.length; i++) {
      const msg = primaryMsgs[i]; if (!msg) continue;
      const e = parse(msg);
      const [tag, accent, hint, act] = tagFor(e.fromRaw, e.subject);
      if (tag !== '📬 INBOX' && emailSignals.length < 12) emailSignals.push({ tag, accent, from: e.from, subject: e.subject, hint, act });
      mailLines.push(`[${e.date}] ${e.from} — ${e.subject}${e.snippet ? ' — ' + e.snippet : ''}`);
      if (!mailSeen.has(primaryIds[i]) && FIN_SENDER_RE.test(e.fromRaw) && TRADE_RE.test(e.subject)) {
        tradeHits.push(`${e.from}: ${e.subject}`);
        mailSeen.add(primaryIds[i]);
      }
    }

    const deliveryLines = [];
    for (const msg of shipMsgs) {
      if (!msg) continue;
      const e = parse(msg);
      deliveryLines.push(`[${e.date}] ${e.from} — ${e.subject}${e.snippet ? ' — ' + e.snippet : ''}`);
      if (emailSignals.length < 12) { const [tag, accent, hint, act] = tagFor(e.fromRaw, e.subject); emailSignals.push({ tag: '📦 DELIVERY', accent: '--sky', from: e.from, subject: e.subject, hint: 'Delivery → ', act: 'track' }); }
    }

    // Trade/large-txn emails → a pushed 💰 alert (unless finance alerts are muted).
    const patchExtra = {};
    if (tradeHits.length && !(d0.alertPrefs && d0.alertPrefs.finance === false)) {
      const at2 = new Date().toISOString();
      patchExtra.financeMailSeen = [...mailSeen].slice(-200);
      patchExtra.alerts = [
        { id: 'a' + Date.now(), type: 'finance', title: `💰 Brokerage mail — ${tradeHits.length} item${tradeHits.length > 1 ? 's' : ''}`, text: tradeHits.join('\n'), at: at2, feedback: null, appUrl: 'https://www.mikesmoney.app' },
        ...(d0.alerts || []),
      ].slice(0, 120);
      const tokens = [d0.fcmToken || (d0.fcmTokens || []).slice(-1)[0]].filter(Boolean);
      for (const token of tokens) {
        try {
          await getMessaging().send({
            token,
            notification: { title: '💰 Brokerage mail', body: tradeHits[0].slice(0, 180) },
            data: { url: 'https://mikeslife.app/?source=push&focus=content' },
            webpush: { notification: { icon: 'https://mikeslife.app/icon-192.png' }, fcmOptions: { link: 'https://mikeslife.app/?source=push&focus=content' } },
          });
        } catch (e) { console.error('push failed:', e.message); }
      }
    }

    await db.doc(`lifeos/${OWNER_UID}`).set({
      ...patchExtra,
      calendar: { weekEvents, days, updatedAt: new Date().toISOString() },
      calendarText: calLines.slice(0, 25).join('\n') || 'No events in the next 7 days.',
      ...(emailSignals.length ? { emailSignals } : {}),
      emailText: (mailLines.slice(0, 30).join('\n') || 'No recent mail.')
        + (deliveryLines.length ? '\n\nShipments / deliveries in transit:\n' + deliveryLines.slice(0, 10).join('\n') : ''),
      googleSyncedAt: new Date().toISOString(),
    }, { merge: true });

    return res.status(200).json({ ok: true, events: calLines.length, signals: emailSignals.length, mails: mailLines.length, deliveries: deliveryLines.length, tradeAlerts: tradeHits.length });
  } catch (e) {
    console.error('cron-google error', e);
    return res.status(500).json({ error: e.message || 'error' });
  }
}
