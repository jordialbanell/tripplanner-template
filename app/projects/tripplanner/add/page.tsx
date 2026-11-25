'use client';

// Where the iPhone "Save to TripPlanner" Shortcut lands: /projects/tripplanner/add?url=<shared link>.
// Pulls the place(s) out of a TikTok / Instagram / map link (same extractor as the paste box),
// saves them, and adds them to the trip you pick. Works for the owner (signed in) and for anyone
// who has opened an edit link in this browser. The server checks both on every call.

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import type { ExtractedPlace } from '@/app/projects/tripplanner/api/extract/route';
import type { PlacesResult } from '@/app/projects/tripplanner/api/places/route';
import { supabase } from '@/lib/trip/supabase';
import { fetchAllPlaces, findDuplicate, insertPlaces } from '@/lib/trip/places';
import { CATEGORIES, isCategory, type SavedPlace } from '@/app/projects/tripplanner/_components/placeTypes';
import { useTripAccess } from '@/app/projects/tripplanner/_components/useTripAccess';
import { TripSignIn } from '@/app/projects/tripplanner/_components/TripSignIn';

interface TripOption { id: string; name: string; start_date: string; end_date: string }
type Saved = { name: string; city: string; category: string; status: 'saved' | 'already' | 'failed' };
type Choice = { place: ExtractedPlace; options: PlacesResult[] };

const LAST_TRIP_KEY = 'tp-add-last-trip';
const today = () => new Date().toISOString().slice(0, 10);

