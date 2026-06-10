// Step 2: Google redirects here with a code; exchange it, verify it's Mike's
// account, and store the refresh token in Firestore (secrets/google — no client
// rules expose it; only the Admin SDK reads it).
// Required env: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, FIREBASE_SERVICE_ACCOUNT

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const REDIRECT = 'https://mikeslife.app/api/google-callback';
const OWNER_EMAIL = process.env.OWNER_EMAIL || 'mdulin@gmail.com';

export default async function handler(req, res) {
  try {
    const { code, error } = req.query || {};
    if (error) return res.status(400).send('Google said: ' + error);
    if (!code) return res.status(400).send('Missing code.');

    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: REDIRECT,
        grant_type: 'authorization_code',
      }),
    });
    const tok = await r.json();
    if (!r.ok) return res.status(400).send('Token exchange failed: ' + JSON.stringify(tok));

    // Verify the consenting account is Mike (id_token payload; audience = our client).
    let email = '';
    try {
      const payload = JSON.parse(Buffer.from(tok.id_token.split('.')[1], 'base64url').toString());
      if (payload.aud !== process.env.GOOGLE_CLIENT_ID) return res.status(403).send('Wrong audience.');
      email = payload.email || '';
    } catch { return res.status(400).send('Could not read id_token.'); }
    if (email.toLowerCase() !== OWNER_EMAIL.toLowerCase()) {
      return res.status(403).send(`This connector is private — ${email} is not the owner.`);
    }
    if (!tok.refresh_token) return res.status(400).send('No refresh token returned — visit /api/google-auth again (it forces prompt=consent).');

    if (!getApps().length) initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
    await getFirestore().doc('secrets/google').set({
      refreshToken: tok.refresh_token, email, savedAt: new Date().toISOString(),
    });

    res.setHeader('Content-Type', 'text/html');
    return res.status(200).send('<body style="font-family:-apple-system,sans-serif;background:#0b1220;color:#e8edf5;display:grid;place-items:center;height:90vh"><div style="text-align:center"><div style="font-size:48px">🦚</div><h2>Google connected ✓</h2><p>Rupert can now read your calendar + email lanes.<br>You can close this tab.</p></div></body>');
  } catch (e) {
    console.error('google-callback error', e);
    return res.status(500).send(e.message || 'error');
  }
}
