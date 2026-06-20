// Owner-only test push: sends a notification to every stored FCM token so Mike can
// confirm delivery on demand (the crons are per-day idempotent + only push when they
// have something to say, which makes ad-hoc testing impossible). Reports per-token
// success/failure so a dead token is visible rather than silently swallowed.
// env: FIREBASE_SERVICE_ACCOUNT, OWNER_UID
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';

const OWNER_UID = process.env.OWNER_UID || 'F8QJ8dCk0CV5yX7yHu7AHPd6QS32';
const LINK = 'https://mikeslife.app/?source=push';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try {
    if (!getApps().length) initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
    const { idToken, url, title, body } = req.body || {};
    if (!idToken) return res.status(401).json({ error: 'missing idToken' });
    const decoded = await getAuth().verifyIdToken(idToken);
    if (decoded.uid !== OWNER_UID) return res.status(403).json({ error: 'not authorized' });

    const ALLOWED = ['mikeslife.app', 'www.mikeslife.app', 'mikesmoney.app', 'www.mikesmoney.app', 'rainbowrentals.app', 'www.rainbowrentals.app'];
    let link = LINK;
    if (url) { try { if (ALLOWED.includes(new URL(url).hostname)) link = url; } catch (_) { /* keep default */ } }

    const d = (await getFirestore().doc(`lifeos/${OWNER_UID}`).get()).data() || {};
    const tokens = [d.fcmToken || (d.fcmTokens || []).slice(-1)[0]].filter(Boolean);
    if (!tokens.length) return res.status(200).json({ ok: false, reason: 'no tokens stored — tap Enable/Re-sync first', tokens: 0 });

    const results = [];
    let pushed = 0;
    const stale = [];
    for (const token of tokens) {
      try {
        await getMessaging().send({
          token,
          notification: { title: title || '🦚 Rupert test ping', body: body || 'If you see this, notifications are working. ✓' },
          data: { url: link },
          webpush: { notification: { icon: 'https://mikeslife.app/icon-192.png' }, fcmOptions: { link } },
        });
        pushed++; results.push({ token: token.slice(0, 12) + '…', ok: true });
      } catch (e) {
        results.push({ token: token.slice(0, 12) + '…', ok: false, error: e.code || e.message });
        if (/registration-token-not-registered|invalid-argument|invalid-registration/.test(e.code || e.message || '')) stale.push(token);
      }
    }
    // Prune dead tokens so the list stays clean (the live one survives).
    if (stale.length) {
      const keep = tokens.filter((t) => !stale.includes(t));
      await getFirestore().doc(`lifeos/${OWNER_UID}`).set({ fcmTokens: keep, fcmToken: keep[keep.length - 1] || null }, { merge: true });
    }
    return res.status(200).json({ ok: pushed > 0, pushed, tokens: tokens.length, pruned: stale.length, results });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
