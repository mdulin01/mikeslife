// Seed / mock data. Native data (checkins, plans, people, proposals) persists to
// Firestore once configured; calendar + email + spoke status are PREVIEW mocks
// until the Google APIs and the Rupert snapshot bridge are wired.

export const COL = { health:'--emerald', rel:'--rose', fin:'--amber', purpose:'--violet', fun:'--sky' };
export const SDOT = { ok:'var(--emerald)', warn:'var(--amber)', new:'var(--sky)', alert:'var(--rose)' };
export const PILLAR_LABEL = { health:'Health', rel:'Relationships', fin:'Finances', purpose:'Purpose', fun:'Fun & Travel' };

export const PILLARS = {
  health:{ em:'🫀', name:'Health',
    goals:['Protect zone-2 base; don’t let every session go hard','Close preventive-care gaps; finish the health record','VO2 + bodyweight trending the right way'],
    apps:[['mikesfitness','ok'],['mikeshealth','warn']] },
  rel:{ em:'❤️', name:'Relationships',
    goals:['A memory with Adam every 1–2 weeks','Stay close with Mom, son, friends','Tend the professional network deliberately'],
    apps:[['mikeandadam','warn'],['People · in mikeslife','ok']] },
  fin:{ em:'💰', name:'Finances',
    goals:['Stay ahead of estimated taxes; park surplus for April 2027','Keep rentals reconciled; Schedule E clean','Investments aligned to glide-path target'],
    apps:[['mikesmoney','ok'],['rainbow-rentals','ok']] },
  purpose:{ em:'🎯', name:'Purpose',
    goals:['Bill consulting promptly; collect the GMA balance','Screen inbound opportunities; define the next gig','Volunteering — give time to causes that matter','Grow the life-design course; keep learning'],
    apps:[['mikedulinmd','warn'],['lifedesigncourse','ok']] },
  fun:{ em:'🏖️', name:'Fun & Travel',
    goals:['Plan the August friends trip well (8 going)','Work the someday list — Spain, Alaska, sailing','Protect time for play, not just productivity'],
    apps:[['Plans · in mikeslife','ok'],['Aug trip · standalone','new']] },
};

export const SEED_PROPOSALS = [
  { id:1, pk:'health', kind:'', src:'BODY COACH', pillar:'🫀 Health', title:'Protect one easy aerobic block this week',
    why:'Last 7 days were all moderate-to-hard; resting HR is creeping up.', act:'Add a 40-min zone-2 session this weekend.' },
  { id:2, pk:'fin', kind:'', src:'MONEY & RETIREMENT COACH', pillar:'💰 Finances', title:'Park the projected tax surplus in HYSA',
    why:'2026 income ~9% ahead of pace → likely above safe-harbor by ~$10–14k.', act:'Route surplus to the April-2027 HYSA. (Confirm with CPA.)' },
  { id:3, pk:'fun', kind:'signal', src:'✈️ TRAVEL SIGNAL · from email', pillar:'🏖️ Fun & Travel', title:'Spain + Portugal rail deal landed in your inbox',
    why:'Matches your “month in Spain” plan. Fare windows close fast.', act:'Promote to Plans with rough dates, or dismiss.' },
  { id:4, pk:'purpose', kind:'signal', src:'🎯 CAREER SIGNAL · from email', pillar:'🎯 Purpose', title:'Inbound: Fractional CMO at a digital-health startup',
    why:'You wanted to screen these against your next-gig criteria.', act:'Open to screen, or hold for the weekly review.' },
  { id:5, pk:'rel', kind:'signal', src:'🤝 NETWORK · from email', pillar:'❤️ Relationships', title:'Allen Naidoo replied — suggested a call',
    why:'Warm professional contact; a reply is waiting on you.', act:'Draft a reply + propose 2 calendar slots (you confirm).' },
  { id:6, pk:'health', kind:'', src:'MEDICAL HEALTH COACH', pillar:'🫀 Health', title:'Schedule the overdue preventive item',
    why:'mikeshealth flags one preventive-care item past due.', act:'Book it; log the date so the flag clears.' },
];

