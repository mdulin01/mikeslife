import { useState } from 'react';

// ── Mike's Purpose · Learning & cognitive work ──────────────────────────────
// Interests: AI (esp. AI applications in health), precision medicine, renewable
// energy, EVs, autonomous vehicles, LGBTQ+ issues. Podcasts moved here from the
// content feed — this is the "keep learning / grow" half of Purpose.
// Conference dates verified via web search (June 2026); see Sources in chat.

const sp = (q) => `https://open.spotify.com/search/${encodeURIComponent(q)}`;

const TOPIC_COL = {
  'AI in health': '--teal', 'Precision medicine': '--emerald', 'AI': '--sky',
  'Renewable energy': '--amber', 'EVs': '--violet', 'Autonomous vehicles': '--rose', 'LGBTQ+': '--rose',
};

export const INTERESTS = ['AI in health', 'AI', 'Precision medicine', 'Renewable energy', 'EVs', 'Autonomous vehicles', 'LGBTQ+'];

export const LEARNING = {
  podcasts: [
    { topic: 'AI in health', show: 'Ground Truths (Eric Topol)', why: 'AI + precision medicine from the field’s clearest voice.', url: sp('Ground Truths Eric Topol') },
    { topic: 'AI in health', show: 'NEJM AI Grand Rounds', why: 'How AI actually lands in the clinic — rigorous, current.', url: sp('NEJM AI Grand Rounds') },
    { topic: 'AI in health', show: 'The Peter Attia Drive', why: 'Longevity, prevention, the science of healthspan.', url: sp('The Peter Attia Drive') },
    { topic: 'AI', show: 'No Priors', why: 'Frontier AI with the people building it.', url: sp('No Priors podcast') },
    { topic: 'AI', show: 'Hard Fork (NYT)', why: 'The week in AI + tech, smart and fun for the commute.', url: sp('Hard Fork New York Times') },
    { topic: 'Renewable energy', show: 'Catalyst with Shayle Kann', why: 'The technologies decarbonizing energy, explained.', url: sp('Catalyst with Shayle Kann') },
    { topic: 'EVs', show: 'Volts (David Roberts)', why: 'Deep, wonky energy + electrification conversations.', url: sp('Volts David Roberts podcast') },
    { topic: 'Autonomous vehicles', show: 'The Autonocast', why: 'Self-driving + the future of mobility.', url: sp('The Autonocast') },
    { topic: 'LGBTQ+', show: 'Making Gay History', why: 'The people and turning points behind LGBTQ+ rights.', url: sp('Making Gay History podcast') },
  ],
  courses: [
    { topic: 'AI in health', title: 'AI in Healthcare Specialization', provider: 'Stanford · Coursera', why: '5-course path; evaluate + deploy AI in the clinic.', url: 'https://www.coursera.org/specializations/ai-healthcare' },
    { topic: 'AI in health', title: 'Artificial Intelligence in Healthcare', provider: 'Stanford Online', why: 'Stanford Medicine program; CME-accredited.', url: 'https://online.stanford.edu/programs/artificial-intelligence-healthcare' },
    { topic: 'AI in health', title: 'Evaluations of AI Applications in Healthcare', provider: 'Stanford · Coursera', why: 'How to judge whether a clinical AI tool actually works.', url: 'https://www.coursera.org/learn/evaluations-ai-applications-healthcare' },
    { topic: 'AI in health', title: '150 AI-in-Healthcare courses (browse)', provider: 'Class Central', why: 'A curated index to pick your next one.', url: 'https://www.classcentral.com/report/ai-in-healthcare-online-courses/' },
    { topic: 'EVs', title: 'Electric vehicles & energy (browse)', provider: 'Coursera', why: 'EV tech, batteries, and the grid.', url: 'https://www.coursera.org/search?query=electric%20vehicles' },
    { topic: 'Renewable energy', title: 'Renewable energy (browse)', provider: 'edX', why: 'Solar, wind, storage, the energy transition.', url: 'https://www.edx.org/search?q=renewable+energy' },
  ],
  conferences: [
    { topic: 'AI', name: 'CES', date: 'Jan 6–9, 2026', place: 'Las Vegas', why: 'AV, EV, and AI all under one roof.', url: 'https://www.ces.tech' },
    { topic: 'AI in health', name: 'ViVE 2026', date: 'Feb 22–25, 2026', place: 'Los Angeles', why: 'Digital-health + the business of AI in care.', url: 'https://www.viveevent.com' },
    { topic: 'AI in health', name: 'HIMSS26 (AI in Healthcare Forum)', date: 'Mar 9–12, 2026', place: 'Las Vegas', why: 'AI Forum on Mar 9 — pilots to performance.', url: 'https://www.himss.org' },
    { topic: 'EVs', name: 'EV Tech Expo South', date: 'Apr 22–23, 2026', place: 'Charlotte, NC', why: 'In your backyard (~1.5h from Greensboro).', url: 'https://www.evtechexposouth.com' },
    { topic: 'Precision medicine', name: 'Precision Med Tri-Con', date: 'May 4–5, 2026', place: 'San Francisco', why: 'Diagnostics + AI + precision medicine.', url: 'https://www.triconference.com' },
    { topic: 'AI in health', name: 'AI in Healthcare Forum', date: 'Jun 25–26, 2026', place: 'Boston', why: 'Two days, purely AI in care.', url: 'https://www.himss.org/events-overview/ai-in-healthcare-forum-boston/' },
    { topic: 'LGBTQ+', name: 'National LGBTQ Health Conference', date: 'Aug 2026', place: 'Chicago', why: 'Research + practice in LGBTQ+ health.', url: 'https://lgbtqhealthconference.org' },
    { topic: 'LGBTQ+', name: 'GLMA 44th Annual Conference', date: 'Sep 17–19, 2026', place: 'Seattle', why: 'LGBTQ+ health professionals, advancing equity.', url: 'https://www.glma.org' },
    { topic: 'Renewable energy', name: 'RE+', date: 'Fall 2026', place: 'see site', why: 'North America’s largest clean-energy event.', url: 'https://www.re-plus.com' },
    { topic: 'AI in health', name: 'HLTH', date: 'Nov 15–18, 2026', place: 'Las Vegas', why: 'The big tent for health innovation.', url: 'https://www.hlth.com' },
  ],
};

