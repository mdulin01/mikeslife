// Shared engine for Mike's Updates (the mikesupdates spoke app).
// Used by api/cron-updates.js (daily 11:30 UTC) and api/refresh-updates.js
// (manual pull-to-refresh / 🦚 button in the app).
//
// Design goals (2026-07-10 overhaul):
//  - GROUNDED: news comes from real RSS headlines fetched here, not model memory.
//    The model only curates/summarizes indexed headlines, so links are real.
//  - MERGE, don't clobber: saved items and recent items survive each run;
//    job statuses (interested/applied/pass) are always preserved.
//  - FEEDBACK-AWARE: 👍/👎 and job statuses steer the next generation.
//  - JOBS: a real job-search lane for Mike (DC think tanks / health policy /
//    fractional CMO / locums) in updates/data.jobs, and a separate board for
//    Adam in updates/adam driven by an editable `criteria` field.
//
// Env: OPENAI_API_KEY (or ANTHROPIC_API_KEY), FIREBASE_SERVICE_ACCOUNT (mikeslife),
//      FIREBASE_SA_UPDATES (admin JSON for mikesupdates-5f240).
import { initializeApp, cert, getApps, getApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { llmChat, pickProvider } from './_llm.js';

const OWNER_UID = process.env.OWNER_UID || 'F8QJ8dCk0CV5yX7yHu7AHPd6QS32';
const ET = 'America/New_York';
const easternYMD = (dt = new Date()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: ET, year: 'numeric', month: '2-digit', day: '2-digit' }).format(dt);
const gsearch = (t) => 'https://www.google.com/search?q=' + encodeURIComponent(String(t || '').slice(0, 80));
const nowIso = () => new Date().toISOString();
const normTitle = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 80);

// ---------------- fetch helpers ----------------
async function fetchText(url, ms = 6000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { 'user-agent': 'mikesupdates-rupert/2.0' } });
    return r.ok ? await r.text() : null;
  } catch { return null; } finally { clearTimeout(t); }
}
const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#039;|&apos;/g, "'").replace(/&quot;/g, '"').trim() : '';
};

// ---------------- news sources (all verified RSS) ----------------
// kind: which feed chip the item lands under in the app.
const NEWS_FEEDS = [
  { name: 'FIERCE HEALTHCARE', url: 'https://www.fiercehealthcare.com/rss/xml', kind: 'news' },
  { name: 'HEALTHCARE DIVE', url: 'https://www.healthcaredive.com/feeds/news/', kind: 'news' },
  { name: 'STAT NEWS', url: 'https://www.statnews.com/feed/', kind: 'news' },
  { name: 'KFF HEALTH NEWS', url: 'https://kffhealthnews.org/feed/', kind: 'news' },
  { name: 'MEDCITY NEWS', url: 'https://medcitynews.com/feed/', kind: 'news' },
  { name: 'POLITICO HEALTH', url: 'https://rss.politico.com/healthcare.xml', kind: 'news' },
];
const DC_FEEDS = [
  { name: 'AXIOS DC', url: 'https://api.axios.com/feed/local/washington-dc', kind: 'dc' },
  { name: 'WTOP', url: 'https://wtop.com/feed/', kind: 'dc' },
  { name: 'WASHINGTONIAN', url: 'https://www.washingtonian.com/feed/', kind: 'dc' },
  { name: 'CITY PAPER', url: 'https://washingtoncitypaper.com/feed/', kind: 'dc' },
  { name: 'POPVILLE', url: 'https://www.popville.com/feed/', kind: 'dc' },
];

