// Firebase init — gracefully no-ops in DEMO mode when env vars are absent.
import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';

const cfg = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

export const FIREBASE_READY = Boolean(cfg.apiKey && cfg.projectId);
export const OWNER_UID = import.meta.env.VITE_OWNER_UID || null;

let app = null;
let auth = null;
let db = null;
let provider = null;

if (FIREBASE_READY) {
  app = initializeApp(cfg);
  auth = getAuth(app);
  db = getFirestore(app);
  provider = new GoogleAuthProvider();
}

export { app, auth, db, provider };
