// Vercel Cron 7:00 ET: the morning check-in nudge — one push, no alert-history
// noise. Tapping it opens the Plan-your-day screen (?focus=checkin). If Mike has
// already submitted today's plan (early bird), it stays silent.
// Required env: CRON_SECRET, FIREBASE_SERVICE_ACCOUNT

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';

const OWNER_UID = process.env.OWNER_UID || 'F8QJ8dCk0CV5yX7yHu7AHPd6QS32';
const LINK = 'https://mikeslife.app/?source=push&focus=checkin';

const easternYMD = (dt = new Date()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(dt);

export default async function handler(req, res) {
  if (process.env.CRON_SECRET && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    if (!getApps().length) initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
    const d = (await getFirestore().doc(`lifeos/${OWNER_UID}`).get()).data() || {};
    if (d.alertPrefs && d.alertPrefs.brief === false) return res.status(200).json({ ok: true, skipped: 'muted' });
    if (d.dayPlan && d.dayPlan.date === easternYMD()) return res.status(200).json({ ok: true, skipped: 'plan already submitted' });

    const tokens = Array.from(new Set([...(d.fcmTokens || []), d.fcmToken].filter(Boolean)));
    let pushed = 0;
    for (const token of tokens) {
      try {
        await getMessaging().send({
          token,
          notification: { title: '🦚 Plan your day with Rupert', body: 'Pick today\'s focus + give Rupert his assignments — 60 seconds.' },
          data: { url: LINK },
          webpush: { notification: { icon: 'https://mikeslife.app/icon-192.png' }, fcmOptions: { link: LINK } },
        });
        pushed++;
      } catch (e) { console.error('push failed:', e.message); }
    }
    return res.status(200).json({ ok: true, pushed });
  } catch (e) {
    console.error('cron-checkin error', e);
    return res.status(500).json({ error: e.message || 'error' });
  }
}
