import { useState } from 'react';
import { COL, PILLAR_LABEL, ODYSSEY_GAUGES } from './seed';

const SUBTABS = [['plans', 'Plans'], ['odyssey', 'Odyssey'], ['mindmap', 'Mind Map'], ['journal', 'Good Time Journal']];

function pillarPill(pk) {
  const c = `var(${COL[pk]})`;
  return <span className="pill" style={{ background: 'rgba(148,163,184,.14)', color: c }}>{PILLAR_LABEL[pk]}</span>;
}

// ───────────── Plans (activate → stages → to-dos) ─────────────
function PlanCard({ plan, activatePlan, setPlanStatus, toggleTask }) {
  const [hint, setHint] = useState(false);
  const tasks = (plan.stages || []).flatMap((s) => s.tasks);
  const done = tasks.filter((t) => t.done).length;
  const pct = tasks.length ? Math.round((done / tasks.length) * 100) : 0;
  const c = `var(${COL[plan.pk]})`;

  return (
    <div className="card" style={{ borderLeft: `3px solid ${c}` }}>
      <div className="planhead">
        <div><div className="nm">{plan.title}</div><div className="nt">{plan.note}</div></div>
        <div className="row" style={{ alignItems: 'center' }}>
          {pillarPill(plan.pk)}
          {plan.status === 'done' && <span className="pill" style={{ background: 'rgba(52,211,153,.15)', color: 'var(--emerald)' }}>done</span>}
        </div>
      </div>

      {plan.status === 'someday' && (
        <button className="btn app" style={{ marginTop: 12 }} onClick={() => activatePlan(plan.id)}>Activate &amp; plan it →</button>
      )}

      {plan.status !== 'someday' && tasks.length > 0 && (
        <>
          <div className="prog"><div style={{ width: `${pct}%` }} /></div>
          <div className="dim" style={{ fontSize: 12 }}>{done} of {tasks.length} done</div>
          {plan.stages.map((s) => (
            <div className="stage" key={s.id}>
              <div className="sh">{s.title}</div>
              {s.tasks.map((t) => (
                <div className={'task' + (t.done ? ' done' : '')} key={t.id} onClick={() => toggleTask(plan.id, s.id, t.id)}>
                  <div className="box">{t.done ? '✓' : ''}</div>
                  <div className="tt">{t.text}</div>
                </div>
              ))}
            </div>
          ))}
          <div className="row" style={{ marginTop: 12, gap: 8 }}>
            <button className="btn def" onClick={() => setHint(!hint)}>✨ Refine with Rupert</button>
            {plan.status === 'active'
              ? <button className="btn app" onClick={() => setPlanStatus(plan.id, 'done')}>Mark done</button>
              : <button className="btn def" onClick={() => setPlanStatus(plan.id, 'active')}>Reopen</button>}
          </div>
          {hint && <p className="banner" style={{ textAlign: 'left', marginTop: 8 }}>Rupert isn’t wired into this app yet — once the snapshot bridge is connected he’ll add plan-specific steps here. For now the template steps are a starting point you can check off.</p>}
        </>
      )}
    </div>
  );
}

