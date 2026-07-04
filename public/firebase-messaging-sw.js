/* Firebase Cloud Messaging service worker — handles background push + notification taps.
   Service workers can't read import.meta.env, so the (public) web config is inline.

   Pushes are DATA-ONLY (see api/_push.js): the server never sends a `notification`
   payload, so the FCM SDK doesn't auto-display anything and this worker is the
   single display path — that's what fixed the double notifications. */
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

messaging.onBackgroundMessage((payload) => {
  const data = payload.data || {};
  const n = payload.notification || {}; // legacy fallback while old sends drain
  self.registration.showNotification(data.title || n.title || 'Mike’s Life', {
    body: data.body || n.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { url: data.url || '/?source=push' },
    vibrate: [180, 80, 180],
  });
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  // Cross-origin (spoke apps: mikesmoney/mikesfitness/rainbowrentals…) must use
  // openWindow — client.navigate() rejects cross-origin URLs, which used to
  // silently re-focus mikeslife instead of opening the spoke app.
  let external = false;
  try { external = /^https?:/i.test(url) && new URL(url).origin !== self.location.origin; } catch (e) { /* relative */ }
  event.waitUntil((async () => {
    if (external) {
      if (clients.openWindow) return clients.openWindow(url);
      return;
    }
    const list = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of list) {
      if ('focus' in c) {
        try { await c.navigate(url); } catch (e) { /* ignore */ }
        return c.focus();
      }
    }
    if (clients.openWindow) return clients.openWindow(url);
  })());
});
