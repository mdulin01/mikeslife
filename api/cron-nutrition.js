// Vercel Cron: Rupert fills Mike's Nutrition (separate app: mikesnutrition).
// Generates recipes + a weekly meal-prep plan and writes them to the mikesnutrition
// project's `nutrition/data` doc via a dedicated admin app. Recipes are content
// (not facts), so generation is appropriate. Grounds protein goals in lifeos
// fitnessContext when available. Does NOT touch Mike's `log` entries.
//
// Required env: CRON_SECRET, OPENAI_API_KEY, FIREBASE_SA_NUTRITION (admin JSON for
//   the mikesnutrition project). Optional: FIREBASE_SERVICE_ACCOUNT (mikeslife) for context.
import OpenAI from 'openai';
import { initializeApp, cert, getApps, getApp } from 'firebase-admin/app';
import { getFirestore } from "firebase-admin/firestore";

const OWNER_UID = process.env.OWNER_UID || 'F8QJ8dCk0CV5yX7yHu7AHPd6QS32';
const MODEL = process.env.OPENAI_MODEL || 'gpt-5.5';
const ET = 'America/New_York';
const easternYMD = (dt = new Date()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: ET, year: 'numeric', month: '2-digit', day: '2-digit' }).format(dt);

const SYS = `You are Rupert, Mike's chief of staff and informal nutrition coach. Mike wants high-protein, healthy, not-fussy meals; he meal-preps on Sundays. Keep recipes realistic and seasonal for the current month.`;

export default async function handler(req, res) {
  if (process.env.CRON_SECRET && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    if (!process.env.OPENAI_API_KEY) return res.status(503).json({ error: 'no OPENAI_API_KEY' });
    if (!process.env.FIREBASE_SA_NUTRITION) return res.status(503).json({ error: 'no FIREBASE_SA_NUTRITION (add the mikesnutrition admin key to mikeslife Vercel env)' });

    if (!getApps().length && process.env.FIREBASE_SERVICE_ACCOUNT) initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
    let nApp; try { nApp = getApp('nutrition'); } catch { nApp = initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SA_NUTRITION)) }, 'nutrition'); }
    const nDb = getFirestore(nApp);

    let fitness = '';
    try { if (getApps().some((a) => a.name === '[DEFAULT]')) fitness = ((await getFirestore().doc(`lifeos/${OWNER_UID}`).get()).data() || {}).fitnessContext || ''; } catch { /* fine */ }

    const today = easternYMD();
    const isSunday = new Intl.DateTimeFormat('en-US', { timeZone: ET, weekday: 'short' }).format(new Date()) === 'Sun';
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, ...(process.env.OPENAI_BASE_URL ? { baseURL: process.env.OPENAI_BASE_URL } : {}) });

    const RULE = `Respond with ONLY JSON (no prose, no code fence): {
  "recipes": [ up to 3 of {"title","tags":[..],"minutes":N,"ingredients":[..],"steps":[..]} ],
  "mealPrep": [ one {"items":[{"name","macros":"~Ng protein / serving","batch":"N servings"}]} ]  // ${isSunday ? 'a full week plan (3-4 batch dishes)' : '1 simple batch idea'}
}`;

    const c = await openai.chat.completions.create({
      model: MODEL, max_completion_tokens: 1800,
      messages: [{ role: 'system', content: SYS }, { role: 'user', content: `Today is ${today}.${fitness ? ' Training context: ' + fitness.slice(0, 400) : ''} Suggest fresh high-protein recipes${isSunday ? ' and a Sunday meal-prep plan' : ''} for this week. ${RULE}` }],
    });
    let gen; try { gen = JSON.parse((c.choices?.[0]?.message?.content || '').replace(/```json|```/g, '').trim()); }
    catch { return res.status(200).json({ ok: false, error: 'parse' }); }

    const recipes = (Array.isArray(gen.recipes) ? gen.recipes : []).slice(0, 3).map((r, i) => ({
      id: 'r' + Date.now() + '_' + i, title: String(r.title || '').slice(0, 90),
      tags: Array.isArray(r.tags) ? r.tags.slice(0, 4).map((t) => String(t).slice(0, 24)) : [],
      minutes: Number(r.minutes) || null, source: 'Rupert', link: '',
      ingredients: Array.isArray(r.ingredients) ? r.ingredients.map((x) => String(x).slice(0, 80)).slice(0, 16) : [],
      steps: Array.isArray(r.steps) ? r.steps.map((x) => String(x).slice(0, 160)).slice(0, 10) : [],
      saved: false,
    }));
    const mp = (Array.isArray(gen.mealPrep) ? gen.mealPrep : [])[0];
    const mealPrep = mp && Array.isArray(mp.items) ? [{
      id: 'mp' + Date.now(), week: today,
      items: mp.items.slice(0, 5).map((it) => ({ name: String(it.name || '').slice(0, 80), macros: String(it.macros || '').slice(0, 60), batch: String(it.batch || '').slice(0, 40) })),
    }] : [];

    if (!recipes.length && !mealPrep.length) return res.status(200).json({ ok: false, skipped: 'nothing generated' });

    const patch = { refreshedAt: new Date().toISOString() };
    if (recipes.length) patch.recipes = recipes;
    if (mealPrep.length) patch.mealPrep = mealPrep;
    // merge:true keeps Mike's `log` array untouched.
    await nDb.doc('nutrition/data').set(patch, { merge: true });
    return res.status(200).json({ ok: true, recipes: recipes.length, mealPrep: mealPrep.length, isSunday });
  } catch (e) {
    console.error('cron-nutrition', e);
    return res.status(500).json({ error: e.message });
  }
}
