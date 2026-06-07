// On-demand refresh — what the pull-to-refresh / Refresh button calls.
// Verifies the owner, then has Rupert (gpt-5.5) regenerate fresh material for
// whatever view Mike is looking at, and stamps lifeos.refreshedAt.
//   - Always: a fresh "content feed" for the current time slot (podcasts /
//     recipes / travel …), with real listen/search links.
//   - If a pillar is open (or the Inbox): a couple of fresh idea-proposals for
//     that pillar, honestly labelled "RUPERT · IDEA" (not faked email signals).
//
// NOTE: live email/calendar reading is Phase 2 (the Google pipeline). Until then
// this generates from model knowledge + the curated context Rupert already syncs.
//
// Required Vercel env: OPENAI_API_KEY, FIREBASE_SERVICE_ACCOUNT
// Optional: OPENAI_MODEL (default gpt-5.5), OPENAI_BASE_URL, OWNER_UID

import OpenAI from 'openai';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

const OWNER_UID = process.env.OWNER_UID || 'F8QJ8dCk0CV5yX7yHu7AHPd6QS32';
const MODEL = process.env.OPENAI_MODEL || 'gpt-5.5';

const PILLAR_LABEL = { health: '🫀 Health', rel: '❤️ Relationships', fin: '💰 Finances', purpose: '🎯 Purpose', fun: '🏖️ Fun & Travel' };

const CONTENT_PROMPTS = {
  podcast: 'Recommend 2–3 specific podcast episodes — mix AI and health/longevity — Mike would enjoy on a ~2-hour commute. Each: show + episode title + a one-line why.',
  recipe: 'Suggest 2 dinner recipes Mike could cook tonight — healthy, high-protein, not fussy. Each: name + 4–6 key ingredients + a one-line method.',
  mealprep: 'Give Mike a simple Sunday meal-prep plan: 2–3 batch recipes (high-protein, healthy) plus a combined grocery list.',
  travel: 'Suggest 2–3 inspiring travel ideas for Mike (loves hiking, biking, warm places; has a January birthday trip and a "month in Spain" goal). Keep it short.',
};
const CONTENT_TITLES = { podcast: '🎧 Podcasts for you', recipe: "🍳 Dinner ideas", mealprep: '🥗 Sunday meal-prep', travel: '✈️ Travel ideas' };
const LINK_RULE = ' For each item, add a clickable link on its own line: for podcasts use a Spotify search URL "Listen: https://open.spotify.com/search/" + the show and episode words joined by %20; for recipes/travel a relevant Google search URL "https://www.google.com/search?q=" + the words joined by +. Keep it phone-friendly, no preamble.';

// Eastern-time slot (Mike's timezone) — manual refresh always yields something.
function slotNow() {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', hour12: false });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map((p) => [p.type, p.value]));
  const day = parts.weekday; const h = parseInt(parts.hour, 10);
  if (day === 'Sun' && h < 12) return 'mealprep';
  if (day === 'Sat' || day === 'Sun') return 'travel';
  if ((day === 'Mon' || day === 'Tue') && h >= 15) return 'recipe';
  return 'podcast';
}

function ctx(d) {
  const lines = [];
  if (d.checkin) lines.push(`Check-in: energy ${d.checkin.energy}/10, mood ${d.checkin.mood}/10, capacity ${d.checkin.capacity}/10.`);
  if (d.fitnessContext) lines.push('Training:\n' + d.fitnessContext);
  if (d.financeContext) lines.push('Finances:\n' + d.financeContext);
  if (d.healthContext) lines.push('Health:\n' + d.healthContext);
  const someday = (d.plans || []).filter((p) => p.status === 'someday').map((p) => p.title);
  if (someday.length) lines.push('Someday list: ' + someday.join(', '));
  return lines.join('\n') || 'No saved context yet.';
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try {
    if (!process.env.OPENAI_API_KEY || !process.env.FIREBASE_SERVICE_ACCOUNT) {
      return res.status(503).json({ error: 'not-configured', message: "Refresh needs OPENAI_API_KEY + FIREBASE_SERVICE_ACCOUNT in Vercel." });
    }
    if (!getApps().length) initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });

    const { idToken, view = 'home', pk = null } = req.body || {};
    if (!idToken) return res.status(400).json({ error: 'missing idToken' });
    const decoded = await getAuth().verifyIdToken(idToken);
    if (decoded.uid !== OWNER_UID) return res.status(403).json({ error: 'not authorized' });

    const ref = getFirestore().doc(`lifeos/${decoded.uid}`);
    const snap = await ref.get();
    const d = snap.exists ? snap.data() : {};
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, ...(process.env.OPENAI_BASE_URL ? { baseURL: process.env.OPENAI_BASE_URL } : {}) });

    const refreshedAt = new Date().toISOString();
    const patch = { refreshedAt };

    // 1) Fresh content feed for the current slot.
    const slot = slotNow();
    const cc = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: "You are Rupert, Mike's chief of staff. Concise, specific, warm. No preamble." },
        { role: 'user', content: CONTENT_PROMPTS[slot] + LINK_RULE + '\n\nMike context:\n' + ctx(d) },
      ],
    });
    patch.contentFeed = { slot, title: CONTENT_TITLES[slot], text: (cc.choices?.[0]?.message?.content || '').trim(), at: refreshedAt };

    // 2) If a pillar is open or we're in the Inbox, add a couple of fresh ideas.
    let added = 0;
    if (view === 'pillar' || view === 'inbox') {
      const target = pk && PILLAR_LABEL[pk] ? pk : null;
      const scope = target ? `the "${PILLAR_LABEL[target]}" pillar` : 'whichever pillars matter most right now';
      const ip = await openai.chat.completions.create({
        model: MODEL,
        messages: [
          { role: 'system', content: 'You are Rupert. Return ONLY a JSON array (no prose, no code fence). 1–2 objects. Each: {"pk": one of health|rel|fin|purpose|fun, "title": short actionable idea, "why": one sentence, "act": one concrete next step}. Ideas must be genuinely useful and grounded in the context; never invent facts about his data.' },
          { role: 'user', content: `Propose 1–2 fresh ideas for ${scope}.\n\nMike context:\n${ctx(d)}` },
        ],
      });
      try {
        const raw = (ip.choices?.[0]?.message?.content || '').replace(/```json|```/g, '').trim();
        const arr = JSON.parse(raw);
        const ideas = (Array.isArray(arr) ? arr : []).slice(0, 2)
          .filter((x) => x && x.title && PILLAR_LABEL[x.pk])
          .map((x, i) => ({ id: 'r' + Date.now() + '_' + i, pk: x.pk, kind: 'idea', src: 'RUPERT · IDEA', pillar: PILLAR_LABEL[x.pk], title: String(x.title), why: String(x.why || ''), act: String(x.act || '') }));
        if (ideas.length) { patch.proposals = [...ideas, ...(d.proposals || [])]; added = ideas.length; }
      } catch { /* model didn't return clean JSON — skip ideas, content still refreshed */ }
    }

    await ref.set(patch, { merge: true });
    return res.status(200).json({ ok: true, refreshedAt, slot, addedProposals: added });
  } catch (e) {
    console.error('refresh error', e);
    return res.status(500).json({ error: e.message || 'error' });
  }
}
