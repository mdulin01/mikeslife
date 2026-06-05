import { useEffect, useState, useCallback, useRef } from 'react';
import { doc, onSnapshot, setDoc } from 'firebase/firestore';
import { db } from './firebase';
import { SEED_PROPOSALS, SEED_PLANS, SEED_PEOPLE } from './seed';

const initial = () => ({
  proposals: SEED_PROPOSALS,
  plans: SEED_PLANS,
  people: SEED_PEOPLE,
  checkin: null, // { date, energy, mood, capacity, journal }
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

  const resolveProposal = useCallback((id) => {
    setData((prev) => {
      const proposals = prev.proposals.filter((p) => p.id !== id);
      write({ proposals });
      return { ...prev, proposals };
    });
  }, [write]);

  const saveCheckin = useCallback((checkin) => {
    setData((prev) => { write({ checkin }); return { ...prev, checkin }; });
  }, [write]);

  return { data, loaded, resolveProposal, saveCheckin };
}
