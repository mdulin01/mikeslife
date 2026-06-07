import { useEffect, useRef, useState } from 'react';
import { Mic, Send, Volume2, VolumeX } from 'lucide-react';
import { auth } from './firebase';

const GREETING = "Morning. Tell me your energy, mood, and what you want to get done today — or ask me anything (a workout, a grocery list, a plan).";

export default function RupertChat() {
  const [messages, setMessages] = useState([{ role: 'assistant', content: GREETING }]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [speak, setSpeak] = useState(false);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const mediaRec = useRef(null);
  const chunks = useRef([]);
  const endRef = useRef(null);
  const canRecord = typeof navigator !== 'undefined' && navigator.mediaDevices && typeof window !== 'undefined' && window.MediaRecorder;

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, busy]);

  const say = (text) => {
    if (!speak || typeof speechSynthesis === 'undefined') return;
    try { speechSynthesis.cancel(); speechSynthesis.speak(new SpeechSynthesisUtterance(text)); } catch { /* ignore */ }
  };

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    const history = messages.slice(1); // drop the greeting
    const next = [...messages, { role: 'user', content: text }];
    setMessages(next);
    setInput('');
    setBusy(true);
    try {
      const token = auth?.currentUser ? await auth.currentUser.getIdToken() : null;
      const r = await fetch('/api/rupert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken: token, message: text, history }),
      });
      const data = await r.json();
      const reply = r.ok ? data.reply
        : (data.message || "Rupert's brain isn't connected yet — add the OpenAI key in Vercel and I'll come alive.");
      setMessages([...next, { role: 'assistant', content: reply }]);
      say(reply);
    } catch (e) {
      setMessages([...next, { role: 'assistant', content: 'Network hiccup — try again in a moment.' }]);
    } finally {
      setBusy(false);
    }
  };

  const blobToB64 = (blob) => new Promise((resolve) => {
    const r = new FileReader();
    r.onloadend = () => resolve(String(r.result).split(',')[1]);
    r.readAsDataURL(blob);
  });

  // Record audio → Whisper (works in the iOS PWA, unlike Web Speech).
  const toggleMic = async () => {
    if (transcribing) return;
    if (recording) { mediaRec.current?.stop(); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream);
      chunks.current = [];
      mr.ondataavailable = (e) => { if (e.data && e.data.size) chunks.current.push(e.data); };
      mr.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        setRecording(false);
        const blob = new Blob(chunks.current, { type: mr.mimeType || 'audio/webm' });
        if (!blob.size) return;
        setTranscribing(true);
        try {
          const audio = await blobToB64(blob);
          const token = auth?.currentUser ? await auth.currentUser.getIdToken() : null;
          const r = await fetch('/api/transcribe', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ idToken: token, audio, mime: mr.mimeType }),
          });
          const data = await r.json();
          if (data.text) setInput((p) => (p ? p + ' ' : '') + data.text);
        } catch { /* ignore */ } finally { setTranscribing(false); }
      };
      mediaRec.current = mr; setRecording(true); mr.start();
    } catch { setRecording(false); }
  };

  return (
    <section className="rupert">
      <div className="between" style={{ marginBottom: 10 }}>
        <div className="section-title" style={{ margin: 0 }}>Talk to Rupert</div>
        <button className="iconbtn" title={speak ? 'Spoken replies on' : 'Spoken replies off'} onClick={() => setSpeak(!speak)}>
          {speak ? <Volume2 size={18} /> : <VolumeX size={18} />}
        </button>
      </div>

      <div className="chat">
        {messages.map((m, i) => (
          <div key={i} className={'bubble ' + m.role}>{m.content}</div>
        ))}
        {busy && <div className="bubble assistant typing">Rupert is thinking…</div>}
        <div ref={endRef} />
      </div>

      <div className="composer">
        {canRecord && (
          <button className={'iconbtn' + (recording ? ' rec' : '')} title={recording ? 'Stop' : 'Record'} onClick={toggleMic} disabled={transcribing}>
            <Mic size={18} />
          </button>
        )}
        <input
          type="text"
          placeholder={transcribing ? 'Transcribing…' : recording ? 'Listening… tap mic to stop' : 'Talk or type…'}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') send(); }}
        />
        <button className="iconbtn send" onClick={send} disabled={busy || !input.trim()}><Send size={18} /></button>
      </div>
      <p className="banner">Rupert sees your check-in, plans, and goals. He advises and drafts — he can’t act in the world.</p>
    </section>
  );
}