// ── Planning templates: Activate a plan → stages → checkable to-dos ──
export const PLAN_TEMPLATES = {
  trip: [
    { title: 'Decide & commit', tasks: ['Confirm who’s coming', 'Pick target dates'] },
    { title: 'Travel', tasks: ['Compare flights vs. driving', 'Book transport', 'Reserve lodging'] },
    { title: 'Logistics', tasks: ['Sort gear & supplies', 'Make a packing list'] },
    { title: 'Lock it in', tasks: ['Book it', 'Share the plan with everyone'] },
  ],
  learning: [
    { title: 'Set the goal', tasks: ['Define the outcome', 'Set a target date'] },
    { title: 'Method & resources', tasks: ['Pick an app / course / tutor', 'Gather materials'] },
    { title: 'Build the habit', tasks: ['Schedule recurring practice', 'Start a streak'] },
    { title: 'Milestones', tasks: ['Set a first checkpoint', 'Plan a real-world / immersion test'] },
  ],
  event: [
    { title: 'Date & guests', tasks: ['Pick a date', 'Draft the guest list'] },
    { title: 'Logistics', tasks: ['Choose venue / location', 'Sort food & supplies'] },
    { title: 'Invite & confirm', tasks: ['Send invites', 'Track RSVPs'] },
  ],
  career: [
    { title: 'Research the space', tasks: ['Map the landscape', 'Find 3 examples to study'] },
    { title: 'Talk to people', tasks: ['List 5 people to talk to', 'Reach out'] },
    { title: 'Prototype a small bet', tasks: ['Design a low-risk experiment', 'Run it'] },
    { title: 'Decide', tasks: ['Review what you learned', 'Commit or pivot'] },
  ],
  generic: [
    { title: 'Clarify the outcome', tasks: ['Write what “done” looks like'] },
    { title: 'Break it down', tasks: ['List the major steps'] },
    { title: 'First actions', tasks: ['Pick the first task', 'Schedule it'] },
  ],
};

// Build stages (with ids) from a template — used on Activate.
export function stagesFromTemplate(type) {
  const tpl = PLAN_TEMPLATES[type] || PLAN_TEMPLATES.generic;
  return tpl.map((s, i) => ({
    id: `s${i}_${Date.now()}`,
    title: s.title,
    tasks: s.tasks.map((t, j) => ({ id: `t${i}_${j}_${Date.now()}`, text: t, done: false })),
  }));
}

