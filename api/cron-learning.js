// Vercel Cron (weekly, Sun 12:00 UTC): refresh the Purpose → Learning conference
// list so past events roll off and next occurrences roll on. Writes
// lifeos/{uid}.learning = { conferences[], refreshedAt }; the app prefers this
// over the static seed in src/learning.jsx and ALSO hides past dates client-side,
// so a failed run degrades gracefully.
// Required env: CRON_SECRET, FIREBASE_SERVICE_ACCOUNT, OPENAI_API_KEY (or ANTHROPIC_API_KEY)
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { llmChat, pickProvider } from './_llm.js';

const OWNER_UID = process.env.OWNER_UID || 'F8QJ8dCk0CV5yX7yHu7AHPd6QS32';
const easternYMD = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

// The anchor set — real recurring conferences matched to Mike's interests.
// The model's job is ONLY to roll these to their next occurrence, not invent events.
const BASE = [
  { topic: 'AI', name: 'CES', place: 'Las Vegas', why: 'AV, EV, and AI all under one roof.', url: 'https://www.ces.tech' },
  { topic: 'AI in health', name: 'ViVE', place: 'varies', why: 'Digital-health + the business of AI in care.', url: 'https://www.viveevent.com' },
  { topic: 'AI in health', name: 'HIMSS Global Health Conference', place: 'varies', why: 'The big one for health IT; AI Forum on day 1.', url: 'https://www.himss.org' },
  { topic: 'EVs', name: 'EV Tech Expo South', place: 'Charlotte, NC', why: 'In your backyard (~1.5h from Greensboro).', url: 'https://www.evtechexposouth.com' },
  { topic: 'Precision medicine', name: 'Precision Med Tri-Con', place: 'San Francisco', why: 'Diagnostics + AI + precision medicine.', url: 'https://www.triconference.com' },
  { topic: 'AI in health', name: 'AI in Healthcare Forum (HIMSS)', place: 'varies', why: 'Two days, purely AI in care.', url: 'https://www.himss.org/events-overview/ai-in-healthcare-forum-boston/' },
  { topic: 'LGBTQ+', name: 'National LGBTQ Health Conference', place: 'varies', why: 'Research + practice in LGBTQ+ health.', url: 'https://lgbtqhealthconference.org' },
  { topic: 'LGBTQ+', name: 'GLMA Annual Conference', place: 'varies', why: 'LGBTQ+ health professionals, advancing equity.', url: 'https://www.glma.org' },
  { topic: 'Renewable energy', name: 'RE+', place: 'varies', why: "North America's largest clean-energy event.", url: 'https://www.re-plus.com' },
  { topic: 'AI in health', name: 'HLTH', place: 'Las Vegas', why: 'The big tent for health innovation.', url: 'https://www.hlth.com' },
  { topic: 'AI in health', name: 'NVIDIA GTC (healthcare track)', place: 'San Jose', why: 'Where the AI infrastructure of medicine shows up first.', url: 'https://www.nvidia.com/gtc/' },
];

export default async function handler(req, res) {
  if (process.env.CRON_SECRET && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    if (!process.env.FIREBASE_SERVICE_ACCOUNT) return res.status(503).json({ error: 'no FIREBASE_SERVICE_ACCOUNT' });
    if (!getApps().length) initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
    const ref = getFirestore().doc(`lifeos/${OWNER_UID}`);
    const d = (await ref.get()).data() || {};
    const today = easternYMD();

    const system = 'You maintain a small conference calendar. You only work from the anchor list given — '
      + 'you may NOT invent conferences. Reply with a STRICT JSON array, no markdown fences, no commentary.';
    const user = `Today is ${today}.
Anchor conferences (recurring annual events): ${JSON.stringify(BASE)}

For each anchor, output its NEXT occurrence strictly AFTER today (roll to next year if this year's edition has passed).
Rules:
- Keep topic/name/why/url exactly as given; update place only if the event's location rotates and you are confident of the next city, otherwise keep it or use "see site".
- date: "Mon d–d, YYYY" if you are confident of exact dates; otherwise "Mon YYYY (check site)" or "Season YYYY (check site)". NEVER fabricate exact dates you are unsure of.
- Output fields per item: topic, name, date, place, why, url. Sort ascending by date. Output ONLY the JSON array.`;

    const text = await llmChat({ provider: pickProvider(d.settings), system, messages: [{ role: 'user', content: user }], maxTokens: 1800 });
    let conferences;
    try {
      conferences = JSON.parse(text.replace(/^```(json)?/m, '').replace(/```\s*$/m, '').trim());
    } catch { return res.status(200).json({ ok: false, error: 'model returned non-JSON', sample: text.slice(0, 200) }); }
    conferences = (Array.isArray(conferences) ? conferences : [])
      .filter((c) => c && c.name && c.url && c.date)
      .slice(0, 14);
    if (conferences.length < 5) return res.status(200).json({ ok: false, error: 'too few valid items', n: conferences.length });

    await ref.set({ learning: { ...(d.learning || {}), conferences, refreshedAt: new Date().toISOString() } }, { merge: true });
    return res.status(200).json({ ok: true, n: conferences.length });
  } catch (e) {
    console.error('cron-learning', e);
    return res.status(500).json({ error: e.message });
  }
}
