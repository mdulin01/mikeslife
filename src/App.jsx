/* global __BUILD__ */
import { useEffect, useState, useCallback, useRef } from 'react';
import { Trash2, RefreshCw } from 'lucide-react';
import { onAuthStateChanged, signInWithPopup, signOut } from 'firebase/auth';
import { FIREBASE_READY, OWNER_UID, auth, provider } from './firebase';
import { useLifeData } from './useLifeData';
import { requestPushToken } from './messaging';
import PlanningHub from './planning';
import RupertChat from './rupert';
import MemoriesView from './memories';
import VaultView from './vault';
import PurposeLearning from './learning';
import {
  PILLARS, COL, SDOT, PILLAR_LABEL,
  WEEK_DAYS, WEEK_EVENTS, MAILS, CODING_UPDATES,
} from './seed';

// One nav, two skins: bottom dock (mobile) and top bar (desktop).
// The Rupert tab (id 'home' for deep-link back-compat) holds three sub-tabs:
// Today's brief · Planning (today's items) · Signals.
const PRIMARY_TABS = [
  ['home', '🦚', 'Rupert'], ['planning', '🗺️', 'Planning'], ['calendar', '🗓️', 'Calendar'],
  ['life', '🧭', 'Life'], ['memories', '📸', 'Memories'], ['vault', '🚨', 'Vault'],
];
const HOME_SUBTABS = [
  ['brief', '☀️', "Today's brief"], ['signals', '📥', 'Signals'],
];


// Mike is US Eastern — NEVER use toISOString() for "today" (it's UTC; after ~8pm ET
// that's already tomorrow). Always format/key dates in America/New_York.
const EASTERN = 'America/New_York';
const easternYMD = (dt = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: EASTERN, year: 'numeric', month: '2-digit', day: '2-digit' }).format(dt);
const easternDisplay = (dt = new Date()) => ({
  weekday: new Intl.DateTimeFormat('en-US', { timeZone: EASTERN, weekday: 'long' }).format(dt),
  long: new Intl.DateTimeFormat('en-US', { timeZone: EASTERN, month: 'long', day: 'numeric', year: 'numeric' }).format(dt),
});
const BUILD = (typeof __BUILD__ !== 'undefined') ? __BUILD__ : 'dev';

// "Updated 4m ago" — relative time from an ISO string.
const relTime = (iso) => {
  if (!iso) return null;
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
};

