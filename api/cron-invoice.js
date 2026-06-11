// Vercel Cron: invoice & time-tracking nudges (Fridays 1pm ET).
//   1. Every Friday: "log your Avance + Triad hours" → deep link to the portal timesheet.
//   2. First Friday of the month: GMA payment reminder (they owe ~$6.4k, plan = $1k/month —
//      nudge Mike to send the reminder email / check whether the $1k arrived).
// Alert type 'finance' (rateable/mutable), pushed + in history.
// Required env: CRON_SECRET, FIREBASE_SERVICE_ACCOUNT

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';

const OWNER_UID = process.env.OWNER_UID || 'F8QJ8dCk0CV5yX7yHu7AHPd6QS32';
const LINK = 'https://mikeslife.app/?source=push&focus=content';
const TIMESHEET = 'https://mikedulinmd.app/timesheet.html';

const easternYMD = (dt = new Date()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(dt);

export default async function handler(req, res) {
  if (process.env.CRON_SECRET && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    if (!getApps().length) initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
    const db = getFirestore();
    const ref = db.doc(`lifeos/${OWNER_UID}`);
    const d = (await ref.get()).data() || {};
    const today = easternYMD();

    if (d.alertPrefs && d.alertPrefs.finance === false) {
      return res.status(200).json({ ok: true, skipped: 'finance alerts muted' });
    }
    const dupe = (d.alerts || []).some((a) => a.title && a.title.includes('Time & invoices') && a.at && easternYMD(new Date(a.at)) === today);
    if (dupe) return res.status(200).json({ ok: true, skipped: 'already nudged today' });

    const dayOfMonth = Number(today.slice(8, 10));
    const firstFriday = dayOfMonth <= 7;

    const lines = [
      '🗓️ Friday wrap-up — log this week\'s consulting hours:',
      '• Avance ($250/hr, min 10/wk)',
      '• Triad Primary Care ($150 first 16/wk, then $200)',
      `Log them: ${TIMESHEET}`,
    ];
    if (firstFriday) {
      lines.push('');
      lines.push('💸 GMA check: did the $1k monthly payment arrive? If not, send Sheila/Louise the reminder (balance ~$6.4k + 1.5%/mo accrual). Ask Rupert to draft it.');
    }
    const text = lines.join('\n');
    const at = new Date().toISOString();

    await ref.set({
      alerts: [
        { id: 'a' + Date.now(), type: 'finance', title: '🧾 Time & invoices — Friday', text, at, feedback: null, appUrl: TIMESHEET },
        ...(d.alerts || []),
      ].slice(0, 120),
    }, { merge: true });

    const tokens = Array.from(new Set([...(d.fcmTokens || []), d.fcmToken].filter(Boolean)));
    let pushed = 0;
    for (const token of tokens) {
      try {
        await getMessaging().send({
          token,
          notification: { title: '🧾 Log your hours', body: 'Avance + Triad this week' + (firstFriday ? ' · GMA payment check' : '') },
          data: { url: LINK },
          webpush: { notification: { icon: 'https://mikeslife.app/icon-192.png' }, fcmOptions: { link: LINK } },
        });
        pushed++;
      } catch (e) { console.error('push failed:', e.message); }
    }
    return res.status(200).json({ ok: true, pushed, firstFriday });
  } catch (e) {
    console.error('cron-invoice error', e);
    return res.status(500).json({ error: e.message || 'error' });
  }
}
