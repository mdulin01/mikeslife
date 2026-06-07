import { useEffect, useMemo, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { onAuthStateChanged, signInWithPopup, signOut } from 'firebase/auth';
import { FIREBASE_READY, OWNER_UID, auth, provider } from './firebase';
import { useLifeData } from './useLifeData';
import { requestPushToken } from './messaging';
import PlanningHub from './planning';
import RupertChat from './rupert';
import {
  PILLARS, COL, SDOT, PILLAR_LABEL, TODAY_POOL, QUOTES,
  WEEK_DAYS, WEEK_EVENTS, MAILS, CODING_UPDATES,
} from './seed';

const TABS = [
  ['checkin', 'Check-in'], ['today', 'Today'], ['rupert', 'Rupert'], ['inbox', 'Inbox'],
  ['planning', 'Planning'], ['calendar', 'Calendar'], ['email', 'Email'],
  ['people', 'People'], ['updates', 'Coding Updates'],
];

const moodEmoji = (v) => { v = +v; return v <= 2 ? '😣' : v <= 4 ? '😐' : v <= 6 ? '🙂' : v <= 8 ? '😄' : '🤩'; };
const capLevel = (v) => (v <= 3 ? 'low' : v <= 7 ? 'med' : 'high');
const capLabel = (v) => (v <= 3 ? 'Low · rest' : v <= 7 ? 'Medium' : 'High · go');

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
          {brief}
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

function PersonRow({ p }) {
  return (
    <div className="person"><div><div className="pn">{p.name}</div><div className="pm">{p.meta}</div></div>
      <span className="pa">{p.action}</span></div>
  );
}

function People({ people }) {
  return (
    <section>
      <div className="card"><div className="subhead">Personal</div>{people.personal.map((p) => <PersonRow key={p.id} p={p} />)}</div>
      <div className="card"><div className="subhead">Professional network</div>{people.professional.map((p) => <PersonRow key={p.id} p={p} />)}
        <div className="person"><div><div className="pn">+ from your email</div><div className="pm">Rupert surfaces contacts you've gone quiet on</div></div><span className="pa">review</span></div>
      </div>
      <div className="card"><div className="subhead">🎯 Job opportunities &amp; next gig <span className="dim" style={{ textTransform: 'none', fontWeight: 500 }}>· powered by mikedulinmd.app</span></div>
        {people.opportunities.map((p) => <PersonRow key={p.id} p={p} />)}</div>
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

function PillarArea({ pk, proposals, plans, onResolve, onBack }) {
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
        <div className="card"><h3>Plans in this area</h3><div className="cgrid">{myplans.map((x) => <PlanCard key={x.id} p={x} />)}</div></div>
      )}
    </section>
  );
}

// ───────────────────────── App ─────────────────────────
export default function App() {
  const [user, setUser] = useState(null);
  const [authReady, setAuthReady] = useState(!FIREBASE_READY);
  const [authErr, setAuthErr] = useState('');
  const [tab, setTab] = useState('checkin');
  const [pillar, setPillar] = useState(null);
  const [capVal, setCapVal] = useState(5);
  const [notif, setNotif] = useState(typeof Notification !== 'undefined' ? Notification.permission : 'unsupported');

  const quote = useMemo(() => QUOTES[Math.floor(Math.random() * QUOTES.length)], []);
  const {
    data, resolveProposal, saveCheckin,
    activatePlan, setPlanStatus, toggleTask, addPlan,
    updateOdyssey, addGoodTime, setMindTopic, addMindBranch, removeMindBranch,
    setFcmToken,
  } = useLifeData(user);

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

  const onSaveCheckin = (c) => { saveCheckin({ ...c, date: now.toISOString().slice(0, 10) }); goTab('today'); };

  return (
    <div className="wrap">
      <div className="apphead">
        <div className="logo">Mike's <b>Life</b>{!FIREBASE_READY && <span className="demo-tag">DEMO</span>}</div>
        <div className="date">
          {now.toLocaleDateString('en-US', { weekday: 'long' })}<br />
          {now.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
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

      <nav>
        {TABS.map(([id, label]) => (
          <button className={'tab' + (!pillar && tab === id ? ' active' : '')} key={id} onClick={() => goTab(id)}>
            {label}{id === 'inbox' ? <span className="pill" style={{ background: 'var(--teal)', color: '#04201c', marginLeft: 6 }}>{data.proposals.length}</span> : null}
          </button>
        ))}
      </nav>

      {FIREBASE_READY && notif !== 'granted' && notif !== 'unsupported' && (
        <div className="card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
          <div style={{ fontSize: 13 }}>🔔 <b>Turn on notifications</b> so Rupert can ping your phone for check-ins.
            <span className="dim"> On iPhone, add this app to your Home Screen first, open it from there, then tap Enable.</span></div>
          <button className="btn app" style={{ flex: '0 0 auto' }} onClick={enableNotify}>{notif === 'working' ? '…' : 'Enable'}</button>
        </div>
      )}

      {pillar ? (
        <PillarArea pk={pillar} proposals={data.proposals} plans={data.plans} onResolve={resolveProposal} onBack={() => goTab('today')} />
      ) : (
        <>
          {tab === 'checkin' && <CheckIn quote={quote} capVal={capVal} setCapVal={setCapVal} onSave={onSaveCheckin} />}
          {tab === 'today' && <Today capVal={capVal} data={data} />}
          {tab === 'rupert' && <RupertChat />}
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
              updateOdyssey={updateOdyssey}
              addGoodTime={addGoodTime}
              setMindTopic={setMindTopic}
              addMindBranch={addMindBranch}
              removeMindBranch={removeMindBranch}
            />
          )}
          {tab === 'people' && <People people={data.people} />}
          {tab === 'updates' && <CodingUpdates />}
        </>
      )}

      <p className="banner" style={{ marginTop: 24 }}>Mike's Life · {FIREBASE_READY ? 'connected' : 'demo mode — add Firebase config to enable sign-in + saving'}</p>
    </div>
  );
}
