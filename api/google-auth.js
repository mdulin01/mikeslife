// Step 1 of the Google pipeline: send Mike to Google's consent screen.
// Visit https://mikeslife.app/api/google-auth once; the callback stores the
// refresh token. Re-visit any time to re-connect.
// Required env: GOOGLE_CLIENT_ID (+ GOOGLE_CLIENT_SECRET used by the callback).

const REDIRECT = 'https://mikeslife.app/api/google-callback';
const SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/gmail.readonly',
  'openid', 'email',
].join(' ');

export default function handler(req, res) {
  if (!process.env.GOOGLE_CLIENT_ID) {
    return res.status(503).send('Add GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET in Vercel first.');
  }
  const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: REDIRECT,
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',
    prompt: 'consent', // force a refresh token every time
  });
  res.writeHead(302, { Location: url });
  res.end();
}
