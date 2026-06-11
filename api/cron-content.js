// Vercel Cron: the daily content push (podcasts / recipes / meal-prep / travel).
// One run per day; slot = day of week (ET):
//   Mon/Tue → recipe · Wed/Thu → podcast · Fri → (skip) · Sat → travel · Sun → mealprep
//
// Output is STRUCTURED: alert.items = [{ t, s, link, feedback }] so the app can
// rate each item separately. Podcasts are REAL recent episodes — pulled from the
// shows' RSS feeds (last 60 days) and picked by the model, with real episode links.
// Idempotent per day · respects lifeos.alertPrefs mutes.
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

const TITLES = { podcast: '🎧 Podcasts for your commute', recipe: "🍳 Tonight's dinner ideas", mealprep: '🥗 Sunday meal-prep', travel: '✈️ Travel ideas', ainews: '🤖 Healthcare AI news' };

// ── Real recent podcast episodes via iTunes lookup + RSS (no fabricated "recent" eps) ──
const SHOWS = [
  'The Peter Attia Drive', 'Huberman Lab', 'Hard Fork', 'The AI Daily Brief',
  'FoundMyFitness', 'NEJM AI Grand Rounds', 'Volts', 'Freakonomics Radio',
];

async function fetchText(url, ms = 6000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { 'user-agent': 'mikeslife-rupert/1.0' } });
    return r.ok ? await r.text() : null;
  } catch { return null; } finally { clearTimeout(t); }
}

const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '').trim() : '';
};

async function recentEpisodes(show, days = 60) {
  const search = await fetchText(`https://itunes.apple.com/search?term=${encodeURIComponent(show)}&media=podcast&limit=1`);
  if (!search) return [];
  let feedUrl;
  try { feedUrl = JSON.parse(search).results?.[0]?.feedUrl; } catch { return []; }
  if (!feedUrl) return [];
  const xml = await fetchText(feedUrl);
  if (!xml) return [];
  const cutoff = Date.now() - days * 86400 * 1000;
  const out = [];
  for (const item of xml.split(/<item[\s>]/i).slice(1, 7)) {
    const title = tag(item, 'title');
    const pub = new Date(tag(item, 'pubDate') || 0).getTime();
    if (!title || !pub || pub < cutoff) continue;
    const link = tag(item, 'link') || (item.match(/enclosure[^>]*url="([^"]+)"/i) || [])[1] || '';
    out.push({ show, title, date: new Date(pub).toISOString().slice(0, 10), link, desc: tag(item, 'description').slice(0, 180) });
  }
  return out;
}

// Render items[] to plain text (push body + legacy text field).
const renderItems = (items) => items.map((it) => `${it.t}${it.s ? '\n' + it.s : ''}${it.link ? '\n' + it.link : ''}`).join('\n\n');

