// Voice transcription for the Rupert chat — records audio in the app, sends it here,
// Whisper turns it into text. Works in the installed iOS PWA (MediaRecorder + getUserMedia),
// unlike the Web Speech API.
import OpenAI, { toFile } from 'openai';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

const OWNER_UID = process.env.OWNER_UID || 'F8QJ8dCk0CV5yX7yHu7AHPd6QS32';

function ensureAdmin() {
  if (!getApps().length) initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try {
    if (!process.env.OPENAI_API_KEY || !process.env.FIREBASE_SERVICE_ACCOUNT) {
      return res.status(503).json({ error: 'not-configured' });
    }
    ensureAdmin();
    const { idToken, audio, mime } = req.body || {};
    if (!idToken || !audio) return res.status(400).json({ error: 'missing idToken or audio' });

    const decoded = await getAuth().verifyIdToken(idToken);
    if (decoded.uid !== OWNER_UID) return res.status(403).json({ error: 'not authorized' });

    const buf = Buffer.from(audio, 'base64');
    const ext = (mime || '').includes('mp4') ? 'mp4' : (mime || '').includes('wav') ? 'wav' : 'webm';
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const file = await toFile(buf, `voice.${ext}`, { type: mime || 'audio/webm' });
    const tr = await openai.audio.transcriptions.create({ file, model: 'whisper-1' });
    return res.status(200).json({ text: (tr.text || '').trim() });
  } catch (e) {
    console.error('transcribe error', e);
    return res.status(500).json({ error: e.message || 'error' });
  }
}