function Plans({ data, activatePlan, setPlanStatus, toggleTask, addPlan }) {
  const [title, setTitle] = useState('');
  const [pk, setPk] = useState('fun');
  const submit = () => { if (title.trim()) { addPlan(title, pk); setTitle(''); } };
  const active = data.plans.filter((p) => p.status === 'active');
  const someday = data.plans.filter((p) => p.status === 'someday');
  const done = data.plans.filter((p) => p.status === 'done');
  const Section = ({ label, items }) => items.length > 0 && (
    <>
      <div className="subhead" style={{ margin: '6px 0 8px' }}>{label}</div>
      {items.map((p) => <PlanCard key={p.id} plan={p} activatePlan={activatePlan} setPlanStatus={setPlanStatus} toggleTask={toggleTask} />)}
    </>
  );
  return (
    <section>
      <div className="card">
        <div className="subhead" style={{ marginTop: 0 }}>Add a plan</div>
        <div className="addrow">
          <select value={pk} onChange={(e) => setPk(e.target.value)} style={{ flex: '0 0 auto', background: 'var(--panel2)', border: '1px solid var(--line)', borderRadius: 10, color: 'var(--txt)', padding: '9px 10px' }}>
            {Object.entries(PILLAR_LABEL).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
          </select>
          <input type="text" placeholder="New plan or someday idea…" value={title}
            onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') submit(); }} />
          <button className="btn app" onClick={submit}>Add</button>
        </div>
      </div>
      <Section label={`In motion (${active.length})`} items={active} />
      <Section label={`Someday (${someday.length})`} items={someday} />
      <Section label={`Done (${done.length})`} items={done} />
      <p className="banner">Add an idea, then Activate it to break it into stages of to-dos. Template-first; Rupert refines later.</p>
    </section>
  );
}

// ───────────── Odyssey Plans (Design Your Life) ─────────────
function Odyssey({ data, updateOdyssey }) {
  return (
    <section>
      <div className="section-title">Odyssey Plans — three alternate 5-year lives</div>
      {data.odyssey.map((o) => (
        <div className="card" key={o.id}>
          <div className="nm" style={{ fontSize: 15, fontWeight: 700, marginBottom: 8 }}>{o.title}</div>
          <textarea value={o.sketch} onChange={(e) => updateOdyssey(o.id, { sketch: e.target.value })} />
          <div style={{ marginTop: 12 }}>
            {ODYSSEY_GAUGES.map((g) => (
              <div className="gauge" key={g}>
                <label>{g}<span style={{ color: 'var(--teal)' }}>{o.gauges[g]}/5</span></label>
                <input type="range" min="1" max="5" value={o.gauges[g]} style={{ accentColor: 'var(--teal)' }}
                  onChange={(e) => updateOdyssey(o.id, { gauges: { [g]: +e.target.value } })} />
              </div>
            ))}
          </div>
        </div>
      ))}
      <p className="banner">Sketch each path, then rate it on resources, how much you like it, confidence, and coherence with who you are.</p>
    </section>
  );
}

// ───────────── Mind Map / brainstorm ─────────────
function MindMap({ data, setMindTopic, addMindBranch, removeMindBranch }) {
  const [text, setText] = useState('');
  const add = () => { if (text.trim()) { addMindBranch(text.trim()); setText(''); } };
  return (
    <section>
      <div className="section-title">Mind map — brainstorm before it’s a plan</div>
      <div className="card">
        <label className="dim" style={{ fontSize: 12, fontWeight: 600 }}>Topic</label>
        <input type="text" value={data.mindmap.topic} onChange={(e) => setMindTopic(e.target.value)} style={{ marginTop: 6, marginBottom: 4 }} />
        <div className="mind-center" style={{ marginTop: 10 }}>{data.mindmap.topic || 'Your topic'}</div>
        <div className="branchwrap">
          {data.mindmap.branches.map((b, i) => (
            <span className="branch" key={i}>{b}<button onClick={() => removeMindBranch(i)} title="Remove">×</button></span>
          ))}
        </div>
        <div className="addrow">
          <input type="text" placeholder="Add a branch / idea…" value={text}
            onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') add(); }} />
          <button className="btn app" onClick={add}>Add</button>
        </div>
      </div>
      <p className="banner">Dump every angle of a fuzzy idea. When one’s worth pursuing, it can graduate into a Plan.</p>
    </section>
  );
}

// ───────────── Good Time Journal ─────────────
function Journal({ data, addGoodTime }) {
  const [activity, setActivity] = useState('');
  const [energy, setEnergy] = useState(3);
  const [engagement, setEngagement] = useState(3);
  const [note, setNote] = useState('');
  const save = () => {
    if (!activity.trim()) return;
    addGoodTime({ activity: activity.trim(), energy, engagement, note: note.trim() });
    setActivity(''); setEnergy(3); setEngagement(3); setNote('');
  };
  return (
    <section>
      <div className="section-title">Good Time Journal — what energizes you</div>
      <div className="card">
        <div className="field" style={{ marginBottom: 12 }}><label>Activity</label>
          <input type="text" placeholder="e.g., Coaching call, gardening, writing…" value={activity} onChange={(e) => setActivity(e.target.value)} /></div>
        <div className="gauge"><label>Energy <span style={{ color: 'var(--amber)' }}>{energy}/5</span></label>
          <input type="range" min="1" max="5" value={energy} style={{ accentColor: 'var(--amber)' }} onChange={(e) => setEnergy(+e.target.value)} /></div>
        <div className="gauge"><label>Engagement <span style={{ color: 'var(--violet)' }}>{engagement}/5</span></label>
          <input type="range" min="1" max="5" value={engagement} style={{ accentColor: 'var(--violet)' }} onChange={(e) => setEngagement(+e.target.value)} /></div>
        <div className="field" style={{ margin: '8px 0 12px' }}><label>Note</label>
          <input type="text" placeholder="What about it worked or didn't?" value={note} onChange={(e) => setNote(e.target.value)} /></div>
        <button className="btn app" onClick={save}>Log it</button>
      </div>
      <div className="card">
        <h3>Recent</h3>
        {data.goodTime.map((g) => (
          <div className="loop" key={g.id}><div className="dot" style={{ background: g.energy >= 4 ? 'var(--emerald)' : g.energy <= 2 ? 'var(--rose)' : 'var(--amber)' }} />
            <div><div className="lt">{g.activity}</div><div className="lm">energy {g.energy}/5 · engagement {g.engagement}/5{g.note ? ` · ${g.note}` : ''}</div></div></div>
        ))}
      </div>
      <p className="banner">Patterns here tell you what to do more of — and what’s worth activating as a plan.</p>
    </section>
  );
}

// ───────────── Hub ─────────────
export default function PlanningHub(props) {
  const [sub, setSub] = useState('plans');
  return (
    <section>
      <div className="substrip">
        {SUBTABS.map(([id, label]) => (
          <button key={id} className={sub === id ? 'on' : ''} onClick={() => setSub(id)}>{label}</button>
        ))}
      </div>
      {sub === 'plans' && <Plans {...props} />}
      {sub === 'odyssey' && <Odyssey {...props} />}
      {sub === 'mindmap' && <MindMap {...props} />}
      {sub === 'journal' && <Journal {...props} />}
    </section>
  );
}
