import { useState } from 'react';
import { Trash2 } from 'lucide-react';

export default function MemoriesView({ data, addMemory, deleteMemory, addDocument, deleteDocument }) {
  const [memText, setMemText] = useState('');
  const [docTitle, setDocTitle] = useState('');
  const [docBody, setDocBody] = useState('');

  const saveMemory = () => { if (memText.trim()) { addMemory(memText); setMemText(''); } };
  const saveDoc = () => { if (docTitle.trim()) { addDocument(docTitle, docBody); setDocTitle(''); setDocBody(''); } };

  const memories = data.memories || [];
  const documents = data.documents || [];

  return (
    <section>
      <div className="card">
        <h3>Capture a memory</h3>
        <div className="field">
          <textarea placeholder="A moment worth keeping — what happened, how it felt…" value={memText} onChange={(e) => setMemText(e.target.value)} />
        </div>
        <button className="btn app" style={{ marginTop: 10 }} onClick={saveMemory}>Save memory</button>
      </div>

      {memories.length > 0 && (
        <div className="card">
          <h3>Memories</h3>
          {memories.map((m) => (
            <div className="loop" key={m.id} style={{ alignItems: 'flex-start' }}>
              <div className="dot" style={{ background: 'var(--rose)' }} />
              <div style={{ flex: 1 }}>
                <div className="lt" style={{ whiteSpace: 'pre-wrap' }}>{m.text}</div>
                <div className="lm">{m.date}</div>
              </div>
              <button className="trash" title="Delete" onClick={() => deleteMemory(m.id)}><Trash2 size={15} /></button>
            </div>
          ))}
        </div>
      )}

      <div className="card">
        <h3>Add a document / note</h3>
        <div className="field" style={{ marginBottom: 10 }}>
          <input type="text" placeholder="Title (e.g., Next-gig criteria, Travel wishlist)" value={docTitle} onChange={(e) => setDocTitle(e.target.value)} />
        </div>
        <div className="field">
          <textarea placeholder="The contents…" value={docBody} onChange={(e) => setDocBody(e.target.value)} />
        </div>
        <button className="btn app" style={{ marginTop: 10 }} onClick={saveDoc}>Save document</button>
      </div>

      {documents.map((doc) => (
        <div className="card" key={doc.id}>
          <div className="between">
            <h3 style={{ margin: 0 }}>{doc.title}</h3>
            <button className="trash" title="Delete" onClick={() => deleteDocument(doc.id)}><Trash2 size={15} /></button>
          </div>
          {doc.body && <div style={{ whiteSpace: 'pre-wrap', fontSize: 14, color: 'var(--mut)', marginTop: 8, lineHeight: 1.5 }}>{doc.body}</div>}
        </div>
      ))}

      <p className="banner">Your private memories + documents. Rupert reads them as context — and a NotebookLM-style "ask my notes" is the next layer.</p>
    </section>
  );
}