// Make a model-written URL actually work: strip trailing punctuation the URL regex
// swallowed (the usual reason Spotify links 404) and re-encode Spotify search terms
// (apostrophes/quotes/colons from episode titles break the path unless encoded).
function cleanUrl(raw) {
  let url = raw.replace(/[.,;:!?"'»)\]]+$/, '');
  const m = url.match(/^https?:\/\/open\.spotify\.com\/search\/(.+)$/i);
  if (m) {
    let q; try { q = decodeURIComponent(m[1]); } catch { q = m[1]; }
    url = 'https://open.spotify.com/search/' + encodeURIComponent(q.replace(/[^\w\s-]/g, ' ').replace(/\s+/g, ' ').trim());
  }
  return url;
}

// Turn bare URLs in Rupert's text into clickable links (podcasts, recipes, travel).
function Linkified({ text }) {
  const parts = String(text || '').split(/(https?:\/\/[^\s)]+)/g);
  return parts.map((s, i) => {
    if (!/^https?:\/\//.test(s)) return <span key={i}>{s}</span>;
    const url = cleanUrl(s);
    const trail = s.slice(s.replace(/[.,;:!?"'»)\]]+$/, '').length);
    return (
      <span key={i}>
        <a href={url} target="_blank" rel="noopener noreferrer" className="clink">{url.replace(/^https?:\/\/(www\.)?/, '').split('/')[0]} ↗</a>
        {trail}
      </span>
    );
  });
}

// ───────────────────────── Alerts (Rupert push history) ─────────────────────────
const ALERT_TYPES = [
  ['all', 'All', ''],
  ['brief', 'Briefs', '☀️'],
  ['podcast', 'Podcasts', '🎧'],
  ['recipe', 'Recipes', '🍳'],
  ['mealprep', 'Meal-prep', '🥗'],
  ['travel', 'Travel', '✈️'],
  ['fitness', 'Fitness', '💪'],
  ['finance', 'Finance', '💰'],
  ['health', 'Health', '🫀'],
  ['rental', 'Rentals', '🏠'],
  ['celebrate', 'Wins', '🎉'],
  ['ainews', 'AI news', '🤖'],
];
const ALERT_EMOJI = { brief: '☀️', podcast: '🎧', recipe: '🍳', mealprep: '🥗', travel: '✈️', fitness: '💪', finance: '💰', health: '🫀', rental: '🏠', celebrate: '🎉', ainews: '🤖' };
// Spoke-app deep links — alerts about an area link back to the app that owns it.
const APP_LINKS = {
  fitness: ['mikesfitness', 'https://mikesfitness.app'],
  finance: ['mikes-money', 'https://www.mikesmoney.app'],
  health: ['mikeshealth', 'https://mikeshealth.app'],
  rental: ['rainbow rentals', 'https://rainbowrentals.app'],
  celebrate: ['mikesfitness', 'https://mikesfitness.app'],
};
const RECENT_DAYS = 5;

// Structured items inside a content alert (one per podcast/recipe/idea).
// New alerts carry items[] from the cron; legacy text alerts get split heuristically.
function alertItems(a) {
  if (Array.isArray(a.items) && a.items.length) return a.items;
  if (a.type === 'brief' || a.type === 'celebrate') return null;
  const chunks = String(a.text || '').split(/\n\s*\n/).map((c) => c.trim()).filter(Boolean);
  if (chunks.length < 2 || chunks.length > 6) return null;
  return chunks.map((c) => {
    const lines = c.split('\n').map((l) => l.trim());
    const link = (c.match(/https?:\/\/[^\s)]+/) || [null])[0];
    return {
      t: lines[0].replace(/^[-•*\d.)\s]+/, '').slice(0, 90),
      s: lines.slice(1).filter((l) => l && !/^https?:\/\//.test(l) && !/^Listen:/i.test(l)).join(' '),
      link, feedback: null,
    };
  });
}

// First real CONTENT line of a Rupert text: skips greetings, bare section headers
// ("Top of mind:", "FYI:"), and URLs — so collapsed cards preview substance, not scaffolding.
const firstContentLine = (text) => {
  const line = String(text || '').split('\n').map((s) => s.trim())
    .filter((s) => s && !/^https?:\/\//.test(s) && !/^Listen:/i.test(s) && !/^good morning/i.test(s) && !/^[^-•🥇🥈🥉].{0,28}:$/.test(s))[0] || '';
  return line.replace(/^[-•]\s*/, '');
};
const alertSnippet = (a) => {
  const line = firstContentLine(a.text);
  return line.length > 90 ? line.slice(0, 90) + '…' : line;
};
const isRecent = (a) => a.at && (Date.now() - new Date(a.at).getTime()) < RECENT_DAYS * 86400 * 1000;

// The last few days of alerts as tappable 1–2 line summaries (body of a Collapse).
function RecentAlerts({ alerts, onOpen, onAll, onSearch }) {
  const recent = alerts.filter(isRecent).slice(0, 8);
  const older = alerts.length - recent.length;
  return (
    <>
      {recent.length ? recent.map((a) => (
        <div className="loop" key={a.id} onClick={() => onOpen(a.id)} style={{ cursor: 'pointer' }}>
          <div className="dot" style={{ background: 'var(--sky)' }} />
          <div style={{ minWidth: 0 }}>
            <div className="lt">{ALERT_EMOJI[a.type] || '🔔'} {a.title || a.type} <span className="dim" style={{ fontWeight: 400, fontSize: 11 }}>· {relTime(a.at)}</span></div>
            <div className="lm">{alertSnippet(a)}</div>
          </div>
        </div>
      )) : <p className="dim" style={{ fontSize: 13 }}>Nothing in the last {RECENT_DAYS} days.</p>}
      <div className="row" style={{ gap: 8, marginTop: 10 }}>
        <button className="btn def" style={{ fontSize: 12 }} onClick={onSearch}>🔎 Search</button>
        {older > 0 && <button className="btn def" style={{ fontSize: 12 }} onClick={onAll}>Prior alerts ({older}) →</button>}
      </div>
    </>
  );
}

// Per-type mute toggles — producers (crons + mini scripts) skip muted types.
function AlertPrefs({ prefs, setPref }) {
  const p = { brief: true, podcast: true, recipe: true, mealprep: true, travel: true, fitness: true, finance: true, health: true, rental: true, celebrate: true, ainews: true, ...(prefs || {}) };
  return (
    <div className="card">
      <div className="subhead" style={{ marginTop: 0 }}>Notification types <span className="dim" style={{ textTransform: 'none', fontWeight: 500 }}>· tap to mute/unmute</span></div>
      <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
        {ALERT_TYPES.filter(([k]) => k !== 'all').map(([k, label, em]) => (
          <button key={k} className="pill" onClick={() => setPref(k, !p[k])}
            style={{ cursor: 'pointer', border: '1px solid var(--line)', background: p[k] ? 'var(--teal)' : 'var(--panel2)', color: p[k] ? '#04201c' : 'var(--mut)', opacity: p[k] ? 1 : .7 }}>
            {em} {label} {p[k] ? '' : '🔇'}
          </button>
        ))}
      </div>
    </div>
  );
}

// Full history: search + type filter, tap an alert to open it.
function AlertsView({ alerts, onOpen, onBack, autoFocusSearch, prefs, setPref }) {
  const [q, setQ] = useState('');
  const [type, setType] = useState('all');
  const inputRef = useRef(null);
  useEffect(() => { if (autoFocusSearch && inputRef.current) inputRef.current.focus(); }, [autoFocusSearch]);
  const shown = alerts.filter((a) => (type === 'all' || a.type === type)
    && (!q.trim() || ((a.title || '') + ' ' + (a.text || '')).toLowerCase().includes(q.trim().toLowerCase())));
  return (
    <section>
      <button className="backbtn" onClick={onBack}>‹ back</button>
      <div className="card">
        <h3>🔔 All alerts</h3>
        <input ref={inputRef} type="text" placeholder="Search alerts…" value={q} onChange={(e) => setQ(e.target.value)}
          style={{ width: '100%', boxSizing: 'border-box', marginTop: 8 }} />
        <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
          {ALERT_TYPES.map(([k, label, em]) => (
            <button key={k} className="pill" onClick={() => setType(k)}
              style={{ cursor: 'pointer', border: '1px solid var(--line)', background: type === k ? 'var(--teal)' : 'var(--panel2)', color: type === k ? '#04201c' : 'var(--mut)' }}>
              {em} {label}
            </button>
          ))}
        </div>
        <div style={{ marginTop: 12 }}>
          {shown.length ? shown.map((a) => (
            <div className="loop" key={a.id} onClick={() => onOpen(a.id)} style={{ cursor: 'pointer' }}>
              <div className="dot" style={{ background: 'var(--sky)' }} />
              <div style={{ minWidth: 0 }}>
                <div className="lt">{ALERT_EMOJI[a.type] || '🔔'} {a.title || a.type}
                  <span className="dim" style={{ fontWeight: 400, fontSize: 11 }}> · {relTime(a.at)}</span>
                  {a.feedback && <span style={{ fontSize: 11 }}> {a.feedback === 'up' ? '👍' : '👎'}</span>}</div>
                <div className="lm">{alertSnippet(a)}</div>
              </div>
            </div>
          )) : <p className="dim" style={{ fontSize: 13 }}>No alerts match.</p>}
        </div>
      </div>
      <AlertPrefs prefs={prefs} setPref={setPref} />
    </section>
  );
}

// ───────────────────────── Global search ─────────────────────────
// One box across plans, tasks, people, memories, documents, and alerts.
function SearchView({ data, onBack, onOpenAlert, goTab }) {
  const [q, setQ] = useState('');
  const inputRef = useRef(null);
  useEffect(() => { if (inputRef.current) inputRef.current.focus(); }, []);
  const ql = q.trim().toLowerCase();
  const has = (s) => String(s || '').toLowerCase().includes(ql);

  const hits = [];
  if (ql.length >= 2) {
    (data.plans || []).forEach((p) => {
      if (has(p.title) || has(p.note)) hits.push({ icon: '🗺️', kind: 'Plan', title: p.title, sub: `${PILLAR_LABEL[p.pk] || ''} · ${p.status}`, go: () => goTab('planning') });
      (p.stages || []).forEach((s) => (s.tasks || []).forEach((t) => {
        if (has(t.text)) hits.push({ icon: t.done ? '✅' : '☑️', kind: 'Step', title: t.text, sub: p.title, go: () => goTab('planning') });
      }));
    });
    (data.todayItems || []).forEach((t) => { if (has(t.title)) hits.push({ icon: '🎯', kind: 'Today', title: t.title, sub: t.status + (t.until ? ' until ' + t.until : ''), go: () => goTab('home') }); });
    Object.entries(data.people || {}).forEach(([g, list]) => (list || []).forEach((pp) => {
      if (has(pp.name) || has(pp.meta)) hits.push({ icon: '👤', kind: 'Person', title: pp.name, sub: pp.meta || g, go: () => goTab('people') });
    }));
    (data.memories || []).forEach((m) => { if (has(m.text)) hits.push({ icon: '📸', kind: 'Memory', title: m.text.slice(0, 70), sub: m.date || '', go: () => goTab('memories') }); });
    (data.documents || []).forEach((dd) => { if (has(dd.title) || has(dd.body)) hits.push({ icon: '📄', kind: 'Document', title: dd.title, sub: '', go: () => goTab('memories') }); });
    (data.alerts || []).forEach((a) => { if (has(a.title) || has(a.text)) hits.push({ icon: ALERT_EMOJI[a.type] || '🔔', kind: 'Alert', title: a.title || a.type, sub: relTime(a.at), go: () => onOpenAlert(a.id) }); });
    (data.goodTime || []).forEach((g) => { if (has(g.activity)) hits.push({ icon: '⚡', kind: 'Energy log', title: g.activity, sub: `energy ${g.energy}`, go: () => goTab('planning') }); });
  }

  return (
    <section>
      <button className="backbtn" onClick={onBack}>‹ back</button>
      <div className="card">
        <h3>🔎 Search everything</h3>
        <input ref={inputRef} type="text" placeholder="Plans, steps, people, memories, documents, alerts…" value={q} onChange={(e) => setQ(e.target.value)}
          style={{ width: '100%', boxSizing: 'border-box', marginTop: 8 }} />
        <div style={{ marginTop: 12 }}>
          {ql.length < 2 ? <p className="dim" style={{ fontSize: 13 }}>Type at least 2 characters.</p>
            : hits.length ? hits.slice(0, 30).map((h, i) => (
              <div className="loop" key={i} onClick={h.go} style={{ cursor: 'pointer' }}>
                <div className="dot" style={{ background: 'var(--teal)' }} />
                <div style={{ minWidth: 0 }}>
                  <div className="lt">{h.icon} {h.title} <span className="pill" style={{ background: 'rgba(148,163,184,.14)', color: 'var(--mut)', marginLeft: 6 }}>{h.kind}</span></div>
                  {h.sub && <div className="lm">{h.sub}</div>}
                </div>
              </div>
            )) : <p className="dim" style={{ fontSize: 13 }}>No matches.</p>}
        </div>
      </div>
    </section>
  );
}

// One alert, full screen: read, follow links, rate it (per item!), act on it.
const ALERT_PILLAR = { recipe: 'health', mealprep: 'health', podcast: 'purpose', travel: 'fun', brief: 'purpose', fitness: 'health', finance: 'fin', health: 'health', rental: 'fin', celebrate: 'health' };

function AlertDetail({ alert: a, onBack, onFeedback, onItemFeedback, onDelete, openRupert, addTodayItem, addPlan }) {
  const [actMsg, setActMsg] = useState('');
  if (!a) return null;
  const pk = ALERT_PILLAR[a.type] || 'fun';
  const items = alertItems(a);
  const app = APP_LINKS[a.type];
  const fbBtn = (cur, on, fb, em) => (
    <button className="btn def" style={{ padding: '4px 9px', fontSize: 12, ...(cur === fb ? { background: 'var(--teal)', color: '#04201c', borderColor: 'var(--teal)' } : {}) }} onClick={on}>{em}</button>
  );
  const actLabel = { recipe: 'Cook tonight', mealprep: 'Do the meal-prep', podcast: 'Listen on the commute', travel: 'Look into this trip' }[a.type] || (a.title || a.type);
  return (
    <section className="focusview">
      <button className="backbtn" onClick={onBack}>‹ back</button>
      <div className="card" style={{ borderLeft: '3px solid var(--sky)', fontSize: 15, lineHeight: 1.6 }}>
        <div className="between">
          <h3 style={{ margin: 0 }}>{ALERT_EMOJI[a.type] || '🔔'} {a.title || a.type}</h3>
          <span className="dim" style={{ fontSize: 11, flex: '0 0 auto' }}>{relTime(a.at)}</span>
        </div>
        {items ? (
          <div style={{ marginTop: 10 }}>
            {items.map((it, i) => (
              <div key={i} style={{ border: '1px solid var(--line)', borderRadius: 12, padding: '10px 12px', marginBottom: 8, opacity: it.feedback === 'down' ? .5 : 1 }}>
                <div className="lt" style={{ fontSize: 14 }}>{it.t}</div>
                {it.s && <div className="lm" style={{ marginTop: 3 }}>{it.s}</div>}
                <div className="row" style={{ gap: 6, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  {it.link && <a className="btn app" style={{ padding: '4px 10px', fontSize: 12, textDecoration: 'none' }} href={cleanUrl(it.link)} target="_blank" rel="noopener noreferrer">{a.type === 'podcast' ? '▶ Listen' : 'Open ↗'}</a>}
                  {fbBtn(it.feedback, () => onItemFeedback(a.id, items, i, 'up'), 'up', '👍')}
                  {fbBtn(it.feedback, () => onItemFeedback(a.id, items, i, 'down'), 'down', '👎')}
                  <button className="btn def" style={{ padding: '4px 9px', fontSize: 12 }} onClick={() => { addTodayItem({ title: it.t.slice(0, 70), why: a.title || 'from Rupert', pk }); setActMsg(`"${it.t.slice(0, 30)}…" added to Today ✓`); }}>➕ Today</button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div style={{ marginTop: 10, whiteSpace: 'pre-wrap' }}><Linkified text={a.text} /></div>
        )}
      </div>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        {app && <a className="btn app" style={{ textDecoration: 'none' }} href={a.appUrl || app[1]} target="_blank" rel="noopener noreferrer">Open {app[0]} ↗</a>}
        {!items && <button className="btn app" onClick={() => { addTodayItem({ title: actLabel, why: a.title || 'from Rupert', pk }); setActMsg('Added to Today ✓'); }}>➕ Add to Today</button>}
        <button className="btn def" onClick={() => { addPlan(a.title || actLabel, pk, String(a.text || '').slice(0, 500)); setActMsg('Saved to Plans (someday) ✓'); }}>📌 Save as plan</button>
        <button className="btn def" onClick={() => openRupert(`About your "${a.title || a.type}" alert from ${relTime(a.at)} — tell me more.`)}>Ask Rupert</button>
      </div>
      {actMsg && <p className="dim" style={{ fontSize: 12, margin: '6px 2px' }}>{actMsg}</p>}
      <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
        {!items && fbBtn(a.feedback, () => onFeedback(a.id, 'up'), 'up', '👍 Helpful')}
        {!items && fbBtn(a.feedback, () => onFeedback(a.id, 'down'), 'down', '👎 Not helpful')}
        <button className="btn def" onClick={() => { onDelete(a.id); onBack(); }} style={{ color: 'var(--rose)' }}><Trash2 size={14} style={{ verticalAlign: '-2px' }} /> Delete</button>
      </div>
      <p className="banner">{items ? 'Rate each item — 👎 fades it and Rupert sends fewer like it; 👍 means more.' : '👍/👎 teaches Rupert what’s worth sending.'}</p>
    </section>
  );
}

// ───────────────────────── Login ─────────────────────────
function Login({ onSignIn, error }) {
  return (
    <div className="login">
      <h1>Mike's <b>Life</b></h1>
      <p>Your strategic hub — the layer above the apps. Sign in to continue.</p>
      <button onClick={onSignIn}>Sign in with Google</button>
      {error && <div className="err">{error}</div>}
    </div>
  );
}

// ───────────────────────── Views ─────────────────────────

// Collapsible home-page card: one line collapsed (title + sub), tap to expand.
function Collapse({ icon, title, sub, right, defaultOpen = false, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="card">
      <div className="between" style={{ cursor: 'pointer', alignItems: 'center', gap: 8 }} onClick={() => setOpen(!open)}>
        <h3 style={{ margin: 0 }}>{icon} {title}</h3>
        <span className="dim" style={{ fontSize: 12, flex: '0 0 auto' }}>{right}{right ? ' ' : ''}{open ? '▾' : '▸'}</span>
      </div>
      {!open && sub && <div className="lm" style={{ marginTop: 6, cursor: 'pointer' }} onClick={() => setOpen(true)}>{sub}</div>}
      {open && <div style={{ marginTop: 10 }}>{children}</div>}
    </div>
  );
}

// ── Today engine (no check-in — capacity is assumed: 4-5 items/day) ──
const DELAYS = [['1 day', 1], ['1 week', 7], ['1 month', 30]];

// Daily roll-forward: sleeping delays stay hidden, due delays resurface,
// yesterday's done/untouched items drop, fresh items come from active plans.
function generateTodayItems(prev, plans, today, doneLedger, dismissed) {
  const old = prev || [];
  const recentlyDone = new Set([...(doneLedger || []), ...(dismissed || [])].map((e) => e.title));
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

// ── ② Plan-step dialogs ──────────────────────────────────────────────────────
// A Today one-liner that came from a plan task opens a sheet showing the step in
// context, with an input whose answer is saved onto the plan task (task.note).
function findPlanStep(plans, t) {
  for (const p of (plans || [])) {
    if (t.planId && p.id !== t.planId) continue;
    for (const s of (p.stages || [])) {
      const task = (s.tasks || []).find((x) => x.text === t.title);
      if (task) return { plan: p, stage: s, task };
    }
    if (t.planId) return null;
  }
  return null;
}

function StepDialog({ step, onClose, setTaskNote, toggleTask, markTodayDone }) {
  const { plan, stage, task, todayId } = step;
  const [note, setNote] = useState(task.note || '');
  const save = (alsoDone) => {
    if (note.trim() !== (task.note || '')) setTaskNote(plan.id, stage.id, task.id, note);
    if (alsoDone) {
      if (!task.done) toggleTask(plan.id, stage.id, task.id);
      if (todayId) markTodayDone(todayId);
    }
    onClose();
  };
  return (
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-rupert" style={{ maxWidth: 480 }}>
        <div className="section-title" style={{ marginBottom: 2 }}>🎯 {task.text}</div>
        <div className="dim" style={{ fontSize: 12, marginBottom: 12 }}>{plan.title} · {stage.title}{task.done ? ' · ✓ done' : ''}</div>
        <textarea className="step-input" rows={4} autoFocus placeholder="Your answer / notes for this step…"
          value={note} onChange={(e) => setNote(e.target.value)} />
        <div className="row" style={{ gap: 8, marginTop: 12, justifyContent: 'flex-end' }}>
          <button className="btn def" onClick={onClose}>Cancel</button>
          <button className="btn def" onClick={() => save(false)}>Save</button>
          {!task.done && <button className="btn app" onClick={() => save(true)}>Save &amp; done ✓</button>}
        </div>
      </div>
    </div>
  );
}

function TodayItemRow({ t, onDone, onDelay, onStep, onDelete }) {
  const [menu, setMenu] = useState(false);
  const done = t.status === 'done';
  return (
    <div className="loop" style={{ alignItems: 'center' }}>
      <div className="dot" style={{ background: `var(${COL[t.pk] || '--teal'})` }} />
      <div style={{ flex: 1, minWidth: 0, cursor: onStep ? 'pointer' : 'default' }} onClick={onStep || undefined}>
        <div className="lt" style={done ? { textDecoration: 'line-through', opacity: .55 } : {}}>{t.icon ? t.icon + ' ' : ''}{t.title}{onStep ? <span className="dim" style={{ fontSize: 12 }}> ›</span> : null}</div>
        {t.why && <div className="lm">{t.why}</div>}
      </div>
      <div className="row" style={{ gap: 6, flex: '0 0 auto', position: 'relative', alignItems: 'center' }}>
        <button className="btn app" title={done ? 'Undo' : 'Done'} style={{ padding: '5px 11px', fontSize: 12 }} onClick={() => onDone(t.id)}>{done ? '↩︎' : '✓'}</button>
        {!done && <button className="btn def" title="Delay" style={{ padding: '5px 9px', fontSize: 12 }} onClick={() => setMenu(!menu)}>⏰</button>}
        {!done && onDelete && <button className="btn def" title="Delete — won't come back" style={{ padding: '5px 9px', fontSize: 12 }} onClick={() => onDelete(t)}>🗑</button>}
        {menu && (
          <div style={{ position: 'absolute', right: 0, top: '108%', zIndex: 60, background: 'var(--panel2)', border: '1px solid var(--line)', borderRadius: 10, overflow: 'hidden', boxShadow: '0 6px 18px rgba(0,0,0,.4)' }}>
            {DELAYS.map(([label, days]) => (
              <button key={days} className="btn def" style={{ display: 'block', width: '100%', border: 'none', borderRadius: 0, textAlign: 'left', fontSize: 12, whiteSpace: 'nowrap' }}
                onClick={() => { setMenu(false); onDelay(t.id, days); }}>+ {label}</button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// Make the brief's 🥇🥈🥉 focus lines tappable: matching plan → activate + open
// Planning; already on today's list → just confirm; otherwise → add to Today.
function BriefActions({ brief, plans, todayItems, activatePlan, addTodayItem, goTab, toggleTask, setPlanStatus, markTodayDone }) {
  const [msg, setMsg] = useState('');
  const norm = (s) => String(s || '').toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const overlap = (a, b) => { const x = norm(a), y = norm(b); return x.length > 3 && y.length > 3 && (x.includes(y) || y.includes(x)); };
  const lines = String(brief || '').split('\n')
    .map((l) => { const m = l.match(/^\s*(?:🥇|🥈|🥉)\s*(.+)$/u); return m ? m[1].replace(/[.。]\s*$/, '').trim() : null; })
    .filter(Boolean).slice(0, 3);
  if (!lines.length) return null;
  const act = (line) => {
    const n = norm(line);
    const plan = (plans || []).find((p) => overlap(p.title, line));
    if (plan) {
      if (plan.status !== 'active' && plan.status !== 'done') activatePlan(plan.id);
      goTab('planning');
      return;
    }
    const onList = (todayItems || []).some((t) => norm(t.title) === n);
    if (onList) { setMsg(`"${line}" is already on Today ✓`); return; }
    addTodayItem({ title: line, why: "from Rupert's brief", pk: 'purpose' });
    setMsg(`"${line}" added to Today ✓`);
  };
  // "Already handled IRL" — stop Rupert from recycling this item tomorrow.
  // Marks the matching plan task done, else the whole plan done, else the Today item done.
  const markHandled = (line) => {
    for (const pl of (plans || [])) {
      for (const s of (pl.stages || [])) {
        for (const t of (s.tasks || [])) {
          if (!t.done && overlap(t.text, line)) { toggleTask(pl.id, s.id, t.id); setMsg(`Marked "${line.slice(0, 30)}…" handled ✓`); return; }
        }
      }
    }
    const plan = (plans || []).find((p) => overlap(p.title, line));
    if (plan) { setPlanStatus(plan.id, 'done'); setMsg(`Marked plan "${plan.title}" done ✓`); return; }
    const item = (todayItems || []).find((t) => norm(t.title) === norm(line));
    if (item && item.status !== 'done') { markTodayDone(item.id); setMsg(`Marked "${line.slice(0, 30)}…" done ✓`); return; }
    setMsg(`Couldn't match "${line.slice(0, 30)}…" — mark it done in Plans.`);
  };
  return (
    <div style={{ marginTop: 12 }}>
      <div className="dim" style={{ fontSize: 11, marginBottom: 6 }}>Act on these — tap to plan/add, or ✓ if already handled:</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {lines.map((l, i) => (
          <div key={i} className="row" style={{ gap: 6, alignItems: 'center' }}>
            <button className="btn def" style={{ fontSize: 12, flex: 1, textAlign: 'left' }} onClick={() => act(l)}>{['🥇', '🥈', '🥉'][i]} {l.slice(0, 46)} →</button>
            <button className="btn def" title="Already handled — stop showing this" style={{ fontSize: 12 }} onClick={() => markHandled(l)}>✓</button>
          </div>
        ))}
      </div>
      {msg && <div className="dim" style={{ fontSize: 12, marginTop: 6 }}>{msg}</div>}
    </div>
  );
}


// ───────────────────────── Morning check-in: plan the day with Rupert ─────────────────────────
// Rupert's standing jobs. via:'telegram' = runs on the Mac mini (queued), via:'app' = cloud, results land as alerts.
const RUPERT_JOBS = [
  { kind: 'adamjobs', label: "Send Adam job updates", icon: '💼', via: 'telegram', recDays: [1, 4] },
  { kind: 'social', label: 'Social listener — age-gap couples', icon: '📡', via: 'telegram', recDays: [2] },
  { kind: 'ainews', label: 'Healthcare AI news scan', icon: '🤖', via: 'app', recDays: [1, 2, 3, 4, 5] },
  { kind: 'podcast', label: 'Find podcasts for the commute', icon: '🎧', via: 'app', recDays: [3, 4] },
  { kind: 'recipe', label: "Dinner recipes for tonight", icon: '🍳', via: 'app', recDays: [1, 2] },
  { kind: 'mealprep', label: 'Sunday meal-prep plan', icon: '🥗', via: 'app', recDays: [0] },
  { kind: 'travel', label: 'Travel ideas', icon: '✈️', via: 'app', recDays: [6, 0] },
];

// Wellness catalog — exercise FIRST, then fuel/health/social/cognitive.
// rec(dow, fitnessContext) marks Rupert's strategic pick for the day.
const lastGymWas = (fc) => {
  const t = String(fc || '').toLowerCase();
  const u = t.indexOf('upper'); const l = Math.max(t.indexOf('leg'), t.indexOf('lower'), t.indexOf('squat'));
  if (u === -1 && l === -1) return null;
  if (l === -1) return 'upper'; if (u === -1) return 'legs';
  return u < l ? 'upper' : 'legs'; // entries newest-first: smaller index = more recent
};
const WELLNESS = [
  { section: '🏃 Move (pick at least one)', pk: 'health', items: [
    { id: 'w_swim', icon: '🏊', title: 'Swim', rec: (d) => [3, 6, 0].includes(d), why: d => d === 3 ? 'Wednesday — after clinic' : 'weekend swim' },
    { id: 'w_gym_up', icon: '🏋️', title: 'Gym — upper body', rec: (d, fc) => [4, 6, 0].includes(d) && lastGymWas(fc) === 'legs', why: () => 'YMCA — alternate from last session' },
    { id: 'w_gym_legs', icon: '🦵', title: 'Gym — legs day', rec: (d, fc) => [4, 6, 0].includes(d) && lastGymWas(fc) !== 'legs', why: () => 'YMCA — alternate from last session' },
    { id: 'w_walk', icon: '🚶', title: 'Evening walk', rec: () => true, why: () => 'the daily anchor' },
    { id: 'w_run', icon: '👟', title: 'Run (stretch goal)', rec: () => false, why: () => "you've been wanting more of this" },
    { id: 'w_bike', icon: '🚴', title: 'Bike (stretch goal)', rec: () => false, why: () => "you've been wanting more of this" },
  ]},
  { section: '🍎 Fuel', pk: 'health', items: [
    { id: 'n_protein', icon: '🥩', title: 'High-protein day', rec: () => true },
    { id: 'n_hydrate', icon: '💧', title: 'Hydrate 3L', rec: () => false },
    { id: 'n_noalc', icon: '🚫', title: 'No alcohol tonight', rec: () => false },
  ]},
  { section: '🫀 Health', pk: 'health', items: [
    { id: 'h_meds', icon: '💊', title: 'Meds & supplements on schedule', rec: () => true },
    { id: 'h_bp', icon: '🩺', title: 'Log blood pressure', rec: () => true },
    { id: 'h_stretch', icon: '🧘', title: 'Stretch / mobility 10 min', rec: () => false },
  ]},
  { section: '🤝 Social', pk: 'rel', items: [
    { id: 's_friend', icon: '💬', title: 'Text or call a friend', rec: (d) => [1, 3, 5].includes(d) },
    { id: 's_adam', icon: '❤️', title: 'Plan something with Adam', rec: (d) => [5].includes(d) },
    { id: 's_quiet', icon: '🤝', title: 'Reach out to someone gone quiet', rec: () => false },
  ]},
  { section: '🧠 Cognitive', pk: 'purpose', items: [
    { id: 'c_read', icon: '📚', title: 'Read 30 minutes', rec: () => true },
    { id: 'c_learn', icon: '🎓', title: 'One Learning-hub item', rec: (d) => [2, 4].includes(d) },
    { id: 'c_puzzle', icon: '♟️', title: 'Puzzle / chess', rec: () => false },
    { id: 'c_journal', icon: '✍️', title: 'Journal a few lines', rec: () => false },
  ]},
];

// Drag-to-rank list (pointer-based so it works on the iPhone PWA) + ↑↓ fallback.
function RankList({ items, setItems }) {
  const [dragId, setDragId] = useState(null);
  const refs = useRef({});
  const onMove = (e) => {
    if (!dragId) return;
    const y = e.clientY;
    const ids = items.map((i) => i.id);
    const from = ids.indexOf(dragId);
    let to = from;
    for (const [id, el] of Object.entries(refs.current)) {
      if (!el || id === dragId) continue;
      const r = el.getBoundingClientRect();
      if (y > r.top && y < r.bottom) { to = ids.indexOf(id); break; }
    }
    if (to !== from && to >= 0) {
      const n = [...items]; const [m] = n.splice(from, 1); n.splice(to, 0, m); setItems(n);
    }
  };
  const bump = (id, dir) => {
    const i = items.findIndex((x) => x.id === id); const j = i + dir;
    if (i < 0 || j < 0 || j >= items.length) return;
    const n = [...items]; [n[i], n[j]] = [n[j], n[i]]; setItems(n);
  };
  return (
    <div onPointerMove={onMove} onPointerUp={() => setDragId(null)} onPointerCancel={() => setDragId(null)}>
      {items.map((it, i) => (
        <div key={it.id} ref={(el) => { refs.current[it.id] = el; }} className="loop"
          style={{ alignItems: 'center', borderRadius: 10, padding: '7px 6px', background: dragId === it.id ? 'rgba(45,212,191,.14)' : 'transparent', border: dragId === it.id ? '1px dashed var(--teal)' : '1px solid transparent' }}>
          <span onPointerDown={(e) => { e.preventDefault(); setDragId(it.id); e.currentTarget.setPointerCapture?.(e.pointerId); }}
            style={{ cursor: 'grab', padding: '2px 10px 2px 2px', fontSize: 18, color: 'var(--mut)', touchAction: 'none', userSelect: 'none' }} title="Drag to reorder">≡</span>
          <span className="pill" style={{ background: 'var(--teal)', color: '#04201c', fontWeight: 700, marginRight: 8 }}>{i + 1}</span>
          <div className="lt" style={{ flex: 1, minWidth: 0 }}>{it.icon ? it.icon + ' ' : ''}{it.title}</div>
          <div className="row" style={{ gap: 4, flex: '0 0 auto' }}>
            <button className="btn def" style={{ padding: '2px 8px', fontSize: 12 }} onClick={() => bump(it.id, -1)}>↑</button>
            <button className="btn def" style={{ padding: '2px 8px', fontSize: 12 }} onClick={() => bump(it.id, 1)}>↓</button>
          </div>
        </div>
      ))}
    </div>
  );
}

function CheckInView({ data, submitDayPlan, saveCheckin, onDone, dismissTask }) {
  const today = easternYMD();
  const dow = new Date(new Date().toLocaleString('en-US', { timeZone: EASTERN })).getDay();
  const fc = data.fitnessContext;

  // Plan/task candidates (pending items + fresh steps from active plans).
  // Titles on the done or dismissed ledgers never reappear here — that's the
  // "I deleted 'Ask Josh' but it keeps coming back" fix.
  const initialCands = () => {
    const out = [];
    const hidden = new Set([...(data.doneLedger || []), ...(data.dismissed || [])].map((e) => e.title));
    const seen = new Set(hidden);
    for (const t of (data.todayItems || [])) if (t.status === 'pending' && !seen.has(t.title)) { seen.add(t.title); out.push({ ...t, icon: '📌' }); }
    const active = (data.plans || []).filter((p) => p.status === 'active');
    outer: for (let round = 0; round < 5; round++) {
      for (const p of active) {
        const open = (p.stages || []).flatMap((st) => st.tasks || []).filter((x) => !x.done);
        const task = open[round];
        if (!task || seen.has(task.text)) continue;
        seen.add(task.text);
        out.push({ id: 'td' + Date.now() + '_' + out.length, title: task.text, why: p.title, pk: p.pk, planId: p.id, status: 'pending', until: null, icon: '📌' });
        if (out.length >= 8) break outer;
      }
    }
    return out;
  };
  const [cands, setCands] = useState(initialCands);

  // One unified ordered selection (exercise recs first — health is the priority).
  const wellnessItem = (w, sec) => ({ id: w.id, title: w.title, icon: w.icon, why: w.why ? w.why(dow) : sec.section.replace(/^[^ ]+ /, ''), pk: sec.pk, status: 'pending', until: null });
  const [picked, setPicked] = useState(() => {
    const out = [];
    for (const sec of WELLNESS) for (const w of sec.items) if (w.rec(dow, fc)) out.push(wellnessItem(w, sec));
    for (const c of cands.slice(0, 2)) out.push(c);
    return out;
  });
  // Delete a candidate for good: drop it here + record it on the dismissed ledger.
  const dropCand = (c) => {
    setCands((list) => list.filter((x) => x.id !== c.id));
    setPicked((list) => list.filter((x) => x.id !== c.id));
    if (dismissTask) dismissTask({ title: c.title, planId: c.planId, id: c.id });
  };
  const [jobs, setJobs] = useState(() => RUPERT_JOBS.filter((j) => j.recDays.includes(dow)).map((j) => j.kind));
  const [busy, setBusy] = useState(false);
  const c0 = data.checkin && data.checkin.date === today ? data.checkin : {};
  const [energy, setEnergy] = useState(c0.energy ?? 6);
  const [mood, setMood] = useState(c0.mood ?? 6);
  const [capacity, setCapacity] = useState(c0.capacity ?? 6);

  const isPicked = (id) => picked.some((p) => p.id === id);
  const togglePick = (item) => setPicked((c) => isPicked(item.id) ? c.filter((x) => x.id !== item.id) : [...c, item]);

  const Chip = ({ on, rec, onClick, children }) => (
    <button onClick={onClick} className="pill"
      style={{ cursor: 'pointer', border: '1px solid ' + (on ? 'var(--teal)' : 'var(--line)'), background: on ? 'rgba(45,212,191,.18)' : 'var(--panel2)', color: on ? 'var(--teal)' : 'var(--mut)', padding: '7px 11px', fontSize: 13 }}>
      {rec && '⭐ '}{children}{on && ' ✓'}
    </button>
  );

  const submit = async () => {
    setBusy(true);
    const delayed = (data.todayItems || []).filter((t) => t.status === 'delayed');
    const items = picked.map((p) => ({ id: p.id, title: p.title, why: p.why || '', pk: p.pk || 'health', planId: p.planId || null, status: 'pending', until: null, icon: p.icon || null }));
    const rupertTasks = RUPERT_JOBS.filter((j) => jobs.includes(j.kind)).map((j) => ({ id: 'rt' + Date.now() + '_' + j.kind, kind: j.kind, label: j.label, icon: j.icon, via: j.via, status: 'pending' }));
    if (saveCheckin) saveCheckin({ date: today, energy, mood, capacity });
    submitDayPlan([...items, ...delayed], rupertTasks, today);
    try {
      const token = auth?.currentUser ? await auth.currentUser.getIdToken() : null;
      if (token && jobs.length) await fetch('/api/run-tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken: token, tasks: jobs }) });
    } catch (e) { console.warn('run-tasks', e); }
    setBusy(false);
    onDone();
  };

  const Slider = ({ label, val, set, emoji }) => (
    <div style={{ flex: '1 1 150px' }}>
      <div className="row" style={{ justifyContent: 'space-between', fontSize: 12, marginBottom: 2 }}><span className="dim">{label}</span><span style={{ fontWeight: 600 }}>{emoji} {val}/10</span></div>
      <input type="range" min="1" max="10" value={val} onChange={(e) => set(+e.target.value)} style={{ width: '100%', accentColor: 'var(--teal)' }} />
    </div>
  );
  return (
    <section className="focusview">
      <div className="card" style={{ borderLeft: '3px solid var(--teal)' }}>
        <h3 style={{ marginBottom: 8 }}>How are you today?</h3>
        <div className="row" style={{ gap: 14, flexWrap: 'wrap' }}>
          <Slider label="Energy" val={energy} set={setEnergy} emoji="⚡" />
          <Slider label="Mood" val={mood} set={setMood} emoji={mood <= 3 ? '😣' : mood <= 6 ? '🙂' : '😄'} />
          <Slider label="Capacity" val={capacity} set={setCapacity} emoji="🎚️" />
        </div>
      </div>
      {WELLNESS.map((sec) => (
        <div className="card" key={sec.section} style={sec.section.startsWith('🏃') ? { borderLeft: '3px solid var(--emerald)' } : {}}>
          <h3 style={{ marginBottom: 8 }}>{sec.section}</h3>
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            {sec.items.map((w) => (
              <Chip key={w.id} on={isPicked(w.id)} rec={w.rec(dow, fc)} onClick={() => togglePick(wellnessItem(w, sec))}>{w.icon} {w.title}</Chip>
            ))}
          </div>
        </div>
      ))}

      <div className="card">
        <h3 style={{ marginBottom: 8 }}>📌 Tasks & plans <span className="dim" style={{ fontWeight: 500, textTransform: 'none', fontSize: 12 }}>· tap to add · ✕ to delete for good</span></h3>
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          {cands.length ? cands.map((c, i) => (
            <span key={c.id} className="candwrap">
              <Chip on={isPicked(c.id)} rec={i < 2} onClick={() => togglePick(c)}>
                {c.title.slice(0, 40)}{c.why ? <span className="dim" style={{ fontWeight: 500 }}> · {String(c.why).slice(0, 22)}</span> : null}
              </Chip>
              <button className="canddel" title="Delete this task — it won't come back" onClick={() => dropCand(c)}>✕</button>
            </span>
          )) : <p className="dim" style={{ fontSize: 13 }}>No open plan steps — activate a plan in Planning.</p>}
        </div>
      </div>

      <div className="card" style={{ borderLeft: '3px solid var(--violet)' }}>
        <h3 style={{ marginBottom: 8 }}>🛠️ Rupert's assignments <span className="dim" style={{ fontWeight: 500, textTransform: 'none', fontSize: 12 }}>· 📡 = Telegram</span></h3>
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          {RUPERT_JOBS.map((j) => (
            <Chip key={j.kind} on={jobs.includes(j.kind)} rec={j.recDays.includes(dow)}
              onClick={() => setJobs((c) => c.includes(j.kind) ? c.filter((x) => x !== j.kind) : [...c, j.kind])}>
              {j.icon} {j.label.slice(0, 30)}{j.via === 'telegram' ? ' 📡' : ''}
            </Chip>
          ))}
        </div>
      </div>

      <div className="card" style={{ borderLeft: '3px solid var(--teal)' }}>
        <h3 style={{ marginBottom: 4 }}>🎯 Your day, ranked</h3>
        <p className="dim" style={{ fontSize: 12, margin: '0 0 8px' }}>Drag ≡ (or ↑↓) — top item is your first priority.</p>
        {picked.length ? <RankList items={picked} setItems={setPicked} /> : <p className="dim" style={{ fontSize: 13 }}>Nothing selected yet — tap chips above.</p>}
      </div>

      <button className="btn app" style={{ width: '100%', padding: 12, fontSize: 15 }} disabled={busy || !picked.length} onClick={submit}>
        {busy ? 'Sending to Rupert…' : `Start the day → (${picked.length} for me · ${jobs.length} for Rupert)`}
      </button>
    </section>
  );
}

// Status strip under Today: what Rupert is working on (from the morning plan).
function RupertTaskStrip({ dayPlan, alerts, onOpenAlert }) {
  if (!dayPlan || dayPlan.date !== easternYMD() || !(dayPlan.rupertTasks || []).length) return null;
  const STATUS = { pending: '⏳', queued: '📡 queued', done: '✓ done', failed: '⚠ retry' };
  return (
    <div className="row" style={{ gap: 6, flexWrap: 'wrap', margin: '2px 0 12px' }}>
      {dayPlan.rupertTasks.map((t) => {
        const resultAlert = t.status === 'done' ? (alerts || []).find((a) => a.type === t.kind) : null;
        return (
          <button key={t.id} className="pill" onClick={() => resultAlert && onOpenAlert(resultAlert.id)}
            style={{ cursor: resultAlert ? 'pointer' : 'default', border: '1px solid var(--line)', background: t.status === 'done' ? 'rgba(45,212,191,.15)' : 'var(--panel2)', color: t.status === 'done' ? 'var(--teal)' : 'var(--mut)' }}>
            {t.icon || '🛠️'} {t.label.split(' — ')[0].slice(0, 24)} · {STATUS[t.status] || t.status}
          </button>
        );
      })}
    </div>
  );
}

// "Planning" sub-tab: today's items — the action center.
function TodayPlan({ data, onOpenAlert, markTodayDone, delayTodayItem, onPlanMore, setTaskNote, toggleTask, dismissTask }) {
  const [showDone, setShowDone] = useState(false);
  const all = (data && data.todayItems ? data.todayItems : []).filter((t) => t.status !== 'delayed');
  const [openStep, setOpenStep] = useState(null); // {plan, stage, task, todayId}
  const stepHandler = (t) => { const hit = findPlanStep(data.plans, t); return hit ? () => setOpenStep({ ...hit, todayId: t.id }) : null; };
  const items = all.filter((t) => t.status === 'pending');
  const doneItems = all.filter((t) => t.status === 'done');

  return (
    <section>
      <div className="card">
        <div className="between"><h3 style={{ margin: 0 }}>🎯 Today</h3><span className="dim" style={{ fontSize: 12 }}>{items.length ? `${items.length} open` : ''}</span></div>
        <div style={{ marginTop: 10 }}>
          {items.length ? items.map((t) => <TodayItemRow key={t.id} t={t} onDone={markTodayDone} onDelay={delayTodayItem} onStep={stepHandler(t)} onDelete={dismissTask} />)
            : <p className="dim" style={{ fontSize: 13 }}>{doneItems.length ? 'All done — strong day. 🎉' : 'Nothing queued yet — tap ➕ Plan more or run the morning check-in.'}</p>}
          {doneItems.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <button className="btn def" style={{ fontSize: 12 }} onClick={() => setShowDone(!showDone)}>✓ {doneItems.length} done today {showDone ? '▾' : '▸'}</button>
              {showDone && doneItems.map((t) => <TodayItemRow key={t.id} t={t} onDone={markTodayDone} onDelay={delayTodayItem} onStep={stepHandler(t)} />)}
            </div>
          )}
          <div className="row" style={{ gap: 8, marginTop: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <button className="btn def" style={{ fontSize: 12 }} onClick={onPlanMore}>➕ Plan more</button>
            <span className="dim" style={{ fontSize: 11 }}>✓ done · ⏰ delay 1d/1w/1mo (returns on its date)</span>
          </div>
          {openStep && <StepDialog step={openStep} onClose={() => setOpenStep(null)} setTaskNote={setTaskNote} toggleTask={toggleTask} markTodayDone={markTodayDone} />}
        </div>
      </div>
      <RupertTaskStrip dayPlan={data.dayPlan} alerts={data.alerts} onOpenAlert={onOpenAlert} />
    </section>
  );
}

// "Today's brief" sub-tab: the morning brief (open), alert history, content fallback.
function BriefView({ data, onOpenAlert, onAllAlerts, onSearchAlerts, activatePlan, addTodayItem, goTab, toggleTask, setPlanStatus, markTodayDone }) {
  const brief = data && data.todayBrief && data.todayBrief.text;
  const alerts = (data && data.alerts) || [];
  // Preview the newest NON-brief alert when the brief already has its own card above.
  const latest = (brief ? alerts.find((a) => a.type !== 'brief') : null) || alerts[0];

  return (
    <section>
      {brief ? (
        <div className="card" style={{ borderLeft: '3px solid var(--teal)' }}>
          <div className="between"><h3 style={{ margin: 0 }}>☀️ Rupert's brief</h3><span className="dim" style={{ fontSize: 12 }}>{data.todayBrief.date || ''}</span></div>
          <div style={{ whiteSpace: 'pre-wrap', fontSize: 14, lineHeight: 1.55, marginTop: 10 }}><Linkified text={brief} /></div>
          <BriefActions brief={brief} plans={data.plans} todayItems={data.todayItems} activatePlan={activatePlan} addTodayItem={addTodayItem} goTab={goTab} toggleTask={toggleTask} setPlanStatus={setPlanStatus} markTodayDone={markTodayDone} />
          <button className="btn app" style={{ marginTop: 12 }} onClick={() => goTab('planning')}>🎯 Today's plan →</button>
        </div>
      ) : <p className="banner">No brief yet today — it lands each morning at your set time (⚙️ Settings).</p>}

      {/* 🔔 Alerts — collapsed to the newest one */}
      {alerts.length > 0 && (
        <Collapse icon="🔔" title="From Rupert" right={relTime(latest.at)}
          sub={`${ALERT_EMOJI[latest.type] || '🔔'} ${latest.title || latest.type} — ${alertSnippet(latest)}`.slice(0, 95)}>
          <RecentAlerts alerts={alerts} onOpen={onOpenAlert} onAll={onAllAlerts} onSearch={onSearchAlerts} />
        </Collapse>
      )}
      {/* Fallback while alert history is still empty */}
      {!alerts.length && data && data.contentFeed && data.contentFeed.text && (
        <Collapse icon="📬" title={data.contentFeed.title || 'From Rupert'} right={relTime(data.contentFeed.at)}
          sub={String(data.contentFeed.text).split('\n').filter((l) => l.trim())[0]?.slice(0, 90)}>
          <div style={{ whiteSpace: 'pre-wrap', fontSize: 14, lineHeight: 1.55 }}><Linkified text={data.contentFeed.text} /></div>
        </Collapse>
      )}
    </section>
  );
}

function Proposal({ p, onResolve }) {
  return (
    <div className={'prop' + (p.kind === 'signal' ? ' signal' : '')}>
      <div className="between"><span className="src">{p.src}</span>
        <div className="row">
          <span className="pill" style={{ background: 'rgba(148,163,184,.15)', color: 'var(--mut)' }}>{p.pillar}</span>
          <button className="trash" title="Remove" onClick={() => onResolve(p.id)}><Trash2 size={16} /></button>
        </div></div>
      <div className="ttl">{p.title}</div>
      <div className="why">{p.why}</div>
      <div className="act">→ {p.act}</div>
      <div className="btns">
        <button className="btn app" onClick={() => onResolve(p.id)}>Do it</button>
        <button className="btn def" onClick={() => onResolve(p.id)}>Hold</button>
      </div>
    </div>
  );
}

// One triage pass: coach proposals up top, email signals below.
function Signals({ proposals, onResolve, data }) {
  const live = !!(data.emailSignals && data.emailSignals.length);
  const mails = live ? data.emailSignals : MAILS;
  return (
    <section>
      <div className="section-title">📥 Signals <span className="dim" style={{ fontWeight: 500 }}>· one pass, then get on with the day</span></div>
      {proposals.length ? proposals.map((p) => <Proposal key={p.id} p={p} onResolve={onResolve} />)
        : <p className="banner">Nothing to triage. 🎉</p>}
      <div className="section-title" style={{ marginTop: 18 }}>✉️ From email <span className="dim" style={{ fontWeight: 500 }}>{live ? '(live)' : '(preview)'}</span></div>
      <div className="card">
        {mails.map((m, i) => (
          <div className="mail" key={i}>
            <span className="tag" style={{ background: 'rgba(148,163,184,.14)', color: `var(${m[1]})` }}>{m[0]}</span>
            <div><div className="mf">{m[2]}</div><div className="ms">{m[3]}</div>
              <span className="mact">{m[4]}<b style={{ color: `var(${m[1]})` }}>{m[5]}</b></span></div>
          </div>
        ))}
      </div>
      <p className="banner">Rupert watches defined email lanes (travel deals, recruiters, named contacts, bills) — never everything, never auto-replies.</p>
    </section>
  );
}

function PlanCard({ p }) {
  const c = `var(${COL[p.pk]})`;
  return (
    <div className="gcard" style={{ borderLeft: `3px solid ${c}` }}>
      <div className="between"><span className="nm">{p.title}</span>
        <span className="pill" style={{ background: 'rgba(148,163,184,.14)', color: c }}>{PILLAR_LABEL[p.pk]}</span></div>
      <div className="sig">{p.note}</div>
    </div>
  );
}

function Plans({ plans }) {
  return (
    <section>
      <div className="section-title">Plans &amp; someday — the life you're aiming at</div>
      <div className="cgrid">{plans.map((p) => <PlanCard key={p.id} p={p} />)}</div>
      <p className="banner">✈️ Travel ideas from your email auto-land here as drafts — you promote the good ones into a real plan.</p>
    </section>
  );
}

const PERSON_TAGS = ['', 'son', 'partner', 'family', 'friend', 'colleague', 'recruiter', 'mentor', 'doctor', 'other'];

// Birthday helper: days until the next occurrence of an MM-DD (or YYYY-MM-DD) date.
const daysToBirthday = (bd) => {
  const m = String(bd || '').match(/(\d{2})-(\d{2})$/);
  if (!m) return null;
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: EASTERN }));
  let next = new Date(now.getFullYear(), +m[1] - 1, +m[2]);
  if (next < new Date(now.getFullYear(), now.getMonth(), now.getDate())) next = new Date(now.getFullYear() + 1, +m[1] - 1, +m[2]);
  return Math.round((next - now) / 86400000);
};

function PersonEditor({ p, group, groups, onSave, onCancel }) {
  const [f, setF] = useState({ name: p.name || '', tag: p.tag || '', meta: p.meta || '', phone: p.phone || '', email: p.email || '', birthday: p.birthday || '', group });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const inp = { background: 'var(--panel2)', color: 'var(--txt)', border: '1px solid var(--line)', borderRadius: 8, padding: '7px 9px', fontSize: 13, boxSizing: 'border-box' };
  return (
    <div style={{ padding: '8px 0', borderBottom: '1px solid var(--line)' }}>
      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
        <input style={{ ...inp, flex: '2 1 140px' }} placeholder="Name" value={f.name} onChange={set('name')} autoFocus />
        <select style={{ ...inp, flex: '1 1 90px' }} value={f.tag} onChange={set('tag')}>
          {PERSON_TAGS.map((t) => <option key={t} value={t}>{t || 'tag…'}</option>)}
        </select>
        <select style={{ ...inp, flex: '1 1 110px' }} value={f.group} onChange={set('group')}>
          {groups.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
        </select>
      </div>
      <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
        <input style={{ ...inp, flex: '1 1 120px' }} placeholder="Phone" value={f.phone} onChange={set('phone')} />
        <input style={{ ...inp, flex: '1 1 150px' }} placeholder="Email" value={f.email} onChange={set('email')} />
        <input type="date" style={{ ...inp, flex: '0 1 140px', color: f.birthday ? 'var(--txt)' : 'var(--mut)' }} title="Birthday" value={f.birthday} onChange={set('birthday')} />
      </div>
      <input style={{ ...inp, width: '100%', marginTop: 6 }} placeholder="Note (role, how you know them…)" value={f.meta} onChange={set('meta')} />
      <div className="row" style={{ gap: 8, marginTop: 8, justifyContent: 'flex-end' }}>
        <button className="btn def" style={{ fontSize: 12 }} onClick={onCancel}>Cancel</button>
        <button className="btn app" style={{ fontSize: 12 }} onClick={() => { if (f.name.trim()) onSave({ ...f, name: f.name.trim() }); }}>Save</button>
      </div>
    </div>
  );
}

function PersonRow({ p, onDelete, onEdit }) {
  const bd = daysToBirthday(p.birthday);
  const contact = [p.phone, p.email].filter(Boolean).join(' · ');
  return (
    <div className="person" style={onEdit ? { cursor: 'pointer' } : {}}>
      <div style={{ minWidth: 0, flex: 1 }} onClick={onEdit || undefined} title={onEdit ? 'Tap to edit' : undefined}>
        <div className="pn">{p.name}
          {p.tag && <span className="pill" style={{ background: 'rgba(148,163,184,.14)', color: 'var(--mut)', marginLeft: 6, fontSize: 10 }}>{p.tag}</span>}
          {bd != null && bd <= 30 && <span className="pill" style={{ background: 'rgba(244,114,182,.15)', color: 'var(--rose)', marginLeft: 6, fontSize: 10 }}>🎂 {bd === 0 ? 'today!' : `in ${bd}d`}</span>}
        </div>
        {p.meta && <div className="pm">{p.meta}</div>}
        {contact && <div className="pm" style={{ opacity: .75 }}>{contact}</div>}
      </div>
      <div className="row" style={{ alignItems: 'center', gap: 8, flex: '0 0 auto' }}>
        {p.action && <span className="pa">{p.action}</span>}
        {onEdit && <button className="trash" title="Edit" onClick={onEdit} style={{ fontSize: 13 }}>✏️</button>}
        {onDelete && <button className="trash" title="Remove" onClick={() => onDelete(p.id)}><Trash2 size={15} /></button>}
      </div></div>
  );
}

// Minimal vCard (.vcf) parser — pulls name + title/org + first email/phone.
function parseVCards(text) {
  const out = [];
  for (const block of String(text).split(/END:VCARD/i)) {
    if (!/BEGIN:VCARD/i.test(block)) continue;
    const grab = (re) => { const m = block.match(re); return m ? m[1].trim() : ''; };
    const name = grab(/\nFN[^:\n]*:(.+)/i);
    if (!name) continue;
    const title = grab(/\nTITLE[^:\n]*:(.+)/i);
    const org = grab(/\nORG[^:\n]*:(.+)/i).replace(/;+$/, '').replace(/;/g, ' ');
    const email = grab(/\nEMAIL[^:\n]*:(.+)/i);
    const tel = grab(/\nTEL[^:\n]*:(.+)/i);
    const bday = grab(/\nBDAY[^:\n]*:(.+)/i).replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3');
    const role = [title, org].filter(Boolean).join(' · ');
    out.push({ name, meta: role, email, phone: tel, birthday: /^\d{4}-\d{2}-\d{2}/.test(bday) ? bday.slice(0, 10) : '' });
  }
  return out;
}

function AddPerson({ groups, defaultGroup, onAdd }) {
  const [group, setGroup] = useState(defaultGroup);
  const [name, setName] = useState('');
  const [meta, setMeta] = useState('');
  const submit = () => { if (name.trim()) { onAdd(group, { name, meta }); setName(''); setMeta(''); } };
  return (
    <div className="addrow" style={{ flexWrap: 'wrap', gap: 8 }}>
      <select value={group} onChange={(e) => setGroup(e.target.value)} style={{ flex: '0 0 auto', background: 'var(--panel2)', border: '1px solid var(--line)', borderRadius: 10, color: 'var(--txt)', padding: '9px 10px' }}>
        {groups.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
      </select>
      <input type="text" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') submit(); }} style={{ flex: '1 1 130px' }} />
      <input type="text" placeholder="Note (role, how you know them…)" value={meta} onChange={(e) => setMeta(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') submit(); }} style={{ flex: '2 1 180px' }} />
      <button className="btn app" onClick={submit}>Add</button>
    </div>
  );
}

function People({ people, addPerson, deletePerson, addPeople, updatePerson }) {
  const fileRef = useRef(null);
  const [imported, setImported] = useState('');
  const [editing, setEditing] = useState(null); // { group, id }
  const live = !!addPerson;
  const GROUPS = [['personal', 'Personal'], ['professional', 'Professional'], ['opportunities', 'Opportunities']];

  const renderPerson = (group) => (p) => editing && editing.group === group && editing.id === p.id
    ? <PersonEditor key={p.id} p={p} group={group} groups={GROUPS}
        onCancel={() => setEditing(null)}
        onSave={(f) => { updatePerson(group, p.id, f); setEditing(null); }} />
    : <PersonRow key={p.id} p={p}
        onEdit={live && updatePerson ? () => setEditing({ group, id: p.id }) : null}
        onDelete={live ? (id) => deletePerson(group, id) : null} />;

  const onFile = async (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const text = await f.text();
    const found = parseVCards(text);
    if (found.length) { addPeople('professional', found); setImported(`Imported ${found.length} contact${found.length > 1 ? 's' : ''} → Professional.`); }
    else setImported("Couldn't read any contacts from that file.");
    e.target.value = '';
  };

  return (
    <section>
      {live && (
        <div className="card">
          <div className="subhead" style={{ marginTop: 0 }}>Add someone</div>
          <AddPerson groups={GROUPS} defaultGroup="personal" onAdd={addPerson} />
          <div className="row" style={{ marginTop: 12, alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <input ref={fileRef} type="file" accept=".vcf,text/vcard" style={{ display: 'none' }} onChange={onFile} />
            <button className="btn def" onClick={() => fileRef.current?.click()}>📇 Import from iPhone Contacts (.vcf)</button>
            {imported && <span className="dim" style={{ fontSize: 12 }}>{imported}</span>}
          </div>
          <p className="banner" style={{ marginTop: 10, textAlign: 'left' }}>iPhone: open Contacts → pick a person (or select multiple) → <b>Share Contact</b> → Save to Files / AirDrop the <code>.vcf</code>, then import it here. (Browsers can't read your phone's address book directly — this is the privacy-safe way in.)</p>
        </div>
      )}
      <div className="card"><div className="subhead">Personal</div>{people.personal.map(renderPerson('personal'))}</div>
      <div className="card"><div className="subhead">Professional network</div>{people.professional.map(renderPerson('professional'))}
        <div className="person"><div><div className="pn">+ from your email</div><div className="pm">Rupert surfaces contacts you've gone quiet on</div></div><span className="pa">review</span></div>
      </div>
      <div className="card"><div className="subhead">🎯 Job opportunities &amp; next gig <span className="dim" style={{ textTransform: 'none', fontWeight: 500 }}>· powered by mikedulinmd.app</span></div>
        {people.opportunities.map(renderPerson('opportunities'))}</div>
      <p className="banner">Tap anyone to edit their name, tag, contact info, or move them between groups. Rupert watches email for follow-ups, quiet contacts, and inbound opportunities.</p>
    </section>
  );
}

function Calendar({ data }) {
  const days = data.calendar && Array.isArray(data.calendar.days) ? data.calendar.days : null;
  const live = !!days || !!(data.calendar && data.calendar.weekEvents);
  const today = easternYMD();
  const scroller = useRef(null);
  // A single render model whether the data is the new date-keyed `days` array,
  // the legacy weekday-bucketed `weekEvents`, or the preview seed.
  const model = days
    ? days.map((d) => ({ key: d.date, head: d.label, isToday: d.date === today,
        events: (d.events || []).map((e) => Array.isArray(e) ? { t: e[0], c: e[1] === 'prop' ? e[2] : e[1], prop: e[1] === 'prop' } : { t: e.t, c: e.c, prop: !!e.prop }) }))
    : WEEK_DAYS.map((lbl, i) => ({ key: i, head: lbl, isToday: false,
        events: ((data.calendar && data.calendar.weekEvents ? data.calendar.weekEvents[i] : WEEK_EVENTS[i]) || [])
          .map((e) => e[1] === 'prop' ? { t: e[0], c: e[2], prop: true } : { t: e[0], c: e[1], prop: false }) }));
  // Center today when the live agenda loads, so "now" is the first thing Mike sees.
  useEffect(() => {
    const el = scroller.current; if (!el) return;
    const t = el.querySelector('.day.today');
    if (t) el.scrollLeft = Math.max(0, t.offsetLeft - 8);
  }, [days]);
  return (
    <section>
      <div className="section-title">Your Google calendars, color-coded by pillar <span className="dim">{live ? '(live · swipe →)' : '(preview)'}</span></div>
      <div className="card">
        <div className="week" ref={scroller}>
          {model.map((d) => (
            <div className={'day' + (d.isToday ? ' today' : '') + (d.events.length ? '' : ' empty')} key={d.key}>
              <div className="dh">{d.head}</div>
              {d.events.map((e, j) => e.prop
                ? <div className="ev prop" style={{ '--c': `var(${e.c})` }} key={j}>{e.t}</div>
                : <div className="ev" style={{ background: `var(${e.c})` }} key={j}>{e.t}</div>)}
            </div>
          ))}
        </div>
        <div className="evcal">
          <span><i className="swatch" style={{ background: 'var(--emerald)' }} />Health</span>
          <span><i className="swatch" style={{ background: 'var(--rose)' }} />Relationships</span>
          <span><i className="swatch" style={{ background: 'var(--amber)' }} />Finances</span>
          <span><i className="swatch" style={{ background: 'var(--violet)' }} />Purpose</span>
          <span><i className="swatch" style={{ background: 'var(--sky)' }} />Fun &amp; Travel</span>
          <span><i className="swatch" style={{ border: '1px dashed var(--mut)' }} />Proposed (needs OK)</span>
        </div>
      </div>
      <div className="card">
        <h3>Proposed calendar changes — nothing happens until you approve</h3>
        <div className="prop signal" style={{ borderLeftColor: 'var(--rose)' }}>
          <div className="between"><span className="src" style={{ color: 'var(--rose)' }}>CALENDAR · from a network email</span>
            <span className="pill" style={{ background: 'rgba(148,163,184,.15)', color: 'var(--mut)' }}>❤️ Relationships</span></div>
          <div className="ttl">Hold two 30-min slots for an Allen Naidoo call</div>
          <div className="why">He replied suggesting a call; Tue 2:00 and Thu 11:00 are open across your calendars.</div>
          <div className="act">→ Approve to tentatively place both holds + draft him the two options (you send).</div>
          <div className="btns"><button className="btn app">Approve &amp; draft</button><button className="btn def">Pick other times</button></div>
        </div>
        <div className="prop" style={{ borderLeftColor: 'var(--emerald)' }}>
          <div className="between"><span className="src">CALENDAR · Body Coach</span>
            <span className="pill" style={{ background: 'rgba(148,163,184,.15)', color: 'var(--mut)' }}>🫀 Health</span></div>
          <div className="ttl">Block Sat 9:00 for an easy zone-2 ride</div>
          <div className="why">Your weekend is open and you're light on easy aerobic work this week.</div>
          <div className="act">→ Approve to add the event to your personal calendar.</div>
          <div className="btns"><button className="btn app">Add to calendar</button><button className="btn def">Hold</button></div>
        </div>
      </div>
      <p className="banner">LifeOS reads your calendars to anchor Today, find gaps, and catch conflicts — but only writes events from a proposal you approve.</p>
    </section>
  );
}

function CodingUpdates() {
  return (
    <section>
      <div className="card">
        <h3>Coding updates — what's built &amp; what's pending across your apps</h3>
        {CODING_UPDATES.map((u, i) => (
          <div className="loop" key={i}><div className="dot" style={{ background: u[0] }} /><div>
            <div className="lt">{u[1]}</div><div className="lm">{u[2]}</div></div></div>
        ))}
      </div>
      <p className="banner">The build/dev queue — distinct from life proposals. Where the coding agent reports status.</p>
    </section>
  );
}

function PillarArea({ pk, proposals, plans, onResolve, onBack, onPlanClick, peopleSection }) {
  const p = PILLARS[pk];
  const c = `var(${COL[pk]})`;
  const props = proposals.filter((x) => x.pk === pk);
  const myplans = plans.filter((x) => x.pk === pk);
  return (
    <section>
      {onBack && <button className="backbtn" onClick={onBack}>‹ back</button>}
      <div className="strat-pillar" style={{ '--c': c }}>
        <h4>{p.em} {p.name}</h4>
        <ul>{p.goals.map((g, i) => <li key={i}>{g}</li>)}</ul>
        <div className="apps">{p.apps.map((a, i) => (
          <span className="a" key={i}><i className="sdot" style={{ background: SDOT[a[1]] }} />{a[0]}</span>))}</div>
      </div>
      {props.length > 0 && (
        <div className="card"><h3>Needs your attention</h3>{props.map((x) => <Proposal key={x.id} p={x} onResolve={onResolve} />)}</div>
      )}
      {myplans.length > 0 && (
        <div className="card"><h3>Plans in this area <span className="dim" style={{ fontWeight: 500, textTransform: 'none' }}>· tap one to start planning</span></h3>
          <div className="cgrid">{myplans.map((x) => <div key={x.id} onClick={() => onPlanClick(x)} style={{ cursor: 'pointer' }}><PlanCard p={x} /></div>)}</div></div>
      )}
      {pk === 'purpose' && <PurposeLearning />}
      {pk === 'rel' && peopleSection}
    </section>
  );
}

// A tapped notification lands here — one focused screen about that one thing.
function FocusView({ focus, data, openRupert, onOpenApp }) {
  const brief = data && data.todayBrief && data.todayBrief.text;
  const content = data && data.contentFeed;
  const top = (data && data.proposals ? data.proposals : []).slice(0, 3);

  if (focus === 'content' && content && content.text) {
    return (
      <section className="focusview">
        <div className="card" style={{ borderLeft: '3px solid var(--sky)', whiteSpace: 'pre-wrap', fontSize: 15, lineHeight: 1.6 }}>
          <h3>{content.title || 'From Rupert'}</h3>
          <Linkified text={content.text} />
        </div>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <button className="btn app" onClick={() => openRupert('Tell me more about what you just sent.')}>Ask Rupert</button>
          <button className="btn def" onClick={onOpenApp}>Open the full app →</button>
        </div>
      </section>
    );
  }
  // default focus = the morning brief + the top things waiting
  return (
    <section className="focusview">
      <div className="card" style={{ borderLeft: '3px solid var(--teal)', whiteSpace: 'pre-wrap', fontSize: 15, lineHeight: 1.6 }}>
        <h3>☀️ Rupert's brief</h3>
        {brief ? <Linkified text={brief} /> : 'Open the app for today’s plan.'}
      </div>
      {top.length > 0 && (
        <div className="card"><h3>Top for you right now</h3>
          {top.map((p) => (
            <div className="loop" key={p.id}><div className="dot" style={{ background: `var(${COL[p.pk] || '--teal'})` }} />
              <div><div className="lt">{p.title}</div><div className="lm">{p.act || p.why}</div></div></div>
          ))}
        </div>
      )}
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <button className="btn app" onClick={() => openRupert()}>Talk to Rupert</button>
        <button className="btn def" onClick={onOpenApp}>Open the full app →</button>
      </div>
    </section>
  );
}

// ───────────────────────── Life ─────────────────────────
// The strategic view: the five pillars with a real status line each, pulled
// from the context slices Rupert already syncs (fitness/finance/health/travel)
// plus the app's own data (plans, memories, people).
const sliceLine = (slice, prefixes = []) => {
  const lines = String(slice || '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return null;
  for (const p of prefixes) { const hit = lines.find((l) => l.startsWith(p)); if (hit) return hit; }
  return lines[0];
};
const daysAgo = (ymd) => {
  if (!ymd) return null;
  const d = Math.floor((Date.now() - new Date(String(ymd).slice(0, 10) + 'T12:00:00').getTime()) / 86400000);
  return d < 0 ? null : d;
};

function pillarStatus(data) {
  const activeByPk = (pk) => (data.plans || []).filter((p) => p.status === 'active' && p.pk === pk).length;
  const plansBit = (pk) => { const n = activeByPk(pk); return n ? `${n} active plan${n > 1 ? 's' : ''}` : null; };

  // Health: today's session > recovery > latest weight > health flag.
  const health = sliceLine(data.fitnessContext, ["Today's planned session:", 'Recovery:', 'Latest weight:'])
    || sliceLine(data.healthContext) || plansBit('health');

  // Relationships: freshest memory + people counts.
  const mem = (data.memories || [])[0];
  const dm = mem ? daysAgo(mem.date) : null;
  const npers = ((data.people && data.people.personal) || []).length;
  const rel = [dm != null ? `last memory ${dm === 0 ? 'today' : dm + 'd ago'}` : null, npers ? `${npers} personal` : null, plansBit('rel')]
    .filter(Boolean).join(' · ') || null;

  // Finances: net worth + top flag.
  const nw = sliceLine(data.financeContext, ['Net worth:']);
  const flag = sliceLine(data.financeContext, ['Top flag:']);
  const fin = [nw, flag && flag.replace('Top flag: ', '⚠ ')].filter(Boolean).join(' · ') || plansBit('fin');

  // Purpose: opportunities in the pipeline + active plans.
  const nopp = ((data.people && data.people.opportunities) || []).length;
  const purpose = [nopp ? `${nopp} opportunit${nopp > 1 ? 'ies' : 'y'} to screen` : null, plansBit('purpose')]
    .filter(Boolean).join(' · ') || null;

  // Fun & Travel: next trip from the travel slice, else plans.
  const fun = sliceLine(data.travelContext) || plansBit('fun');

  return { health, rel, fin, purpose, fun };
}

function LifeView({ counts, pillar, openPillar, data, proposals, onResolve, onPlanClick, peopleSection }) {
  const status = pillarStatus(data);
  return (
    <section>
      <div className="section-title">🧭 Life <span className="dim" style={{ fontWeight: 500 }}>· tap a pillar — it opens right here</span></div>
      <div className="hero lifegrid">
        {Object.entries(PILLARS).map(([k, p]) => {
          const c = `var(${COL[k]})`;
          const need = counts[k];
          return (
            <div className={'ptile' + (pillar === k ? ' sel' : '')} style={{ '--c': c }} key={k} onClick={() => openPillar(k)}>
              {need > 0 ? <div className="badge" style={{ '--c': c }}>{need}</div> : <div className="okdot" />}
              <div className="em">{p.em}</div>
              <div className="pnm">{p.name}</div>
              <div className="pst">{need > 0 ? `${need} need${need > 1 ? '' : 's'} you` : 'on track'}</div>
              {status[k] && <div className="psl">{status[k]}</div>}
            </div>
          );
        })}
      </div>
      {pillar
        ? <PillarArea pk={pillar} proposals={proposals} plans={data.plans} onResolve={onResolve} onPlanClick={onPlanClick} peopleSection={peopleSection} />
        : <p className="banner">Status lines come from what Rupert syncs overnight (training, money, health, travel) + your plans and memories here.</p>}
    </section>
  );
}

// ───────────────────────── App ─────────────────────────
function CommitmentsCard({ value, onSave }) {
  const DEFAULT = 'In Charlotte working at Rea Farms every Wed & Thu — no evening plans those nights.';
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(value || '');
  useEffect(() => { setText(value || ''); }, [value]);
  const current = (value && value.trim()) || DEFAULT;
  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <button className="row" style={{ width: '100%', background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', justifyContent: 'space-between', alignItems: 'center', padding: 0 }} onClick={() => setOpen((o) => !o)}>
        <span style={{ fontSize: 13 }}>📌 <b>Recurring commitments</b> <span className="dim">— Rupert won't schedule over these</span></span>
        <span className="dim" style={{ fontSize: 13 }}>{open ? '▾' : '▸'}</span>
      </button>
      {!open && <div className="dim" style={{ fontSize: 12, marginTop: 6 }}>{current}</div>}
      {open && (
        <div style={{ marginTop: 8 }}>
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} placeholder={DEFAULT}
            style={{ width: '100%', boxSizing: 'border-box', background: 'var(--panel2)', color: 'var(--txt)', border: '1px solid var(--line)', borderRadius: 10, padding: 10, fontSize: 13, fontFamily: 'inherit', resize: 'vertical' }} />
          <div className="row" style={{ gap: 8, marginTop: 8, justifyContent: 'flex-end' }}>
            <button className="btn def" onClick={() => { setText(value || ''); setOpen(false); }}>Cancel</button>
            <button className="btn app" onClick={() => { onSave(text.trim()); setOpen(false); }}>Save</button>
          </div>
        </div>
      )}
    </div>
  );
}

const ALERT_LABELS = [
  ['brief', '☀️ Morning brief'], ['celebrate', '🎉 Evening wins'],
  ['podcast', '🎧 Podcasts'], ['recipe', '🍳 Recipes'], ['mealprep', '🥗 Meal prep'],
  ['ainews', '🤖 AI news'], ['travel', '✈️ Travel'], ['fitness', '🏋️ Fitness'],
  ['finance', '💰 Finance'], ['health', '🩺 Health'], ['rental', '🏠 Rentals'],
];

function Toggle({ on, onChange }) {
  return (
    <button type="button" className={'toggle' + (on ? ' on' : '')} role="switch" aria-checked={on} onClick={() => onChange(!on)}>
      <span className="knob" />
    </button>
  );
}

// ⚙️ Settings — notifications, brief time, quiet hours, recurring commitments,
// per-type alert mutes, and which AI brain Rupert uses.
function SettingsSheet({ data, onClose, setSetting, setCommitments, setAlertPref, notif, enableNotify, testPush, notifMsg }) {
  const st = { aiProvider: 'openai', briefHour: 7, quietStart: 21, quietEnd: 7, ...(data.settings || {}) };
  const prefs = { brief: true, podcast: true, recipe: true, mealprep: true, travel: true, fitness: true, finance: true, health: true, rental: true, celebrate: true, ainews: true, ...(data.alertPrefs || {}) };
  const HOURS = Array.from({ length: 24 }, (_, h) => h);
  const hlabel = (h) => { const ap = h < 12 ? 'AM' : 'PM'; const hr = h % 12 === 0 ? 12 : h % 12; return `${hr} ${ap}`; };
  const sel = { background: 'var(--panel2)', color: 'var(--txt)', border: '1px solid var(--line)', borderRadius: 8, padding: '6px 8px', fontSize: 13 };
  return (
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-settings">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>⚙️ Settings</h2>
          <button className="btn def" onClick={onClose}>Done</button>
        </div>

        <div className="card">
          <h3>🔔 Notifications</h3>
          {notif === 'granted' ? (
            <>
              <div style={{ fontSize: 13, marginBottom: 8 }}>On for this device. Not getting pings? Re-sync the push token.</div>
              <div className="row" style={{ gap: 8 }}>
                <button className="btn def" onClick={testPush}>Send test</button>
                <button className="btn app" onClick={enableNotify}>{notif === 'working' ? '…' : 'Re-sync'}</button>
              </div>
            </>
          ) : notif === 'unsupported' ? (
            <div className="dim" style={{ fontSize: 13 }}>Open this app from its Home-Screen icon (not Safari) to enable push.</div>
          ) : (
            <>
              <div style={{ fontSize: 13, marginBottom: 8 }}>On iPhone: add this app to your Home Screen, open it from there, then enable.</div>
              <button className="btn app" onClick={enableNotify}>{notif === 'working' ? '…' : 'Enable notifications'}</button>
            </>
          )}
          {notifMsg && <div className="dim" style={{ fontSize: 12, marginTop: 6 }}>{notifMsg}</div>}
        </div>

        <div className="card">
          <h3>☀️ Morning brief</h3>
          <div className="setrow"><span>Send my brief at</span>
            <select style={sel} value={st.briefHour} onChange={(e) => setSetting('briefHour', +e.target.value)}>
              {HOURS.slice(4, 12).map((h) => <option key={h} value={h}>{hlabel(h)}</option>)}
            </select>
          </div>
          <div className="dim" style={{ fontSize: 11, marginTop: 6 }}>Eastern time. The check-in nudge and brief both follow this.</div>
        </div>

        <div className="card">
          <h3>🌙 Quiet hours</h3>
          <div className="setrow"><span>Mute pushes</span>
            <span className="row" style={{ gap: 6 }}>
              <select style={sel} value={st.quietStart} onChange={(e) => setSetting('quietStart', +e.target.value)}>{HOURS.map((h) => <option key={h} value={h}>{hlabel(h)}</option>)}</select>
              <span className="dim">→</span>
              <select style={sel} value={st.quietEnd} onChange={(e) => setSetting('quietEnd', +e.target.value)}>{HOURS.map((h) => <option key={h} value={h}>{hlabel(h)}</option>)}</select>
            </span>
          </div>
          <div className="dim" style={{ fontSize: 11, marginTop: 6 }}>Content still refreshes in-app — you just won't get buzzed.</div>
        </div>

        <CommitmentsCard value={data.commitments} onSave={setCommitments} />

        <div className="card">
          <h3>📣 What Rupert can ping me about</h3>
          {ALERT_LABELS.map(([k, label]) => (
            <div className="setrow" key={k}><span style={{ fontSize: 14 }}>{label}</span><Toggle on={prefs[k] !== false} onChange={(v) => setAlertPref(k, v)} /></div>
          ))}
        </div>

        <div className="card">
          <h3>🧠 Rupert's brain</h3>
          <div className="seg">
            <button className={'segbtn' + (st.aiProvider !== 'anthropic' ? ' on' : '')} onClick={() => setSetting('aiProvider', 'openai')}>OpenAI</button>
            <button className={'segbtn' + (st.aiProvider === 'anthropic' ? ' on' : '')} onClick={() => setSetting('aiProvider', 'anthropic')}>Anthropic</button>
          </div>
          <div className="dim" style={{ fontSize: 11, marginTop: 8 }}>{st.aiProvider === 'anthropic' ? 'Using Claude — requires ANTHROPIC_API_KEY in Vercel. Applies to Rupert chat + your morning brief.' : 'Using OpenAI (gpt-5.5).'}</div>
        </div>

        <p className="banner" style={{ marginTop: 8 }}>Mike's Life · <span className="dim">build {BUILD}</span></p>
      </div>
    </div>
  );
}

function QuickCapture({ captures, addCapture, deleteCapture, addTodayItem }) {
  const [text, setText] = useState('');
  const list = captures || [];
  const add = () => { if (text.trim()) { addCapture(text); setText(''); } };
  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div className="row" style={{ gap: 8 }}>
        <input style={{ flex: 1, minWidth: 0, background: 'var(--panel2)', color: 'var(--txt)', border: '1px solid var(--line)', borderRadius: 10, padding: '9px 11px', fontSize: 14 }}
          placeholder="🗒️ Capture a thought, idea, errand…" value={text}
          onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') add(); }} />
        <button className="btn app" style={{ flex: '0 0 auto' }} onClick={add}>Add</button>
      </div>
      {list.length > 0 && (
        <div style={{ marginTop: 8 }}>
          {list.slice(0, 6).map((c) => (
            <div className="row" key={c.id} style={{ gap: 8, alignItems: 'center', padding: '5px 0', borderBottom: '1px solid var(--line)' }}>
              <span style={{ flex: 1, minWidth: 0, fontSize: 13 }}>{c.text}</span>
              <button className="btn def" style={{ fontSize: 11, padding: '4px 8px' }} title="Send to Today"
                onClick={() => { addTodayItem({ title: c.text, pk: 'fun' }); deleteCapture(c.id); }}>→ Today</button>
              <button className="btn def" style={{ fontSize: 11, padding: '4px 8px' }} onClick={() => deleteCapture(c.id)}>✕</button>
            </div>
          ))}
          {list.length > 6 && <div className="dim" style={{ fontSize: 11, marginTop: 6 }}>+{list.length - 6} more captured</div>}
        </div>
      )}
    </div>
  );
}

export default function App() {
  const [user, setUser] = useState(null);
  const [authReady, setAuthReady] = useState(!FIREBASE_READY);
  const [authErr, setAuthErr] = useState('');
  const [tab, setTab] = useState(() => {
    // A tapped push lands on the Rupert tab; ?view=<pillar> opens Life with it selected.
    try {
      const p = new URLSearchParams(window.location.search);
      const v = p.get('view') || 'home';
      return PILLARS[v] ? 'life' : v;
    } catch { return 'home'; }
  });
  const [homeTab, setHomeTab] = useState('brief'); // Rupert sub-tab: brief | plan | signals
  const [pillar, setPillar] = useState(() => {
    try { const v = new URLSearchParams(window.location.search).get('view'); return PILLARS[v] ? v : null; } catch { return null; }
  });
  const [notif, setNotif] = useState(typeof Notification !== 'undefined' ? Notification.permission : 'unsupported');
  const [rupertOpen, setRupertOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [rupertSeed, setRupertSeed] = useState('');
  const [peacockPop, setPeacockPop] = useState(false);
  const openRupert = (s = '') => {
    setRupertSeed(s); setRupertOpen(true);
    setPeacockPop(true); setTimeout(() => setPeacockPop(false), 850);
  };

  const {
    data, loaded, resolveProposal, saveCheckin, addCapture, deleteCapture,
    activatePlan, setPlanStatus, toggleTask, setTaskNote, addPlan, addTask,
    updateOdyssey, addGoodTime, setMindTopic, addMindBranch, removeMindBranch,
    addMemory, deleteMemory, addDocument, deleteDocument, setEmergency,
    addPerson, deletePerson, addPeople, updatePerson,
    setLocation, setFcmToken, setCommitments, setVaultDocs,
    setAlertFeedback, deleteAlert,
    setTodayItems, markTodayDone, delayTodayItem, addTodayItem, dismissTask,
    setAlertPref, setAlertItemFeedback, submitDayPlan, setSetting,
  } = useLifeData(user);

  // Pin the floating dock to the *visual* viewport. iOS Safari positions
  // position:fixed against the layout viewport, so when its toolbar animates in/out
  // the dock appears to drift up/down the screen. We publish the gap between the
  // layout- and visual-viewport bottoms as --vvb; the dock/more-sheet translate up by
  // it to stay glued to the visible bottom edge. No-op on desktop/Android (gap ≈ 0).
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const root = document.documentElement;
    let raf = 0;
    const apply = () => { raf = 0; root.style.setProperty('--vvb', Math.max(0, window.innerHeight - vv.height - vv.offsetTop) + 'px'); };
    const onChange = () => { if (!raf) raf = requestAnimationFrame(apply); };
    apply();
    vv.addEventListener('resize', onChange);
    vv.addEventListener('scroll', onChange);
    return () => { vv.removeEventListener('resize', onChange); vv.removeEventListener('scroll', onChange); if (raf) cancelAnimationFrame(raf); };
  }, []);

  // Daily roll-forward of the Today list (client fallback — cron-brief also does this
  // server-side; whoever runs first today wins via the todayItemsDate guard).
  useEffect(() => {
    if (!FIREBASE_READY || !user || !loaded) return;
    const today = easternYMD();
    if (data.todayItemsDate === today) return;
    setTodayItems(generateTodayItems(data.todayItems, data.plans, today, data.doneLedger, data.dismissed), today);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, loaded, data.todayItemsDate]);

  // Alert navigation: openAlertId = a single alert's page; alertsOpen = the
  // searchable full-history view ('search' auto-focuses the search box).
  const [openAlertId, setOpenAlertId] = useState(() => { try { return new URLSearchParams(window.location.search).get('alert'); } catch { return null; } });
  const [alertsOpen, setAlertsOpen] = useState(null); // null | 'list' | 'search'
  const [searchOpen, setSearchOpen] = useState(false); // global search

  // A tapped notification can deep-link to a focused view (?focus=brief|content)
  // or open Rupert (?rupert=1). Pillars still come in via ?view=<pillar>.
  const [focus, setFocus] = useState(() => { try { return new URLSearchParams(window.location.search).get('focus'); } catch { return null; } });
  const [locMsg, setLocMsg] = useState('');

  const captureLocation = useCallback(() => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) { setLocMsg('Location not supported here'); return; }
    setLocMsg('Locating…');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocation({ lat: +pos.coords.latitude.toFixed(5), lng: +pos.coords.longitude.toFixed(5), accuracy: Math.round(pos.coords.accuracy), at: new Date().toISOString(), source: 'app' });
        setLocMsg('📍 Shared with Rupert');
        try { localStorage.setItem('rupertLoc', '1'); } catch { /* ignore */ }
      },
      () => setLocMsg('Location permission denied'),
      { enableHighAccuracy: false, timeout: 9000, maximumAge: 300000 },
    );
  }, [setLocation]);

  const [refreshing, setRefreshing] = useState(false);
  const [refreshMsg, setRefreshMsg] = useState('');
  const touch = useRef({ y: 0, pulling: false });

  const doRefresh = useCallback(async () => {
    if (refreshing || !FIREBASE_READY || !auth?.currentUser) return;
    setRefreshing(true); setRefreshMsg('');
    try {
      const token = await auth.currentUser.getIdToken();
      const r = await fetch('/api/refresh', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken: token, view: pillar ? 'pillar' : tab, pk: pillar || null }),
      });
      const dd = await r.json();
      if (!r.ok) setRefreshMsg(dd.message || "Couldn't refresh — try again.");
      else setRefreshMsg(dd.addedProposals ? `Fresh content + ${dd.addedProposals} new idea${dd.addedProposals > 1 ? 's' : ''}.` : 'Fresh content from Rupert.');
    } catch { setRefreshMsg('Network hiccup — try again.'); }
    finally { setRefreshing(false); }
  }, [refreshing, pillar, tab]);

  // Mobile pull-to-refresh: a downward drag while scrolled to the top.
  const onTouchStart = (e) => { touch.current = { y: e.touches[0].clientY, pulling: window.scrollY <= 2 }; };
  const onTouchEnd = (e) => {
    if (touch.current.pulling && window.scrollY <= 2) {
      const dy = e.changedTouches[0].clientY - touch.current.y;
      if (dy > 70) doRefresh();
    }
    touch.current.pulling = false;
  };

  const [notifMsg, setNotifMsg] = useState('');
  const enableNotify = async () => {
    setNotif('working'); setNotifMsg('');
    const r = await requestPushToken();
    if (r.ok) { setFcmToken(r.token); setNotif('granted'); setNotifMsg('✓ Notifications synced — Rupert can reach this device.'); }
    else { setNotif(typeof Notification !== 'undefined' ? Notification.permission : 'default'); setNotifMsg('Could not enable: ' + r.reason + (r.reason === 'unsupported' ? ' — open from the Home-Screen icon, not Safari.' : '')); console.warn('notifications:', r.reason); }
  };
  const testPush = async () => {
    setNotifMsg('Sending test ping…');
    try {
      const idToken = await auth.currentUser.getIdToken();
      const r = await fetch('/api/test-push', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken }) });
      const j = await r.json();
      if (j.ok) setNotifMsg(`Sent to ${j.pushed} device${j.pushed === 1 ? '' : 's'}${j.pruned ? ` · pruned ${j.pruned} dead` : ''} — watch for it. If nothing arrives, check iOS Settings → Notifications → mikeslife.`);
      else setNotifMsg('Test push: ' + (j.reason || j.error || 'no devices reached') + (j.pruned ? ` (pruned ${j.pruned} stale)` : ''));
    } catch (e) { setNotifMsg('Test push failed: ' + e.message); }
  };

  useEffect(() => {
    if (!FIREBASE_READY) return;
    return onAuthStateChanged(auth, (u) => {
      if (u && OWNER_UID && u.uid !== OWNER_UID) {
        setAuthErr('This account is not authorized.');
        signOut(auth);
        setUser(null);
      } else {
        setUser(u);
        setAuthErr('');
      }
      setAuthReady(true);
    });
  }, []);

  // Deep-link: ?rupert=1 (or ?view=rupert) opens the chat from anywhere.
  useEffect(() => {
    try {
      const p = new URLSearchParams(window.location.search);
      // ?ask=<text> (from spoke apps, e.g. Rainbow Reality's sell-vs-hold review
      // button) pre-fills the chat input so Mike can review/edit before sending.
      if (p.get('rupert') === '1' || p.get('view') === 'rupert') openRupert(p.get('ask') || '');
      // ?alert=<id> from a tapped push: strip it from the URL once consumed so a
      // reload doesn't re-open it (openAlertId already initialised from the param).
      if (p.get('alert')) window.history.replaceState({}, '', window.location.pathname);
    } catch { /* ignore */ }
  }, []);

  // If Mike previously shared location, refresh it quietly each time he opens the app.
  useEffect(() => {
    if (!user) return;
    try { if (localStorage.getItem('rupertLoc') === '1') captureLocation(); } catch { /* ignore */ }
  }, [user, captureLocation]);

  const signIn = () => signInWithPopup(auth, provider).catch((e) => setAuthErr(e.message));

  if (!authReady) return <div className="wrap"><p className="banner" style={{ marginTop: 40 }}>Loading…</p></div>;
  if (FIREBASE_READY && !user) return <Login onSignIn={signIn} error={authErr} />;

  const counts = {};
  Object.keys(PILLARS).forEach((k) => { counts[k] = data.proposals.filter((p) => p.pk === k).length; });

  const now = new Date();
  const openPillar = (k) => { setPillar((cur) => (cur === k ? null : k)); setTab('life'); };
  const goTab = (t) => {
    setOpenAlertId(null); setAlertsOpen(null); setSearchOpen(false);
    // People now lives inside Life → Relationships; legacy 'people' links land there.
    if (t === 'people') { setPillar('rel'); setTab('life'); return; }
    setPillar(null); setTab(t);
  };
  // "Do it" on an inbox proposal: commit its concrete next-step onto Today's list
  // (so it has a real home), clear the proposal, and jump to Home to see it land.
  const doProposal = (p) => {
    addTodayItem({ title: (p.act || p.title || '').replace(/^→\s*/, '').trim(), why: p.title, pk: p.pk || 'fun' });
    resolveProposal(p.id);
    goTab('home');
  };
  const openAlert = data.alerts ? data.alerts.find((a) => a.id === openAlertId) : null;


  return (
    <div className="wrap">
      <div className="apphead">
        <div className="logo">Mike's <b>Life</b>{!FIREBASE_READY && <span className="demo-tag">DEMO</span>}</div>
        {FIREBASE_READY && user && (
          <div className="rupert-center">
            <button className={'rupertbtn big' + (peacockPop ? ' pop' : '')} title="Talk to Rupert" onClick={() => openRupert()}>
              <span className="peacock" role="img" aria-label="Rupert">🦚</span>
              {peacockPop && <span className="featherring" />}
            </button>
          </div>
        )}
        <div className="date">
          {easternDisplay(now).weekday}<br />
          {easternDisplay(now).long}
          {FIREBASE_READY && user && <div className="row" style={{ gap: 8, justifyContent: 'flex-end', marginTop: 3 }}><button className="gearbtn" title="Settings" onClick={() => setSettingsOpen(true)}>⚙️</button><button className="signout" onClick={() => signOut(auth)}>Sign out</button></div>}
        </div>
      </div>

      {/* Desktop top bar — same five items as the mobile dock */}
      <nav className="topnav">
        {PRIMARY_TABS.map(([id, ic, label]) => (
          <button className={'tab' + (tab === id ? ' active' : '')} key={id} onClick={() => goTab(id)}>
            {ic} {label}{id === 'home' && data.proposals.length > 0 ? <span className="pill" style={{ background: 'var(--teal)', color: '#04201c', marginLeft: 6 }}>{data.proposals.length}</span> : null}
          </button>
        ))}
      </nav>

      <div className="layout">
      <main className="content" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>

      {FIREBASE_READY && (
        <div className="refreshbar">
          <span className="upd">{(() => {
            const stamps = [data.refreshedAt, data.googleSyncedAt, data.fitnessUpdatedAt, data.financeUpdatedAt, data.healthUpdatedAt, (data.alerts || [])[0]?.at].filter(Boolean).map((t) => new Date(t).getTime()).filter((n) => !isNaN(n));
            return stamps.length ? `Updated ${relTime(new Date(Math.max(...stamps)).toISOString())}` : 'Pull down or tap Refresh to update';
          })()}</span>
          <button className="btn def refbtn" onClick={() => setSearchOpen(true)} title="Search everything" style={{ marginRight: 6 }}>🔎</button>
          <button className="btn def refbtn" onClick={doRefresh} disabled={refreshing} title="Have Rupert pull fresh content + ideas">
            <RefreshCw size={14} className={refreshing ? 'spin' : ''} /> {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      )}
      {refreshMsg && <div className="dim" style={{ fontSize: 12, margin: '-2px 2px 10px' }}>{refreshMsg}</div>}

      {FIREBASE_READY && notif !== 'unsupported' && notif !== 'granted' && (
        <div className="card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
          <div style={{ fontSize: 13 }}>🔔 <b>Turn on notifications</b> so Rupert can ping your phone for check-ins.
            <span className="dim"> On iPhone, add this app to your Home Screen first, open it from there, then tap Enable. (Manage anytime in ⚙️ Settings.)</span></div>
          <button className="btn app" style={{ flex: '0 0 auto' }} onClick={enableNotify}>{notif === 'working' ? '…' : 'Enable'}</button>
        </div>
      )}
      {notifMsg && notif !== 'granted' && <div className="dim" style={{ fontSize: 12, margin: '-2px 2px 10px' }}>{notifMsg}</div>}
      {tab === 'home' && <QuickCapture captures={data.captures} addCapture={addCapture} deleteCapture={deleteCapture} addTodayItem={addTodayItem} />}

      {focus === 'checkin' ? (
        <CheckInView data={data} submitDayPlan={submitDayPlan} saveCheckin={saveCheckin} dismissTask={dismissTask} onDone={() => { setFocus(null); goTab('home'); try { window.history.replaceState({}, '', window.location.pathname); } catch { /* ignore */ } }} />
      ) : focus ? (
        <FocusView focus={focus} data={data} openRupert={openRupert} onOpenApp={() => { setFocus(null); try { window.history.replaceState({}, '', window.location.pathname); } catch { /* ignore */ } }} />
      ) : openAlert ? (
        <AlertDetail alert={openAlert} onBack={() => setOpenAlertId(null)} onFeedback={setAlertFeedback} onItemFeedback={setAlertItemFeedback} onDelete={deleteAlert} openRupert={openRupert} addTodayItem={addTodayItem} addPlan={addPlan} />
      ) : searchOpen ? (
        <SearchView data={data} onBack={() => setSearchOpen(false)} onOpenAlert={(id) => { setSearchOpen(false); setOpenAlertId(id); }} goTab={goTab} />
      ) : alertsOpen ? (
        <AlertsView alerts={data.alerts || []} onOpen={setOpenAlertId} onBack={() => setAlertsOpen(null)} autoFocusSearch={alertsOpen === 'search'} prefs={data.alertPrefs} setPref={setAlertPref} />
      ) : (
        <>
          {tab === 'home' && (
            <>
              <div className="subtabs">
                {HOME_SUBTABS.map(([id, ic, label]) => (
                  <button key={id} className={'tab' + (homeTab === id ? ' active' : '')} onClick={() => setHomeTab(id)}>
                    {ic} {label}
                    {id === 'signals' && data.proposals.length > 0 && <span className="pill" style={{ background: homeTab === id ? '#04201c' : 'var(--teal)', color: homeTab === id ? 'var(--teal)' : '#04201c', marginLeft: 5 }}>{data.proposals.length}</span>}
                  </button>
                ))}
              </div>
              {homeTab === 'brief' && <BriefView data={data} onOpenAlert={setOpenAlertId} onAllAlerts={() => setAlertsOpen('list')} onSearchAlerts={() => setAlertsOpen('search')} activatePlan={activatePlan} addTodayItem={addTodayItem} goTab={goTab} toggleTask={toggleTask} setPlanStatus={setPlanStatus} markTodayDone={markTodayDone} />}
              {homeTab === 'signals' && <Signals proposals={data.proposals} onResolve={resolveProposal} data={data} />}
            </>
          )}
          {tab === 'life' && <LifeView counts={counts} pillar={pillar} openPillar={openPillar} data={data}
            proposals={data.proposals} onResolve={resolveProposal}
            onPlanClick={(p) => { if (p.status !== 'active' && p.status !== 'done') activatePlan(p.id); goTab('planning'); }}
            peopleSection={<People people={data.people} addPerson={addPerson} deletePerson={deletePerson} addPeople={addPeople} updatePerson={updatePerson} />} />}
          {tab === 'calendar' && <Calendar data={data} />}
          {tab === 'planning' && (
            <PlanningHub
              todaySection={(
                <>
                  <TodayPlan data={data} onOpenAlert={setOpenAlertId} markTodayDone={markTodayDone} delayTodayItem={delayTodayItem} onPlanMore={() => setFocus('checkin')} setTaskNote={setTaskNote} toggleTask={toggleTask} dismissTask={dismissTask} />
                  {FIREBASE_READY && (
                    <div className="locrow" style={{ marginTop: 12 }}>
                      <button className="btn def" onClick={captureLocation}>📍 Share my location with Rupert</button>
                      {locMsg && <span className="dim" style={{ fontSize: 12 }}>{locMsg}</span>}
                      {!locMsg && data.location && <span className="dim" style={{ fontSize: 12 }}>last: {data.location.place || `${data.location.lat}, ${data.location.lng}`} · {relTime(data.location.at)}</span>}
                    </div>
                  )}
                </>
              )}
              data={data}
              activatePlan={activatePlan}
              setPlanStatus={setPlanStatus}
              toggleTask={toggleTask}
              addPlan={addPlan}
              addTask={addTask}
              openRupert={openRupert}
              updateOdyssey={updateOdyssey}
              addGoodTime={addGoodTime}
              setMindTopic={setMindTopic}
              addMindBranch={addMindBranch}
              removeMindBranch={removeMindBranch}
            />
          )}
          {tab === 'memories' && <MemoriesView data={data} addMemory={addMemory} deleteMemory={deleteMemory} addDocument={addDocument} deleteDocument={deleteDocument} />}
          {tab === 'vault' && <VaultView data={data} setEmergency={setEmergency} setVaultDocs={setVaultDocs} user={user} people={data.people} />}
        </>
      )}

      <p className="banner" style={{ marginTop: 24 }}>Mike's Life · {FIREBASE_READY ? 'connected' : 'demo mode — add Firebase config to enable sign-in + saving'} · <span className="dim">build {BUILD}</span></p>


      </main>
      </div>
      {/* Fixed overlays live OUTSIDE the scrolling <main> so iOS anchors them to the
          viewport rather than a scrolled/animated ancestor — this is what kept the
          floating dock from drifting up the screen on the brief/focus views. */}
      {/* Mobile floating dock — same five items as the desktop top bar (peacock lives in the header) */}
      <div className="dock">
        {PRIMARY_TABS.map(([id, ic, lb]) => (
          <button key={id} className={'dock-item' + (tab === id ? ' active' : '')}
            title={lb} aria-label={lb} onClick={() => goTab(id)}>
            <span className="di">{ic}</span>
            {id === 'home' && data.proposals.length > 0 && <span className="dock-badge">{data.proposals.length}</span>}
          </button>
        ))}
      </div>

      {rupertOpen && (
        <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) setRupertOpen(false); }}>
          <div className="modal-rupert">
            <RupertChat seed={rupertSeed} onClose={() => setRupertOpen(false)} />
          </div>
        </div>
      )}
      {settingsOpen && (
        <SettingsSheet data={data} onClose={() => setSettingsOpen(false)} setSetting={setSetting} setCommitments={setCommitments} setAlertPref={setAlertPref} notif={notif} enableNotify={enableNotify} testPush={testPush} notifMsg={notifMsg} />
      )}
    </div>
  );
}
