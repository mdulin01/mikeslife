// Vercel Cron: the evening "way to go" — Rupert notices today's wins and celebrates.
// Runs ~9pm ET. Sources, best first:
//   1. mikesfitness Firestore DIRECTLY (today's exerciseLog/runs) — needs env
//      FIREBASE_SA_FITNESS = the mikesfitness reader service-account JSON.
//      Without it, falls back to lifeos.fitnessContext (one day behind).
//   2. Today-list items marked done.
//   3. financeContext (milestones Rupert noted).
// If there's nothing genuinely worth celebrating, it stays silent (model says SKIP).
// Alert type 'celebrate' deep-links back to mikesfitness. Respects alertPrefs.celebrate.
// Required env: CRON_SECRET, OPENAI_API_KEY, FIREBASE_SERVICE_ACCOUNT · optional FIREBASE_SA_FITNESS

import OpenAI from 'openai';
import { initializeApp, cert, getApps, getApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';

const OWNER_UID = process.env.OWNER_UID || 'F8QJ8dCk0CV5yX7yHu7AHPd6QS32';
const MODEL = process.env.OPENAI_MODEL || 'gpt-5.5';
const LINK = 'https://mikeslife.app/?source=push&focus=content';
const APPS = { fitness: 'https://mikesfitness.app', finance: 'https://www.mikesmoney.app', health: 'https://mikeshealth.app' };

const easternYMD = (dt = new Date()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(dt);

function appFor(name, saJson) {
  if (!getApps().find((a) => a.name === name)) initializeApp({ credential: cert(JSON.parse(saJson)) }, name);
  return getFirestore(getApp(name));
}

// Today's actual training from mikesfitness (shape per rupert/notify/sync-fitness-context.mjs).
async function todaysTraining(today) {
  if (!process.env.FIREBASE_SA_FITNESS) return null;
  try {
    const fitDb = appFor('fitness', process.env.FIREBASE_SA_FITNESS);
    const snap = await fitDb.doc('mikesfitness/mike-health').get();
    if (!snap.exists) return null;
    const h = snap.data();
    const lines = [];
    const log = (h.exerciseLog && typeof h.exerciseLog === 'object') ? h.exerciseLog[today] : null;
    if (Array.isArray(log) && log.length) {
      lines.push('Workouts logged TODAY: ' + log.map((w) => w.exerciseName || w.type || w.name).filter(Boolean).join(', '));
    }
    const runs = Array.isArray(h.runEntries) ? h.runEntries.filter((r) => r.date === today) : [];
    if (runs.length) lines.push('Runs/walks TODAY: ' + runs.map((r) => `${r.distance || r.miles || '?'} mi`).join(', '));
    return lines.length ? lines.join('\n') : null;
  } catch (e) { console.error('fitness read failed:', e.message); return null; }
}

export default async function handler(req, res) {
  if (process.env.CRON_SECRET && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    if (!process.env.OPENAI_API_KEY || !process.env.FIREBASE_SERVICE_ACCOUNT) {
      return res.status(503).json({ error: 'not-configured' });
    }
    const db = getFirestore(getApps().find((a) => a.name === '[DEFAULT]') ? getApp() : initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) }));
    const ref = db.doc(`lifeos/${OWNER_UID}`);
    const d = (await ref.get()).data() || {};
    const today = easternYMD();

    if (d.alertPrefs && d.alertPrefs.celebrate === false) {
      return res.status(200).json({ ok: true, skipped: 'celebrations muted' });
    }
    const dupe = (d.alerts || []).some((a) => a.type === 'celebrate' && a.at && easternYMD(new Date(a.at)) === today);
    if (dupe) return res.status(200).json({ ok: true, skipped: 'already celebrated today' });

    // Gather today's evidence.
    const ev = [];
    const live = await todaysTraining(today);
    if (live) ev.push(live + '\n(source: fitness — live)');
    else if (d.fitnessContext) ev.push('Training (synced nightly, may lag a day):\n' + d.fitnessContext);
    const done = (d.todayItems || []).filter((t) => t.status === 'done').map((t) => t.title);
    if (done.length) ev.push('Today-list items completed: ' + done.join('; '));
    if (d.financeContext) ev.push('Finance notes:\n' + d.financeContext);
    if (!ev.length) return res.status(200).json({ ok: true, skipped: 'no evidence to celebrate' });

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, ...(process.env.OPENAI_BASE_URL ? { baseURL: process.env.OPENAI_BASE_URL } : {}) });
    const c = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: `You are Rupert, Mike's chief of staff. Today is ${today}. If the evidence shows a GENUINE win from TODAY (a workout/walk/run, several items completed, a real money milestone), reply with ONLY JSON: {"text": a warm, specific 1-3 sentence "way to go" (mention the actual thing — e.g. the 3-mile walk), "area": "fitness"|"finance"|"health"|null}. Be real, not saccharine; no generic praise. If there is nothing clearly from today worth celebrating, reply with exactly SKIP.` },
        { role: 'user', content: 'Evidence:\n\n' + ev.join('\n\n') },
      ],
    });
    const raw = (c.choices?.[0]?.message?.content || '').replace(/```json|```/g, '').trim();
    if (/^SKIP/i.test(raw)) return res.status(200).json({ ok: true, skipped: 'nothing to celebrate (model)' });
    let out;
    try { out = JSON.parse(raw); } catch { return res.status(200).json({ ok: true, skipped: 'unparseable, stayed silent' }); }
    if (!out || !out.text) return res.status(200).json({ ok: true, skipped: 'empty' });

    const at = new Date().toISOString();
    const appUrl = APPS[out.area] || null;
    await ref.set({
      alerts: [
        { id: 'a' + Date.now(), type: 'celebrate', title: '🎉 Way to go', text: out.text, at, feedback: null, ...(appUrl ? { appUrl } : {}) },
        ...(d.alerts || []),
      ].slice(0, 120),
    }, { merge: true });

    const tokens = Array.from(new Set([...(d.fcmTokens || []), d.fcmToken].filter(Boolean)));
    let pushed = 0;
    for (const token of tokens) {
      try {
        await getMessaging().send({
          token,
          notification: { title: '🎉 Way to go, Mike', body: out.text.slice(0, 180) },
          data: { url: LINK },
          webpush: { notification: { icon: 'https://mikeslife.app/icon-192.png', badge: 'https://mikeslife.app/icon-192.png' }, fcmOptions: { link: LINK } },
        });
        pushed++;
      } catch (e) { console.error('push failed:', e.message); }
    }
    return res.status(200).json({ ok: true, pushed, live: !!live });
  } catch (e) {
    console.error('cron-celebrate error', e);
    return res.status(500).json({ error: e.message || 'error' });
  }
}