// The share sheet sometimes hands over text with the link inside it.
function firstLink(raw: string | null): string | null {
  if (!raw) return null;
  const m = raw.match(/https?:\/\/[^\s"'<>]+/i);
  return m ? m[0] : null;
}

function readLastTrip(): string | null {
  try { return localStorage.getItem(LAST_TRIP_KEY); } catch { return null; }
}
function writeLastTrip(id: string) {
  try { localStorage.setItem(LAST_TRIP_KEY, id); } catch { /* private mode */ }
}

function AddInner() {
  // Read everything after "url=" as-is, so a shared link with its own ? and & isn't cut short
  // (the Shortcut doesn't need to encode it). Falls back to the normal query value.
  const params = useSearchParams();
  const [link, setLink] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    const q = window.location.search;
    const i = q.indexOf('url=');
    let raw = i >= 0 ? q.slice(i + 4) : params.get('url');
    if (raw && /^https?%3A/i.test(raw)) { try { raw = decodeURIComponent(raw); } catch { /* keep */ } }
    setLink(firstLink(raw ?? null));
  }, [params]);
  const access = useTripAccess();
  const canAddAnywhere = access.owner;
  const editTrips = access.canEdit;

  const [trips, setTrips] = useState<TripOption[] | null>(null);
  const [tripId, setTripId] = useState<string>('');
  const [stage, setStage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<Saved[]>([]);
  const [choices, setChoices] = useState<Choice[]>([]);
  const [done, setDone] = useState(false);
  const started = useRef(false);
  const existing = useRef<SavedPlace[]>([]);

  const allowed = access.loaded && (canAddAnywhere || editTrips.length > 0);

  // Trips this person can add to, soonest upcoming first.
  useEffect(() => {
    if (!allowed) return;
    supabase.from('trips').select('id, name, start_date, end_date').order('start_date', { ascending: true }).then(({ data }) => {
      const list: TripOption[] = (data || []).filter((t: TripOption) => canAddAnywhere || editTrips.includes(t.id));
      setTrips(list);
      const last = readLastTrip();
      const upcoming = list.find(t => t.end_date >= today());
      const pick = (last && list.some(t => t.id === last) ? last : null) ?? upcoming?.id ?? list[0]?.id ?? '';
      setTripId(pick);
    });
  }, [allowed, canAddAnywhere, editTrips]);

  const addToTrip = useCallback(async (placeIds: string[]) => {
    if (!tripId || placeIds.length === 0) return;
    // Ignore "already included" errors: the place is in the trip either way.
    await Promise.all(placeIds.map(id => supabase.from('trip_included_places').insert({ trip_id: tripId, place_id: id })));
  }, [tripId]);

  const saveOne = useCallback(async (place: ExtractedPlace, geo: PlacesResult | null): Promise<Saved> => {
    const base = { name: geo?.name || place.name, city: place.city || geo?.city || '', category: place.category };
    const dup = geo
      ? findDuplicate(existing.current, { name: place.name, google_place_id: geo.place_id, lat: geo.lat, lng: geo.lng })
      : existing.current.find(p => p.name.toLowerCase() === place.name.toLowerCase() && p.city.toLowerCase() === (place.city || '').toLowerCase());
    if (dup) {
      await addToTrip([dup.id]);
      return { ...base, status: 'already' };
    }
    try {
      const rows = await insertPlaces([{
        name: place.name,
        city: place.city || geo?.city || '',
        country: place.country || geo?.country || '',
        category: place.category,
        vibe: place.vibe,
        description: place.description || undefined,
        lat: geo?.lat ?? null,
        lng: geo?.lng ?? null,
        address: geo?.address ?? null,
        google_place_id: geo?.place_id ?? null,
        neighbourhood: geo?.neighbourhood ?? null,
        tiktok_url: link ?? '',
        source_handle: place.source_handle ?? null,
      }]);
      existing.current = [...rows, ...existing.current];
      await addToTrip(rows.map(r => r.id));
      return { ...base, status: rows.length ? 'saved' : 'failed' };
    } catch {
      return { ...base, status: 'failed' };
    }
  }, [addToTrip, link]);

  const run = useCallback(async () => {
    if (!link) return;
    setError(null); setSaved([]); setChoices([]); setDone(false);
    setStage('Reading the link…');
    try { existing.current = await fetchAllPlaces(); } catch { existing.current = []; }

    try {
      const res = await fetch('/projects/tripplanner/api/extract', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: link }),
      });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? 'Something went wrong.'); setStage(null); return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done: end, value } = await reader.read();
        if (end) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() ?? '';
        for (const part of parts) {
          const ev = part.match(/^event: (\w+)/m)?.[1];
          const raw = part.match(/^data: (.+)/m)?.[1];
          if (!ev || !raw) continue;
          const data = JSON.parse(raw);
          if (ev === 'status') setStage(data.stage);
          else if (ev === 'error') { setError(data.error ?? 'Something went wrong.'); setStage(null); return; }
          else if (ev === 'result') {
            const incoming: ExtractedPlace[] = data.places || [];
            if (incoming.length === 0) {
              setError("Couldn't find a place in that post. Open TripPlanner and add it by name instead.");
              setStage(null); return;
            }
            setStage('Saving…');
            const results: Saved[] = [];
            const pending: Choice[] = [];
            for (const place of incoming) {
              if (place.geoAll && place.geoAll.length >= 2) pending.push({ place, options: place.geoAll.slice(0, 4) });
              else results.push(await saveOne(place, place.geoAll?.length === 1 ? place.geoAll[0] : (place.geo ?? null)));
            }
            setSaved(results);
            setChoices(pending);
            setStage(null);
            if (pending.length === 0) setDone(true);
          }
        }
      }
    } catch {
      setError('Network error. Check your connection and try again.');
      setStage(null);
    }
  }, [link, saveOne]);

  // Start as soon as we know who's asking and which trip to add to.
  useEffect(() => {
    if (started.current || !allowed || !link || trips === null) return;
    started.current = true;
    run();
  }, [allowed, link, trips, run]);

  async function pickBranch(i: number, geo: PlacesResult | 'all' | 'skip') {
    const c = choices[i];
    const rest = choices.filter((_, j) => j !== i);
    setChoices(rest);
    if (geo === 'all') {
      const out: Saved[] = [];
      for (const g of c.options) out.push(await saveOne(c.place, g));
      setSaved(prev => [...prev, ...out]);
    } else if (geo !== 'skip') {
      const r = await saveOne(c.place, geo);
      setSaved(prev => [...prev, r]);
    }
    if (rest.length === 0) setDone(true);
  }

  const trip = trips?.find(t => t.id === tripId);

  // ---------- screens ----------

  if (link === undefined) {
    return <Shell><Busy text="Loading…" /></Shell>;
  }
  if (!link) {
    return <Shell><p className="text-sm text-gray-600">No link came through. Share a TikTok, Instagram post or map link to <b>Save to TripPlanner</b>.</p></Shell>;
  }
  if (!access.loaded) {
    return <Shell><Busy text="Checking access…" /></Shell>;
  }
  if (!allowed) {
    return (
      <Shell>
        <p className="text-sm text-gray-700">This browser isn&apos;t signed in to TripPlanner.</p>
        <p className="text-sm text-gray-500">Owner: sign in below. Anyone else: open the edit link you were sent once in Safari, then share again.</p>
        <TripSignIn owner={false} />
        <LinkLine link={link} />
      </Shell>
    );
  }

  return (
    <Shell>
      <LinkLine link={link} />

      {trips && trips.length > 0 && (
        <label className="flex items-center gap-2 text-sm text-gray-600">
          Add to
          <select value={tripId} disabled={!!stage}
            onChange={e => { setTripId(e.target.value); writeLastTrip(e.target.value); }}
            className="min-w-0 flex-1 rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-sm text-gray-900">
            {canAddAnywhere && <option value="">No trip, just save the place</option>}
            {trips.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </label>
      )}

      {stage && <Busy text={stage} />}
      {error && (
        <div className="space-y-2">
          <p className="text-sm text-red-600">{error}</p>
          <button onClick={() => { started.current = true; run(); }} className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-700">Try again</button>
        </div>
      )}

      {choices.map((c, i) => (
        <div key={c.place.name + i} className="space-y-2 rounded-xl border border-sky-200 bg-sky-50 p-3">
          <p className="text-sm font-medium text-sky-900">&quot;{c.place.name}&quot; has a few branches. Which one?</p>
          {c.options.map(o => (
            <button key={o.place_id} onClick={() => pickBranch(i, o)}
              className="block w-full rounded-lg border border-sky-200 bg-white px-3 py-2 text-left text-sm text-gray-800 hover:border-sky-400">
              {o.name}<span className="block text-xs text-gray-500">{o.address}</span>
            </button>
          ))}
          <div className="flex gap-2">
            <button onClick={() => pickBranch(i, 'all')} className="flex-1 rounded-lg bg-sky-500 px-3 py-1.5 text-xs font-medium text-white">Save all {c.options.length}</button>
            <button onClick={() => pickBranch(i, 'skip')} className="flex-1 rounded-lg bg-white px-3 py-1.5 text-xs font-medium text-gray-600">Skip</button>
          </div>
        </div>
      ))}

      {saved.length > 0 && (
        <ul className="space-y-2">
          {saved.map((s, i) => (
            <li key={s.name + i} className="flex items-center gap-3 rounded-xl border border-gray-200 bg-white px-3 py-2.5">
              <span className="text-lg">{isCategory(s.category) ? CATEGORIES[s.category].emoji : '📍'}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-gray-900">{s.name}</span>
                <span className="block truncate text-xs text-gray-500">{s.city}</span>
              </span>
              <span className={`text-xs font-medium ${s.status === 'saved' ? 'text-emerald-600' : s.status === 'already' ? 'text-gray-500' : 'text-red-600'}`}>
                {s.status === 'saved' ? 'Saved' : s.status === 'already' ? 'Already saved' : "Couldn't save"}
              </span>
            </li>
          ))}
        </ul>
      )}

      {done && (
        <div className="space-y-2 pt-1">
          <p className="text-sm text-gray-600">
            {trip ? <>In <b>{trip.name}</b>.</> : 'Saved to your places.'} You can close this tab.
          </p>
          <a href={trip ? `/projects/tripplanner/trip/${trip.id}` : '/projects/tripplanner'}
            className="block rounded-lg bg-sky-500 px-3 py-2 text-center text-sm font-medium text-white">
            {trip ? `Open ${trip.name}` : 'Open TripPlanner'}
          </a>
        </div>
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex h-full justify-center overflow-y-auto bg-gray-50 px-4 py-8">
      <div className="w-full max-w-md space-y-4">
        <h1 className="text-lg font-semibold text-gray-900">Save to TripPlanner</h1>
        {children}
      </div>
    </main>
  );
}

function Busy({ text }: { text: string }) {
  return (
    <p className="flex items-center gap-2 text-sm text-gray-500">
      <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
      </svg>
      {text}
    </p>
  );
}

function LinkLine({ link }: { link: string }) {
  let host = link;
  try { host = new URL(link).hostname.replace(/^www\./, ''); } catch { /* keep raw */ }
  return <p className="truncate text-xs text-gray-400">From {host}</p>;
}

export default function AddPage() {
  return <Suspense fallback={<Shell><Busy text="Loading…" /></Shell>}><AddInner /></Suspense>;
}
