import { useState } from 'react';
import { storage } from './firebase';
import { ref as sRef, uploadBytes, getDownloadURL, deleteObject } from 'firebase/storage';

// ---- Document vault: real files (PDF/scans) in Firebase Storage, indexed in
// lifeos.vaultDocs. Owner-only via storage.rules (vault/{uid}/**); to share with
// Adam later, widen the rule — see storage.rules at repo root.
const CATS = [
  ['legal', '⚖️ Estate / legal'],
  ['property', '🏠 Property / financial'],
  ['identity', '🪪 Identity / medical'],
  ['tax', '🧾 Taxes'],
];
const CAT_LABEL = Object.fromEntries(CATS);
const MAX_MB = 20;
const fmtSize = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
const daysUntil = (d) => Math.ceil((new Date(d + 'T12:00:00') - Date.now()) / 86400000);

function DocumentsSection({ user, docs, setVaultDocs }) {
  const [cat, setCat] = useState('all');
  const [upCat, setUpCat] = useState('legal');
  const [busy, setBusy] = useState(false);
  const ready = Boolean(storage && user);
  const shown = docs
    .filter((d) => cat === 'all' || d.category === cat)
    .slice()
    .sort((a, b) => String(b.uploadedAt || '').localeCompare(String(a.uploadedAt || '')));

  const onFile = async (ev) => {
    const file = ev.target.files && ev.target.files[0];
    ev.target.value = '';
    if (!file || !ready || busy) return;
    if (file.size > MAX_MB * 1048576) { alert(`Max ${MAX_MB} MB per file.`); return; }
    setBusy(true);
    try {
      const id = 'v' + Date.now();
      const path = `vault/${user.uid}/${id}-${file.name}`;
      const r = sRef(storage, path);
      await uploadBytes(r, file, { contentType: file.type || 'application/octet-stream' });
      const url = await getDownloadURL(r);
      setVaultDocs([{
        id, name: file.name, path, url, category: upCat,
        size: file.size, contentType: file.type || '',
        uploadedAt: new Date().toISOString(), expires: '',
      }, ...docs]);
    } catch (e) {
      alert('Upload failed: ' + (e.message || e.code || e));
    } finally { setBusy(false); }
  };

  const del = async (d) => {
    if (!window.confirm(`Delete "${d.name}"? The file is removed permanently.`)) return;
    try {
      if (storage && d.path) await deleteObject(sRef(storage, d.path));
    } catch (e) {
      if (e.code !== 'storage/object-not-found') { alert('Delete failed: ' + (e.message || e.code)); return; }
    }
    setVaultDocs(docs.filter((x) => x.id !== d.id));
  };

  const setExpires = (d, expires) => setVaultDocs(docs.map((x) => (x.id === d.id ? { ...x, expires } : x)));

  return (
    <>
      <div className="section-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <span>📁 Documents</span>
        <label className="btn app" style={{ fontSize: 13, cursor: ready && !busy ? 'pointer' : 'not-allowed', opacity: ready ? 1 : 0.5 }}>
          {busy ? '⏳ Uploading…' : '📤 Add document'}
          <input type="file" hidden disabled={!ready || busy} onChange={onFile} />
        </label>
      </div>
      <p className="banner" style={{ marginTop: 0 }}>
        Will, POA, deeds, titles, passport scans, filed returns — stored in your own Firebase Storage, owner-locked.
        New uploads land in the selected category. Set an expiry on anything that renews (passport, insurance) and it flags itself 60 days out.
      </p>
      {!ready && (
        <div className="card" style={{ marginBottom: 12 }}>
          <p className="dim" style={{ margin: 0, fontSize: 13 }}>
            ⚠️ Storage isn't configured yet — enable the Storage product on mikeslife-963c6 (Blaze), publish storage.rules, and set VITE_FIREBASE_STORAGE_BUCKET in Vercel. Uploads unlock automatically after redeploy.
          </p>
        </div>
      )}
      <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginBottom: 10, alignItems: 'center' }}>
        {[['all', 'All'], ...CATS].map(([k, lbl]) => (
          <button key={k} className={'btn ' + (cat === k ? 'app' : 'def')} style={{ fontSize: 12 }}
            onClick={() => { setCat(k); if (k !== 'all') setUpCat(k); }}>
            {lbl}{k !== 'all' ? ` (${docs.filter((d) => d.category === k).length})` : ''}
          </button>
        ))}
        <span className="dim" style={{ fontSize: 12, marginLeft: 'auto' }}>uploads → {CAT_LABEL[upCat]}</span>
      </div>
      <div className="card" style={{ marginBottom: 16 }}>
        {shown.length === 0 && <p className="dim" style={{ margin: 0, fontSize: 13 }}>Nothing here yet.</p>}
        {shown.map((d) => {
          const dleft = d.expires ? daysUntil(d.expires) : null;
          return (
            <div key={d.id} className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap', padding: '7px 0', borderBottom: '1px solid var(--line)' }}>
              <a href={d.url} target="_blank" rel="noreferrer" style={{ flex: '2 1 200px', minWidth: 0, color: 'var(--txt)', fontSize: 14, textDecoration: 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {(d.contentType || '').includes('pdf') ? '📄' : (d.contentType || '').startsWith('image/') ? '🖼️' : '📎'} {d.name}
              </a>
              <span className="dim" style={{ fontSize: 12 }}>{CAT_LABEL[d.category] || d.category}</span>
              <span className="dim" style={{ fontSize: 12 }}>{d.size ? fmtSize(d.size) : ''} · {String(d.uploadedAt || '').slice(0, 10)}</span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                {dleft != null && dleft <= 60 && <span style={{ fontSize: 12, color: dleft < 0 ? 'var(--red, #f87171)' : 'var(--amber, #fbbf24)' }}>{dleft < 0 ? '⚠ expired' : `⏳ ${dleft}d`}</span>}
                <input type="date" value={d.expires || ''} onChange={(ev) => setExpires(d, ev.target.value)} title="Expiry / renewal date (optional)"
                  style={{ background: 'var(--panel2)', color: d.expires ? 'var(--txt)' : 'var(--dim, #888)', border: '1px solid var(--line)', borderRadius: 8, padding: '4px 6px', fontSize: 12 }} />
              </span>
              <button className="btn def" style={{ fontSize: 12 }} onClick={() => del(d)}>✕</button>
            </div>
          );
        })}
      </div>
    </>
  );
}

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

export default function VaultView({ data, setEmergency, setVaultDocs, user }) {
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
      <DocumentsSection user={user} docs={Array.isArray(data.vaultDocs) ? data.vaultDocs : []} setVaultDocs={setVaultDocs} />

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