// status: 'someday' | 'active' | 'done' ; type drives the template
export const SEED_PLANS = [
  { id:'p1', title:'🇪🇸 A month in Spain', note:'Live there ~4 weeks and actually learn Spanish.', pk:'fun', type:'trip', status:'someday', stages:[] },
  { id:'p_spanish', title:'🇪🇸 Learn Spanish', note:'A real conversational goal — ties into the Spain month.', pk:'purpose', type:'learning', status:'someday', stages:[] },
  { id:'p2', title:'⛵ Caribbean sailing', note:'Learn to sail with Chris.', pk:'fun', type:'trip', status:'someday', stages:[] },
  { id:'p3', title:'👩 Go see Mom', note:'Don’t let it keep sliding — pick a date.', pk:'rel', type:'trip', status:'someday', stages:[] },
  { id:'p4', title:'💝 Something special for Adam', note:'A surprise / a trip / a gesture worth planning.', pk:'rel', type:'generic', status:'someday', stages:[] },
  { id:'p_camp', title:'🏕️ Camping with Josh', note:'A trip with my son, Josh Dulin.', pk:'rel', type:'trip', status:'active', stages:[
    { id:'cs1', title:'Decide & commit', tasks:[ {id:'ct1', text:'Ask Josh', done:false}, {id:'ct2', text:'Find a date', done:false} ] },
    { id:'cs2', title:'Travel', tasks:[ {id:'ct3', text:'Look for flights', done:false}, {id:'ct4', text:'Decide: drive to Detroit vs. fly', done:false}, {id:'ct5', text:'Rent a car', done:false} ] },
    { id:'cs3', title:'Gear & supplies', tasks:[ {id:'ct6', text:'Figure out how to get camping supplies there', done:false} ] },
    { id:'cs4', title:'Where', tasks:[ {id:'ct7', text:'Find a park / campground to camp at', done:false}, {id:'ct8', text:'Book the site', done:false} ] },
  ] },
  { id:'p6', title:'🥾 Hiking in Alaska', note:'Bucket-list trip.', pk:'fun', type:'trip', status:'someday', stages:[] },
  { id:'p_bday', title:'🎂 60th birthday trip', note:'January 2027 — somewhere warm. Cruise or Key West?', pk:'fun', type:'trip', status:'active', stages:[
    { id:'bs1', title:'Decide the destination', tasks:[ {id:'bt1', text:'Compare: cruise vs. Key West', done:false}, {id:'bt2', text:'Pick warm-weather dates in January 2027', done:false} ] },
    { id:'bs2', title:'Who & budget', tasks:[ {id:'bt3', text:'Decide who comes (Adam, friends?)', done:false}, {id:'bt4', text:'Set a budget', done:false} ] },
    { id:'bs3', title:'Book', tasks:[ {id:'bt5', text:'Book travel + lodging / cabin', done:false} ] },
  ] },
  { id:'p7', title:'💪 Health splurge', note:'Botox, teeth whitening, travel to see the urologist.', pk:'health', type:'generic', status:'someday', stages:[] },
  { id:'p8', title:'🏠 UK co-living experiment', note:'Try the co-living thing for a stretch.', pk:'fun', type:'trip', status:'someday', stages:[] },
];

// Design Your Life — Odyssey Plans (3 alternate 5-year paths)
export const ODYSSEY_GAUGES = ['resources', 'like', 'confidence', 'coherence'];
export const SEED_ODYSSEY = [
  { id:'a', title:'Plan A — Keep building', sketch:'Grow the fractional CMO / advisory work and the life-design course. Steady, known, compounding.', gauges:{ resources:4, like:3, confidence:4, coherence:4 } },
  { id:'b', title:'Plan B — Precision Medicine', sketch:'Turn lived genetics experience into a precision-medicine venture or advisory practice.', gauges:{ resources:3, like:4, confidence:3, coherence:4 } },
  { id:'c', title:'Plan C — Age-gap couples', sketch:'Build support / services for age-gap couples — content, community, coaching.', gauges:{ resources:2, like:4, confidence:2, coherence:3 } },
];

// Good Time Journal — log activities by energy + engagement
export const SEED_GOODTIME = [
  { id:'g1', activity:'Morning zone-2 ride', energy:5, engagement:5, note:'Clear head, felt strong' },
  { id:'g2', activity:'Invoice / admin', energy:2, engagement:2, note:'Draining — batch it' },
];

// Mind-map / brainstorm board
export const SEED_MINDMAP = {
  topic: 'Precision Medicine business',
  branches: ['My genetics story = credibility', 'Who is the customer?', 'Partners: labs, clinics', 'Revenue model', 'A first small experiment'],
};

// Personal memories + documents (your own — Rupert reads them as context).
export const SEED_MEMORIES = [
  { id: 'm1', date: '2026-05-24', text: 'Long greenway ride at dawn — felt strong, watched a heron the whole far stretch.' },
];
export const SEED_DOCUMENTS = [
  { id: 'd1', title: 'Next-gig criteria (draft)', body: 'Remote-friendly. Mission in health / precision medicine. Fractional or advisory. Smart, kind team. Pays well enough to fund the life, not all of it.' },
];

