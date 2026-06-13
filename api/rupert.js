// Rupert's conversational brain — Vercel serverless function.
// Verifies the caller's Firebase ID token (must be the owner), pulls their
// LifeOS context from Firestore, and asks the model for a reply.
//
// Required Vercel env:
//   OPENAI_API_KEY            — the key (Rupert's existing gpt-5.5 key works)
//   FIREBASE_SERVICE_ACCOUNT  — the mikeslife-963c6 Admin SDK JSON (as a string)
// Optional:
//   OPENAI_MODEL    (default 'gpt-5.5')
//   OPENAI_BASE_URL (set if Rupert routes gpt-5.5 through a gateway)
//   OWNER_UID       (default below)

import OpenAI from 'openai';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

const OWNER_UID = process.env.OWNER_UID || 'F8QJ8dCk0CV5yX7yHu7AHPd6QS32';
const MODEL = process.env.OPENAI_MODEL || 'gpt-5.5';

const DEFAULT_COMMITMENTS = 'In Charlotte working at Rea Farms every Wednesday and Thursday — NOT available for evening plans or dinners on Wed/Thu nights.';

const SYSTEM = `You are Rupert, Mike's AI chief of staff inside the "Mike's Life" app.
Be warm, concise, and genuinely useful — talk like a sharp, trusted aide, not a chatbot. Prefer short, skimmable answers; use lists only when they help (e.g. a grocery list or a workout).

Mike organizes life around five pillars: Health, Relationships, Finances, Purpose (work + learning), and Fun & Travel. Tie suggestions back to them when natural.

You can: help him check in (energy/mood/capacity), design workouts, build grocery lists + recipe ideas, break goals into steps, and think through plans. If you lack a detail you need (e.g. what he trained recently), ask one quick question rather than guessing.

Hard rules:
- You cannot send messages, move money, book, or change anything in the world — you only advise and draft. Say so if asked to act.
- Don't advise on medications or medical decisions — that's out of scope. If asked, briefly point him to his own provider and move on.
- For financial/tax specifics, end with: "— but confirm with a fee-only fiduciary advisor, and your CPA for taxes."
- Never invent facts about his data. If the context doesn't say, say you don't have it.
- ALWAYS respect Mike's recurring commitments / availability (shown in context). Never propose plans, dinners, workouts, or events that conflict with them.`;

function ensureAdmin() {
  if (!getApps().length) {
    const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    initializeApp({ credential: cert(sa) });
  }
}

function buildContext(d) {
  if (!d) return `Recurring commitments (NEVER schedule over these): ${DEFAULT_COMMITMENTS}`;
  const lines = [];
  lines.push('Recurring commitments / availability (NEVER schedule over these): ' + ((d.commitments && d.commitments.trim()) || DEFAULT_COMMITMENTS));
  if (d.checkin) {
    const c = d.checkin;
    lines.push(`Latest check-in (${c.date || '?'}): energy ${c.energy}/10, mood ${c.mood}/10, capacity ${c.capacity}/10.` + (c.journal ? ` Journal: "${c.journal}"` : ''));
  }
  const active = (d.plans || []).filter((p) => p.status === 'active');
  if (active.length) {
    lines.push('Active plans:');
    active.forEach((p) => {
      const tasks = (p.stages || []).flatMap((s) => s.tasks);
      const open = tasks.filter((t) => !t.done).map((t) => t.text);
      lines.push(`- ${p.title} [${p.pk}] — open: ${open.slice(0, 6).join('; ') || 'none'}`);
    });
  }
  const someday = (d.plans || []).filter((p) => p.status === 'someday').map((p) => p.title);
  if (someday.length) lines.push('Someday list: ' + someday.join(', '));
  if (d.odyssey) lines.push('Career Odyssey options: ' + d.odyssey.map((o) => o.title).join(' | '));
  if (d.goodTime && d.goodTime.length) {
    lines.push('Recent energy log: ' + d.goodTime.slice(0, 4).map((g) => `${g.activity} (e${g.energy}/g${g.engagement})`).join(', '));
  }
  // Real slices written by Rupert (on the mini) from the spoke apps.
  if (d.fitnessContext) lines.push('Training (from mikesfitness, curated by Rupert):\n' + d.fitnessContext);
  if (d.financeContext) lines.push('Finances (from mikes-money, curated by Rupert):\n' + d.financeContext);
  if (d.healthContext) lines.push('Health (from mikeshealth):\n' + d.healthContext);
  if (d.location && (d.location.place || d.location.lat)) {
    const ago = d.location.at ? ` (as of ${d.location.at})` : '';
    lines.push(`Current location: ${d.location.place || `${d.location.lat}, ${d.location.lng}`}${ago}. Use it for timely, context-aware suggestions when relevant.`);
  }
  if (Array.isArray(d.memories) && d.memories.length) lines.push('Recent memories: ' + d.memories.slice(0, 5).map((m) => `${m.date || ''} ${m.text}`).join(' | '));
  // Recent alerts you sent him + his 👍/👎 ratings — so you can discuss them and learn his taste.
  if (Array.isArray(d.alerts) && d.alerts.length) {
    lines.push('Recent alerts you sent: ' + d.alerts.slice(0, 6).map((a) => `[${a.type}${a.feedback ? ' ' + (a.feedback === 'up' ? '👍' : '👎') : ''}] ${a.title}`).join(' | '));
    const fb = d.alerts.filter((a) => a.feedback).slice(0, 10);
    if (fb.length) lines.push('His content ratings (more like 👍, less like 👎): ' + fb.map((a) => `${a.feedback === 'up' ? '👍' : '👎'} ${a.title}`).join('; '));
  }
  if (Array.isArray(d.documents) && d.documents.length) lines.push('Documents on file: ' + d.documents.map((x) => x.title).join(', '));
  return lines.join('\n');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try {
    if (!process.env.OPENAI_API_KEY || !process.env.FIREBASE_SERVICE_ACCOUNT) {
      return res.status(503).json({ error: 'not-configured', message: "Rupert's brain isn't wired yet — add OPENAI_API_KEY + FIREBASE_SERVICE_ACCOUNT in Vercel." });
    }
    ensureAdmin();

    const { idToken, message, history = [] } = req.body || {};
    if (!idToken || !message) return res.status(400).json({ error: 'missing idToken or message' });

    const decoded = await getAuth().verifyIdToken(idToken);
    if (decoded.uid !== OWNER_UID) return res.status(403).json({ error: 'not authorized' });

    const snap = await getFirestore().doc(`lifeos/${decoded.uid}`).get();
    const context = buildContext(snap.exists ? snap.data() : null);

    const openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      ...(process.env.OPENAI_BASE_URL ? { baseURL: process.env.OPENAI_BASE_URL } : {}),
    });

    const messages = [
      { role: 'system', content: `${SYSTEM}\n\n=== Mike's current context ===\n${context}` },
      ...history.slice(-8).map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '') })),
      { role: 'user', content: String(message) },
    ];

    const completion = await openai.chat.completions.create({ model: MODEL, messages });
    const reply = completion.choices?.[0]?.message?.content?.trim() || '…';
    return res.status(200).json({ reply });
  } catch (e) {
    console.error('rupert error', e);
    return res.status(500).json({ error: e.message || 'error' });
  }
}
