// Location ingest for iOS Shortcuts geofencing (the only way to passively know
// Mike is at the gym/clinic/grocery — the web app can't track in the background).
// An iOS Automation ("When I arrive at Gym") POSTs here; we write lifeos.location
// so Rupert's brain has the context.
//
// Secured by a shared secret (LOCATION_TOKEN) since Shortcuts can't do Firebase auth.
// Required Vercel env: FIREBASE_SERVICE_ACCOUNT, LOCATION_TOKEN
//
// POST body (JSON): { token, place, lat?, lng? }
//   place — e.g. "gym", "grocery", "clinic", "home", "away"

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const OWNER_UID = process.env.OWNER_UID || 'F8QJ8dCk0CV5yX7yHu7AHPd6QS32';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try {
    if (!process.env.FIREBASE_SERVICE_ACCOUNT || !process.env.LOCATION_TOKEN) {
      return res.status(503).json({ error: 'not-configured', message: 'Add FIREBASE_SERVICE_ACCOUNT + LOCATION_TOKEN in Vercel.' });
    }
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const token = body.token || req.headers['x-location-token'];
    if (token !== process.env.LOCATION_TOKEN) return res.status(403).json({ error: 'bad token' });

    const place = String(body.place || '').slice(0, 40) || 'unknown';
    const location = { place, at: new Date().toISOString(), source: 'shortcut' };
    if (body.lat != null && body.lng != null) { location.lat = +(+body.lat).toFixed(5); location.lng = +(+body.lng).toFixed(5); }

    if (!getApps().length) initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
    await getFirestore().doc(`lifeos/${OWNER_UID}`).set({ location }, { merge: true });
    return res.status(200).json({ ok: true, location });
  } catch (e) {
    console.error('location error', e);
    return res.status(500).json({ error: e.message || 'error' });
  }
}