export const SEED_PEOPLE = {
  personal:[
    { id:'adam', name:'❤️ Adam', meta:'46 days since your last shared memory', action:'plan a memory' },
    { id:'mom', name:'👩 Mom', meta:'A visit is overdue', action:'pick a date' },
    { id:'son', name:'🧒 Son', meta:'Camping trip idea sitting in Plans', action:'propose a weekend' },
    { id:'chris', name:'⛵ Chris', meta:'Caribbean sailing idea', action:'float it' },
  ],
  professional:[
    { id:'ray', name:'Ray Dorsey', meta:'Digital-health / telemedicine · warm, possible lead', action:'coffee or call' },
    { id:'allen', name:'Allen Naidoo', meta:'Replied — suggested a call (see Calendar)', action:'schedule it' },
  ],
  opportunities:[
    { id:'o1', name:'Fractional CMO — digital-health startup', meta:'Inbound via email · not yet screened', action:'screen' },
    { id:'o2', name:'Advisory role — health-tech', meta:'Inbound via LinkedIn · not yet screened', action:'screen' },
    { id:'o3', name:'Next-gig criteria', meta:'Define what you’re optimizing for so screening is easy', action:'set criteria' },
  ],
};

export const TODAY_POOL = [
  { t:'Protect one easy aerobic block (Z2, 40 min)', m:'Health · Body Coach', c:'var(--emerald)' },
  { t:'Move Q2 tax surplus to the HYSA', m:'Finances · Money Coach', c:'var(--amber)' },
  { t:'Start the August trip flight board', m:'Fun & Travel · Travel Agent', c:'var(--sky)' },
  { t:'Reach out to Ray Dorsey for a coffee', m:'Relationships · network lead', c:'var(--rose)' },
  { t:'Book the overdue preventive item', m:'Health · Medical Coach', c:'var(--emerald)' },
  { t:'Screen the 2 inbound job opportunities', m:'Purpose · career', c:'var(--violet)' },
  { t:'Add a memory from the last two weeks', m:'Relationships · mikeandadam', c:'var(--rose)' },
  { t:'Log Q2 payments in mikesmoney', m:'Finances · admin', c:'var(--amber)' },
  { t:'Plan a date to go see Mom', m:'Relationships · Plans', c:'var(--rose)' },
  { t:'Attach michaeldulinmd.com domain', m:'Purpose · mikedulinmd', c:'var(--violet)' },
];

export const QUOTES = [
  ['The trouble is, you think you have time.','Buddhist proverb'],
  ['How we spend our days is, of course, how we spend our lives.','Annie Dillard'],
  ['Tell me, what is it you plan to do with your one wild and precious life?','Mary Oliver'],
  ['You do not rise to the level of your goals. You fall to the level of your systems.','James Clear'],
];

export const WEEK_DAYS = ['MON 1','TUE 2','WED 3','THU 4','FRI 5','SAT 6','SUN 7'];
export const WEEK_EVENTS = {
  0:[['Triad block','--violet'],['Run 5mi','--emerald']],
  1:[['Avance call','--violet'],['Naidoo call?','prop','--rose']],
  2:[['UNC consult','--violet'],['Dinner: Adam','--rose']],
  3:[['Strength','--emerald'],['Naidoo call?','prop','--rose']],
  4:[['Triad block','--violet'],['Z2 ride','--emerald'],['Dinner w/ Adam','--rose']],
  5:[['Z2 ride?','prop','--emerald'],['Farmers mkt','--rose']],
  6:[['Long run','--emerald'],['Trip planning','--sky']],
};

