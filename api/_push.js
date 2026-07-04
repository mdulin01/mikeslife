// Shared push-message builder — DATA-ONLY messages, deliberately.
//
// Why: sending a `notification` payload makes the FCM SDK auto-display it,
// and our service worker ALSO displayed it in onBackgroundMessage — the same
// push arrived twice ("double notifications"). Data-only messages make the
// service worker the single display path, and its notificationclick handler
// controls the URL — including cross-origin spoke apps (mikesmoney/
// mikesfitness), which the old client.navigate() path silently couldn't reach
// (it rejects cross-origin, so taps just re-focused mikeslife).
// See public/firebase-messaging-sw.js for the display + click side.
export function dataPush(token, title, body, url) {
  return {
    token,
    data: {
      title: String(title || "Mike's Life"),
      body: String(body || ''),
      url: String(url || 'https://mikeslife.app/?source=push'),
    },
    webpush: { headers: { Urgency: 'high', TTL: '86400' } },
  };
}