async function harvestFeed(f, maxItems = 6, maxAgeDays = 4) {
  const xml = await fetchText(f.url);
  if (!xml) return [];
  const cutoff = Date.now() - maxAgeDays * 86400 * 1000;
  const out = [];
  for (const item of xml.split(/<item[\s>]|<entry[\s>]/i).slice(1, maxItems + 4)) {
    const title = tag(item, 'title');
    const pub = new Date(tag(item, 'pubDate') || tag(item, 'published') || tag(item, 'updated') || 0).getTime();
    let link = tag(item, 'link');
    if (!link) { const m = item.match(/<link[^>]*href="([^"]+)"/i); link = m ? m[1] : ''; }
    if (!title || !link) continue;
    if (pub && pub < cutoff) continue;
    out.push({ src: f.name, kind: f.kind, title, link, desc: tag(item, 'description') .slice(0, 200), at: pub ? new Date(pub).toISOString() : nowIso() });
    if (out.length >= maxItems) break;
  }
  return out;
}

// ---------------- podcasts (unchanged, real episodes only) ----------------
const SHOWS = ['The Peter Attia Drive', 'Huberman Lab', 'Hard Fork', 'The AI Daily Brief', 'NEJM AI Grand Rounds', 'FoundMyFitness'];
async function recentEpisodes(show, days = 30) {
  const search = await fetchText(`https://itunes.apple.com/search?term=${encodeURIComponent(show)}&media=podcast&limit=1`);
  if (!search) return [];
  let feedUrl; try { feedUrl = JSON.parse(search).results?.[0]?.feedUrl; } catch { return []; }
  if (!feedUrl) return [];
  const xml = await fetchText(feedUrl); if (!xml) return [];
  const cutoff = Date.now() - days * 86400 * 1000; const out = [];
  for (const item of xml.split(/<item[\s>]/i).slice(1, 6)) {
    const title = tag(item, 'title'); const pub = new Date(tag(item, 'pubDate') || 0).getTime();
    if (!title || !pub || pub < cutoff) continue;
    const link = tag(item, 'link') || (item.match(/enclosure[^>]*url="([^"]+)"/i) || [])[1] || '';
    out.push({ show, title, date: easternYMD(new Date(pub)), link, desc: tag(item, 'description').slice(0, 160) });
  }
  return out;
}

