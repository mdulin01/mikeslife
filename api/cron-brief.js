// Vercel Cron: the morning brief — generated in the cloud so it arrives even when
// the Mac mini is off. Mirrors rupert/notify/generate-brief.mjs, plus:
//   - rolls the Today list forward (resurface delays, fresh items from active plans)
//   - flags plans with no activity in 14+ days
//   - idempotent: skips if today's brief already exists (so the mini job and this
//     cron can coexist; unload the mini's brief plist once this is verified)
//
// vercel.json schedules this; Vercel sends "Authorization: Bearer ${CRON_SECRET}".
// Required env: CRON_SECRET, OPENAI_API_KEY, FIREBASE_SERVICE_ACCOUNT

import { llmChat, pickProvider } from './_llm.js';
import { briefHour, etHour, inQuietHours } from './_prefs.js';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';
import { dataPush } from './_push.js';

const OWNER_UID = process.env.OWNER_UID || 'F8QJ8dCk0CV5yX7yHu7AHPd6QS32';
const LINK = 'https://mikeslife.app/?source=push&focus=brief';

const easternYMD = (dt = new Date()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(dt);

// Same roll-forward the app does client-side (whoever runs first today wins).
function rollTodayItems(prev, plans, today, doneLedger) {
  const old = prev || [];
  const recentlyDone = new Set((doneLedger || []).map((e) => e.title));
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
      if (!task || titles.has(task.text) || recentlyDone.has(task.text)) continue;
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
    if (!process.env.FIREBASE_SERVICE_ACCOUNT || (!process.env.OPENAI_API_KEY && !process.env.ANTHROPIC_API_KEY)) {
      return res.status(503).json({ error: 'not-configured' });
    }
    if (!getApps().length) initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
    const db = getFirestore();
    const ref = db.doc(`lifeos/${OWNER_UID}`);
    const d = (await ref.get()).data() || {};
    const today = easternYMD();

    if (d.alertPrefs && d.alertPrefs.brief === false) {
      return res.status(200).json({ ok: true, skipped: 'briefs muted in app preferences' });
    }
    if (etHour() !== briefHour(d.settings)) {
      return res.status(200).json({ ok: true, skipped: `not brief hour (want ${briefHour(d.settings)} ET)` });
    }

    // Idempotency — the mini (or an earlier invocation) may have already sent it.
    const briefToday = (d.alerts || []).some((a) => a.type === 'brief' && String(a.at || '').length && easternYMD(new Date(a.at)) === today);
    if (briefToday || (d.todayBrief && d.todayBrief.date === today)) {
      return res.status(200).json({ ok: true, skipped: 'brief already exists for today' });
    }

    // Roll the Today list forward if the app hasn't yet.
    let todayItems = d.todayItems || [];
    const patch = {};
    if (d.todayItemsDate !== today) {
      todayItems = rollTodayItems(d.todayItems, d.plans, today, d.doneLedger);
      patch.todayItems = todayItems;
      patch.todayItemsDate = today;
    }
    const openItems = todayItems.filter((t) => t.status === 'pending');

    // Context (no check-in — capacity is assumed at 4-5 items/day).
    const DEFAULT_COMMITMENTS = 'In Charlotte working at Rea Farms every Wednesday and Thursday — NOT available for evening plans or dinners on Wed/Thu nights.';
    const ctx = [];
    ctx.push('Recurring commitments (NEVER schedule over these): ' + ((d.commitments && d.commitments.trim()) || DEFAULT_COMMITMENTS));
    if (openItems.length) ctx.push("Today's list (4-5 items, accept-or-delay model): " + openItems.map((t) => `${t.title} [${t.pk}${t.why ? ' · ' + t.why : ''}]`).join('; '));
    const doneRecently = [...new Set([
      ...(d.todayItems || []).filter((t) => t.status === 'done').map((t) => t.title),
      ...((d.doneLedger || []).map((e) => e.title)),
    ])];
    if (doneRecently.length) ctx.push('Recently completed (DONE — never resurface these as focus or actions): ' + doneRecently.slice(0, 30).join('; '));
    const active = (d.plans || []).filter((p) => p.status === 'active');
    if (active.length) ctx.push('Active plans: ' + active.map((p) => p.title).join('; '));
    const stalled = active.filter((p) => p.updatedAt && (Date.now() - new Date(p.updatedAt).getTime()) > 14 * 86400 * 1000);
    if (stalled.length) ctx.push('Stalled plans (no activity 14+ days — nudge gently): ' + stalled.map((p) => p.title).join('; '));
    if (d.fitnessContext) ctx.push('Training:\n' + d.fitnessContext);
    if (d.financeContext) ctx.push('Finances:\n' + d.financeContext);
    if (d.healthContext) ctx.push('Health:\n' + d.healthContext);
    if (d.travelContext) ctx.push('Travel (upcoming trips from mikestravel):\n' + d.travelContext);
    if (d.location && (d.location.place || d.location.lat)) ctx.push(`Location: ${d.location.place || `${d.location.lat}, ${d.location.lng}`}`);
    if (d.calendarText) ctx.push('Calendar (week ahead):\n' + d.calendarText);
    if (d.emailText) ctx.push('Recent email headers:\n' + d.emailText);
    const fb = [];
    for (const a of (d.alerts || []).slice(0, 40)) {
      if (a.feedback) fb.push(`${a.feedback === 'up' ? '👍' : '👎'} ${a.title}`);
      for (const it of (a.items || [])) if (it.feedback) fb.push(`${it.feedback === 'up' ? '👍' : '👎'} ${it.t}`);
    }
    if (fb.length) ctx.push('His ratings of past content (more like 👍, less like 👎): ' + fb.slice(0, 16).join('; '));

    // Anti-repetition: surface what the last few briefs already pushed as focus, so we
    // vary the focus instead of parroting the same long-term plan items every morning.
    const recentFocus = [];
    for (const a of (d.alerts || []).filter((x) => x.type === 'brief').slice(0, 3)) {
      for (const ln of String(a.text || '').split('\n')) {
        const m = ln.match(/^\s*(?:🥇|🥈|🥉)\s*(.+)$/u);
        if (m) recentFocus.push(m[1].replace(/[.。]\s*$/, '').trim());
      }
    }
    if (recentFocus.length) ctx.push('Focus items already shown in recent briefs (do NOT just repeat these — vary them, retire ones with no progress, or ask if already handled): ' + [...new Set(recentFocus)].join('; '));

    const isSunday = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' }).format(new Date()) === 'Sun';

    const SYS_WEEKLY = `You are Rupert, Mike's chief of staff. It's Sunday — write his WEEKLY REVIEW + week ahead, phone-readable, in EXACTLY this shape:
Good morning Mike — your week in review.
Wins:
- ...
- ...
Plans:
- ... (progress or stalled, per plan)
Health
- ...
Money
- ...
Week ahead:
🥇 ...
🥈 ...
🥉 ...
One question to sit with: ...
Rules: short lines. Respect Mike's recurring commitments — never suggest anything that conflicts. Wins come from done items + plan activity in the context. Only include Health/Money lines supported by the context, and for Health never list a normal/'ok' lab — only abnormal/flagged results or care that is due. Surface time-sensitive items from Calendar/email (payments, RSVPs, replies, deadlines) in the relevant lines. The week-ahead picks come from active plans + today's list. End with one genuinely good reflective question. No preamble, no sign-off. ACCURACY (critical): state only facts that appear in the context. Never invent, round, or extrapolate numbers, dates, or events; if a Health/Money/Training fact isn't in the context, omit that line entirely rather than guessing. When the context gives a date for a fact, keep it so nothing reads as more current than it is.`;

    const SYS = isSunday ? SYS_WEEKLY : `You are Rupert, Mike's chief of staff. Write Mike's morning rundown — warm, specific, and phone-readable, in the spirit of a sharp aide who actually read his inbox and calendar. Use concrete details (names, dates, amounts, addresses, tracking numbers, IDs) when the context provides them. Include ONLY sections that have real content — silently drop any that would be empty. Shape EXACTLY:
Good morning Mike — your daily rundown.
Top of mind:
- <the few genuinely time-sensitive, act-on-able things in the next ~5 days, each WITH its date — mined from Calendar, Recent email and Finances: payments/auto-drafts, RSVPs, replies awaited, deadlines, appointments to prep for. One sentence each, lead with the verb.>
Today's focus:
🥇 ...
🥈 ...
🥉 ...
Health & Training:
- <ONLY abnormal/⚠-flagged labs or preventive care that is due/overdue, each with its date — NEVER a normal/'ok' result>
- <one concrete training line grounded in recent workouts + current plan; suggest recovery if he trained hard the last day or two>
FYI:
- <low-priority but useful heads-ups: confirmed reservations, statements/receipts, deposits and payment confirmations, security/expiration notices (tokens, cards, domains), birthdays, renewals — grouped tightly, each with its date>
Delivery updates:
- <packages in transit pulled from shipping/tracking emails — what + carrier + ETA. OMIT this whole section if the context has no shipping email.>
Looking ahead:
<Short theme title in Title Case>
<one line on why now is the moment>
→ <a concrete next step>
→ <a second concrete next step>
<(up to 3 themes; each = bigger threads tied to his plans/pillars — autumn locum work, travel/upgrades, triathlon prep, the apps, finances, etc. — that aren't urgent today)>
Rules:
- "Top of mind" is the most important section: actively scan Calendar + Recent email + Finances for anything time-sensitive and act-on-able and lead with it, each dated. Skip the section only if truly nothing is pending.
- LINKS: email lines in the context end with " | https://mail.google.com/…". When a Top of mind / FYI / Delivery item comes from such a line, end that item with the bare URL (a space before it, NO punctuation after it) so it renders as a tappable "view message" link. Never invent a link.
- Today's focus: EXACTLY 3 items drawn from active plans + today's list, each on its own 🥇/🥈/🥉 line. ANTI-REPEAT (critical): do NOT just re-list focus items shown in recent briefs — vary them; if an item has recurred for days with no progress, retire it or convert it to one gentle "still open, or already handled?" nudge. NEVER list anything in 'Recently completed'.
- Health & Training: never surface normal/'ok' labs. Always include one training line whenever any training data exists.
- "Looking ahead" themes must NOT duplicate Top-of-mind items — these are the slower-burning threads, each with a crisp rationale and 1-2 "→" next steps.
- Respect Mike's recurring commitments — never suggest a focus, event, or day-block that conflicts (e.g. a Wed/Thu evening plan in Charlotte).
- Keep every line short. No preamble before "Good morning", no sign-off.
ACCURACY (critical): state only facts that appear in the context. Never invent, round, or extrapolate numbers, dates, tracking IDs, or events; if a fact isn't in the context, omit it. Keep any date the context attaches to a fact so nothing reads as more current than it is.`;

    const brief = (await llmChat({
      provider: pickProvider(d.settings),
      system: `Today is ${today}. ` + SYS,
      messages: [{ role: 'user', content: 'Context:\n' + (ctx.join('\n\n') || 'No data yet.') }],
      maxTokens: 1800,
    })).trim();
    const at = new Date().toISOString();

    const alertId = 'a' + Date.now();
    const link = `https://mikeslife.app/?source=push&alert=${alertId}`;
    patch.todayBrief = { text: brief, date: today };
    patch.alerts = [
      { id: alertId, type: 'brief', title: (isSunday ? '🗓️ Weekly review ' : '☀️ Morning brief ') + today, text: brief, at, feedback: null },
      ...(d.alerts || []),
    ].slice(0, 120);
    await ref.set(patch, { merge: true });

    // Nightly backup of the whole lifeos doc (everything lives in it now); prune >14d.
    try {
      await db.doc(`lifeos_backups/${today}`).set({ ...d, ...patch, backedUpAt: at });
      const old = await db.collection('lifeos_backups').get();
      for (const doc of old.docs) {
        if (doc.id < easternYMD(new Date(Date.now() - 14 * 86400 * 1000))) await doc.ref.delete();
      }
    } catch (e) { console.error('backup failed:', e.message); }

    // Push preview = the first real content line (skip greeting + bare section headers),
    // so the lock-screen notification says something useful, Gemini-style.
    const firstContent = (brief.split('\n').map((l) => l.trim())
      .filter((l) => l && !/^good morning/i.test(l) && !/^[^-•🥇🥈🥉].{0,28}:$/.test(l))[0] || 'Your brief is ready — tap to open.')
      .replace(/^[-•]\s*/, '').slice(0, 170);
    const tokens = inQuietHours(d.settings) ? [] : [d.fcmToken || (d.fcmTokens || []).slice(-1)[0]].filter(Boolean);
    let pushed = 0;
    for (const token of tokens) {
      try {
        await getMessaging().send(dataPush(token, (isSunday ? '🗓️ Weekly review' : '☀️ Morning brief') + ' — ' + today, firstContent, link));
        pushed++;
      } catch (e) { console.error('push failed:', e.message); }
    }
    return res.status(200).json({ ok: true, pushed, items: openItems.length });
  } catch (e) {
    console.error('cron-brief error', e);
    return res.status(500).json({ error: e.message || 'error' });
  }
}
