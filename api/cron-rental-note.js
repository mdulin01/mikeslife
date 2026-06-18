// Vercel Cron: the rainbow-rentals Rupert banner — CLOUD replacement for the mini's
// sync-rental-note.mjs. rainbow-rentals keeps each section as its own doc in the
// rentalData collection (rentalData/properties.properties[], rentalData/sharedHub.tasks[]).
// Surfaces open/overdue tasks + property count, writes rupert/note for the banner.
// env: CRON_SECRET, FIREBASE_SA_RAINBOW.

import { initializeApp, cert, getApps, getApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

function appFor(name, saJson) {
  if (!getApps().find((a) => a.name === name)) initializeApp({ credential: cert(JSON.parse(saJson)) }, name);
  return getFirestore(getApp(name));
}
const arr = (x) => (Array.isArray(x) ? x : []);
const ymd = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

export default async function handler(req, res) {
  if (process.env.CRON_SECRET && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    if (!process.env.FIREBASE_SA_RAINBOW) return res.status(200).json({ ok: true, skipped: 'FIREBASE_SA_RAINBOW not set' });
    const db = appFor('rainbow', process.env.FIREBASE_SA_RAINBOW);

    const getDoc = async (id) => { const s = await db.doc(`rentalData/${id}`).get().catch(() => null); return s && s.exists ? s.data() : {}; };
    const [propsDoc, hubDoc] = await Promise.all([getDoc('properties'), getDoc('sharedHub')]);

    const props = arr(propsDoc.properties);
    const openTasks = arr(hubDoc.tasks).filter((t) => !(t.done || t.completed || t.completedAt || t.status === 'done'));
    const today = ymd(new Date());
    const overdue = openTasks.filter((t) => t.dueDate && t.dueDate < today);

    const signals = [];
    if (overdue.length) signals.push({ label: `${overdue.length} rental task${overdue.length > 1 ? 's' : ''} overdue`, href: '/' });

    const priorities = [];
    if (props.length) priorities.push(`${props.length} propert${props.length > 1 ? 'ies' : 'y'} tracked`);
    if (openTasks.length) priorities.push(`${openTasks.length} open task${openTasks.length > 1 ? 's' : ''}`);
    priorities.push('Keep rents reconciled for Schedule E');

    const text = openTasks.length
      ? `${openTasks.length} open task${openTasks.length > 1 ? 's' : ''} across the portfolio${overdue.length ? ` — ${overdue.length} overdue` : ''}.`
      : 'Portfolio looks clean — no open tasks. 🌈';

    const note = { text, signals, priorities: priorities.slice(0, 4), updatedAt: new Date().toISOString(), app: 'rainbow-rentals' };
    await db.doc('rupert/note').set(note, { merge: false });
    return res.status(200).json({ ok: true, text, open: openTasks.length, overdue: overdue.length });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
