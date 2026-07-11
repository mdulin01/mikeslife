// On-demand read endpoint for Mike's coding.html boards (mikedulinmd-cf65b
// Firestore) so Claude/Cowork sessions can pull Capture + Roadmap + AI context
// + the secrets INDEX (names/rotation only — never values) at session start,
// without a mounted service-account key. coding.html stays the single place
// Mike edits; this is a read-only mirror.
//
// Auth: ?token=<CODING_BOARD_TOKEN> (query param — Cowork's fetch can't set
// headers; the boards contain no secret values, worst case is bug-list read).
// Env: CODING_BOARD_TOKEN + FIREBASE_SA_MIKEDULINMD (reader SA JSON for
// mikedulinmd-cf65b). Output: markdown (default) or ?format=json.
//
// 2026-07-11: synced to the redesigned coding.html schema — roadmap status is
// 'doing' (was misread as 'inprogress', which hid every in-progress item),
// capture items use type/project (was kind/app → rendered "[? · ?]"),
// markdown now shows P1–P3 priority + due dates, and JSON returns the
// structured handoff object.
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const ts = (v) => { try { return v && v.toDate ? v.toDate().toISOString().slice(0, 10) : (v || ''); } catch { return ''; } };

// Mirrors coding.html's priorityOf() so both views label legacy items the same.
const priorityOf = (x) => {
  if (x.priority) return x.priority;
  const t = (x.title || '').toLowerCase();
  if (/overdue|firebase deploy|q3 tax/.test(t)) return 'p1';
  if (x.status === 'idea') return 'p3';
  return 'p2';
};
const PRI_RANK = { p1: 0, p2: 1, p3: 2 };
const rmLine = (r) => {
  const pri = priorityOf(r).toUpperCase();
  const due = r.dueDate ? ` · due ${r.dueDate}` : '';
  return `- [${pri}] [${r.app || '?'}] ${r.title}${due}${r.note ? ` — ${r.note}` : ''}`;
};

export default async function handler(req, res) {
  const token = (req.query.token || '').trim();
  if (!process.env.CODING_BOARD_TOKEN || token !== process.env.CODING_BOARD_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    if (!process.env.FIREBASE_SA_MIKEDULINMD) return res.status(503).json({ error: 'FIREBASE_SA_MIKEDULINMD not set' });
    let app = getApps().find((a) => a.name === 'mdmd');
    if (!app) app = initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SA_MIKEDULINMD)) }, 'mdmd');
    const db = getFirestore(app);

    const [itemsSnap, roadmapSnap, ctxSnap, secretsSnap] = await Promise.all([
      db.collection('coding_items').orderBy('createdAt', 'desc').limit(100).get(),
      db.collection('coding_roadmap').get(),
      db.doc('coding_meta/aiContext').get(),
      db.collection('coding_secrets').orderBy('name', 'asc').get(),
    ]);
    const items = itemsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const roadmap = roadmapSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const secrets = secretsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const ctx = ctxSnap.exists ? ctxSnap.data() : {};
    const aiContext = ctx.summary || '';

    if (req.query.format === 'json') {
      return res.status(200).json({ items, roadmap, aiContext, handoff: ctx.handoff || null, secrets, fetchedAt: new Date().toISOString() });
    }

    const weekAgo = Date.now() - 7 * 86400 * 1000;
    const open = items.filter((i) => i.status !== 'done');
    const recentDone = items.filter((i) => i.status === 'done' && i.doneAt && i.doneAt.toDate && i.doneAt.toDate().getTime() > weekAgo);
    const cols = [['doing', 'In progress'], ['next', 'Next up'], ['idea', 'Ideas'], ['done', 'Done']];
    const md = [];
    md.push(`# Coding boards (coding.html) — fetched ${new Date().toISOString().slice(0, 16)}Z`);
    md.push(`\n## 🐛 Capture — ${open.length} open`);
    for (const i of open) md.push(`- [${i.type || i.kind || 'item'} · ${i.project || i.app || '?'} · ${ts(i.createdAt)}] ${i.title}${i.notes ? ` — ${i.notes}` : ''}`);
    if (recentDone.length) { md.push(`\n### Done this week`); for (const i of recentDone) md.push(`- ✓ [${i.project || i.app || '?'}] ${i.title}`); }
    md.push(`\n## 🧭 Roadmap`);
    for (const [k, label] of cols) {
      const list = roadmap.filter((r) => (r.status || 'idea') === k)
        .sort((a, b) => (PRI_RANK[priorityOf(a)] ?? 1) - (PRI_RANK[priorityOf(b)] ?? 1) || (a.dueDate || '9999').localeCompare(b.dueDate || '9999'));
      if (k === 'done') { md.push(`- Done: ${list.length} items (fetch ?format=json for the list)`); continue; }
      md.push(`\n### ${label} (${list.length})`);
      for (const r of list) md.push(rmLine(r));
    }
    if (aiContext) md.push(`\n## 🤖 AI context (Mike's saved handoff + working-style summary)\n${aiContext}`);
    if (secrets.length) {
      md.push(`\n## 🔐 Secrets index (names/rotation only — values live in Vercel/password manager)`);
      for (const s of secrets) md.push(`- ${s.name} @ ${s.location || '?'} — last rotated ${s.lastRotated || 'never'}, every ${s.every || '?'}d${s.notes ? ` — ${s.notes}` : ''}`);
    }
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    return res.status(200).send(md.join('\n'));
  } catch (e) {
    console.error('coding-board error', e);
    return res.status(500).json({ error: e.message || 'error' });
  }
}
