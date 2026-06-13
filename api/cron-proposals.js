// Vercel Cron: Rupert writes REAL inbox proposals from Mike's actual signals
// (email, finance/fitness/health context, stalled plans) instead of seed mock.
// Proposals match the app's shape { id, pk, kind, src, pillar, title, why, act }.
// Merge rules: keep existing un-acted proposals, never regenerate ones Mike
// dismissed (lifeos.dismissedProposalKeys), only add genuinely new ones, cap 12.
// Runs daily after cron-google (so email signals are fresh). env: CRON_SECRET,
// FIREBASE_SERVICE_ACCOUNT, OPENAI_API_KEY (+ optional OPENAI_MODEL).
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const OWNER_UID = process.env.OWNER_UID || 'F8QJ8dCk0CV5yX7yHu7AHPd6QS32';
const PILLAR = {
  health: '🫀 Health', rel: '❤️ Relationships', fin: '💰 Finances', purpose: '🎯 Purpose', fun: '🏖️ Fun & Travel',
};
const norm = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();

const SYS = `You are Rupert, Mike's chief of staff. From the context, surface 3-6 PROPOSALS worth his attention right now — things to act on or decide, drawn from real signals (email, money, training, health, plans). Each must be specific and grounded in the context (no generic advice, no invented facts).

Return ONLY a JSON array, no prose. Each item:
{ "pk": one of "health"|"rel"|"fin"|"purpose"|"fun",
  "kind": "signal" if it came from an email/external signal else "",
  "src": short ALL-CAPS source label (e.g. "MONEY COACH", "EMAIL SIGNAL", "BODY COACH", "TRAVEL"),
  "title": one concise line (the proposal),
  "why": one sentence of grounded rationale (cite the number/fact),
  "act": the single concrete next step }
Respect Mike's recurring commitments — never propose anything that conflicts. Skip anything you can't ground in the context.`;

export default async function handler(req, res) {
  if (process.env.CRON_SECRET && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    if (!process.env.OPENAI_API_KEY) return res.status(503).json({ error: 'no OPENAI_API_KEY' });
    if (!getApps().length) initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
    const ref = getFirestore().doc(`lifeos/${OWNER_UID}`);
    const d = (await ref.get()).data() || {};
    if (d.alertPrefs && d.alertPrefs.proposals === false) return res.status(200).json({ ok: true, skipped: 'muted' });

    const dismissed = new Set(d.dismissedProposalKeys || []);
    const existing = Array.isArray(d.proposals) ? d.proposals : [];
    const existingKeys = new Set(existing.map((p) => norm(p.title)));

    // Build grounded context.
    const ctx = [];
    if (d.commitments) ctx.push('Recurring commitments (NEVER propose over these): ' + d.commitments);
    if (Array.isArray(d.emailSignals) && d.emailSignals.length) ctx.push('Recent email signals: ' + d.emailSignals.map((e) => `[${e.tag}] ${e.from}: ${e.subject}`).join(' | '));
    if (d.financeContext) ctx.push('Finances:\n' + d.financeContext);
    if (d.fitnessContext) ctx.push('Training:\n' + d.fitnessContext);
    if (d.healthContext) ctx.push('Health:\n' + d.healthContext);
    const active = (d.plans || []).filter((p) => p.status === 'active');
    if (active.length) ctx.push('Active plans: ' + active.map((p) => p.title).join('; '));
    const stalled = (d.plans || []).filter((p) => p.status === 'active' && p.updatedAt && (Date.now() - new Date(p.updatedAt).getTime()) > 14 * 86400 * 1000);
    if (stalled.length) ctx.push('Stalled plans (14+ days, nudge): ' + stalled.map((p) => p.title).join('; '));
    if (d.calendarText) ctx.push('Calendar (week ahead):\n' + d.calendarText);
    if (Array.isArray(d.alerts)) {
      const fb = d.alerts.filter((a) => a.feedback).slice(0, 8);
      if (fb.length) ctx.push('His past ratings (more like 👍, less like 👎): ' + fb.map((a) => `${a.feedback === 'up' ? '👍' : '👎'} ${a.title}`).join('; '));
    }
    if (ctx.length < 2) return res.status(200).json({ ok: true, skipped: 'not enough context yet' });

    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || 'gpt-5.5',
        max_completion_tokens: 3000,
        messages: [{ role: 'system', content: SYS }, { role: 'user', content: 'Context:\n' + ctx.join('\n\n') }],
      }),
    });
    const j = await r.json();
    if (!r.ok) return res.status(502).json({ error: j.error?.message || 'openai failed' });
    let raw = (j.choices?.[0]?.message?.content || '').trim().replace(/^```json\s*|\s*```$/g, '');
    let gen;
    try { gen = JSON.parse(raw); } catch { return res.status(200).json({ ok: false, error: 'parse', raw: raw.slice(0, 300) }); }
    if (!Array.isArray(gen)) gen = [];

    const fresh = [];
    for (const g of gen) {
      const key = norm(g.title);
      if (!key || dismissed.has(key) || existingKeys.has(key)) continue;
      const pk = PILLAR[g.pk] ? g.pk : 'purpose';
      existingKeys.add(key);
      fresh.push({
        id: 'p' + Date.now() + '_' + fresh.length,
        pk, kind: g.kind === 'signal' ? 'signal' : '',
        src: String(g.src || 'RUPERT').slice(0, 40),
        pillar: PILLAR[pk],
        title: String(g.title || '').slice(0, 120),
        why: String(g.why || '').slice(0, 240),
        act: String(g.act || '').slice(0, 200),
        at: new Date().toISOString(),
      });
    }

    const merged = [...fresh, ...existing].slice(0, 12);
    await ref.set({ proposals: merged }, { merge: true });
    return res.status(200).json({ ok: true, added: fresh.length, total: merged.length, titles: fresh.map((p) => p.title) });
  } catch (e) {
    console.error('cron-proposals', e);
    return res.status(500).json({ error: e.message });
  }
}
