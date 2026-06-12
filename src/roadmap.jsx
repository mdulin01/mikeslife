import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { ROADMAP_APPS, ROADMAP_COLS } from './seed';

const STATUSES = ROADMAP_COLS.map(([k]) => k);

function AppChip({ app }) {
  const a = ROADMAP_APPS[app] || { label: app, c: '--mut' };
  return <span className="rm-chip" style={{ color: `var(${a.c})`, borderColor: `var(${a.c})` }}>{a.label}</span>;
}

export default function RoadmapView({ data, addRoadmapItem, updateRoadmapItem, deleteRoadmapItem }) {
  const items = data.roadmap || [];
  const [filter, setFilter] = useState('all');
  const [title, setTitle] = useState('');
  const [app, setApp] = useState('lifeos');
  const [status, setStatus] = useState('idea');

  const shown = items.filter((x) => filter === 'all' || x.app === filter);
  const submit = () => { if (title.trim()) { addRoadmapItem({ title: title.trim(), app, status }); setTitle(''); } };

  const counts = {};
  STATUSES.forEach((s) => { counts[s] = items.filter((x) => x.status === s).length; });

  return (
    <section>
      <div className="section-title">🗺️ Roadmap <span className="dim" style={{ fontWeight: 500 }}>· {items.length} items across the LifeOS + spoke apps</span></div>

      <div className="card">
        <div className="addrow" style={{ flexWrap: 'wrap', gap: 8 }}>
          <input type="text" placeholder="Add an item / idea…" value={title} style={{ flex: '2 1 220px' }}
            onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') submit(); }} />
          <select value={app} onChange={(e) => setApp(e.target.value)} className="rm-select">
            {Object.entries(ROADMAP_APPS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
          <select value={status} onChange={(e) => setStatus(e.target.value)} className="rm-select">
            {ROADMAP_COLS.map(([k, lb]) => <option key={k} value={k}>{lb}</option>)}
          </select>
          <button className="btn app" onClick={submit}>Add</button>
        </div>
      </div>

      <div className="rm-filters">
        <button className={'chipbtn' + (filter === 'all' ? ' on' : '')} onClick={() => setFilter('all')}>All</button>
        {Object.entries(ROADMAP_APPS).map(([k, v]) => (
          <button key={k} className={'chipbtn' + (filter === k ? ' on' : '')} onClick={() => setFilter(k)}>{v.label}</button>
        ))}
      </div>

      <div className="rm-board">
        {ROADMAP_COLS.map(([s, label]) => {
          const col = shown.filter((x) => x.status === s);
          return (
            <div className="rm-col" key={s}>
              <div className="rm-colhead">{label} <span className="dim">{col.length}</span></div>
              {col.map((it) => (
                <div className="rm-item" key={it.id}>
                  <div className="rm-itemtop">
                    <AppChip app={it.app} />
                    <button className="trash" title="Delete" onClick={() => deleteRoadmapItem(it.id)}><Trash2 size={14} /></button>
                  </div>
                  <div className="rm-title">{it.title}</div>
                  {it.note && <div className="rm-note">{it.note}</div>}
                  <select className="rm-move" value={it.status} onChange={(e) => updateRoadmapItem(it.id, { status: e.target.value })}>
                    {ROADMAP_COLS.map(([k, lb]) => <option key={k} value={k}>{lb}</option>)}
                  </select>
                </div>
              ))}
              {col.length === 0 && <div className="rm-empty">—</div>}
            </div>
          );
        })}
      </div>
      <p className="banner">Your single source of truth for LifeOS + spoke-app work. Saved to your account; Rupert can read it. Move items with the dropdown, add ideas up top.</p>
    </section>
  );
}
