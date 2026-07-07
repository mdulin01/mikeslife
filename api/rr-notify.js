// Send a queued Rainbow Reality push notification (e.g. "analysis ready" → Liam).
// Security model mirrors liam-done: the endpoint takes NO payload — it only delivers
// items that an AUTHORIZED RR user already wrote to rentalData/notifyQueue (Firestore
// rules restrict writes to the three owner emails), so it can't be used to push
// arbitrary messages. Items must be <15 min old and unsent; marked sent after delivery.
// env: FIREBASE_SA_RAINBOW (rainbow-rentals admin SA).
import { initializeApp, cert, getApps, getApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try {
    if (!process.env.FIREBASE_SA_RAINBOW) return res.status(503).json({ error: 'no FIREBASE_SA_RAINBOW' });
    let app; try { app = getApp('rainbow'); } catch { app = initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SA_RAINBOW)) }, 'rainbow'); }
    const db = getFirestore(app);
    const msg = getMessaging(app);

    const qRef = db.doc('rentalData/notifyQueue');
    const q = (await qRef.get()).data() || {};
    const items = q.items || [];
    const cutoff = Date.now() - 15 * 60 * 1000;
    const pending = items.filter(i => !i.sentAt && i.queuedAt && new Date(i.queuedAt).getTime() > cutoff);
    if (!pending.length) return res.status(200).json({ ok: false, reason: 'nothing pending (queue items expire after 15 min)' });

    const tokensSnap = await db.collection('pushTokens').get();
    const byEmail = {};
    tokensSnap.forEach(d => { const t = d.data(); if (t.email && t.token) byEmail[t.email.toLowerCase()] = t.token; });

    const results = [];
    for (const item of pending) {
      const token = byEmail[(item.toEmail || '').toLowerCase()];
      if (!token) { results.push({ id: item.id, ok: false, reason: `no push token for ${item.toEmail} — they need to enable alerts in the app` }); continue; }
      try {
        await msg.send({
          token,
          notification: { title: item.title || '🌈 Rainbow Reality', body: item.body || '' },
          webpush: { fcmOptions: { link: item.link || 'https://rainbowrentals.app/' } },
        });
        item.sentAt = new Date().toISOString();
        results.push({ id: item.id, ok: true });
      } catch (e) {
        results.push({ id: item.id, ok: false, reason: e.message?.slice(0, 120) });
      }
    }
    await qRef.set({ items: items.slice(-30), lastRun: new Date().toISOString() }, { merge: true });
    return res.status(200).json({ ok: true, results, knownTokens: Object.keys(byEmail) });
  } catch (e) {
    return res.status(500).json({ error: e.message?.slice(0, 200) });
  }
}
