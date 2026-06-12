import { useEffect, useState, useCallback, useRef } from 'react';
import { doc, onSnapshot, setDoc } from 'firebase/firestore';
import { db } from './firebase';
import {
  SEED_PROPOSALS, SEED_PLANS, SEED_PEOPLE,
  SEED_ODYSSEY, SEED_GOODTIME, SEED_MINDMAP, SEED_MEMORIES, SEED_DOCUMENTS, stagesFromTemplate,
} from './seed';

const ymdEastern = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

const initial = () => ({
  proposals: SEED_PROPOSALS,
  plans: SEED_PLANS,
  people: SEED_PEOPLE,
  checkin: null, // { date, energy, mood, capacity, journal }
  odyssey: SEED_ODYSSEY,
  goodTime: SEED_GOODTIME,
  mindmap: SEED_MINDMAP,
  memories: SEED_MEMORIES,
  documents: SEED_DOCUMENTS,
  // Filled by the backend Google pipeline (Phase 2); falls back to previews when absent.
  calendar: null,      // { weekEvents: { 0:[[title, '--color']|[title,'prop','--color'], ...], ... }, updatedAt }
  emailSignals: null,  // [ [TAG, '--accent', from, subject, hintPrefix, actionText], ... ]
  // Alert history — every brief/content push lands here (newest first, capped at 120).
  // Written by the mini scripts + /api/refresh; the app reads / gives feedback / deletes.
  alerts: [],          // [{ id, type: 'brief'|'podcast'|'recipe'|'mealprep'|'travel', title, text, at, feedback: 'up'|'down'|null }]
  // Today engine — 4-5 concrete items/day (no check-in; capacity is assumed).
  // Regenerated daily (client fallback + cron-brief); delayed items resurface on their date.
  todayItems: [],      // [{ id, title, why, pk, planId?, status: 'pending'|'done'|'delayed', until: null|'YYYY-MM-DD' }]
  todayItemsDate: null,
  // Morning check-in output: today's ranked plan + Rupert's assignments.
  dayPlan: null,       // { date, rupertTasks: [{id, kind, label, via, status}], submittedAt }
  rupertQueue: [],     // mini-bound jobs the Mac mini picks up (adamjobs, social)
  // Per-type alert mutes — producers (crons + mini scripts) skip muted types.
  alertPrefs: { brief: true, podcast: true, recipe: true, mealprep: true, travel: true, fitness: true, finance: true, health: true, rental: true, celebrate: true, ainews: true },
});

