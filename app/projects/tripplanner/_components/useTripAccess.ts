'use client';

import { useEffect, useState } from 'react';

// What this browser may do, for showing or hiding buttons. The server enforces it regardless.
export interface TripAccess {
  loaded: boolean;
  owner: boolean;
  canEdit: string[];
  canView: string[];
  demo: string[];
}

const EMPTY: TripAccess = { loaded: false, owner: false, canEdit: [], canView: [], demo: [] };
let cache: TripAccess | null = null;

export function useTripAccess(): TripAccess {
  const [a, setA] = useState<TripAccess>(cache ?? EMPTY);
  useEffect(() => {
    if (cache) return;
    fetch('/projects/tripplanner/api/me', { cache: 'no-store' })
      .then(r => r.json())
      .then(d => { cache = { loaded: true, owner: !!d.owner, canEdit: d.canEdit ?? [], canView: d.canView ?? [], demo: d.demo ?? [] }; setA(cache); })
      .catch(() => { cache = { ...EMPTY, loaded: true }; setA(cache); });
  }, []);
  return a;
}

export const canEditTrip = (a: TripAccess, tripId: string) => a.owner || a.canEdit.includes(tripId);
