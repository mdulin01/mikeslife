// Web push (FCM) client. Requires the app to be installed to the iOS Home Screen
// for notifications to work on iPhone.
import { getMessaging, getToken, deleteToken, onMessage, isSupported } from 'firebase/messaging';
import { app, FIREBASE_READY } from './firebase';

// Public VAPID key (Firebase → Cloud Messaging → Web Push certificates).
const VAPID_KEY = 'BNfj4PZGls_gXvHz1RpWOakw0VED49VYLjqlm9NRhDPwkUDQC5NnCLJbaI_zWh0VMYjlNnxkquSnaQEJI_MifuE';

// forceFresh: delete any existing token first so iOS re-subscribes to APNs cleanly
// (re-minting over a stale subscription is a common silent failure on iOS PWAs).
export async function requestPushToken({ forceFresh = true } = {}) {
  try {
    if (!FIREBASE_READY) return { ok: false, reason: 'not-configured' };
    if (!('serviceWorker' in navigator) || !('Notification' in window)) return { ok: false, reason: 'unsupported' };
    if (!(await isSupported().catch(() => false))) return { ok: false, reason: 'unsupported (open from the installed app, not Safari)' };

    await navigator.serviceWorker.register('/firebase-messaging-sw.js');
    // getToken needs an ACTIVE service worker — registration alone may still be installing on iOS.
    const reg = await navigator.serviceWorker.ready;

    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return { ok: false, reason: 'permission ' + permission };

    const messaging = getMessaging(app);
    if (forceFresh) { try { await deleteToken(messaging); } catch { /* none to delete */ } }

    const token = await getToken(messaging, { vapidKey: VAPID_KEY, serviceWorkerRegistration: reg });
    if (!token) return { ok: false, reason: 'no-token (getToken returned empty)' };
    return { ok: true, token };
  } catch (e) {
    console.error('requestPushToken failed', e);
    return { ok: false, reason: (e && (e.code || e.message)) || 'error' };
  }
}

export async function listenForeground(cb) {
  try {
    if (!FIREBASE_READY || !(await isSupported().catch(() => false))) return;
    onMessage(getMessaging(app), cb);
  } catch (e) { /* ignore */ }
}