// ---------------- job search config ----------------
// Career pages worth scanning — REAL urls only; the model links leads to these
// (or LinkedIn searches), never to invented deep posting URLs.
const MIKE_JOB_BOARDS = [
  { org: 'Brookings Institution', url: 'https://www.brookings.edu/careers/job-openings/' },
  { org: 'Urban Institute', url: 'https://urban.wd1.myworkdayjobs.com/Urban-Careers' },
  { org: 'Bipartisan Policy Center', url: 'https://bipartisanpolicy.freshteam.com/jobs' },
  { org: 'KFF', url: 'https://www.kff.org/about-us/employment-opportunities/' },
  { org: 'Milken Institute', url: 'https://milkeninstitute.org/about/careers' },
  { org: 'Center for American Progress', url: 'https://www.americanprogress.org/about-us/jobs/' },
  { org: 'Mathematica (health research)', url: 'https://careers.mathematica.org/category/health-research-jobs/727/39702/1' },
  { org: 'National Academy of Medicine', url: 'https://nam.edu/opportunities-at-the-nam/' },
  { org: 'AcademyHealth Career Center (sector-wide HSR board)', url: 'https://jobs.academyhealth.org/' },
  { org: 'Duke-Margolis Center for Health Policy', url: 'https://healthpolicy.duke.edu/careers' },
  { org: 'Aspen Institute', url: 'https://www.aspeninstitute.org/about/our-careers/career-opportunities/' },
  { org: 'Arnold Ventures', url: 'https://www.arnoldventures.org/careers/' },
  { org: 'Peterson Center on Healthcare', url: 'https://petersonhealthcare.org/careers/' },
  { org: 'ARPA-H', url: 'https://arpa-h.gov/careers' },
  { org: 'CompHealth (locums)', url: 'https://comphealth.com/jobs/physician/family-practice' },
  { org: 'Weatherby Healthcare (locums)', url: 'https://weatherbyhealthcare.com/locum-tenens-jobs/family-practice' },
  { org: 'LocumTenens.com', url: 'https://www.locumtenens.com/family-practice-jobs' },
  { org: 'NEJM CareerCenter (FM locums)', url: 'https://www.nejmcareercenter.org/jobs/family-medicine/locum-tenens/' },
];
// One-time seed of researched, REAL openings — every URL verified live on the
// org's own careers page 2026-07-10. Dedupe key = org+title keeps this
// idempotent across runs; statuses Mike sets are never overwritten.
export const SEED_JOBS = [
  { org: 'Peterson Center on Healthcare', title: 'Senior Manager, Policy', location: 'Washington DC or NYC', salary: '$115–120k + bonus',
    summary: 'Health TECHNOLOGY policy — translating digital-health evidence into policy. Arguably the single best fit.', link: 'https://petersonhealthcare.org/careers/senior-manager-policy/' },
  { org: 'Duke-Margolis Institute for Health Policy', title: 'Research Director — Biomedical Innovation', location: 'Hybrid: DC or Durham NC', salary: '',
    summary: 'Leads medical-product development & regulation program — MD + precision-medicine/regulatory profile.', link: 'https://careers.duke.edu/job/Durham-Research-Director%2C-Duke-Margolis-Institute-for-Health-Policy-Hybrid-%28Washington-DC-or-Durham-NC%29-NC-27710/1376289200/' },
  { org: 'Duke-Margolis Institute for Health Policy', title: 'Research Director — Health Care Transformation', location: 'Hybrid: DC or Durham NC', salary: '',
    summary: 'Leads state-level health-care transformation portfolio — direct value-based-care fit.', link: 'https://careers.duke.edu/job/Durham-Research-Director%2C-Duke-Margolis-Institute-for-Health-Policy-Hybrid-%28Washington-DC-or-Durham-NC%29-NC-27710/1381948500/' },
  { org: 'National Academy of Medicine', title: 'Puffer/ABFM Fellowship (family-medicine physicians)', location: 'Washington, DC', salary: '',
    summary: 'NAM health-policy fellowship SPECIFICALLY for family-medicine physicians — tailor-made DC-policy entry.', link: 'https://nam.edu/our-work/health-policy-fellowships-and-leadership-programs/james-c-puffer-md-american-board-of-family-medicine-fellowship/' },
  { org: 'ARPA-H (HHS)', title: 'Program Manager — rolling open application', location: 'Washington DC area', salary: '',
    summary: 'PM roles for physician/technologist innovators running health moonshots — ideal for a clinical-AI/informatics MD.', link: 'https://arpa-h.gov/careers/program-managers' },
  { org: 'Bipartisan Policy Center', title: 'Senior Policy Analyst, Affordability (Health)', location: 'Washington, DC', salary: '',
    summary: 'Evidence-based health-system affordability work — VBC/analytics fit.', link: 'https://bipartisanpolicy.freshteam.com/jobs/oshwIzsFctIM/senior-policy-analyst-affordability-health-program' },
  { org: 'KFF', title: 'Senior Policy Analyst, Medicare Policy', location: 'Washington, DC', salary: '',
    summary: 'Medicare policy research — fits VBC / health-data expertise.', link: 'https://www.kff.org/job-posting/senior-policy-analyst/' },
  { org: 'AcademyHealth', title: 'Senior Research Associate, Health Systems Improvement', location: 'Washington, DC', salary: '',
    summary: 'Health-services research / delivery-system improvement — core HSR home.', link: 'https://academyhealth.org/professional-resources/jobs-academyhealth/page/jobs-academyhealth' },
  { org: 'Center for American Progress', title: 'Associate Director, Health Policy', location: 'Washington, DC (on-site)', salary: '$77–92k',
    summary: 'Health affordability/prices analysis — open now, though junior for a fractional CMO.', link: 'https://www.americanprogress.org/job/associate-director-health-policy-2/' },
  { org: 'Mathematica', title: 'Sr. Fellow, Value-Based Care Implementation (remote-eligible)', location: 'DC / remote', salary: '$160–220k',
    summary: 'Lead VBC expert/PI, 15+ yrs — exact seniority match. Older posting: confirm it is still open before applying.', link: 'https://careers.mathematica.org/job/washington/sr-fellow-value-based-care-implementation-remote-eligible/727/86523651200' },
];
// Adam's seed — real remote cruise-industry openings verified 2026-07-10.
export const SEED_JOBS_ADAM = [
  { org: 'Carnival Cruise Line', title: 'Personal Vacation Planner Agent (Remote)', location: 'Remote (Miramar FL HQ)', salary: '',
    summary: 'Remote cruise-sales role — directly in his lane.', link: 'https://jobs.carnivalcorp.com/job/miramar/personal-vacation-planner-agent-remote/8858/93805288512/' },
  { org: 'Holland America Line', title: 'Personal Cruise Consultant', location: 'Remote-eligible (Seattle HQ)', salary: '',
    summary: 'Inbound cruise-sales consulting for HAL guests.', link: 'https://jobs.carnivalcorp.com/job/seattle/personal-cruise-consultant/8858/94647599152/' },
  { org: 'Holland America Line', title: 'Business Development Manager — Mid-Atlantic', location: 'Remote, Mid-Atlantic territory', salary: '',
    summary: 'Trade-facing BDM covering agencies in his region — leverages his advisor network.', link: 'https://jobs.carnivalcorp.com/job/seattle/business-development-manager-mid-atlantic-region/8858/95590460528/' },
  { org: 'World Travel Holdings', title: 'Remote cruise sales & service roles (Cruises.com / Dream Vacations)', location: 'Remote (US)', salary: '',
    summary: 'The best-known work-from-home cruise-sales employer; roles cycle — watch this board.', link: 'https://careers-wth.icims.com' },
];

