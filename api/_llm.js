// Provider-agnostic chat helper so Rupert can run on OpenAI *or* Anthropic.
// The active provider is chosen per-call (from the user's Settings → "Rupert's
// brain" toggle, stored at lifeos/{uid}.settings.aiProvider) and falls back to
// the AI_PROVIDER env, then 'openai'.
//
// Env:
//   OPENAI_API_KEY  (+ optional OPENAI_BASE_URL, OPENAI_MODEL  default gpt-5.5)
//   ANTHROPIC_API_KEY (+ optional ANTHROPIC_MODEL  default claude-sonnet-4-6)
//
// Usage: const text = await llmChat({ provider, system, messages });
//   messages: [{ role:'user'|'assistant', content }]  (system passed separately)
import OpenAI from 'openai';

export function pickProvider(settings) {
  const p = (settings && settings.aiProvider) || process.env.AI_PROVIDER || 'openai';
  const want = p === 'anthropic' ? 'anthropic' : 'openai';
  // Fall back rather than crash when the chosen provider's key is missing —
  // a mis-set toggle must never take down the morning brief (2026-07-06).
  if (want === 'anthropic' && !process.env.ANTHROPIC_API_KEY) return 'openai';
  if (want === 'openai' && !process.env.OPENAI_API_KEY && process.env.ANTHROPIC_API_KEY) return 'anthropic';
  return want;
}

export async function llmChat({ provider, system, messages, maxTokens = 1500 }) {
  const msgs = (messages || []).map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: String(m.content || ''),
  }));

  if (provider === 'anthropic') {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error('Anthropic selected but ANTHROPIC_API_KEY is not set in Vercel.');
    const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: maxTokens, system: system || undefined, messages: msgs }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((j && j.error && j.error.message) || `anthropic ${r.status}`);
    return (j.content || []).map((b) => b.text || '').join('').trim();
  }

  // default: OpenAI
  const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    ...(process.env.OPENAI_BASE_URL ? { baseURL: process.env.OPENAI_BASE_URL } : {}),
  });
  const model = process.env.OPENAI_MODEL || 'gpt-5.5';
  const completion = await openai.chat.completions.create({
    model,
    messages: [...(system ? [{ role: 'system', content: system }] : []), ...msgs],
  });
  return (completion.choices?.[0]?.message?.content || '').trim();
}
