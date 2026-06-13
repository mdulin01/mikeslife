import { useState } from 'react';

// Emergency one-pager — the single sheet someone needs if Mike is incapacitated.
// Structured, editable, printable. Stored in lifeos.emergency. NO passwords (a
// homegrown app is the wrong place for secrets — use a real password manager).
const LISTS = [
  { key: 'contacts', label: '👤 Emergency contacts', cols: [['name', 'Name'], ['relation', 'Relation'], ['phone', 'Phone']] },
  { key: 'providers', label: '🩺 Key providers', cols: [['name', 'Name'], ['specialty', 'Specialty'], ['phone', 'Phone']] },
  { key: 'insurance', label: '🛡️ Insurance', cols: [['type', 'Type'], ['provider', 'Provider'], ['member', 'Member #'], ['phone', 'Phone']] },
];
const TEXTS = [
  ['bloodType', 'Blood type', false],
  ['allergies', 'Allergies', false],
  ['conditions', 'Key conditions', true],
  ['medications', 'Medications (or "see mikeshealth")', true],
  ['pharmacy', 'Pharmacy', false],
  ['poa', 'Healthcare proxy / POA (name + phone)', false],
  ['directives', 'Advance directive / living will — where it lives', true],
  ['estate', 'Will / estate docs — where they live', true],
  ['whereThingsAre', 'Where things are (accounts, safe, key docs — NO passwords)', true],
];

export default function VaultView({ data, setEmergency }) {
  const e = data.emergency || {};
  const [draft, setDraft] = useState(e);
  const merged = { ...e, ...draft };

  const saveText = (k, v) => { const next = { ...draft, [k]: v }; setDraft(next); };
  const commit = () => setEmergency(draft);

  const list = (k) => Array.isArray(merged[k]) ? merged[k] : [];
  const addRow = (k) => { const next = { ...draft, [k]: [...list(k), {}] }; setDraft(next); setEmergency(next); };
  const setCell = (k, i, col, v) => { const arr = list(k).map((r, j) => j === i ? { ...r, [col]: v } : r); setDraft({ ...draft, [k]: arr }); };
  const delRow = (k, i) => { const arr = list(k).filter((_, j) => j !== i); const next = { ...draft, [k]: arr }; setDraft(next); setEmergency(next); };

  const printIt = () => {
    const esc = (t) => String(t || '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const sec = (title, body) => body ? `<h2>${title}</h2>${body}` : '';
    const listHtml = (k, label, cols) => {
      const rows = list(k).filter((r) => Object.values(r).some(Boolean));
      if (!rows.length) return '';
      const trs = rows.map((r) => `<tr>${cols.map(([c]) => `<td>${esc(r[c])}</td>`).join('')}</tr>`).join('');
      return sec(label, `<table><thead><tr>${cols.map(([, lbl]) => `<th>${lbl}</th>`).join('')}</tr></thead><tbody>${trs}</tbody></table>`);
    };
    const textHtml = TEXTS.filter(([k]) => merged[k]).map(([k, lbl]) => `<p><b>${lbl}:</b> ${esc(merged[k]).replace(/\n/g, '<br>')}</p>`).join('');
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Emergency One-Pager — Mike Dulin</title>
      <style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:720px;margin:32px auto;color:#111;line-height:1.5}
      h1{font-size:22px;border-bottom:3px solid #111;padding-bottom:6px;margin-bottom:4px}
      .sub{color:#666;font-size:13px;margin-bottom:18px}
      h2{font-size:14px;text-transform:uppercase;letter-spacing:.05em;color:#444;margin:18px 0 6px;border-bottom:1px solid #ddd;padding-bottom:3px}
      table{width:100%;border-collapse:collapse;margin:4px 0 10px} td,th{text-align:left;padding:4px 8px;border-bottom:1px solid #eee;font-size:14px} th{color:#666;font-size:11px;text-transform:uppercase}
      p{font-size:14px;margin:5px 0}</style></head><body>
      <h1>🚨 Emergency One-Pager — Mike Dulin</h1>
      <div class="sub">Printed ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} · keep current</div>
      ${LISTS.map((l) => listHtml(l.key, l.label.replace(/^.. /, ''), l.cols)).join('')}
      ${sec('Medical & legal', textHtml)}
      </body></html>`;
    const w = window.open('', '_blank');
    if (w) { w.document.write(html); w.document.close(); setTimeout(() => w.print(), 350); }
  };

  return (
    <section>
      <div className="section-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <span>🚨 Emergency one-pager</span>
        <button className="btn app" style={{ fontSize: 13 }} onClick={printIt}>🖨️ Print / Save PDF</button>
      </div>
      <p className="banner" style={{ marginTop: 0 }}>The sheet someone needs if you can't speak for yourself. Saved to your account. No passwords here — use a password manager for those.</p>

      {LISTS.map(({ key, label, cols }) => (
        <div className="card" key={key} style={{ marginBottom: 12 }}>
          <h3>{label}</h3>
          {list(key).map((row, i) => (
            <div className="row" key={i} style={{ gap: 6, marginBottom: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              {cols.map(([col, ph]) => (
                <input key={col} placeholder={ph} value={row[col] || ''} onChange={(ev) => setCell(key, i, col, ev.target.value)} onBlur={commit}
                  style={{ flex: '1 1 90px', minWidth: 0, background: 'var(--panel2)', color: 'var(--txt)', border: '1px solid var(--line)', borderRadius: 8, padding: '7px 9px', fontSize: 13, boxSizing: 'border-box' }} />
              ))}
              <button className="btn def" style={{ flex: '0 0 auto', fontSize: 12 }} onClick={() => delRow(key, i)}>✕</button>
            </div>
          ))}
          <button className="btn def" style={{ fontSize: 12, marginTop: 4 }} onClick={() => addRow(key)}>+ Add</button>
        </div>
      ))}

      <div className="card">
        <h3>🩺 Medical &amp; legal</h3>
        {TEXTS.map(([k, lbl, multi]) => (
          <div key={k} style={{ marginBottom: 10 }}>
            <div className="dim" style={{ fontSize: 12, marginBottom: 3 }}>{lbl}</div>
            {multi
              ? <textarea value={merged[k] || ''} rows={2} onChange={(ev) => saveText(k, ev.target.value)} onBlur={commit}
                  style={{ width: '100%', boxSizing: 'border-box', background: 'var(--panel2)', color: 'var(--txt)', border: '1px solid var(--line)', borderRadius: 8, padding: 9, fontSize: 13, fontFamily: 'inherit', resize: 'vertical' }} />
              : <input value={merged[k] || ''} onChange={(ev) => saveText(k, ev.target.value)} onBlur={commit}
                  style={{ width: '100%', boxSizing: 'border-box', background: 'var(--panel2)', color: 'var(--txt)', border: '1px solid var(--line)', borderRadius: 8, padding: '8px 9px', fontSize: 13 }} />}
          </div>
        ))}
      </div>
    </section>
  );
}
