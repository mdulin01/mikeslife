/* global __BUILD__ */
import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
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
  PILLARS, COL, SDOT, PILLAR_LABEL, TODAY_POOL, QUOTES,
  WEEK_DAYS, WEEK_EVENTS, MAILS, CODING_UPDATES,
} from './seed';

const TABS = [
  ['home', 'Home'], ['inbox', 'Inbox'], ['planning', 'Planning'],
  ['calendar', 'Calendar'], ['email', 'Email'], ['people', 'People'], ['memories', 'Memories'],
];

const moodEmoji = (v) => { v = +v; return v <= 2 ? '😣' : v <= 4 ? '😐' : v <= 6 ? '🙂' : v <= 8 ? '😄' : '🤩'; };
const capLevel = (v) => (v <= 3 ? 'low' : v <= 7 ? 'med' : 'high');
const capLabel = (v) => (v <= 3 ? 'Low · rest' : v <= 7 ? 'Medium' : 'High · go');

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

// Turn bare URLs in Rupert's text into clickable links (podcasts, recipes, travel).
function Linkified({ text }) {
  const parts = String(text || '').split(/(https?:\/\/[^\s)]+)/g);
  return parts.map((s, i) => /^https?:\/\//.test(s)
    ? <a key={i} href={s} target="_blank" rel="noopener noreferrer" className="clink">{s.replace(/^https?:\/\/(www\.)?/, '').split('/')[0]} ↗</a>
    : <span key={i}>{s}</span>);
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
function CheckIn({ quote, capVal, setCapVal, onSave }) {
  const [energy, setEnergy] = useState(6);
  const [mood, setMood] = useState(7);
  const [journal, setJournal] = useState('');
  return (
    <section>
      <div className="quote">"{quote[0]}"<span className="by">— {quote[1]}</span></div>
      <div className="card">
        <h3>Morning check-in</h3>
        <div className="field" style={{ marginBottom: 15 }}>
          <label>Energy <span className="val" style={{ color: 'var(--amber)' }}>{energy}</span>/10</label>
          <input type="range" min="1" max="10" value={energy} style={{ accentColor: 'var(--amber)' }} onChange={(e) => setEnergy(+e.target.value)} />
        </div>
        <div className="field" style={{ marginBottom: 15 }}>
          <label>Mood <span className="val" style={{ color: 'var(--violet)' }}>{moodEmoji(mood)}</span></label>
          <input type="range" min="1" max="10" value={mood} style={{ accentColor: 'var(--violet)' }} onChange={(e) => setMood(+e.target.value)} />
        </div>
        <div className="field" style={{ marginBottom: 15 }}>
          <label>Capacity <span className="val" style={{ color: 'var(--sky)' }}>{capLabel(capVal)}</span> <span className="dim" style={{ fontWeight: 500 }}>— sets how full "Today" gets</span></label>
          <input type="range" min="1" max="10" value={capVal} style={{ accentColor: 'var(--sky)' }} onChange={(e) => setCapVal(+e.target.value)} />
        </div>
        <div className="field">
          <label>Journal — reflections on today, or yesterday</label>
          <textarea placeholder="What's on your mind? What went well yesterday?…" value={journal} onChange={(e) => setJournal(e.target.value)} />
        </div>
        <button className="btn app" style={{ marginTop: 13 }} onClick={() => onSave({ energy, mood, capacity: capVal, journal })}>Save &amp; see today →</button>
      </div>
      <p className="banner">Widgets rotate day to day so the ritual stays fresh.</p>
    </section>
  );
}