// Native LifeOS data. Persists to Firestore doc lifeos/{uid} when configured;
// otherwise lives in memory (demo mode).
export function useLifeData(user) {
  const [data, setData] = useState(initial);
  const [loaded, setLoaded] = useState(false);
  const liveRef = useRef(false);

  useEffect(() => {
    if (!db || !user) { setLoaded(true); return; }
    const ref = doc(db, 'lifeos', user.uid);
    const unsub = onSnapshot(ref, (snap) => {
      if (snap.exists()) {
        const fresh = snap.data();
        // Back-compat: plans seeded before the planning feature lack status/stages/type,
        // so they'd be filtered out of every section (someday/active/done) → empty Plans tab.
        if (Array.isArray(fresh.plans)) {
          fresh.plans = fresh.plans.map((p) => ({
            ...p, status: p.status || 'someday', stages: p.stages || [], type: p.type || 'generic',
          }));
        }
        // Firestore can't hold nested arrays, so the Google sync stores objects;
        // convert back to the tuple shapes the Calendar/Email components render.
        if (fresh.calendar && fresh.calendar.weekEvents) {
          const we = {};
          Object.entries(fresh.calendar.weekEvents).forEach(([k, list]) => {
            we[k] = (list || []).map((e) => Array.isArray(e) ? e : (e.prop ? [e.t, 'prop', e.c] : [e.t, e.c]));
          });
          fresh.calendar = { ...fresh.calendar, weekEvents: we };
        }
        if (Array.isArray(fresh.emailSignals) && fresh.emailSignals.length && !Array.isArray(fresh.emailSignals[0])) {
          fresh.emailSignals = fresh.emailSignals.map((m) => [m.tag, m.accent, m.from, m.subject, m.hint, m.act]);
        }
        setData({ ...initial(), ...fresh });
      } else {
        setDoc(ref, initial()).catch(console.error);
        setData(initial());
      }
      liveRef.current = true;
      setLoaded(true);
    }, (err) => { console.error('lifeos snapshot error', err); setLoaded(true); });
    return unsub;
  }, [user]);

  const write = useCallback((patch) => {
    if (db && user && liveRef.current) {
      setDoc(doc(db, 'lifeos', user.uid), patch, { merge: true }).catch(console.error);
    }
  }, [user]);

  // generic: produce next state from prev, persist the named keys
  const mutate = useCallback((producer, keys) => {
    setData((prev) => {
      const next = producer(prev);
      const patch = {};
      keys.forEach((k) => { patch[k] = next[k]; });
      write(patch);
      return next;
    });
  }, [write]);

  const resolveProposal = useCallback((id) => {
    mutate((p) => ({ ...p, proposals: p.proposals.filter((x) => x.id !== id) }), ['proposals']);
  }, [mutate]);

  const saveCheckin = useCallback((checkin) => {
    mutate((p) => ({ ...p, checkin }), ['checkin']);
  }, [mutate]);

  const activatePlan = useCallback((id) => {
    mutate((p) => ({
      ...p,
      plans: p.plans.map((pl) => pl.id === id
        ? { ...pl, status: 'active', stages: pl.stages && pl.stages.length ? pl.stages : stagesFromTemplate(pl.type) }
        : pl),
    }), ['plans']);
  }, [mutate]);

  const setPlanStatus = useCallback((id, status) => {
    mutate((p) => ({ ...p, plans: p.plans.map((pl) => pl.id === id ? { ...pl, status } : pl) }), ['plans']);
  }, [mutate]);

  const toggleTask = useCallback((planId, stageId, taskId) => {
    mutate((p) => ({
      ...p,
      plans: p.plans.map((pl) => pl.id !== planId ? pl : {
        ...pl,
        updatedAt: new Date().toISOString(), // activity stamp — cron-brief flags plans stalled >14d
        stages: pl.stages.map((s) => s.id !== stageId ? s : {
          ...s,
          tasks: s.tasks.map((t) => t.id !== taskId ? t : { ...t, done: !t.done }),
        }),
      }),
    }), ['plans']);
  }, [mutate]);

  const updateOdyssey = useCallback((id, patch) => {
    mutate((p) => ({ ...p, odyssey: p.odyssey.map((o) => o.id === id ? { ...o, ...patch, gauges: { ...o.gauges, ...(patch.gauges || {}) } } : o) }), ['odyssey']);
  }, [mutate]);

  const addGoodTime = useCallback((entry) => {
    mutate((p) => ({ ...p, goodTime: [{ id: 'g' + Date.now(), ...entry }, ...p.goodTime] }), ['goodTime']);
  }, [mutate]);

  const setMindTopic = useCallback((topic) => {
    mutate((p) => ({ ...p, mindmap: { ...p.mindmap, topic } }), ['mindmap']);
  }, [mutate]);

  const addMindBranch = useCallback((text) => {
    mutate((p) => ({ ...p, mindmap: { ...p.mindmap, branches: [...p.mindmap.branches, text] } }), ['mindmap']);
  }, [mutate]);

  const removeMindBranch = useCallback((idx) => {
    mutate((p) => ({ ...p, mindmap: { ...p.mindmap, branches: p.mindmap.branches.filter((_, i) => i !== idx) } }), ['mindmap']);
  }, [mutate]);

  const setLocation = useCallback((location) => {
    mutate((p) => ({ ...p, location }), ['location']);
  }, [mutate]);

  const setFcmToken = useCallback((token) => {
    // Store ALL devices' tokens (phone + desktop) so pushes reach every device,
    // not just whichever one enabled notifications most recently.
    mutate((p) => {
      const fcmTokens = Array.from(new Set([...(p.fcmTokens || []), token])).slice(-5);

  return { ...p, fcmToken: token, fcmTokens, fcmUpdatedAt: new Date().toISOString() };
    }, ['fcmToken', 'fcmTokens', 'fcmUpdatedAt']);
  }, [mutate]);

  const addPlan = useCallback((title, pk = 'fun', note = '') => {
    const t = (title || '').trim();
    if (!t) return;
    mutate((p) => ({
      ...p,
      plans: [{ id: 'p' + Date.now(), title: t, note: (note || '').trim(), pk, type: 'generic', status: 'someday', stages: [] }, ...p.plans],
    }), ['plans']);
  }, [mutate]);

  // Add a custom step to a plan (lands in a "More steps" stage).
  const addTask = useCallback((planId, text) => {
    const t = (text || '').trim();
    if (!t) return;
    mutate((p) => ({
      ...p,
      plans: p.plans.map((pl) => {
        if (pl.id !== planId) return pl;
        const stages = [...(pl.stages || [])];
        const task = { id: 't' + Date.now(), text: t, done: false };
        const i = stages.findIndex((s) => s.title === 'More steps');
        if (i >= 0) stages[i] = { ...stages[i], tasks: [...stages[i].tasks, task] };
        else stages.push({ id: 's_more_' + Date.now(), title: 'More steps', tasks: [task] });
        return { ...pl, status: pl.status === 'someday' ? 'active' : pl.status, stages };
      }),
    }), ['plans']);
  }, [mutate]);

  // ── People: manual add / delete / bulk import (vCard) ──
  const addPerson = useCallback((group, person) => {
    const name = (person.name || '').trim();
    if (!name) return;
    mutate((p) => {
      const list = (p.people && p.people[group]) || [];
      return { ...p, people: { ...p.people, [group]: [{ id: 'pp' + Date.now(), name, meta: (person.meta || '').trim(), action: person.action || '' }, ...list] } };
    }, ['people']);
  }, [mutate]);

  const deletePerson = useCallback((group, id) => {
    mutate((p) => ({ ...p, people: { ...p.people, [group]: ((p.people && p.people[group]) || []).filter((x) => x.id !== id) } }), ['people']);
  }, [mutate]);

  const addPeople = useCallback((group, persons) => {
    const clean = (persons || []).filter((x) => (x.name || '').trim());
    if (!clean.length) return;
    mutate((p) => {
      const list = (p.people && p.people[group]) || [];
      const add = clean.map((x, i) => ({ id: 'pp' + Date.now() + '_' + i, name: x.name.trim(), meta: (x.meta || '').trim(), action: '' }));
      return { ...p, people: { ...p.people, [group]: [...add, ...list] } };
    }, ['people']);
  }, [mutate]);

  const addMemory = useCallback((text) => {
    const t = (text || '').trim();
    if (!t) return;
    mutate((p) => ({ ...p, memories: [{ id: 'm' + Date.now(), date: ymdEastern(), text: t }, ...(p.memories || [])] }), ['memories']);
  }, [mutate]);

  const deleteMemory = useCallback((id) => {
    mutate((p) => ({ ...p, memories: (p.memories || []).filter((m) => m.id !== id) }), ['memories']);
  }, [mutate]);

  const addDocument = useCallback((title, body) => {
    const tt = (title || '').trim();
    if (!tt) return;
    mutate((p) => ({ ...p, documents: [{ id: 'd' + Date.now(), title: tt, body: (body || '').trim() }, ...(p.documents || [])] }), ['documents']);
  }, [mutate]);

  const deleteDocument = useCallback((id) => {
    mutate((p) => ({ ...p, documents: (p.documents || []).filter((x) => x.id !== id) }), ['documents']);
  }, [mutate]);

  // ── Today engine ──
  const setTodayItems = useCallback((items, date) => {
    mutate((p) => ({ ...p, todayItems: items, todayItemsDate: date }), ['todayItems', 'todayItemsDate']);
  }, [mutate]);

  const markTodayDone = useCallback((id) => {
    mutate((p) => ({
      ...p,
      todayItems: (p.todayItems || []).map((t) => t.id === id ? { ...t, status: t.status === 'done' ? 'pending' : 'done' } : t),
    }), ['todayItems']);
  }, [mutate]);

  // One-tap from an alert (or anywhere): put a concrete item on today's list.
  const addTodayItem = useCallback((item) => {
    const title = (item.title || '').trim();
    if (!title) return;
    mutate((p) => ({
      ...p,
      todayItems: [...(p.todayItems || []), { id: 'td' + Date.now(), title, why: item.why || '', pk: item.pk || 'fun', status: 'pending', until: null }],
    }), ['todayItems']);
  }, [mutate]);

  // Submit the morning plan: ranked my-day items become todayItems; Rupert's
  // assignments live on dayPlan (run-tasks updates their statuses server-side).
  const submitDayPlan = useCallback((items, rupertTasks, date) => {
    mutate((p) => ({
      ...p,
      todayItems: items,
      todayItemsDate: date,
      dayPlan: { date, rupertTasks, submittedAt: new Date().toISOString() },
    }), ['todayItems', 'todayItemsDate', 'dayPlan']);
  }, [mutate]);

  const setAlertPref = useCallback((type, on) => {
    mutate((p) => ({ ...p, alertPrefs: { brief: true, podcast: true, recipe: true, mealprep: true, travel: true, fitness: true, finance: true, health: true, rental: true, celebrate: true, ainews: true, ...(p.alertPrefs || {}), [type]: on } }), ['alertPrefs']);
  }, [mutate]);

  // Per-item 👍/👎 inside a content alert. `items` is the rendered list (covers
  // legacy text alerts — first rating materializes the items array onto the alert).
  const setAlertItemFeedback = useCallback((alertId, items, idx, fb) => {
    mutate((p) => ({
      ...p,
      alerts: (p.alerts || []).map((a) => a.id !== alertId ? a : {
        ...a,
        items: items.map((it, i) => i === idx ? { ...it, feedback: it.feedback === fb ? null : fb } : it),
      }),
    }), ['alerts']);
  }, [mutate]);

  const delayTodayItem = useCallback((id, days) => {
    const until = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' })
      .format(new Date(Date.now() + days * 86400 * 1000));
    mutate((p) => ({
      ...p,
      todayItems: (p.todayItems || []).map((t) => t.id === id ? { ...t, status: 'delayed', until } : t),
    }), ['todayItems']);
  }, [mutate]);

  // ── Alerts: feedback (👍/👎 toggle) + delete ──
  const setAlertFeedback = useCallback((id, fb) => {
    mutate((p) => ({
      ...p,
      alerts: (p.alerts || []).map((a) => a.id === id ? { ...a, feedback: a.feedback === fb ? null : fb } : a),
    }), ['alerts']);
  }, [mutate]);

  const deleteAlert = useCallback((id) => {
    mutate((p) => ({ ...p, alerts: (p.alerts || []).filter((a) => a.id !== id) }), ['alerts']);
  }, [mutate]);

  return {
    data, loaded,
    resolveProposal, saveCheckin,
    activatePlan, setPlanStatus, toggleTask, addPlan, addTask,
    updateOdyssey, addGoodTime, setMindTopic, addMindBranch, removeMindBranch,
    addMemory, deleteMemory, addDocument, deleteDocument,
    addPerson, deletePerson, addPeople,
    setLocation, setFcmToken,
    setAlertFeedback, deleteAlert,
    setTodayItems, markTodayDone, delayTodayItem, addTodayItem,
    setAlertPref, setAlertItemFeedback,
    submitDayPlan,
  };
}
