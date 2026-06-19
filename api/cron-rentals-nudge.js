// Vercel Cron: rainbow-rentals reminders. Runs daily ~10am ET.
//  - From Thursday onward each week, push Liam "Record rental updates today" and
//    RE-NUDGE daily until he records (rentalData/liamWeekly.week === this ISO week).
//  - When Liam has recorded (Done & send), push Mike once ("remember to pay Liam")
//    and flip mikeNotified=true so he's not pinged again.
// Reads rainbow-rentals Firestore (pushTokens + rentalData/liamWeekly) + sends FCM
// via an admin app for that project.
// Required env: CRON_SECRET, FIREBASE_SA_RAINBOW (admin SA JSON for rainbow-rentals).
import { initializeApp, cert, getApps, getApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';

const LIAM_EMAIL = 'dulinliam@gmail.com';
const MIKE_EMAIL = 'mdulin@gmail.com';
const OWNER_UID = process.env.OWNER_UID || 'F8QJ8dCk0CV5yX7yHu7AHPd6QS32';
const ET = 'America/New_York';

function isoWeekId(d = new Date()) {
  const dt = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (dt.getUTCDay() + 6) % 7; dt.setUTCDate(dt.getUTCDate() - dayNum + 3);
  const firstThu = new Date(Date.UTC(dt.getUTCFullYear(), 0, 4));
  const weekNo = 1 + Math.round(((dt - firstThu) / 86400000 - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
  return `${dt.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

export default async function handler(req, res) {
  if (process.env.CRON_SECRET && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    if (!process.env.FIREBASE_SA_RAINBOW) return res.status(503).json({ error: 'no FIREBASE_SA_RAINBOW (add the rainbow-rentals admin key to mikeslife Vercel env)' });
    let app; try { app = getApp('rainbow'); } catch { app = initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SA_RAINBOW)) }, 'rainbow'); }
    const db = getFirestore(app);
    const msg = getMessaging(app);
    // mikeslife (default) app — Mike's real, working push tokens live in lifeos/{uid}.
    if (process.env.FIREBASE_SERVICE_ACCOUNT && !getApps().some((a) => a.name === '[DEFAULT]')) {
      initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
    }

    // weekday in ET (Thu=4)
    const wd = new Intl.DateTimeFormat('en-US', { timeZone: ET, weekday: 'short' }).format(new Date());
    const dayIdx = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[wd];
    const thisWeek = isoWeekId(new Date());

    const tokensSnap = await db.collection('pushTokens').get();
    const byEmail = {};
    tokensSnap.forEach((d) => { const t = d.data(); if (t.email && t.token) byEmail[t.email] = t.token; });

    const weekly = (await db.doc('rentalData/liamWeekly').get()).data() || {};
    const doneThisWeek = weekly.week === thisWeek;

    const out = { thisWeek, doneThisWeek, pushedLiam: false, pushedMike: false };

    // 1) Liam reminder — Thursday (4) through Sunday (re-nudge) until done
    if (!doneThisWeek && dayIdx >= 4 && byEmail[LIAM_EMAIL]) {
      try {
        await msg.send({
          token: byEmail[LIAM_EMAIL],
          notification: { title: '🏠 Rainbow Rentals', body: 'Record this week’s rental updates — rents, leases, expenses.' },
          webpush: { notification: { icon: '/icon-192.png' }, fcmOptions: { link: 'https://rainbowrentals.app/?source=push' } },
        });
        out.pushedLiam = true;
      } catch (e) { out.liamErr = e.message; }
    }

    // 2) Mike "Liam done" — once. Primary = Mike's REAL mikeslife tokens (lifeos/{uid});
    //    fall back to a rainbow-rentals pushTokens entry if present. (The instant
    //    /api/liam-done endpoint usually handles this; this cron is the daily backstop.)
    if (doneThisWeek && weekly.mikeNotified !== true) {
      let mikeTokens = [];
      try {
        if (getApps().some((a) => a.name === '[DEFAULT]')) {
          const ml = (await getFirestore().doc(`lifeos/${OWNER_UID}`).get()).data() || {};
          mikeTokens = [...new Set([ml.fcmToken, ...(ml.fcmTokens || [])].filter(Boolean))];
        }
      } catch (e) { out.mikeTokenErr = e.message; }
      if (!mikeTokens.length && byEmail[MIKE_EMAIL]) mikeTokens = [byEmail[MIKE_EMAIL]];
      let pushedMike = 0;
      for (const token of mikeTokens) {
        try {
          await msg.send({
            token,
            notification: { title: '✅ Liam finished the rental updates', body: 'This week’s rents/leases/expenses are recorded — remember to pay Liam.' },
            webpush: { notification: { icon: 'https://mikeslife.app/icon-192.png' }, fcmOptions: { link: 'https://rainbowrentals.app/?source=push' } },
          });
          pushedMike++;
        } catch (e) { out.mikeErr = e.message; }
      }
      if (pushedMike > 0) {
        await db.doc('rentalData/liamWeekly').set({ mikeNotified: true, mikeNotifiedAt: new Date().toISOString() }, { merge: true });
        out.pushedMike = true;
      } else if (!mikeTokens.length) { out.mikeErr = 'no tokens (mikeslife or rainbow)'; }
    }

    return res.status(200).json({ ok: true, ...out });
  } catch (e) {
    console.error('cron-rentals-nudge', e);
    return res.status(500).json({ error: e.message });
  }
}
