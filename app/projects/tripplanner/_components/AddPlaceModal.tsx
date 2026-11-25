'use client';

// Add places from inside a trip: paste a TikTok / Instagram link, or add one by name.
// New places default to the trip's city and country so they show up in the trip.
import { useEffect, useState } from 'react';
import type { ExtractedPlace } from '@/app/projects/tripplanner/api/extract/route';
import type { PlacesResult } from '@/app/projects/tripplanner/api/places/route';
import { findDuplicate, insertPlaces } from '@/lib/trip/places';
import { CATEGORIES, CATEGORY_KEYS, type Category, type SavedPlace } from '@/app/projects/tripplanner/_components/placeTypes';

interface Props {
  existingPlaces: SavedPlace[];
  defaultCity: string;
  defaultCountry: string;
  onSaved: (saved: SavedPlace[]) => void;
  onImportList: () => void;
  onClose: () => void;
}

type Mode = 'link' | 'manual';

export function AddPlaceModal({ existingPlaces, defaultCity, defaultCountry, onSaved, onImportList, onClose }: Props) {
  const [mode, setMode] = useState<Mode>('link');
  const [known, setKnown] = useState<SavedPlace[]>(existingPlaces);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [url, setUrl] = useState('');
  const [queue, setQueue] = useState<{ place: ExtractedPlace; link: string }[]>([]);

  const [name, setName] = useState('');
  const [city, setCity] = useState(defaultCity);
  const [category, setCategory] = useState<Category>('Restaurant');
  const [branches, setBranches] = useState<PlacesResult[] | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  function remember(saved: SavedPlace[]) {
    if (!saved.length) return;
    setKnown(prev => [...saved, ...prev]);
    onSaved(saved);
  }

  function announce(n: number) {
    setNotice(n === 0 ? 'Already saved, nothing new added.' : `Saved ${n} place${n === 1 ? '' : 's'} to this trip.`);
  }

  async function saveExtracted(place: ExtractedPlace, link: string, geo: PlacesResult | null): Promise<number> {
    const dup = geo
      ? findDuplicate(known, { name: place.name, google_place_id: geo.place_id, lat: geo.lat, lng: geo.lng })
      : known.find(p => p.name.toLowerCase() === place.name.toLowerCase());
    if (dup) return 0;
    try {
      const saved = await insertPlaces([{
        name: place.name,
        city: place.city || geo?.city || defaultCity,
        country: place.country || geo?.country || defaultCountry,
        category: place.category,
        vibe: place.vibe,
        description: place.description || undefined,
        lat: geo?.lat ?? null,
        lng: geo?.lng ?? null,
        address: geo?.address ?? null,
        google_place_id: geo?.place_id ?? null,
        neighbourhood: geo?.neighbourhood ?? null,
        tiktok_url: link,
        source_handle: place.source_handle ?? null,
      }]);
      remember(saved);
      return saved.length;
    } catch (err) {
      setError(`Couldn't save "${place.name}": ${err instanceof Error ? err.message : 'unknown error'}`);
      return 0;
    }
  }

  async function submitLink(e: React.FormEvent) {
    e.preventDefault();
    const link = url.trim();
    if (!link) return;
    setBusy('Starting…'); setError(null); setNotice(null);
    try {
      const res = await fetch('/projects/tripplanner/api/extract', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: link }),
      });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? 'Something went wrong.'); setBusy(null); return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() ?? '';
        for (const part of parts) {
          const ev = part.match(/^event: (\w+)/m)?.[1];
          const raw = part.match(/^data: (.+)/m)?.[1];
          if (!ev || !raw) continue;
          const data = JSON.parse(raw);
          if (ev === 'status') setBusy(data.stage);
          else if (ev === 'error') { setError(data.error ?? 'Something went wrong.'); setBusy(null); return; }
          else if (ev === 'result') {
            const incoming: ExtractedPlace[] = data.places;
            if (!incoming.length) {
              setError("Couldn't find a place in that post. Add it by name instead.");
              setMode('manual'); setBusy(null); return;
            }
            let saved = 0;
            const toPick: { place: ExtractedPlace; link: string }[] = [];
            for (const place of incoming) {
              if (place.geoAll && place.geoAll.length >= 2) toPick.push({ place, link });
              else saved += await saveExtracted(place, link, place.geoAll?.length === 1 ? place.geoAll[0] : (place.geo ?? null));
            }
            setQueue(prev => [...prev, ...toPick]);
            if (!toPick.length) announce(saved);
            setUrl(''); setBusy(null);
          }
        }
      }
    } catch {
      setError('Network error. Check your connection and try again.');
      setBusy(null);
    }
  }

  async function lookupManual() {
    if (!name.trim() || !city.trim()) return;
    setBusy('Finding it on Google…'); setError(null); setNotice(null);
    let results: PlacesResult[] = [];
    try {
      const res = await fetch('/projects/tripplanner/api/places', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), city: city.trim(), country: defaultCountry }),
      });
      if (res.ok) { const data = await res.json(); results = Array.isArray(data) ? data : []; }
    } catch { /* saved without a pin below */ }
    setBusy(null);
    if (results.length > 1) { setBranches(results.slice(0, 5)); return; }
    await saveManual(results[0] ?? null);
  }

  async function saveManual(geo: PlacesResult | null) {
    setBusy('Saving…');
    const dup = geo ? findDuplicate(known, { name: name.trim(), google_place_id: geo.place_id, lat: geo.lat, lng: geo.lng }) : undefined;
    if (dup) { setBusy(null); setBranches(null); announce(0); return; }
    try {
      const saved = await insertPlaces([{
        name: name.trim(),
        city: city.trim(),
        country: geo?.country || defaultCountry,
        category,
        lat: geo?.lat ?? null,
        lng: geo?.lng ?? null,
        address: geo?.address ?? null,
        google_place_id: geo?.place_id ?? null,
        neighbourhood: geo?.neighbourhood ?? null,
      }]);
      remember(saved);
      announce(saved.length);
      if (!geo) setError('Saved, but Google couldn\'t find it, so it has no pin on the map.');
      setName(''); setBranches(null);
    } catch (err) {
      setError(`Couldn't save: ${err instanceof Error ? err.message : 'unknown error'}`);
    }
    setBusy(null);
  }

  const pick = queue[0];

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center sm:p-4" onClick={() => !busy && onClose()}>
      <div className="w-full max-w-md rounded-t-2xl bg-white shadow-xl sm:rounded-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 pt-4">
          <h2 className="text-base font-semibold text-gray-900">Add places</h2>
          <button onClick={onClose} disabled={!!busy} className="text-sm text-gray-400 hover:text-gray-600">Close</button>
        </div>

        <div className="mx-5 mt-3 flex rounded-lg bg-gray-100 p-0.5">
          {([['link', 'TikTok / Instagram'], ['manual', 'By name']] as const).map(([m, label]) => (
            <button key={m} onClick={() => { setMode(m); setError(null); }}
              className={`flex-1 rounded-md py-1.5 text-xs font-medium transition ${mode === m ? 'bg-white text-gray-900 shadow-xs' : 'text-gray-500'}`}>
              {label}
            </button>
          ))}
        </div>

        <div className="space-y-3 px-5 py-4">
          {pick ? (
            <div className="space-y-2 rounded-lg border border-sky-200 bg-sky-50 p-3">
              <p className="text-xs font-medium text-sky-800">Several matches for &quot;{pick.place.name}&quot;. Which one?</p>
              {pick.place.geoAll.slice(0, 3).map((geo, i) => (
                <button key={i} onClick={async () => { announce(await saveExtracted(pick.place, pick.link, geo)); setQueue(q => q.slice(1)); }}
                  className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-left text-sm hover:border-sky-400">
                  <p className="font-medium text-gray-900">{geo.address || pick.place.name}</p>
                  <p className="text-xs text-gray-400">{[geo.name, geo.neighbourhood].filter(Boolean).join(' · ')}</p>
                </button>
              ))}
              <button onClick={() => setQueue(q => q.slice(1))} className="w-full rounded-lg bg-white/60 py-1.5 text-xs text-gray-500">Skip this one</button>
            </div>
          ) : mode === 'link' ? (
            <form onSubmit={submitLink} className="space-y-2">
              <input autoFocus value={url} onChange={e => setUrl(e.target.value)} disabled={!!busy}
                placeholder="Paste a TikTok or Instagram link"
                className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2.5 text-sm outline-hidden focus:border-sky-400 focus:bg-white" />
              <button type="submit" disabled={!url.trim() || !!busy}
                className="w-full rounded-lg bg-sky-500 py-2.5 text-sm font-medium text-white transition hover:bg-sky-600 disabled:opacity-40">
                {busy ?? 'Find places in this post'}
              </button>
            </form>
          ) : branches ? (
            <div className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3">
              <p className="text-xs font-medium text-amber-800">{branches.length} matches for &quot;{name}&quot;. Which one?</p>
              {branches.map((geo, i) => (
                <button key={i} onClick={() => saveManual(geo)} disabled={!!busy}
                  className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-left text-sm hover:border-sky-400">
                  <p className="font-medium text-gray-900">{geo.name}</p>
                  <p className="text-xs text-gray-400">{geo.address}</p>
                </button>
              ))}
              <button onClick={() => setBranches(null)} className="w-full py-1 text-xs text-gray-500">Back</button>
            </div>
          ) : (
            <div className="space-y-2">
              <input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="Place name, e.g. Mak's Noodle"
                className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2.5 text-sm outline-hidden focus:border-sky-400 focus:bg-white" />
              <div className="grid grid-cols-2 gap-2">
                <input value={city} onChange={e => setCity(e.target.value)} placeholder="City"
                  className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2.5 text-sm outline-hidden focus:border-sky-400 focus:bg-white" />
                <select value={category} onChange={e => setCategory(e.target.value as Category)}
                  className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2.5 text-sm outline-hidden focus:border-sky-400">
                  {CATEGORY_KEYS.map(k => <option key={k} value={k}>{CATEGORIES[k].emoji} {CATEGORIES[k].label}</option>)}
                </select>
              </div>
              <button onClick={lookupManual} disabled={!name.trim() || !city.trim() || !!busy}
                className="w-full rounded-lg bg-sky-500 py-2.5 text-sm font-medium text-white transition hover:bg-sky-600 disabled:opacity-40">
                {busy ?? 'Add place'}
              </button>
            </div>
          )}

          {error && <p className="text-xs text-red-500">{error}</p>}
          {notice && <p className="text-xs text-emerald-600">{notice}</p>}

          <button onClick={onImportList} disabled={!!busy} className="w-full pt-1 text-xs font-medium text-sky-600 hover:text-sky-700">
            Or import a whole list from a spreadsheet
          </button>
        </div>
      </div>
    </div>
  );
}