const MIKE_PROFILE = `Mike Dulin, MD — physician-informaticist and fractional CMO in digital health.
Background: family medicine, clinical AI, health data/analytics, value-based care, precision medicine, academic + startup advisory.
He is exploring: (a) DC think tanks / health-policy orgs (health AI policy, evidence, tech governance) — open to moving to DC;
(b) broader DC health orgs (foundations, associations, federal-adjacent, ARPA-H-adjacent contractors);
(c) remote fractional-CMO / advisory work in digital health;
(d) family-medicine locum tenens (flexible clinical income during the transition).`;

const SYS = `You are Rupert, Mike's chief of staff. Mike is a physician-informaticist / fractional CMO in digital health; interests: clinical AI, precision medicine, health policy (weighing a move to Washington DC / think-tank work), longevity/fitness, renewables/EVs, downtown Greensboro. Curate tightly — specific, non-generic, no fluff. Respond with ONLY valid JSON when asked for JSON (no prose, no code fences).`;

function parseJsonArr(text) {
  try {
    const arr = JSON.parse(String(text || '').replace(/```json|```/g, '').trim());
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

// ---------------- merge helpers ----------------
function mergeFeed(existing, incoming, { keepHours = 96, cap = 60 } = {}) {
  const cutoff = Date.now() - keepHours * 3600 * 1000;
  const kept = (existing || []).filter((x) => x.saved || (x.at && new Date(x.at).getTime() > cutoff));
  const seen = new Set(kept.map((x) => normTitle(x.title)));
  const fresh = (incoming || []).filter((x) => { const k = normTitle(x.title); if (seen.has(k)) return false; seen.add(k); return true; });
  return [...fresh, ...kept].slice(0, cap);
}
function mergeJobs(existing, incoming, { cap = 80 } = {}) {
  const key = (j) => normTitle((j.org || '') + ' ' + (j.title || ''));
  const out = [...(existing || [])];
  const seen = new Set(out.map(key));
  for (const j of incoming || []) { const k = key(j); if (!seen.has(k)) { seen.add(k); out.unshift(j); } }
  return out.slice(0, cap);
}
function feedbackDigest(feed, jobs) {
  const up = (feed || []).filter((x) => x.feedback === 'up' || x.saved).map((x) => x.title).slice(0, 12);
  const down = (feed || []).filter((x) => x.feedback === 'down').map((x) => x.title).slice(0, 12);
  const jUp = (jobs || []).filter((j) => j.status === 'interested' || j.status === 'applied').map((j) => `${j.title} @ ${j.org}`).slice(0, 10);
  const jDown = (jobs || []).filter((j) => j.status === 'pass').map((j) => `${j.title} @ ${j.org}`).slice(0, 10);
  let s = '';
  if (up.length) s += `\nLiked/saved recently (more like these): ${up.join(' | ')}`;
  if (down.length) s += `\nDisliked (avoid similar): ${down.join(' | ')}`;
  if (jUp.length) s += `\nJobs marked interested/applied (calibrate to these): ${jUp.join(' | ')}`;
  if (jDown.length) s += `\nJobs passed on (avoid similar): ${jDown.join(' | ')}`;
  return s;
}

// ---------------- admin apps ----------------
function ensureApps() {
  if (!getApps().some((a) => a.name === '[DEFAULT]') && process.env.FIREBASE_SERVICE_ACCOUNT) {
    initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
  }
  let upApp;
  try { upApp = getApp('updates'); }
  catch { upApp = initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SA_UPDATES)) }, 'updates'); }
  return { upApp };
}
export function updatesAuthApp() { return ensureApps().upApp; }

