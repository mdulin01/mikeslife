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

messaging.onBackgroundMessage((payload) => {
  const n = payload.notification || {};
  const data = payload.data || {};
  self.registration.showNotification(n.title || 'Mike’s Life', {
    body: n.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { url: data.url || '/?source=push' },
    vibrate: [180, 80, 180],
  });
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) { if ('focus' in c) { c.navigate(url); return c.focus(); } }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
