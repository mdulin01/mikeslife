// Manual refresh for the mikesupdates app (pull-to-refresh + 🦚 button).
// POST with a Firebase ID token from the *mikesupdates* project (Bearer).
//  - Mike (mdulin@) → regenerates feed + both job boards (scope 'all')
//  - Adam (adamjosephbritten@) → regenerates only his board (scope 'adam')
// Rate-limited to one manual run per 5 minutes per doc.
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { runUpdates, updatesAuthApp } from './_updates-core.js';

const OWNER_EMAIL = 'mdulin@gmail.com';
const ADAM_EMAIL = 'adamjosephbritten@gmail.com';
const ORIGINS = [
  'https://mikesupdates.app', 'https://www.mikesupdates.app',
  'https://mikesupdates.vercel.app', 'http://localhost:5173',
];
const MIN_GAP_MS = 5 * 60 * 1000;

export default async function handler(req, res) {
  const origin = req.headers.origin || '';
  if (ORIGINS.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    if (!process.env.FIREBASE_SA_UPDATES) return res.status(503).json({ error: 'FIREBASE_SA_UPDATES not set' });
    const idToken = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!idToken) return res.status(401).json({ error: 'missing token' });

    const upApp = updatesAuthApp();
    let decoded;
    try { decoded = await getAuth(upApp).verifyIdToken(idToken); }
    catch { return res.status(401).json({ error: 'invalid token' }); }
    const email = (decoded.email || '').toLowerCase();
    if (email !== OWNER_EMAIL && email !== ADAM_EMAIL) return res.status(403).json({ error: 'not allowed' });

    const scope = email === ADAM_EMAIL ? 'adam' : 'all';
    const gateDoc = scope === 'adam' ? 'updates/adam' : 'updates/data';
    const db = getFirestore(upApp);

    // rate limit
    const cur = (await db.doc(gateDoc).get()).data() || {};
    const last = cur.manualRefreshAt ? new Date(cur.manualRefreshAt).getTime() : 0;
    const wait = last + MIN_GAP_MS - Date.now();
    if (wait > 0) return res.status(429).json({ error: `Rupert just refreshed — try again in ${Math.ceil(wait / 60000)} min.` });
    await db.doc(gateDoc).set({ manualRefreshAt: new Date().toISOString() }, { merge: true });

    const out = await runUpdates({ scope });
    return res.status(200).json({ ok: true, scope, ...out });
  } catch (e) {
    console.error('refresh-updates', e);
    return res.status(500).json({ error: e.message });
  }
}