function Today({ capVal, data }) {
  const n = capLevel(capVal) === 'high' ? 10 : capLevel(capVal) === 'med' ? 4 : 0;
  const brief = data && data.todayBrief && data.todayBrief.text;
  return (
    <section>
      {brief && (
        <div className="card" style={{ borderLeft: '3px solid var(--teal)', whiteSpace: 'pre-wrap', fontSize: 14, lineHeight: 1.55 }}>
          <h3>☀️ Rupert's morning brief</h3>
          <Linkified text={brief} />
        </div>
      )}
      {data && data.contentFeed && data.contentFeed.text && (
        <div className="card" style={{ borderLeft: '3px solid var(--sky)', whiteSpace: 'pre-wrap', fontSize: 14, lineHeight: 1.55 }}>
          <div className="between"><h3 style={{ margin: 0 }}>{data.contentFeed.title || 'From Rupert'}</h3>
            {data.contentFeed.at && <span className="dim" style={{ fontSize: 11 }}>{relTime(data.contentFeed.at)}</span>}</div>
          <div style={{ marginTop: 8 }}><Linkified text={data.contentFeed.text} /></div>
        </div>
      )}
      <div className="card">
        <div className="between"><h3 style={{ margin: 0 }}>Today · tuned to your capacity</h3>
          <span className="pill" style={{ background: 'rgba(148,163,184,.15)', color: 'var(--mut)' }}>{capLabel(capVal)}</span></div>
        <div style={{ marginTop: 10 }}>
          {n === 0 ? (
            <div className="loop"><div className="dot" style={{ background: 'var(--violet)' }} /><div>
              <div className="lt">Low-capacity day — protect your energy.</div>
              <div className="lm">Nothing on the list. Rest, recover, be kind to yourself. 💛</div></div></div>
          ) : TODAY_POOL.slice(0, n).map((p, i) => (
            <div className="loop" key={i}><div className="dot" style={{ background: p.c }} /><div>
              <div className="lt">{p.t}</div><div className="lm">{p.m}</div></div></div>
          ))}
        </div>
      </div>
      <div className="card">
        <h3>Next on your calendar</h3>
        <div className="loop"><div className="dot" style={{ background: 'var(--violet)' }} /><div><div className="lt">10:30 — Triad client block (consulting)</div><div className="lm">Purpose · 2 hrs</div></div></div>
        <div className="loop"><div className="dot" style={{ background: 'var(--emerald)' }} /><div><div className="lt">5:30 — Zone-2 ride</div><div className="lm">Health · proposed by Body Coach, you confirmed</div></div></div>
        <div className="loop"><div className="dot" style={{ background: 'var(--rose)' }} /><div><div className="lt">7:00 — Dinner with Adam</div><div className="lm">Relationships</div></div></div>
      </div>
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

// ───────────────────────── App ─────────────────────────
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
  const [capVal, setCapVal] = useState(5);
  const [notif, setNotif] = useState(typeof Notification !== 'undefined' ? Notification.permission : 'unsupported');
  const [rupertOpen, setRupertOpen] = useState(false);
  const [rupertSeed, setRupertSeed] = useState('');
  const [peacockPop, setPeacockPop] = useState(false);
  const openRupert = (s = '') => {
    setRupertSeed(s); setRupertOpen(true);
    setPeacockPop(true); setTimeout(() => setPeacockPop(false), 850);
  };

  const quote = useMemo(() => QUOTES[Math.floor(Math.random() * QUOTES.length)], []);
  const {
    data, resolveProposal, saveCheckin,
    activatePlan, setPlanStatus, toggleTask, addPlan, addTask,
    updateOdyssey, addGoodTime, setMindTopic, addMindBranch, removeMindBranch,
    addMemory, deleteMemory, addDocument, deleteDocument,
    addPerson, deletePerson, addPeople,
    setFcmToken,
  } = useLifeData(user);

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

  const enableNotify = async () => {
    setNotif('working');
    const r = await requestPushToken();
    if (r.ok) { setFcmToken(r.token); setNotif('granted'); }
    else { setNotif('default'); console.warn('notifications:', r.reason); }
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

  const signIn = () => signInWithPopup(auth, provider).catch((e) => setAuthErr(e.message));

  if (!authReady) return <div className="wrap"><p className="banner" style={{ marginTop: 40 }}>Loading…</p></div>;
  if (FIREBASE_READY && !user) return <Login onSignIn={signIn} error={authErr} />;

  const counts = {};
  Object.keys(PILLARS).forEach((k) => { counts[k] = data.proposals.filter((p) => p.pk === k).length; });

  const now = new Date();
  const openPillar = (k) => { setPillar(k); };
  const goTab = (t) => { setPillar(null); setTab(t); };

  const onSaveCheckin = (c) => { saveCheckin({ ...c, date: easternYMD(now) }); };

  return (
    <div className="wrap">
      <div className="apphead">
        <div className="row" style={{ gap: 10 }}>
          <div className="logo">Mike's <b>Life</b>{!FIREBASE_READY && <span className="demo-tag">DEMO</span>}</div>
          {FIREBASE_READY && user && (
            <button className={'rupertbtn' + (peacockPop ? ' pop' : '')} title="Talk to Rupert" onClick={() => openRupert()}>
              <span className="peacock" role="img" aria-label="Rupert">🦚</span>
              {peacockPop && <span className="featherring" />}
            </button>
          )}
        </div>
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
          <button className="btn def refbtn" onClick={doRefresh} disabled={refreshing} title="Have Rupert pull fresh content + ideas">
            <RefreshCw size={14} className={refreshing ? 'spin' : ''} /> {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      )}
      {refreshMsg && <div className="dim" style={{ fontSize: 12, margin: '-2px 2px 10px' }}>{refreshMsg}</div>}

      {FIREBASE_READY && notif !== 'granted' && notif !== 'unsupported' && (
        <div className="card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
          <div style={{ fontSize: 13 }}>🔔 <b>Turn on notifications</b> so Rupert can ping your phone for check-ins.
            <span className="dim"> On iPhone, add this app to your Home Screen first, open it from there, then tap Enable.</span></div>
          <button className="btn app" style={{ flex: '0 0 auto' }} onClick={enableNotify}>{notif === 'working' ? '…' : 'Enable'}</button>
        </div>
      )}

      {pillar ? (
        <PillarArea pk={pillar} proposals={data.proposals} plans={data.plans} onResolve={resolveProposal} onBack={() => goTab('home')} onPlanClick={(p) => { if (p.status !== 'active' && p.status !== 'done') activatePlan(p.id); goTab('planning'); }} />
      ) : (
        <>
          {tab === 'home' && (
            <>
              <Today capVal={capVal} data={data} />
              <CheckIn quote={quote} capVal={capVal} setCapVal={setCapVal} onSave={onSaveCheckin} />
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
