// Vercel Cron: the daily content push (podcasts / recipes / meal-prep / travel) —
// cloud version of rupert/notify/content-push.mjs so it runs without the mini.
// One run per day; the slot comes from the day of week (ET):
//   Mon/Tue → recipe · Wed/Thu → podcast · Fri → (skip) · Sat → travel · Sun → mealprep
// Idempotent: skips if today already has an alert of that slot type.
// Required env: CRON_SECRET, OPENAI_API_KEY, FIREBASE_SERVICE_ACCOUNT

import OpenAI from 'openai';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';

const OWNER_UID = process.env.OWNER_UID || 'F8QJ8dCk0CV5yX7yHu7AHPd6QS32';
const MODEL = process.env.OPENAI_MODEL || 'gpt-5.5';
const LINK = 'https://mikeslife.app/?source=push&focus=content';

const easternYMD = (dt = new Date()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(dt);

function slotForToday() {
  const day = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' }).format(new Date());
  return { Mon: 'recipe', Tue: 'recipe', Wed: 'podcast', Thu: 'podcast', Fri: null, Sat: 'travel', Sun: 'mealprep' }[day] ?? null;
}

const LINK_RULE = ' For each item, add the link on its own line: podcasts → "Listen: https://open.spotify.com/search/" + show and episode words joined by %20; recipes/travel → "https://www.google.com/search?q=" + the words joined by +. In search words use ONLY letters, numbers and spaces — no apostrophes, quotes, colons, ampersands or other punctuation — and never put any character (period, comma, paren) immediately after a URL. Phone-friendly, no preamble.';
const TITLES = { podcast: '🎧 Podcasts for your commute', recipe: "🍳 Tonight's dinner ideas", mealprep: '🥗 Sunday meal-prep', travel: '✈️ Travel ideas' };

export default async function handler(req, res) {
  if (process.env.CRON_SECRET && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    if (!process.env.OPENAI_API_KEY || !process.env.FIREBASE_SERVICE_ACCOUNT) {
      return res.status(503).json({ error: 'not-configured' });
    }
    const slot = (req.query && req.query.slot) || slotForToday();
    if (!slot) return res.status(200).json({ ok: true, skipped: 'no content slot today' });

    if (!getApps().length) initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
    const db = getFirestore();
    const ref = db.doc(`lifeos/${OWNER_UID}`);
    const d = (await ref.get()).data() || {};
    const today = easternYMD();

    // Idempotency — the mini may have already sent this slot today.
    const dupe = (d.alerts || []).some((a) => a.type === slot && a.at && easternYMD(new Date(a.at)) === today);
    if (dupe) return res.status(200).json({ ok: true, skipped: `${slot} already sent today` });

    const PROMPTS = {
      podcast: 'Recommend 2–3 specific podcast episodes — mix AI and health/longevity — that Mike would enjoy on a ~2-hour commute. Give show + episode title + a one-line why. He likes AI, precision medicine, fitness, and longevity.',
      recipe: 'Suggest 2 dinner recipes Mike could cook tonight — healthy, high-protein, not fussy. Each: name + 4–6 key ingredients + a one-line method.',
      mealprep: 'Give Mike a simple Sunday meal-prep plan: 2–3 batch recipes (high-protein, healthy) plus a combined grocery list, for weekday lunches/dinners.',
      travel: 'Suggest 2–3 inspiring travel ideas for Mike (loves hiking, biking, warm places; has a January birthday trip and a "month in Spain" goal). Keep it short.'
        + (Array.isArray(d.emailSignals) && d.emailSignals.length ? ' Also weave in anything relevant from his inbox: ' + JSON.stringify(d.emailSignals).slice(0, 800) : ''),
    };
    const fb = (d.alerts || []).filter((a) => a.feedback).slice(0, 12);
    const FB_LINE = fb.length ? '\n\nMike rated past content (send more like 👍, avoid more like 👎): ' + fb.map((a) => `${a.feedback === 'up' ? '👍' : '👎'} ${a.title}: ${String(a.text || '').slice(0, 60)}`).join(' | ') : '';

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, ...(process.env.OPENAI_BASE_URL ? { baseURL: process.env.OPENAI_BASE_URL } : {}) });
    const c = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: "You are Rupert, Mike's chief of staff. Be concise, specific, warm. Output a short phone-friendly message, no preamble." },
        { role: 'user', content: PROMPTS[slot] + LINK_RULE + FB_LINE },
      ],
    });
    const body = (c.choices?.[0]?.message?.content || '').trim();
    const at = new Date().toISOString();

    await ref.set({
      contentFeed: { slot, title: TITLES[slot], text: body, at },
      alerts: [
        { id: 'a' + Date.now(), type: slot, title: TITLES[slot], text: body, at, feedback: null },
        ...(d.alerts || []),
      ].slice(0, 120),
    }, { merge: true });

    const tokens = Array.from(new Set([...(d.fcmTokens || []), d.fcmToken].filter(Boolean)));
    let pushed = 0;
    for (const token of tokens) {
      try {
        await getMessaging().send({
          token,
          notification: { title: TITLES[slot], body: body.slice(0, 180) },
          data: { url: LINK },
          webpush: { notification: { icon: 'https://mikeslife.app/icon-192.png', badge: 'https://mikeslife.app/icon-192.png' }, fcmOptions: { link: LINK } },
        });
        pushed++;
      } catch (e) { console.error('push failed:', e.message); }
    }
    return res.status(200).json({ ok: true, slot, pushed });
  } catch (e) {
    console.error('cron-content error', e);
    return res.status(500).json({ error: e.message || 'error' });
  }
}
