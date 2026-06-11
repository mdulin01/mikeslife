// Travel scan v2: ?q=<gmail query>&n=2 → returns decoded BODY text of matches
// (HTML-stripped, truncated) so reservations can be parsed. CRON_SECRET-protected, read-only.
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const strip = (html) => html
  .replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<[^>]+>/g, ' ').replace(/&zwnj;|&#8204;|&nbsp;|&#847;|&#8199;|&#65279;|‌|͏|‌|\u200c|\u200b|\ufeff/g, ' ')
  .replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
  .replace(/\s+/g, ' ').trim();

function bodyText(payload) {
  if (!payload) return '';
  if (payload.body?.data) {
    const txt = Buffer.from(payload.body.data, 'base64url').toString('utf8');
    return payload.mimeType === 'text/html' ? strip(txt) : txt;
  }
  for (const p of (payload.parts || [])) {
    if (p.mimeType === 'text/plain' && p.body?.data) return Buffer.from(p.body.data, 'base64url').toString('utf8');
  }
  for (const p of (payload.parts || [])) {
    const t = bodyText(p);
    if (t) return t;
  }
  return '';
}

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
    const q = req.query.q || 'from:theboatslip.com';
    const n = Math.min(Number(req.query.n || 2), 4);
    const list = await (await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages?' + new URLSearchParams({ q, maxResults: String(n) }), { headers: { Authorization: `Bearer ${at}` } })).json();
    const rows = [];
    for (const m of (list.messages || [])) {
      const msg = await (await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=full`, { headers: { Authorization: `Bearer ${at}` } })).json();
      const h = Object.fromEntries((msg.payload?.headers || []).map((x) => [x.name, x.value]));
      rows.push({ from: (h.From || '').slice(0, 60), subject: (h.Subject || '').slice(0, 120), date: h.Date, body: strip(bodyText(msg.payload)).slice(0, 2600) });
    }
    return res.status(200).json(rows);
  } catch (e) { return res.status(500).json({ error: e.message }); }
}
