// Vercel Cron: Rupert fills the Mike's Updates feed (separate app: mikesupdates).
// Reads context from the mikeslife lifeos doc (email signals etc.) with the default
// admin app, generates a fresh content feed + email highlights, and writes them to
// the mikesupdates project's `updates/data` doc via a SECOND admin app.
//
// Required env: CRON_SECRET, OPENAI_API_KEY, FIREBASE_SERVICE_ACCOUNT (mikeslife),
//   FIREBASE_SA_UPDATES (admin service-account JSON for the mikesupdates project).
import OpenAI from 'openai';
import { initializeApp, cert, getApps, getApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const OWNER_UID = process.env.OWNER_UID || 'F8QJ8dCk0CV5yX7yHu7AHPd6QS32';
const MODEL = process.env.OPENAI_MODEL || 'gpt-5.5';
const ET = 'America/New_York';
const easternYMD = (dt = new Date()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: ET, year: 'numeric', month: '2-digit', day: '2-digit' }).format(dt);
const gsearch = (t) => 'https://www.google.com/search?q=' + encodeURIComponent(String(t || '').slice(0, 80));

// ---- real recent podcast episodes (no fabricated links) ----
const SHOWS = ['The Peter Attia Drive', 'Huberman Lab', 'Hard Fork', 'The AI Daily Brief', 'NEJM AI Grand Rounds', 'FoundMyFitness'];
async function fetchText(url, ms = 6000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try { const r = await fetch(url, { signal: ctl.signal, headers: { 'user-agent': 'mikesupdates-rupert/1.0' } }); return r.ok ? await r.text() : null; }
  catch { return null; } finally { clearTimeout(t); }
}
const tag = (xml, name) => { const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i')); return m ? m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '').trim() : ''; };
async function recentEpisodes(show, days = 30) {
  const search = await fetchText(`https://itunes.apple.com/search?term=${encodeURIComponent(show)}&media=podcast&limit=1`);
  if (!search) return [];
  let feedUrl; try { feedUrl = JSON.parse(search).results?.[0]?.feedUrl; } catch { return []; }
  if (!feedUrl) return [];
  const xml = await fetchText(feedUrl); if (!xml) return [];
  const cutoff = Date.now() - days * 86400 * 1000; const out = [];
  for (const item of xml.split(/<item[\s>]/i).slice(1, 6)) {
    const title = tag(item, 'title'); const pub = new Date(tag(item, 'pubDate') || 0).getTime();
    if (!title || !pub || pub < cutoff) continue;
    const link = tag(item, 'link') || (item.match(/enclosure[^>]*url="([^"]+)"/i) || [])[1] || '';
    out.push({ show, title, date: easternYMD(new Date(pub)), link, desc: tag(item, 'description').slice(0, 160) });
  }
  return out;
}

const SYS = `You are Rupert, Mike's chief of staff. Mike is a physician-informaticist / fractional CMO in digital health; interests: clinical AI, precision medicine, longevity/fitness, renewables/EVs, downtown Greensboro (downtownGSO). Curate a tight daily feed — specific, non-generic, no fluff.`;

const FEED_RULE = `Respond with ONLY a JSON array (no prose, no code fence) of 5-6 objects:
{"kind": one of "news"|"jobs"|"social"|"content",
 "source": short ALL-CAPS label (e.g. "HEALTHCARE AI","JOBS","LOCAL","READING"),
 "title": one concise line,
 "summary": one sentence of why it matters to Mike,
 "link": a real well-known URL if you are confident it exists, else null}
Aim for ~2 healthcare-AI/precision-medicine news, 1 fractional-CMO/digital-health job angle, 1 Greensboro/local, 1-2 worthwhile reads. Only include a link you're confident is real; otherwise null (the app adds a search link).`;

export default async function handler(req, res) {
  if (process.env.CRON_SECRET && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    if (!process.env.OPENAI_API_KEY) return res.status(503).json({ error: 'no OPENAI_API_KEY' });
    if (!process.env.FIREBASE_SA_UPDATES) return res.status(503).json({ error: 'no FIREBASE_SA_UPDATES (add the mikesupdates admin key to mikeslife Vercel env)' });

    // default app = mikeslife (read context); named app = mikesupdates (write).
    if (!getApps().length && process.env.FIREBASE_SERVICE_ACCOUNT) initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
    let upApp; try { upApp = getApp('updates'); } catch { upApp = initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SA_UPDATES)) }, 'updates'); }
    const upDb = getFirestore(upApp);

    // context from lifeos (best-effort)
    let d = {};
    try { if (getApps().some((a) => a.name === '[DEFAULT]')) d = (await getFirestore().doc(`lifeos/${OWNER_UID}`).get()).data() || {}; } catch { /* no mikeslife creds — fine */ }

    const today = easternYMD();
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, ...(process.env.OPENAI_BASE_URL ? { baseURL: process.env.OPENAI_BASE_URL } : {}) });

    // 1) curated feed
    let feed = [];
    try {
      const c = await openai.chat.completions.create({
        model: MODEL, max_completion_tokens: 1600,
        messages: [{ role: 'system', content: SYS }, { role: 'user', content: `Today is ${today}. ${FEED_RULE}` }],
      });
      const arr = JSON.parse((c.choices?.[0]?.message?.content || '').replace(/```json|```/g, '').trim());
      feed = (Array.isArray(arr) ? arr : []).filter((x) => x && x.title).slice(0, 6).map((x, i) => ({
        id: 'f' + Date.now() + '_' + i,
        kind: ['news', 'jobs', 'social', 'content'].includes(x.kind) ? x.kind : 'content',
        source: String(x.source || 'RUPERT').slice(0, 28),
        title: String(x.title).slice(0, 140),
        summary: String(x.summary || '').slice(0, 220),
        link: x.link && /^https?:\/\//.test(x.link) ? x.link : gsearch(x.title),
        at: new Date().toISOString(), saved: false, feedback: null,
      }));
    } catch (e) { console.warn('feed gen failed', e.message); }

    // 2) two real podcast episodes
    try {
      const eps = (await Promise.all(SHOWS.slice(0, 4).map((s) => recentEpisodes(s)))).flat().slice(0, 2);
      for (const [i, e] of eps.entries()) feed.push({
        id: 'p' + Date.now() + '_' + i, kind: 'podcast', source: e.show.toUpperCase().slice(0, 28),
        title: e.title.slice(0, 140), summary: e.desc, link: e.link || gsearch(e.show + ' ' + e.title),
        at: new Date().toISOString(), saved: false, feedback: null,
      });
    } catch { /* podcasts best-effort */ }

    // 3) email highlights from Rupert-synced inbox signals
    let emailHighlights = [];
    const sig = Array.isArray(d.emailSignals) ? d.emailSignals.slice(0, 12) : [];
    if (sig.length) {
      try {
        const c = await openai.chat.completions.create({
          model: MODEL, max_completion_tokens: 900,
          messages: [{ role: 'system', content: SYS }, { role: 'user', content: `Today is ${today}. From these inbox signals, pick the 3-5 worth Mike's attention. Respond ONLY a JSON array: {"from","subject","snippet": short paraphrase,"why": one line why it matters}. Signals: ${JSON.stringify(sig).slice(0, 1500)}` }],
        });
        const arr = JSON.parse((c.choices?.[0]?.message?.content || '').replace(/```json|```/g, '').trim());
        emailHighlights = (Array.isArray(arr) ? arr : []).slice(0, 6).map((x, i) => ({
          id: 'e' + Date.now() + '_' + i, from: String(x.from || '').slice(0, 80), subject: String(x.subject || '').slice(0, 140),
          snippet: String(x.snippet || '').slice(0, 200), link: 'https://mail.google.com/mail/u/0/#search/' + encodeURIComponent(x.subject || ''),
          at: new Date().toISOString(), status: 'review', why: String(x.why || '').slice(0, 160),
        }));
      } catch (e) { console.warn('email gen failed', e.message); }
    }

    if (!feed.length && !emailHighlights.length) return res.status(200).json({ ok: false, skipped: 'nothing generated' });

    const patch = { refreshedAt: new Date().toISOString() };
    if (feed.length) patch.feed = feed;
    if (emailHighlights.length) patch.emailHighlights = emailHighlights;
    await upDb.doc('updates/data').set(patch, { merge: true });
    return res.status(200).json({ ok: true, feed: feed.length, emails: emailHighlights.length });
  } catch (e) {
    console.error('cron-updates', e);
    return res.status(500).json({ error: e.message });
  }
}