// Per-item + whole-alert ratings, flattened for the prompt.
function feedbackLines(d) {
  const lines = [];
  for (const a of (d.alerts || []).slice(0, 40)) {
    if (a.feedback) lines.push(`${a.feedback === 'up' ? '👍' : '👎'} ${a.title}`);
    for (const it of (a.items || [])) if (it.feedback) lines.push(`${it.feedback === 'up' ? '👍' : '👎'} ${it.t}`);
  }
  return lines.slice(0, 16);
}

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

    if (d.alertPrefs && d.alertPrefs[slot] === false) {
      return res.status(200).json({ ok: true, skipped: `${slot} muted in app preferences` });
    }
    const force = req.query && req.query.force === '1';
    const dupe = (d.alerts || []).some((a) => a.type === slot && a.at && easternYMD(new Date(a.at)) === today);
    if (dupe && !force) return res.status(200).json({ ok: true, skipped: `${slot} already sent today` });

    const fb = feedbackLines(d);
    const FB_LINE = fb.length ? `\n\nMike's ratings of past items (more like 👍, avoid like 👎): ${fb.join(' | ')}` : '';
    const DATE_LINE = `Today is ${today}.`;
    const JSON_RULE = ' Respond with ONLY a JSON array (no prose, no code fence) of 2-3 objects: {"t": short title, "s": one-line description/why (for recipes include key ingredients), "link": a URL}. For links: recipes/travel → "https://www.google.com/search?q=" + words joined by + (letters/numbers only).';

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, ...(process.env.OPENAI_BASE_URL ? { baseURL: process.env.OPENAI_BASE_URL } : {}) });
    let items = null;

    if (slot === 'podcast') {
      // Real episodes from RSS — recent by construction, links are the episodes'.
      const all = (await Promise.all(SHOWS.map((s) => recentEpisodes(s)))).flat();
      if (all.length) {
        const pick = await openai.chat.completions.create({
          model: MODEL,
          messages: [
            { role: 'system', content: "You are Rupert, Mike's chief of staff. He likes AI, precision medicine, fitness, longevity, renewables/EVs." },
            { role: 'user', content: `${DATE_LINE} From these REAL recent episodes, pick the 3 best for Mike's ~2-hour commute (diverse mix). Respond with ONLY a JSON array: {"i": index, "why": one line}.${FB_LINE}\n\n${all.map((e, i) => `${i}: [${e.show}] ${e.title} (${e.date}) — ${e.desc}`).join('\n')}` },
          ],
        });
        try {
          const arr = JSON.parse((pick.choices?.[0]?.message?.content || '').replace(/```json|```/g, '').trim());
          items = (Array.isArray(arr) ? arr : []).slice(0, 3)
            .filter((x) => all[x.i])
            .map((x) => ({ t: `${all[x.i].show} — ${all[x.i].title}`, s: `${all[x.i].date} · ${x.why || ''}`, link: all[x.i].link, feedback: null }));
        } catch { /* fall through to generic path */ }
      }
    }

    if (!items || !items.length) {
      const PROMPTS = {
        podcast: 'Recommend 2-3 podcast episodes — mix AI and health/longevity — for a ~2-hour commute. Use Spotify search links: "https://open.spotify.com/search/" + words joined by %20 (letters/numbers/spaces only).',
        recipe: 'Suggest 2 dinner recipes Mike could cook tonight — healthy, high-protein, not fussy, seasonal for the current month.',
        mealprep: 'A simple Sunday meal-prep plan: 2-3 batch recipes (high-protein, healthy). Put the combined grocery list in the last item\'s "s".',
        ainews: 'Summarize the 3 most significant recent developments in healthcare AI / precision medicine that a physician-informaticist should know (clinical AI, FDA, health systems, LLMs in medicine). One line each + why it matters. Google search link per item.',
        travel: 'Suggest 2-3 inspiring travel ideas (hiking, biking, warm places; January birthday trip and a "month in Spain" goal pending) — seasonal for the current month.'
          + (Array.isArray(d.emailSignals) && d.emailSignals.length ? ' Inbox signals: ' + JSON.stringify(d.emailSignals).slice(0, 600) : ''),
      };
      const c = await openai.chat.completions.create({
        model: MODEL,
        messages: [
          { role: 'system', content: "You are Rupert, Mike's chief of staff. Concise, specific, warm." },
          { role: 'user', content: DATE_LINE + ' ' + PROMPTS[slot] + JSON_RULE + FB_LINE },
        ],
      });
      try {
        const arr = JSON.parse((c.choices?.[0]?.message?.content || '').replace(/```json|```/g, '').trim());
        items = (Array.isArray(arr) ? arr : []).slice(0, 4).filter((x) => x && x.t)
          .map((x) => ({ t: String(x.t).slice(0, 90), s: String(x.s || '').slice(0, 200), link: x.link || null, feedback: null }));
      } catch { items = null; }
    }
    if (!items || !items.length) return res.status(500).json({ error: 'no items generated' });

    const text = renderItems(items);
    const at = new Date().toISOString();
    await ref.set({
      contentFeed: { slot, title: TITLES[slot], text, at },
      alerts: [
        { id: 'a' + Date.now(), type: slot, title: TITLES[slot], text, items, at, feedback: null },
        ...(d.alerts || []),
      ].slice(0, 120),
    }, { merge: true });

    const tokens = Array.from(new Set([...(d.fcmTokens || []), d.fcmToken].filter(Boolean)));
    let pushed = 0;
    for (const token of tokens) {
      try {
        await getMessaging().send({
          token,
          notification: { title: TITLES[slot], body: items.map((it) => it.t).join(' · ').slice(0, 180) },
          data: { url: LINK },
          webpush: { notification: { icon: 'https://mikeslife.app/icon-192.png', badge: 'https://mikeslife.app/icon-192.png' }, fcmOptions: { link: LINK } },
        });
        pushed++;
      } catch (e) { console.error('push failed:', e.message); }
    }
    return res.status(200).json({ ok: true, slot, pushed, items: items.length });
  } catch (e) {
    console.error('cron-content error', e);
    return res.status(500).json({ error: e.message || 'error' });
  }
}
