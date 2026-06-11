// One-shot travel scan: searches Gmail for reservation emails (hotels, AA flights)
// and returns subject/date/snippet so trips can be built in mikestravel.
// CRON_SECRET-protected. Read-only — writes nothing.
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const QUERIES = [
  'boatslip',
  '(palm springs) (hotel OR reservation OR confirmation)',
  'from:aa.com OR from:americanairlines OR ("american airlines" confirmation)',
];

export default async function handler(req, res) {
  if (process.env.CRON_SECRET && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    if (!getApps().length) initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
    const sec = (await getFirestore().doc('secrets/google').get()).data();
    const tr = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ refresh_token: sec.refreshToken, client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, grant_type: 'refresh_token' }),
    });
    const at = (await tr.json()).access_token;
    const out = {};
    for (const q of QUERIES) {
      const list = await (await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages?' + new URLSearchParams({ q: q + ' newer_than:1y', maxResults: '6' }), { headers: { Authorization: `Bearer ${at}` } })).json();
      const rows = [];
      for (const m of (list.messages || [])) {
        const msg = await (await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`, { headers: { Authorization: `Bearer ${at}` } })).json();
        const h = Object.fromEntries((msg.payload?.headers || []).map((x) => [x.name, x.value]));
        rows.push({ from: (h.From || '').slice(0, 60), subject: (h.Subject || '').slice(0, 120), date: h.Date, snippet: (msg.snippet || '').slice(0, 400) });
      }
      out[q] = rows;
    }
    return res.status(200).json(out);
  } catch (e) { return res.status(500).json({ error: e.message }); }
}
