import { useEffect, useState, useCallback, useRef } from 'react';
import { doc, onSnapshot, setDoc } from 'firebase/firestore';
import { db } from './firebase';
import {
  SEED_PROPOSALS, SEED_PLANS, SEED_PEOPLE,
  SEED_ODYSSEY, SEED_GOODTIME, SEED_MINDMAP, stagesFromTemplate,
} from './seed';

const initial = () => ({
  proposals: SEED_PROPOSALS,
  plans: SEED_PLANS,
  people: SEED_PEOPLE,
  checkin: null, // { date, energy, mood, capacity, journal }
  odyssey: SEED_ODYSSEY,
  goodTime: SEED_GOODTIME,
  mindmap: SEED_MINDMAP,
  // Filled by the backend Google pipeline (Phase 2); falls back to previews when absent.
  calendar: null,      // { weekEvents: { 0:[[title, '--color']|[title,'prop','--color'], ...], ... }, updatedAt }
  emailSignals: null,  // [ [TAG, '--accent', from, subject, hintPrefix, actionText], ... ]
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
        setData({ ...initial(), ...snap.data() });
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

  return {
    data, loaded,
    resolveProposal, saveCheckin,
    activatePlan, setPlanStatus, toggleTask,
    updateOdyssey, addGoodTime, setMindTopic, addMindBranch, removeMindBranch,
  };
}
