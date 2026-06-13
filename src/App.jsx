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
import PurposeLearning from './learning';
import {
  PILLARS, COL, SDOT, PILLAR_LABEL,
  WEEK_DAYS, WEEK_EVENTS, MAILS, CODING_UPDATES,
} from './seed';

const TABS = [
  ['home', 'Home'], ['inbox', 'Inbox'], ['planning', 'Planning'],
  ['calendar', 'Calendar'], ['email', 'Email'], ['people', 'People'], ['memories', 'Memories'],
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

const alertSnippet = (a) => {
  const line = String(a.text || '').split('\n').map((s) => s.trim()).filter((s) => s && !/^https?:\/\//.test(s) && !/^Listen:/i.test(s))
    .slice(a.type === 'brief' ? 1 : 0)[0] || '';
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
function generateTodayItems(prev, plans, today) {
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

function TodayItemRow({ t, onDone, onDelay, onStep }) {
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
function BriefActions({ brief, plans, todayItems, activatePlan, addTodayItem, goTab }) {
  const [msg, setMsg] = useState('');
  const norm = (s) => String(s || '').toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const lines = String(brief || '').split('\n')
    .map((l) => { const m = l.match(/^\s*(?:🥇|🥈|🥉)\s*(.+)$/u); return m ? m[1].replace(/[.。]\s*$/, '').trim() : null; })
    .filter(Boolean).slice(0, 3);
  if (!lines.length) return null;
  const act = (line) => {
    const n = norm(line);
    const plan = (plans || []).find((p) => { const pn = norm(p.title); return pn.length > 3 && (n.includes(pn) || pn.includes(n)); });
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
  return (
    <div style={{ marginTop: 12 }}>
      <div className="dim" style={{ fontSize: 11, marginBottom: 6 }}>Act on these — tap to plan or add to Today:</div>
      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
        {lines.map((l, i) => (
          <button key={i} className="btn def" style={{ fontSize: 12 }} onClick={() => act(l)}>{['🥇', '🥈', '🥉'][i]} {l.slice(0, 50)} →</button>
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

function CheckInView({ data, submitDayPlan, onDone }) {
  const today = easternYMD();
  const dow = new Date(new Date().toLocaleString('en-US', { timeZone: EASTERN })).getDay();
  const fc = data.fitnessContext;

  // Plan/task candidates (pending items + fresh steps from active plans).
  const initialCands = () => {
    const out = []; const seen = new Set();
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
  const [cands] = useState(initialCands);

  // One unified ordered selection (exercise recs first — health is the priority).
  const wellnessItem = (w, sec) => ({ id: w.id, title: w.title, icon: w.icon, why: w.why ? w.why(dow) : sec.section.replace(/^[^ ]+ /, ''), pk: sec.pk, status: 'pending', until: null });
  const [picked, setPicked] = useState(() => {
    const out = [];
    for (const sec of WELLNESS) for (const w of sec.items) if (w.rec(dow, fc)) out.push(wellnessItem(w, sec));
    for (const c of cands.slice(0, 2)) out.push(c);
    return out;
  });
  const [jobs, setJobs] = useState(() => RUPERT_JOBS.filter((j) => j.recDays.includes(dow)).map((j) => j.kind));
  const [busy, setBusy] = useState(false);

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
    submitDayPlan([...items, ...delayed], rupertTasks, today);
    try {
      const token = auth?.currentUser ? await auth.currentUser.getIdToken() : null;
      if (token && jobs.length) await fetch('/api/run-tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken: token, tasks: jobs }) });
    } catch (e) { console.warn('run-tasks', e); }
    setBusy(false);
    onDone();
  };

  return (
    <section className="focusview">
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
        <h3 style={{ marginBottom: 8 }}>📌 Tasks & plans</h3>
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          {cands.length ? cands.map((c, i) => (
            <Chip key={c.id} on={isPicked(c.id)} rec={i < 2} onClick={() => togglePick(c)}>{c.title.slice(0, 40)}</Chip>
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

function Today({ data, onOpenAlert, onAllAlerts, onSearchAlerts, markTodayDone, delayTodayItem, activatePlan, addTodayItem, goTab, onPlanMore, setTaskNote, toggleTask }) {
  const [showDone, setShowDone] = useState(false);
  const brief = data && data.todayBrief && data.todayBrief.text;
  const alerts = (data && data.alerts) || [];
  const all = (data && data.todayItems ? data.todayItems : []).filter((t) => t.status !== 'delayed');
  const [openStep, setOpenStep] = useState(null); // {plan, stage, task, todayId}
  const stepHandler = (t) => { const hit = findPlanStep(data.plans, t); return hit ? () => setOpenStep({ ...hit, todayId: t.id }) : null; };
  const items = all.filter((t) => t.status === 'pending');
  const doneItems = all.filter((t) => t.status === 'done');
  const openCount = items.length;
  const briefSub = brief ? (brief.split('\n').map((l) => l.trim()).filter((l) => l && !/^good morning/i.test(l))[0] || '').slice(0, 90) : '';
  const latest = alerts[0];

  return (
    <section>
      {/* 🎯 Today — the action center, open by default */}
      <Collapse icon="🎯" title="Today" right={openCount ? `${openCount} open` : ''} defaultOpen
        sub={items.length ? items.filter((t) => t.status === 'pending').map((t) => t.title).join(' · ').slice(0, 90) : null}>
        {items.length ? items.map((t) => <TodayItemRow key={t.id} t={t} onDone={markTodayDone} onDelay={delayTodayItem} onStep={stepHandler(t)} />)
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
      </Collapse>

      <RupertTaskStrip dayPlan={data.dayPlan} alerts={data.alerts} onOpenAlert={onOpenAlert} />

      {/* ☀️ Brief — collapsed to its first meaningful line; focus lines are actionable */}
      {brief && (
        <Collapse icon="☀️" title="Rupert's brief" sub={briefSub} right={data.todayBrief.date || ''}>
          <div style={{ whiteSpace: 'pre-wrap', fontSize: 14, lineHeight: 1.55 }}><Linkified text={brief} /></div>
          <BriefActions brief={brief} plans={data.plans} todayItems={data.todayItems} activatePlan={activatePlan} addTodayItem={addTodayItem} goTab={goTab} />
        </Collapse>
      )}

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

function Inbox({ proposals, onResolve }) {
  return (
    <section>
      <div className="section-title">For you to triage — coach proposals + signals from email</div>
      {proposals.length ? proposals.map((p) => <Proposal key={p.id} p={p} onResolve={onResolve} />)
        : <p className="banner">Inbox zero. 🎉</p>}
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

function PersonRow({ p, onDelete }) {
  return (
    <div className="person"><div><div className="pn">{p.name}</div><div className="pm">{p.meta}</div></div>
      <div className="row" style={{ alignItems: 'center', gap: 8 }}>
        {p.action && <span className="pa">{p.action}</span>}
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
    const role = [title, org].filter(Boolean).join(' · ');
    const contact = [email, tel].filter(Boolean).join(' · ');
    out.push({ name, meta: [role, contact].filter(Boolean).join(' — ') });
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

function People({ people, addPerson, deletePerson, addPeople }) {
  const fileRef = useRef(null);
  const [imported, setImported] = useState('');
  const live = !!addPerson;
  const GROUPS = [['personal', 'Personal'], ['professional', 'Professional'], ['opportunities', 'Opportunities']];

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
      <div className="card"><div className="subhead">Personal</div>{people.personal.map((p) => <PersonRow key={p.id} p={p} onDelete={live ? (id) => deletePerson('personal', id) : null} />)}</div>
      <div className="card"><div className="subhead">Professional network</div>{people.professional.map((p) => <PersonRow key={p.id} p={p} onDelete={live ? (id) => deletePerson('professional', id) : null} />)}
        <div className="person"><div><div className="pn">+ from your email</div><div className="pm">Rupert surfaces contacts you've gone quiet on</div></div><span className="pa">review</span></div>
      </div>
      <div className="card"><div className="subhead">🎯 Job opportunities &amp; next gig <span className="dim" style={{ textTransform: 'none', fontWeight: 500 }}>· powered by mikedulinmd.app</span></div>
        {people.opportunities.map((p) => <PersonRow key={p.id} p={p} onDelete={live ? (id) => deletePerson('opportunities', id) : null} />)}</div>
      <p className="banner">Relationships split into personal + professional. Rupert watches email for follow-ups, quiet contacts, and inbound opportunities.</p>
    </section>
  );
}

function Calendar({ data }) {
  const live = !!(data.calendar && data.calendar.weekEvents);
  const week = live ? data.calendar.weekEvents : WEEK_EVENTS;
  return (
    <section>
      <div className="section-title">This week · your 3 Google calendars, color-coded by pillar <span className="dim">{live ? '(live)' : '(preview)'}</span></div>
      <div className="card">
        <div className="week">
          {WEEK_DAYS.map((d, i) => (
            <div className={'day' + (i === 4 ? ' today' : '')} key={i}>
              <div className="dh">{d}</div>
              {(week[i] || []).map((e, j) => e[1] === 'prop'
                ? <div className="ev prop" style={{ '--c': `var(${e[2]})` }} key={j}>{e[0]}</div>
                : <div className="ev" style={{ background: `var(${e[1]})` }} key={j}>{e[0]}</div>)}
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

function Email({ data }) {
  const live = !!(data.emailSignals && data.emailSignals.length);
  const mails = live ? data.emailSignals : MAILS;
  return (
    <section>
      <div className="section-title">Email signals · only the lanes you've allow-listed, classified by pillar <span className="dim">{live ? '(live)' : '(preview)'}</span></div>
      <div className="card">
        {mails.map((m, i) => (
          <div className="mail" key={i}>
            <span className="tag" style={{ background: 'rgba(148,163,184,.14)', color: `var(${m[1]})` }}>{m[0]}</span>
            <div><div className="mf">{m[2]}</div><div className="ms">{m[3]}</div>
              <span className="mact">{m[4]}<b style={{ color: `var(${m[1]})` }}>{m[5]}</b></span></div>
          </div>
        ))}
      </div>
      <p className="banner">Rupert watches defined lanes (travel deals, recruiters, named contacts, bills) — never everything, never auto-replies. Drafts only; you send.</p>
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

function PillarArea({ pk, proposals, plans, onResolve, onBack, onPlanClick }) {
  const p = PILLARS[pk];
  const c = `var(${COL[pk]})`;
  const props = proposals.filter((x) => x.pk === pk);
  const myplans = plans.filter((x) => x.pk === pk);
  return (
    <section>
      <button className="backbtn" onClick={onBack}>‹ back</button>
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

export default function App() {
  const [user, setUser] = useState(null);
  const [authReady, setAuthReady] = useState(!FIREBASE_READY);
  const [authErr, setAuthErr] = useState('');
  const [tab, setTab] = useState(() => {
    // A tapped push lands on Home (brief + content live at the top of Home).
    try {
      const p = new URLSearchParams(window.location.search);
      return p.get('view') || 'home';
    } catch { return 'home'; }
  });
  const [pillar, setPillar] = useState(null);
  const [notif, setNotif] = useState(typeof Notification !== 'undefined' ? Notification.permission : 'unsupported');
  const [rupertOpen, setRupertOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [rupertSeed, setRupertSeed] = useState('');
  const [peacockPop, setPeacockPop] = useState(false);
  const openRupert = (s = '') => {
    setRupertSeed(s); setRupertOpen(true);
    setPeacockPop(true); setTimeout(() => setPeacockPop(false), 850);
  };

  const {
    data, loaded, resolveProposal,
    activatePlan, setPlanStatus, toggleTask, setTaskNote, addPlan, addTask,
    updateOdyssey, addGoodTime, setMindTopic, addMindBranch, removeMindBranch,
    addMemory, deleteMemory, addDocument, deleteDocument,
    addPerson, deletePerson, addPeople,
    setLocation, setFcmToken, setCommitments,
    setAlertFeedback, deleteAlert,
    setTodayItems, markTodayDone, delayTodayItem, addTodayItem,
    setAlertPref, setAlertItemFeedback, submitDayPlan,
  } = useLifeData(user);

  // Daily roll-forward of the Today list (client fallback — cron-brief also does this
  // server-side; whoever runs first today wins via the todayItemsDate guard).
  useEffect(() => {
    if (!FIREBASE_READY || !user || !loaded) return;
    const today = easternYMD();
    if (data.todayItemsDate === today) return;
    setTodayItems(generateTodayItems(data.todayItems, data.plans, today), today);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, loaded, data.todayItemsDate]);

  // Alert navigation: openAlertId = a single alert's page; alertsOpen = the
  // searchable full-history view ('search' auto-focuses the search box).
  const [openAlertId, setOpenAlertId] = useState(null);
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
      if (p.get('rupert') === '1' || p.get('view') === 'rupert') openRupert();
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
  const openPillar = (k) => { setPillar(k); };
  const goTab = (t) => { setPillar(null); setOpenAlertId(null); setAlertsOpen(null); setSearchOpen(false); setTab(t); };
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
          {FIREBASE_READY && user && <div><button className="signout" onClick={() => signOut(auth)}>Sign out</button></div>}
        </div>
      </div>

      <div className="hero">
        {Object.entries(PILLARS).map(([k, p]) => {
          const c = `var(${COL[k]})`;
          const need = counts[k];
          return (
            <div className={'ptile' + (pillar === k ? ' sel' : '')} style={{ '--c': c }} key={k} onClick={() => openPillar(k)}>
              {need > 0 ? <div className="badge" style={{ '--c': c }}>{need}</div> : <div className="okdot" />}
              <div className="em">{p.em}</div>
              <div className="pnm">{p.name}</div>
              <div className="pst">{need > 0 ? `${need} need${need > 1 ? '' : 's'} you` : 'on track'}</div>
            </div>
          );
        })}
      </div>

      <div className="layout">
      <nav className="sidenav">
        {TABS.map(([id, label]) => (
          <button className={'tab' + (!pillar && tab === id ? ' active' : '')} key={id} onClick={() => goTab(id)}>
            {label}{id === 'inbox' ? <span className="pill" style={{ background: 'var(--teal)', color: '#04201c', marginLeft: 6 }}>{data.proposals.length}</span> : null}
          </button>
        ))}
      </nav>

      <main className="content" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>

      {FIREBASE_READY && (
        <div className="refreshbar">
          <span className="upd">{data.refreshedAt ? `Updated ${relTime(data.refreshedAt)}` : 'Pull down or tap Refresh to update'}</span>
          <button className="btn def refbtn" onClick={() => setSearchOpen(true)} title="Search everything" style={{ marginRight: 6 }}>🔎</button>
          <button className="btn def refbtn" onClick={doRefresh} disabled={refreshing} title="Have Rupert pull fresh content + ideas">
            <RefreshCw size={14} className={refreshing ? 'spin' : ''} /> {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      )}
      {refreshMsg && <div className="dim" style={{ fontSize: 12, margin: '-2px 2px 10px' }}>{refreshMsg}</div>}

      {FIREBASE_READY && notif !== 'unsupported' && (
        notif === 'granted' ? (
          <div className="card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
            <div style={{ fontSize: 13 }}>🔔 <b>Notifications on.</b>
              <span className="dim"> Not getting pings? Tap Re-sync to refresh this device's push token.</span></div>
            <div className="row" style={{ gap: 6, flex: '0 0 auto' }}>
              <button className="btn def" onClick={testPush}>Test</button>
              <button className="btn def" onClick={enableNotify}>{notif === 'working' ? '…' : 'Re-sync'}</button>
            </div>
          </div>
        ) : (
          <div className="card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
            <div style={{ fontSize: 13 }}>🔔 <b>Turn on notifications</b> so Rupert can ping your phone for check-ins.
              <span className="dim"> On iPhone, add this app to your Home Screen first, open it from there, then tap Enable.</span></div>
            <button className="btn app" style={{ flex: '0 0 auto' }} onClick={enableNotify}>{notif === 'working' ? '…' : 'Enable'}</button>
          </div>
        )
      )}
      {notifMsg && <div className="dim" style={{ fontSize: 12, margin: '-2px 2px 10px' }}>{notifMsg}</div>}

      <CommitmentsCard value={data.commitments} onSave={setCommitments} />

      {focus === 'checkin' ? (
        <CheckInView data={data} submitDayPlan={submitDayPlan} onDone={() => { setFocus(null); goTab('home'); try { window.history.replaceState({}, '', window.location.pathname); } catch { /* ignore */ } }} />
      ) : focus ? (
        <FocusView focus={focus} data={data} openRupert={openRupert} onOpenApp={() => { setFocus(null); try { window.history.replaceState({}, '', window.location.pathname); } catch { /* ignore */ } }} />
      ) : openAlert ? (
        <AlertDetail alert={openAlert} onBack={() => setOpenAlertId(null)} onFeedback={setAlertFeedback} onItemFeedback={setAlertItemFeedback} onDelete={deleteAlert} openRupert={openRupert} addTodayItem={addTodayItem} addPlan={addPlan} />
      ) : searchOpen ? (
        <SearchView data={data} onBack={() => setSearchOpen(false)} onOpenAlert={(id) => { setSearchOpen(false); setOpenAlertId(id); }} goTab={goTab} />
      ) : alertsOpen ? (
        <AlertsView alerts={data.alerts || []} onOpen={setOpenAlertId} onBack={() => setAlertsOpen(null)} autoFocusSearch={alertsOpen === 'search'} prefs={data.alertPrefs} setPref={setAlertPref} />
      ) : pillar ? (
        <PillarArea pk={pillar} proposals={data.proposals} plans={data.plans} onResolve={resolveProposal} onBack={() => goTab('home')} onPlanClick={(p) => { if (p.status !== 'active' && p.status !== 'done') activatePlan(p.id); goTab('planning'); }} />
      ) : (
        <>
          {tab === 'home' && (
            <>
              <Today data={data} onOpenAlert={setOpenAlertId} onAllAlerts={() => setAlertsOpen('list')} onSearchAlerts={() => setAlertsOpen('search')} markTodayDone={markTodayDone} delayTodayItem={delayTodayItem} activatePlan={activatePlan} addTodayItem={addTodayItem} goTab={goTab} onPlanMore={() => setFocus('checkin')} setTaskNote={setTaskNote} toggleTask={toggleTask} />
              {FIREBASE_READY && (
                <div className="locrow">
                  <button className="btn def" onClick={captureLocation}>📍 Share my location with Rupert</button>
                  {locMsg && <span className="dim" style={{ fontSize: 12 }}>{locMsg}</span>}
                  {!locMsg && data.location && <span className="dim" style={{ fontSize: 12 }}>last: {data.location.place || `${data.location.lat}, ${data.location.lng}`} · {relTime(data.location.at)}</span>}
                </div>
              )}
            </>
          )}
          {tab === 'inbox' && <Inbox proposals={data.proposals} onResolve={resolveProposal} />}
          {tab === 'calendar' && <Calendar data={data} />}
          {tab === 'email' && <Email data={data} />}
          {tab === 'planning' && (
            <PlanningHub
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
          {tab === 'people' && <People people={data.people} addPerson={addPerson} deletePerson={deletePerson} addPeople={addPeople} />}
          {tab === 'memories' && <MemoriesView data={data} addMemory={addMemory} deleteMemory={deleteMemory} addDocument={addDocument} deleteDocument={deleteDocument} />}
        </>
      )}

      <p className="banner" style={{ marginTop: 24 }}>Mike's Life · {FIREBASE_READY ? 'connected' : 'demo mode — add Firebase config to enable sign-in + saving'} · <span className="dim">build {BUILD}</span></p>


      {/* Mobile floating dock — 4 primary + More sheet (peacock lives in the header) */}
      {moreOpen && (
        <div className="more-sheet" onClick={() => setMoreOpen(false)}>
          {[['inbox', '📥 Inbox'], ['email', '✉️ Email'], ['memories', '📸 Memories']].map(([id, label]) => (
            <button key={id} className={'tab' + (!pillar && tab === id ? ' active' : '')} onClick={() => { goTab(id); setMoreOpen(false); }}>{label}</button>
          ))}
        </div>
      )}
      <div className="dock">
        {[['home', '🏠', 'Home'], ['planning', '🗺️', 'Plans'], ['calendar', '🗓️', 'Calendar'], ['people', '👥', 'People']].map(([id, ic, lb]) => (
          <button key={id} className={'dock-item' + (!pillar && !moreOpen && tab === id ? ' active' : '')}
            onClick={() => { goTab(id); setMoreOpen(false); }}>
            <span className="di">{ic}</span>{lb}
            {id === 'home' && data.proposals.length > 0 && <span className="dock-badge">{data.proposals.length}</span>}
          </button>
        ))}
        <button className={'dock-item' + (moreOpen || ['inbox', 'email', 'memories'].includes(tab) ? ' active' : '')} onClick={() => setMoreOpen(!moreOpen)}>
          <span className="di">⋯</span>More
        </button>
      </div>

      {rupertOpen && (
        <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) setRupertOpen(false); }}>
          <div className="modal-rupert">
            <RupertChat seed={rupertSeed} onClose={() => setRupertOpen(false)} />
          </div>
        </div>
      )}
      </main>
      </div>
    </div>
  );
}