// ---------------- main ----------------
// scope: 'all' | 'mike' | 'adam'
export async function runUpdates({ scope = 'all' } = {}) {
  if (!process.env.OPENAI_API_KEY && !process.env.ANTHROPIC_API_KEY) throw new Error('no LLM key configured');
  if (!process.env.FIREBASE_SA_UPDATES) throw new Error('no FIREBASE_SA_UPDATES');
  const { upApp } = ensureApps();
  const upDb = getFirestore(upApp);
  const today = easternYMD();
  const provider = pickProvider(null);
  const result = {};

  // lifeos context (best-effort)
  let life = {};
  try { if (getApps().some((a) => a.name === '[DEFAULT]')) life = (await getFirestore().doc(`lifeos/${OWNER_UID}`).get()).data() || {}; } catch { /* fine */ }

  if (scope === 'all' || scope === 'mike') {
    const cur = (await upDb.doc('updates/data').get()).data() || {};
    const fb = feedbackDigest(cur.feed, cur.jobs);
    const sig = Array.isArray(life.emailSignals) ? life.emailSignals.slice(0, 12) : [];

    // Everything below runs in PARALLEL so a manual refresh stays fast.
    // 1+2) harvest real headlines → model curates from them (indices → links stay real)
    const curatedP = Promise.all([...NEWS_FEEDS, ...DC_FEEDS].map((f) => harvestFeed(f)))
      .then(async (r) => {
        const harvested = r.flat();
        if (!harvested.length) return [];
        const numbered = harvested.map((h, i) => `${i}. [${h.src}${h.kind === 'dc' ? '/DC' : ''}] ${h.title} — ${h.desc}`).join('\n');
        const rule = `Below are today's real headlines, numbered. Pick the 6-8 MOST worth Mike's time:
- 2-3 healthcare-AI / health-policy / precision-medicine items
- 2-3 DC items, favoring: health-policy & think-tank world signals, the federal health-tech jobs market / who's staffing up, and living-in-DC intel (neighborhoods, cost of living, city changes) since he's weighing a move
- skip crime blotter, sports, weather, celebrity fluff${fb}
Respond ONLY a JSON array of {"i": headline number, "summary": one sharp sentence on why it matters to Mike}.`;
        const txt = await llmChat({ provider, system: SYS, messages: [{ role: 'user', content: `Today is ${today}.\n${rule}\n\nHEADLINES:\n${numbered.slice(0, 7000)}` }], maxTokens: 1200 });
        return parseJsonArr(txt)
          .filter((x) => Number.isInteger(x.i) && harvested[x.i])
          .slice(0, 8)
          .map((x, n) => {
            const h = harvested[x.i];
            return { id: 'f' + Date.now() + '_' + n, kind: h.kind, source: h.src.slice(0, 28), title: h.title.slice(0, 140), summary: String(x.summary || h.desc).slice(0, 220), link: h.link, at: nowIso(), saved: false, feedback: null };
          });
      }).catch((e) => { console.warn('curate failed', e.message); return []; });

    // 3) one or two worthwhile reads from the model itself (search link — no invented URLs)
    const readsP = llmChat({ provider, system: SYS, messages: [{ role: 'user', content: `Today is ${today}. Suggest 1-2 worthwhile reads/ideas for Mike (kind "content") — essays, papers, or tools tied to his interests.${fb}\nRespond ONLY a JSON array of {"title","summary","source": short ALL-CAPS label}. No URLs.` }], maxTokens: 400 })
      .then((txt) => parseJsonArr(txt).slice(0, 2).filter((x) => x.title).map((x, n) => (
        { id: 'c' + Date.now() + '_' + n, kind: 'content', source: String(x.source || 'READING').slice(0, 28), title: String(x.title).slice(0, 140), summary: String(x.summary || '').slice(0, 220), link: gsearch(x.title), at: nowIso(), saved: false, feedback: null }
      ))).catch((e) => { console.warn('reads failed', e.message); return []; });

    // 4) two real podcast episodes
    const known = new Set((cur.feed || []).map((x) => normTitle(x.title)));
    const podsP = Promise.all(SHOWS.slice(0, 4).map((s) => recentEpisodes(s)))
      .then((r) => r.flat().filter((e) => !known.has(normTitle(e.title))).slice(0, 2).map((e, i) => ({
        id: 'p' + Date.now() + '_' + i, kind: 'podcast', source: e.show.toUpperCase().slice(0, 28),
        title: e.title.slice(0, 140), summary: e.desc, link: e.link || gsearch(e.show + ' ' + e.title),
        at: nowIso(), saved: false, feedback: null,
      }))).catch(() => []);

    // 5) job leads for Mike
    const boards = MIKE_JOB_BOARDS.map((b) => `${b.org}: ${b.url}`).join('\n');
    const jobsP = llmChat({ provider, system: SYS, messages: [{ role: 'user', content: `Today is ${today}.\n${MIKE_PROFILE}\n${fb}\n\nSuggest 3-5 SPECIFIC job leads for Mike right now across his four lanes (DC think tanks, DC health orgs, remote fractional-CMO/advisory, family-medicine locums). A lead = a role type that plausibly exists at a specific org this month, phrased honestly (e.g. "Senior Fellow, health AI policy — check current openings").
For "link": use the org's EXACT careers URL from this list when the org is on it, otherwise a LinkedIn jobs search URL (https://www.linkedin.com/jobs/search/?keywords=...&location=...). NEVER invent a deep posting URL.
BOARDS:\n${boards}\n
Respond ONLY a JSON array of {"org","title","location","salary": "" if unknown,"summary": one line on fit,"link"}.` }], maxTokens: 900 })
      .then((txt) => parseJsonArr(txt).filter((x) => x && x.org && x.title).slice(0, 5).map((x, n) => ({
        id: 'j' + Date.now() + '_' + n, org: String(x.org).slice(0, 60), title: String(x.title).slice(0, 120),
        location: String(x.location || '').slice(0, 50), salary: String(x.salary || '').slice(0, 40),
        summary: String(x.summary || '').slice(0, 200),
        link: x.link && /^https?:\/\//.test(x.link) ? x.link : gsearch(x.org + ' ' + x.title + ' job'),
        at: nowIso(), status: 'new', src: 'rupert',
      }))).catch((e) => { console.warn('mike jobs failed', e.message); return []; });

    // 6) email highlights from Rupert-synced inbox signals (merge, don't resurrect)
    const emailP = !sig.length ? Promise.resolve(null)
      : llmChat({ provider, system: SYS, messages: [{ role: 'user', content: `Today is ${today}. From these inbox signals, pick the 3-5 worth Mike's attention. Respond ONLY a JSON array: {"from","subject","snippet": short paraphrase,"why": one line why it matters}. Signals: ${JSON.stringify(sig).slice(0, 1500)}` }], maxTokens: 900 })
        .then((txt) => {
          const cutoff = Date.now() - 7 * 86400 * 1000;
          const kept = (cur.emailHighlights || []).filter((e) => e.at && new Date(e.at).getTime() > cutoff);
          const seen = new Set(kept.map((e) => normTitle(e.subject)));
          const fresh = parseJsonArr(txt).slice(0, 6)
            .filter((x) => x.subject && !seen.has(normTitle(x.subject)))
            .map((x, i) => ({
              id: 'e' + Date.now() + '_' + i, from: String(x.from || '').slice(0, 80), subject: String(x.subject || '').slice(0, 140),
              snippet: String(x.snippet || '').slice(0, 200), link: 'https://mail.google.com/mail/u/0/#search/' + encodeURIComponent(x.subject || ''),
              at: nowIso(), status: 'review', why: String(x.why || '').slice(0, 160),
            }));
          return [...fresh, ...kept].slice(0, 20);
        }).catch((e) => { console.warn('email gen failed', e.message); return null; });

    const [curated, reads, pods, jobsGen, emailPatch] = await Promise.all([curatedP, readsP, podsP, jobsP, emailP]);
    const feedNew = [...curated, ...reads, ...pods];
    const seeds = SEED_JOBS.map((s, n) => ({ ...s, id: 'seed' + n, at: s.at || nowIso(), status: 'new', src: 'seed' }));
    const jobsNew = mergeJobs(jobsGen, seeds);

    const patch = { refreshedAt: nowIso() };
    patch.feed = mergeFeed(cur.feed, feedNew);
    patch.jobs = mergeJobs(cur.jobs, jobsNew);
    if (emailPatch) patch.emailHighlights = emailPatch;
    await upDb.doc('updates/data').set(patch, { merge: true });
    result.feedNew = feedNew.length; result.jobsTotal = patch.jobs.length;
  }

  if (scope === 'all' || scope === 'adam') {
    const cur = (await upDb.doc('updates/adam').get()).data() || {};
    const criteria = (cur.criteria || '').trim() ||
      'Cruise line / travel-advisor / hospitality roles (Adam runs "Adam the Cruise Guy", a cruise travel business). Greensboro NC or remote.';
    const jFb = feedbackDigest([], cur.jobs);
    // LLM leads are best-effort; the verified seeds get written regardless.
    const arr = await llmChat({ provider, system: 'You are Rupert, a sharp job-search scout. Respond with ONLY valid JSON when asked.', messages: [{ role: 'user', content: `Today is ${today}. Find job leads for Adam. His criteria: "${criteria}".${jFb}
Suggest 3-5 specific, plausible current leads (role type at a specific real company/board this month). For "link": use a real well-known careers/board URL (company careers page, or an Indeed/LinkedIn search URL like https://www.indeed.com/jobs?q=...&l=...). NEVER invent a deep posting URL.
Respond ONLY a JSON array of {"org","title","location","salary": "" if unknown,"summary": one line on why it fits the criteria,"link"}.` }], maxTokens: 900 })
      .then((txt) => parseJsonArr(txt).filter((x) => x && x.org && x.title).slice(0, 5).map((x, n) => ({
        id: 'a' + Date.now() + '_' + n, org: String(x.org).slice(0, 60), title: String(x.title).slice(0, 120),
        location: String(x.location || '').slice(0, 50), salary: String(x.salary || '').slice(0, 40),
        summary: String(x.summary || '').slice(0, 200),
        link: x.link && /^https?:\/\//.test(x.link) ? x.link : gsearch(x.org + ' ' + x.title + ' job'),
        at: nowIso(), status: 'new', src: 'rupert',
      }))).catch((e) => { console.warn('adam jobs failed', e.message); return []; });
    const seeds = SEED_JOBS_ADAM.map((s, n) => ({ ...s, id: 'aseed' + n, at: nowIso(), status: 'new', src: 'seed' }));
    await upDb.doc('updates/adam').set({ criteria, jobs: mergeJobs(cur.jobs, mergeJobs(arr, seeds)), refreshedAt: nowIso() }, { merge: true });
    result.adamJobsNew = arr.length;
  }

  return result;
}
