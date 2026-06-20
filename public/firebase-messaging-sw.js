/* Firebase Cloud Messaging service worker — handles background push + notification taps.
   Service workers can't read import.meta.env, so the (public) web config is inline. */
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: 'AIzaSyC3Bz8BWMG0p_1qp8kVo0y0Zei-SbgdzVU',
  authDomain: 'mikeslife-963c6.firebaseapp.com',
  projectId: 'mikeslife-963c6',
  storageBucket: 'mikeslife-963c6.firebasestorage.app',
  messagingSenderId: '384371855002',
  appId: '1:384371855002:web:d53b35eb67748e5ce65923',
});

const messaging = firebase.messaging();

// Adopt SW updates immediately so link-routing fixes ship on the next app open
// (rather than waiting for every tab to close).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

const ORIGIN = 'https://mikeslife.app';
// Always hand FCM an absolute mikeslife URL — a bare path can resolve against the
// wrong PWA on iOS, and WindowClient.navigate() rejects cross-origin.
const absUrl = (u) => {
  try { return new URL(u || '/?source=push', ORIGIN).href; }
  catch { return ORIGIN + '/?source=push'; }
};

messaging.onBackgroundMessage((payload) => {
  const n = payload.notification || {};
  const data = payload.data || {};
  self.registration.showNotification(n.title || 'Mike’s Life', {
    body: n.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { url: absUrl(data.url) },
    vibrate: [180, 80, 180],
  });
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = absUrl(event.notification.data && event.notification.data.url);
  event.waitUntil((async () => {
    const list = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    // CRITICAL: only consider OUR windows. On iOS, matchAll can return another
    // installed PWA's window (e.g. mikesmoney). Focusing it sent the tap to the
    // wrong app, and navigate() rejected cross-origin — so the user landed on
    // whatever that app last showed. Filter to the mikeslife origin first.
    const ours = list.filter((c) => { try { return new URL(c.url).origin === ORIGIN; } catch { return false; } });
    if (ours.length) {
      const c = ours[0];
      try { await c.navigate(url); } catch { /* same-origin nav can still throw on some iOS builds */ }
      return c.focus();
    }
    if (clients.openWindow) return clients.openWindow(url);
  })());
});
