// Executes the Rupert tasks Mike assigned at morning check-in.
// Cloud-runnable kinds (podcast/recipe/mealprep/travel/ainews) → generated NOW by
// calling our own cron-content with force=1 (results land as alerts).
// Mini-bound kinds (adamjobs, social) → appended to lifeos.rupertQueue for the
// Mac mini's OpenClaw to pick up (delivered via Telegram, as today).
// Auth: Firebase ID token (owner only).
// Required env: FIREBASE_SERVICE_ACCOUNT, CRON_SECRET (to call cron-content internally)

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

const OWNER_UID = process.env.OWNER_UID || 'F8QJ8dCk0CV5yX7yHu7AHPd6QS32';
const CLOUD_KINDS = { podcast: 'podcast', recipe: 'recipe', mealprep: 'mealprep', travel: 'travel', ainews: 'ainews' };
const MINI_KINDS = new Set(['adamjobs', 'social']);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try {
    if (!getApps().length) initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
    const { idToken, tasks = [] } = req.body || {};
    if (!idToken) return res.status(400).json({ error: 'missing idToken' });
    const decoded = await getAuth().verifyIdToken(idToken);
    if (decoded.uid !== OWNER_UID) return res.status(403).json({ error: 'not authorized' });

    const db = getFirestore();
    const ref = db.doc(`lifeos/${OWNER_UID}`);
    const d = (await ref.get()).data() || {};
    const host = `https://${req.headers.host || 'mikeslife.app'}`;
    const results = {};
    const queueAdds = [];

    for (const kind of tasks.slice(0, 8)) {
      if (CLOUD_KINDS[kind]) {
        try {
          const r = await fetch(`${host}/api/cron-content?slot=${CLOUD_KINDS[kind]}&force=1`, {
            headers: process.env.CRON_SECRET ? { Authorization: `Bearer ${process.env.CRON_SECRET}` } : {},
          });
          const j = await r.json();
          results[kind] = j.ok ? 'done' : 'failed';
        } catch (e) { results[kind] = 'failed'; console.error(kind, e.message); }
      } else if (MINI_KINDS.has(kind)) {
        queueAdds.push({ id: 'q' + Date.now() + '_' + kind, kind, requestedAt: new Date().toISOString(), status: 'queued' });
        results[kind] = 'queued';
      }
    }

    // Update dayPlan task statuses + append mini queue.
    const dayPlan = d.dayPlan || {};
    if (Array.isArray(dayPlan.rupertTasks)) {
      dayPlan.rupertTasks = dayPlan.rupertTasks.map((t) => results[t.kind] ? { ...t, status: results[t.kind] } : t);
    }
    await ref.set({
      dayPlan,
      ...(queueAdds.length ? { rupertQueue: [...queueAdds, ...(d.rupertQueue || [])].slice(0, 30) } : {}),
    }, { merge: true });

    return res.status(200).json({ ok: true, results });
  } catch (e) {
    console.error('run-tasks error', e);
    return res.status(500).json({ error: e.message || 'error' });
  }
}