export const MAILS = [
  ['✈️ TRAVEL','--sky','Going.com','Spain + Portugal rail pass — 40% off this week','Matches “month in Spain” → ','promote to Plans'],
  ['🎯 CAREER','--violet','Recruiter (Korn Ferry)','Fractional CMO — digital-health startup, remote','Inbound opportunity → ','screen in People'],
  ['🤝 NETWORK','--rose','Allen Naidoo','Re: catching up — “let’s grab a call”','Reply waiting → ','draft + propose times'],
  ['💰 FINANCE','--amber','Fifth Third Bank','Quarterly statement is ready','FYI / file → ','no action'],
  ['🥾 TRAVEL','--sky','REI Adventures','Alaska guided hiking trips — fall dates open','Matches “Alaska” plan → ','promote to Plans'],
];

export const CODING_UPDATES = [
  ['var(--emerald)','✅ List-erase bug fixed + deployed (mikeandadam)','Done · Jun 5'],
  ['var(--emerald)','✅ Biweekly memory reminder live (mikeandadam)','Done · Jun 5 · Cloud Function deployed'],
  ['var(--emerald)','✅ Mike’s Life scaffolded + deployed','Done · Jun 5 · this app'],
  ['var(--amber)','⏳ Build August trip app (meals + flights + chat)','Pending · standalone shareable app for the 8 friends'],
  ['var(--violet)','⏳ Extend mikedulinmd.app for Purpose (work + job search + volunteering)','Pending · powers People → opportunities'],
  ['var(--sky)','⏳ Wire calendar + email (Google APIs) and spoke snapshots','Pending · turns previews into live data'],
  ['var(--rose)','🔒 Rotate 3 exposed secrets','Pending · security'],
];

// ── Roadmap / work tracker (lifeos.roadmap) ──────────────────────────────────
// Seeded once from the session handoff; thereafter editable in the Roadmap tab
// (and readable by Rupert). status: 'next' | 'doing' | 'idea' | 'done'.
export const ROADMAP_APPS = {
  lifeos:   { label: 'LifeOS',  c: '--teal' },
  money:    { label: 'Money',   c: '--amber' },
  fitness:  { label: 'Fitness', c: '--emerald' },
  health:   { label: 'Health',  c: '--rose' },
  travel:   { label: 'Travel',  c: '--sky' },
  rentals:  { label: 'Rentals', c: '--violet' },
  mini:     { label: 'Mini/Rupert', c: '--mut' },
  security: { label: 'Security', c: '--rose' },
  docs:     { label: 'Docs',    c: '--mut' },
};
export const ROADMAP_COLS = [['doing', 'In progress'], ['next', 'Next up'], ['idea', 'Ideas'], ['done', 'Done']];