function Chip({ topic }) {
  const c = `var(${TOPIC_COL[topic] || '--mut'})`;
  return <span className="pill" style={{ background: 'rgba(148,163,184,.14)', color: c, flex: '0 0 auto' }}>{topic}</span>;
}

const SUBS = [['podcasts', '🎧 Listen'], ['courses', '🎓 Learn'], ['conferences', '📅 Conferences']];

export default function PurposeLearning() {
  const [sub, setSub] = useState('podcasts');
  const [filter, setFilter] = useState('All');
  const items = LEARNING[sub].filter((x) => filter === 'All' || x.topic === filter);

  return (
    <div className="card learnhub">
      <h3>📚 Learning &amp; cognitive work <span className="dim" style={{ fontWeight: 500, textTransform: 'none' }}>· your training for the mind</span></h3>

      <div className="substrip" style={{ marginTop: 10 }}>
        {SUBS.map(([id, label]) => (
          <button key={id} className={sub === id ? 'on' : ''} onClick={() => { setSub(id); }}>{label}</button>
        ))}
      </div>

      <div className="chiprow">
        <button className={'chipbtn' + (filter === 'All' ? ' on' : '')} onClick={() => setFilter('All')}>All</button>
        {INTERESTS.map((t) => (
          <button key={t} className={'chipbtn' + (filter === t ? ' on' : '')} onClick={() => setFilter(t)}>{t}</button>
        ))}
      </div>

      <div className="learnlist">
        {items.map((x, i) => (
          <a key={i} className="learnrow" href={x.url} target="_blank" rel="noopener noreferrer">
            <div className="lr-main">
              <div className="lr-top">
                <span className="lr-title">{x.show || x.title || x.name}</span>
                {x.date && <span className="lr-date">{x.date}</span>}
              </div>
              <div className="lr-sub">{x.provider ? x.provider + ' · ' : ''}{x.place ? x.place + ' · ' : ''}{x.why}</div>
            </div>
            <div className="lr-right"><Chip topic={x.topic} /><span className="lr-go">↗</span></div>
          </a>
        ))}
      </div>

      <p className="banner" style={{ textAlign: 'left' }}>Rupert’s commute podcasts now live here. Conferences also surface from your email when invites land — promote the good ones into a Plan.</p>
    </div>
  );
}
