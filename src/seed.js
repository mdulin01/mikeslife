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

export const SEED_PLANS = [
  { id:'p1', title:'🇪🇸 A month in Spain', note:'Live there ~4 weeks and actually learn Spanish.', pk:'fun' },
  { id:'p2', title:'⛵ Caribbean sailing', note:'Learn to sail with Chris.', pk:'fun' },
  { id:'p3', title:'👩 Go see Mom', note:'Don’t let it keep sliding — pick a date.', pk:'rel' },
  { id:'p4', title:'💝 Something special for Adam', note:'A surprise / a trip / a gesture worth planning.', pk:'rel' },
  { id:'p5', title:'🏕️ Camping with my son', note:'Get a weekend on the calendar.', pk:'rel' },
  { id:'p6', title:'🥾 Hiking in Alaska', note:'Bucket-list trip.', pk:'fun' },
  { id:'p7', title:'💪 Health splurge', note:'Botox, teeth whitening, travel to see the urologist.', pk:'health' },
  { id:'p8', title:'🏠 UK co-living experiment', note:'Try the co-living thing for a stretch.', pk:'fun' },
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