const rm = (id, app, status, title, note = '') => ({ id, app, status, title, note });
export const SEED_ROADMAP = [
  // ── In progress (mostly the Mac-mini housekeeping) ──
  rm('m1', 'mini', 'doing', 'Unload old brief/content/check-in plists', 'They double-send via Telegram; cloud crons replace them.'),
  rm('m2', 'mini', 'doing', 'Add mikeshealth-sa.json + health-sync plist', 'Reader SA (Cloud Datastore User) on mikeshealth-ad213; load ai.openclaw.mikeslife-health-sync.plist.'),
  rm('m3', 'mini', 'doing', 'gog re-auth (calendar/email path)', 'gog auth add mdulin@gmail.com --services gmail,calendar,drive,contacts,docs,sheets.'),
  rm('m4', 'mini', 'doing', 'Build rupertQueue consumer', 'Poll lifeos.rupertQueue -> run adamjobs/social on demand -> write results back as alerts.'),
  rm('h1', 'health', 'doing', 'Tap "Import real data" in mikeshealth', 'Loads the 6/6 HIMS/H&H labs (T 855, E2 45, PSA 1.84).'),

  // ── Next up (approved build queue) ──
  rm('n1', 'lifeos', 'next', 'In-app plan-step input dialogs', 'Today one-liners -> tap -> step with input; answers saved to plan task notes.'),
  rm('n2', 'money', 'next', 'Per-page insight button + Amazon email parsing', 'Needs OPENAI key in mikes-money Vercel; parse Amazon order emails -> Plaid txn matching.'),
  rm('n3', 'lifeos', 'next', 'Design system remainder (IBM Plex dark pass)', 'Full Attending pass on money/fitness/rentals + home pillar-status row.'),
  rm('n4', 'travel', 'next', 'mikestravel Phase 2', 'Gmail itinerary parse -> segments, travelContext slice, pre-trip alerts.'),
  rm('n5', 'lifeos', 'next', 'Real Inbox proposals', 'Rupert writes lifeos.proposals so the Inbox has live items.'),
  rm('n6', 'lifeos', 'next', 'iOS Shortcuts location automations', 'LOCATION_TOKEN is set; build Arrive Gym/Grocery/Clinic/Home -> POST /api/location.'),
  rm('n7', 'security', 'next', 'Security rotation (overdue)', 'GitHub PAT, Telegram bot token, HEALTH_INGEST_TOKEN; delete orphaned Google client secret.'),
  rm('n8', 'docs', 'next', 'Add mikestravel CLAUDE.md entry (#13)', ''),
  rm('n9', 'money', 'next', 'Q3 tax true-up (7/15) + H2 money transition', 'TPC ends 6/30; retirement draws start July.'),

  // ── Ideas (backlog — add yours here) ──
  rm('i1', 'lifeos', 'idea', 'Quick capture', 'Frictionless inbox for fleeting notes/ideas from anywhere.'),
  rm('i2', 'lifeos', 'idea', 'Cross-app correlations', 'e.g. sleep/training vs mood vs spend.'),
  rm('i3', 'lifeos', 'idea', 'Vault + emergency one-pager', 'Key docs/accounts/contacts in one secure place.'),
  rm('i4', 'lifeos', 'idea', 'Calendar timeboxing', 'Auto-block focus/training/recovery on the calendar.'),
  rm('i5', 'fitness', 'idea', 'mikesfitness ideas (add yours)', ''),
  rm('i6', 'health', 'idea', 'mikeshealth ideas (add yours)', ''),
  rm('i7', 'travel', 'idea', 'mikestravel ideas (add yours)', ''),

  // ── Done (recent highlights) ──
  rm('d1', 'lifeos', 'done', 'Rupert chat brain (gpt-5.5) + voice', ''),
  rm('d2', 'lifeos', 'done', 'Planning hub (activate->steps, Odyssey, mind-map, journal)', ''),
  rm('d3', 'lifeos', 'done', 'Alert history + ratings + global search', ''),
  rm('d4', 'lifeos', 'done', 'Wellness-first check-in (drag-to-rank)', ''),
  rm('d5', 'lifeos', 'done', 'Today engine (4-5/day, delay + roll-forward)', ''),
  rm('d6', 'lifeos', 'done', 'Google calendar + email pipeline (LIVE)', ''),
  rm('d7', 'lifeos', 'done', 'Cloud crons (brief/content/celebrate/google/finance/invoice)', ''),
  rm('d8', 'lifeos', 'done', 'Refresh + notification focus pages + location capture', ''),
  rm('d9', 'lifeos', 'done', 'Purpose Learning hub (courses + 2026 conferences)', ''),
  rm('d10', 'lifeos', 'done', 'Floating dock + centered peacock', ''),
  rm('d11', 'lifeos', 'done', 'Rupert banners + peacocks on all 5 apps', ''),
  rm('d12', 'money', 'done', 'Business tab (income matrix + timesheet + invoices + GMA ledger)', ''),
  rm('d13', 'money', 'done', 'Grouped 5-tab nav + large-txn filter', ''),
  rm('d14', 'health', 'done', 'Attending theme (IBM Plex dark) + 6/6 labs', ''),
  rm('d15', 'travel', 'done', 'mikestravel born + live with real trips', ''),
  rm('d16', 'docs', 'done', 'Portal retired to public site (mikedulinmd)', ''),
];
