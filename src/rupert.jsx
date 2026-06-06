import { useEffect, useRef, useState } from 'react';
import { Mic, Send, Volume2, VolumeX } from 'lucide-react';
import { auth } from './firebase';

const GREETING = "Morning. Tell me your energy, mood, and what you want to get done today — or ask me anything (a workout, a grocery list, a plan).";

export default function RupertChat() {
  const [messages, setMessages] = useState([{ role: 'assistant', content: GREETING }]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [speak, setSpeak] = useState(false);
  const [listening, setListening] = useState(false);
  const rec = useRef(null);
  const endRef = useRef(null);
  const SR = typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition);

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

  const toggleMic = () => {
    if (!SR) return;
    if (listening) { rec.current?.stop(); setListening(false); return; }
    const r = new SR();
    r.lang = 'en-US'; r.interimResults = false; r.maxAlternatives = 1;
    r.onresult = (e) => setInput((p) => (p ? p + ' ' : '') + e.results[0][0].transcript);
    r.onend = () => setListening(false);
    r.onerror = () => setListening(false);
    rec.current = r; setListening(true); r.start();
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
        {SR && (
          <button className={'iconbtn' + (listening ? ' rec' : '')} title="Hold to dictate" onClick={toggleMic}><Mic size={18} /></button>
        )}
        <input
          type="text"
          placeholder={SR ? 'Talk or type…' : 'Type (tap your keyboard mic to dictate)…'}
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
