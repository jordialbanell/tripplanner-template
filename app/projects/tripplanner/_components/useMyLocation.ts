'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

// Where the phone is, from the browser's own location service. Free: no Google or AI calls.
// Starts only when you tap (the browser asks for permission once), or straight away on later
// visits if permission was already given. Distances are straight lines, not walking routes.

export interface MyLocation { lat: number; lng: number; accuracy: number }
export type LocationStatus = 'off' | 'asking' | 'on' | 'denied' | 'unavailable';

export function useMyLocation() {
  const [me, setMe] = useState<MyLocation | null>(null);
  const [status, setStatus] = useState<LocationStatus>('off');
  const watchId = useRef<number | null>(null);

  const start = useCallback(() => {
    if (watchId.current != null) return;
    if (typeof navigator === 'undefined' || !navigator.geolocation) { setStatus('unavailable'); return; }
    setStatus(s => (s === 'on' ? s : 'asking'));
    watchId.current = navigator.geolocation.watchPosition(
      pos => {
        setMe({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy });
        setStatus('on');
      },
      err => {
        if (watchId.current != null) navigator.geolocation.clearWatch(watchId.current);
        watchId.current = null;
        setStatus(err.code === err.PERMISSION_DENIED ? 'denied' : 'unavailable');
      },
      { enableHighAccuracy: true, maximumAge: 15000, timeout: 20000 },
    );
  }, []);

  // Already allowed on an earlier visit: switch on without a tap.
  useEffect(() => {
    let cancelled = false;
    navigator.permissions?.query({ name: 'geolocation' as PermissionName })
      .then(p => { if (!cancelled && p.state === 'granted') start(); })
      .catch(() => { /* Permissions API missing: wait for a tap */ });
    return () => {
      cancelled = true;
      if (watchId.current != null) navigator.geolocation.clearWatch(watchId.current);
      watchId.current = null;
    };
  }, [start]);

  return { me, status, start };
}

export function metresBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function fmtDistance(m: number): string {
  if (m < 1000) return `${Math.max(10, Math.round(m / 10) * 10)} m`;
  if (m < 10000) return `${(m / 1000).toFixed(1)} km`;
  return `${Math.round(m / 1000).toLocaleString('en-GB')} km`;
}
