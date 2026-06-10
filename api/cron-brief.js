// Vercel Cron: the morning brief — generated in the cloud so it arrives even when
// the Mac mini is off. Mirrors rupert/notify/generate-brief.mjs, plus:
//   - rolls the Today list forward (resurface delays, fresh items from active plans)
//   - flags plans with no activity in 14+ days
//   - idempotent: skips if today's brief already exists (so the mini job and this
//     cron can coexist; unload the mini's brief plist once this is verified)
//
// vercel.json schedules this; Vercel sends "Authorization: Bearer ${CRON_SECRET}".
// Required env: CRON_SECRET, OPENAI_API_KEY, FIREBASE_SERVICE_ACCOUNT

import OpenAI from 'openai';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';

const OWNER_UID = process.env.OWNER_UID || 'F8QJ8dCk0CV5yX7yHu7AHPd6QS32';
const MODEL = process.env.OPENAI_MODEL || 'gpt-5.5';
const LINK = 'https://mikeslife.app/?source=push&focus=brief';

const easternYMD = (dt = new Date()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(dt);

// Same roll-forward the app does client-side (whoever runs first today wins).
function rollTodayItems(prev, plans, today) {
  const old = prev || [];
  const kept = [];
  for (const t of old) {
    if (t.status === 'delayed' && t.until && t.until > today) kept.push(t);
    else if (t.status === 'delayed' && t.until && t.until <= today) kept.push({ ...t, status: 'pending', until: null });
  }
  const titles = new Set(old.map((t) => t.title));
  const visible = kept.filter((t) => t.status === 'pending').length;
  const active = (plans || []).filter((p) => p.status === 'active');
  const fresh = [];
  outer: for (let round = 0; round < 5; round++) {
    for (const p of active) {
      const open = (p.stages || []).flatMap((s) => s.tasks || []).filter((x) => !x.done);
      const task = open[round];
      if (!task || titles.has(task.text)) continue;
      titles.add(task.text);
      fresh.push({ id: 'td' + Date.now() + '_' + fresh.length, title: task.text, why: p.title, pk: p.pk, planId: p.id, status: 'pending', until: null });
      if (visible + fresh.length >= 5) break outer;
    }
  }
  return [...kept, ...fresh];
}

export default async function handler(req, res) {
  if (process.env.CRON_SECRET && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    if (!process.env.OPENAI_API_KEY || !process.env.FIREBASE_SERVICE_ACCOUNT) {
      return res.status(503).json({ error: 'not-configured' });
    }
    if (!getApps().length) initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
    const db = getFirestore();
    const ref = db.doc(`lifeos/${OWNER_UID}`);
    const d = (await ref.get()).data() || {};
    const today = easternYMD();

    // Idempotency — the mini (or an earlier invocation) may have already sent it.
    const briefToday = (d.alerts || []).some((a) => a.type === 'brief' && String(a.at || '').length && easternYMD(new Date(a.at)) === today);
    if (briefToday || (d.todayBrief && d.todayBrief.date === today)) {
      return res.status(200).json({ ok: true, skipped: 'brief already exists for today' });
    }

    // Roll the Today list forward if the app hasn't yet.
    let todayItems = d.todayItems || [];
    const patch = {};
    if (d.todayItemsDate !== today) {
      todayItems = rollTodayItems(d.todayItems, d.plans, today);
      patch.todayItems = todayItems;
      patch.todayItemsDate = today;
    }
    const openItems = todayItems.filter((t) => t.status === 'pending');

    // Context (no check-in — capacity is assumed at 4-5 items/day).
    const ctx = [];
    if (openItems.length) ctx.push("Today's list (4-5 items, accept-or-delay model): " + openItems.map((t) => `${t.title} [${t.pk}${t.why ? ' · ' + t.why : ''}]`).join('; '));
    const active = (d.plans || []).filter((p) => p.status === 'active');
    if (active.length) ctx.push('Active plans: ' + active.map((p) => p.title).join('; '));
    const stalled = active.filter((p) => p.updatedAt && (Date.now() - new Date(p.updatedAt).getTime()) > 14 * 86400 * 1000);
    if (stalled.length) ctx.push('Stalled plans (no activity 14+ days — nudge gently): ' + stalled.map((p) => p.title).join('; '));
    if (d.fitnessContext) ctx.push('Training:\n' + d.fitnessContext);
    if (d.financeContext) ctx.push('Finances:\n' + d.financeContext);
    if (d.healthContext) ctx.push('Health:\n' + d.healthContext);
    if (d.location && (d.location.place || d.location.lat)) ctx.push(`Location: ${d.location.place || `${d.location.lat}, ${d.location.lng}`}`);
    const fb = (d.alerts || []).filter((a) => a.feedback).slice(0, 10);
    if (fb.length) ctx.push('His ratings of past content (more like 👍, less like 👎): ' + fb.map((a) => `${a.feedback === 'up' ? '👍' : '👎'} ${a.title}`).join('; '));

    const SYS = `You are Rupert, Mike's chief of staff. Write a SHORT morning brief he reads on his phone, in EXACTLY this shape:
Good morning Mike.
Today's focus:
🥇 ...
🥈 ...
🥉 ...
Health
- ...
Money
- ...
Recommended day:
Morning → ...
Afternoon → ...
Evening → ...
Rules: keep every line short. Draw the 3 focus items from today's list and active plans. If a plan is stalled, one gentle nudge line after the focus items. Only include a Health or Money line you can support from the context; skip a section entirely if there's no data. No preamble, no sign-off.`;

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, ...(process.env.OPENAI_BASE_URL ? { baseURL: process.env.OPENAI_BASE_URL } : {}) });
    const completion = await openai.chat.completions.create({
      model: MODEL,
      messages: [{ role: 'system', content: SYS }, { role: 'user', content: 'Context:\n' + (ctx.join('\n\n') || 'No data yet.') }],
    });
    const brief = (completion.choices?.[0]?.message?.content || '').trim();
    const at = new Date().toISOString();

    patch.todayBrief = { text: brief, date: today };
    patch.alerts = [
      { id: 'a' + Date.now(), type: 'brief', title: '☀️ Morning brief ' + today, text: brief, at, feedback: null },
      ...(d.alerts || []),
    ].slice(0, 120);
    await ref.set(patch, { merge: true });

    const firstLine = brief.split('\n')[0] || 'Your morning brief';
    const tokens = Array.from(new Set([...(d.fcmTokens || []), d.fcmToken].filter(Boolean)));
    let pushed = 0;
    for (const token of tokens) {
      try {
        await getMessaging().send({
          token,
          notification: { title: '☀️ ' + firstLine, body: 'Your brief is ready — tap to open.' },
          data: { url: LINK },
          webpush: { notification: { icon: 'https://mikeslife.app/icon-192.png', badge: 'https://mikeslife.app/icon-192.png' }, fcmOptions: { link: LINK } },
        });
        pushed++;
      } catch (e) { console.error('push failed:', e.message); }
    }
    return res.status(200).json({ ok: true, pushed, items: openItems.length });
  } catch (e) {
    console.error('cron-brief error', e);
    return res.status(500).json({ error: e.message || 'error' });
  }
}
