// Vercel Cron: Amazon order-email parser. Reads Mike's Gmail (same OAuth refresh
// token as cron-google) for Amazon order confirmations, extracts order # / total /
// items, and writes them into mikesmoney's `amazonOrders` collection (Admin SDK via
// FIREBASE_SA_MONEY). mikes-money's Transactions page then matches orders to Plaid
// txns by amount+date and shows the 📦 items under the transaction.
// Idempotent: doc id = the Amazon order number.
// env: CRON_SECRET, FIREBASE_SERVICE_ACCOUNT, GOOGLE_CLIENT_ID/SECRET, FIREBASE_SA_MONEY

import { initializeApp, cert, getApps, getApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

function appFor(name, saJson) {
  if (!getApps().find((a) => a.name === name)) initializeApp({ credential: cert(JSON.parse(saJson)) }, name);
  return getFirestore(getApp(name));
}
const b64 = (s) => Buffer.from(String(s || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');

// Prefer text/plain; fall back to de-tagged HTML.
function bodyText(payload, want = 'text/plain') {
  if (!payload) return '';
  if (payload.mimeType === want && payload.body?.data) return b64(payload.body.data);
  for (const p of payload.parts || []) { const t = bodyText(p, want); if (t) return t; }
  if (want === 'text/plain') {
    const html = bodyText(payload, 'text/html');
    if (html) return html.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ');
  }
  if (payload.body?.data) return b64(payload.body.data).replace(/<[^>]+>/g, ' ');
  return '';
}

const etYMD = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Number(ms)));

async function gFetch(url, token) {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`${url.split('?')[0]} → ${r.status}`);
  return r.json();
}

export default async function handler(req, res) {
  if (process.env.CRON_SECRET && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    if (!process.env.FIREBASE_SA_MONEY) return res.status(200).json({ ok: true, skipped: 'FIREBASE_SA_MONEY not set' });
    const lifeDb = getFirestore(getApps().find((a) => a.name === '[DEFAULT]') ? getApp() : initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) }));
    const moneyDb = appFor('money', process.env.FIREBASE_SA_MONEY);

    const sec = (await lifeDb.doc('secrets/google').get()).data();
    if (!sec?.refreshToken) return res.status(503).json({ error: 'google not connected — visit /api/google-auth' });
    const tr = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ refresh_token: sec.refreshToken, client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, grant_type: 'refresh_token' }),
    });
    const tok = await tr.json();
    if (!tr.ok) return res.status(502).json({ error: 'token refresh failed' });
    const at = tok.access_token;

    const q = 'from:(auto-confirm@amazon.com OR order-update@amazon.com) newer_than:45d';
    const list = await gFetch('https://gmail.googleapis.com/gmail/v1/users/me/messages?' + new URLSearchParams({ q, maxResults: '25' }), at);

    let written = 0, seen = 0;
    const results = [];
    for (const m of list.messages || []) {
      const msg = await gFetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=full`, at);
      const h = Object.fromEntries((msg.payload?.headers || []).map((x) => [x.name.toLowerCase(), x.value]));
      const subject = h.subject || '';
      const body = bodyText(msg.payload).slice(0, 20000);
      const orderId = (subject.match(/(\d{3}-\d{7}-\d{7})/) || body.match(/(\d{3}-\d{7}-\d{7})/) || [])[1];
      if (!orderId) continue;
      seen++;
      const ref = moneyDb.collection('amazonOrders').doc(orderId);
      if ((await ref.get()).exists) continue; // idempotent — first parse wins (order emails > shipment emails chronologically per query order is not guaranteed, but totals match either way)
      const totalM = body.match(/(?:Order|Grand)\s*Total:?\s*\$\s*([\d,]+\.\d{2})/i) || body.match(/Total:?\s*\$\s*([\d,]+\.\d{2})/i);
      const total = totalM ? Number(totalM[1].replace(/,/g, '')) : null;
      const items = [];
      const subjItem = subject.match(/order of ["“](.+?)["”…]/);
      if (subjItem) items.push(subjItem[1]);
      const more = subject.match(/and (\d+) more item/);
      if (more) items.push(`+${more[1]} more`);
      // body bullet lines (plain-text order confirmations list items as "* Item name")
      for (const line of body.split('\n')) {
        const t = line.trim();
        if (/^\*\s+\S/.test(t) && t.length < 120 && items.length < 6) items.push(t.replace(/^\*\s+/, ''));
      }
      await ref.set({
        orderId, date: etYMD(msg.internalDate), total, items: [...new Set(items)].slice(0, 6),
        subject: subject.slice(0, 140), source: 'gmail', updatedAt: new Date().toISOString(),
      });
      written++;
      results.push(`${orderId} $${total} ${items[0] || ''}`);
    }
    return res.status(200).json({ ok: true, scanned: (list.messages || []).length, withOrderId: seen, written, results });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
