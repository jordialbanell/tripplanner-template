'use client';

import { useEffect, useMemo, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import dynamic from 'next/dynamic';
import type { ExtractedPlace } from '@/app/projects/tripplanner/api/extract/route';
import { supabase } from '@/lib/trip/supabase';
import { WISHLIST_BOARD_ID, fetchAllPlaces, findDuplicate, insertPlaces, mergePlaces } from '@/lib/trip/places';
import { CATEGORIES, CATEGORY_KEYS, type Category, type SavedPlace } from '@/app/projects/tripplanner/_components/placeTypes';
import { PlaceCard } from '@/app/projects/tripplanner/_components/PlaceCard';
import { InfoModal } from '@/app/projects/tripplanner/_components/InfoModal';
import { ImportModal } from '@/app/projects/tripplanner/_components/ImportModal';
import { useTripAccess } from '@/app/projects/tripplanner/_components/useTripAccess';
import { TripSignIn } from '@/app/projects/tripplanner/_components/TripSignIn';
import { GlobeLoader, useMapShownOnLoad } from '@/app/projects/tripplanner/_components/GlobeLoader';
import { CategoryChips, categoryMatches } from '@/app/projects/tripplanner/_components/CategoryChips';
import type { FocusRequest } from '@/app/projects/tripplanner/_components/PlacesMap';
import type { PlacesResult } from '@/app/projects/tripplanner/api/places/route';

const PlacesMap = dynamic(() => import('@/app/projects/tripplanner/_components/PlacesMap').then(m => m.PlacesMap), { ssr: false });

const MAPBOX_TOKEN = process.env.NEXT_PUBLIC_TRIP_MAPBOX_TOKEN!;

interface Trip {
  id: string;
  name: string;
  start_date: string;
  end_date: string;
  countries: string[];
}

function formatTripDates(start: string, end: string): string {
  const s = new Date(start + 'T00:00:00');
  const e = new Date(end + 'T00:00:00');
  const sameYear = s.getFullYear() === e.getFullYear();
  const sameMonth = sameYear && s.getMonth() === e.getMonth();
  const monthFmt = (d: Date) => d.toLocaleString('en-US', { month: 'short' });
  if (sameMonth) return `${monthFmt(s)} ${s.getDate()}–${e.getDate()}`;
  if (sameYear) return `${monthFmt(s)} ${s.getDate()} – ${monthFmt(e)} ${e.getDate()}`;
  return `${monthFmt(s)} ${s.getDate()}, ${s.getFullYear()} – ${monthFmt(e)} ${e.getDate()}, ${e.getFullYear()}`;
}

export default function Home() {
  const [url, setUrl] = useState('');
  const [loadingStage, setLoadingStage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [places, setPlaces] = useState<SavedPlace[]>([]);
  const [mounted, setMounted] = useState(false);
  const [tripsLoaded, setTripsLoaded] = useState(false);
  const [mapReady, setMapReady] = useState(false);
  const waitForMap = useMapShownOnLoad();
  const [search, setSearch] = useState('');
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [focus, setFocus] = useState<FocusRequest | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);
  const [mobileView, setMobileView] = useState<'list' | 'map'>('list');
  const [activeTab, setActiveTab] = useState<'inspiration' | 'schedule'>('inspiration');
  const [infoPlace, setInfoPlace] = useState<SavedPlace | null>(null);
  const [showManualForm, setShowManualForm] = useState(false);
  const [manualName, setManualName] = useState('');
  const [manualCity, setManualCity] = useState('');
  const [manualCategory, setManualCategory] = useState<Category>('Restaurant');
  const [manualLoading, setManualLoading] = useState(false);
  const [manualGeoResults, setManualGeoResults] = useState<PlacesResult[] | null>(null);
  const [activeCountry, setActiveCountry] = useState<string | null>(null);
  const [placeConfirmQueue, setPlaceConfirmQueue] = useState<{ place: ExtractedPlace; tiktokUrl: string }[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [trips, setTrips] = useState<Trip[]>([]);
  const [tripsCollapsed, setTripsCollapsed] = useState(false);
  const [showNewTripModal, setShowNewTripModal] = useState(false);
  const access = useTripAccess();
  const owner = access.owner;
  const [linkOff, setLinkOff] = useState(false);
  const [demoState, setDemoState] = useState<{ busy: boolean; msg: string | null; missed: string[] }>({ busy: false, msg: null, missed: [] });
  async function setUpDemo() {
    setDemoState({ busy: true, msg: 'Pinning 25 Barcelona places…', missed: [] });
    try {
      const res = await fetch('/projects/tripplanner/api/demo', { method: 'POST' });
      const d = await res.json();
      if (!res.ok) { setDemoState({ busy: false, msg: d.error || 'Setup failed', missed: [] }); return; }
      const missed = (d.report || []).filter((r: { matched: string | null }) => !r.matched).map((r: { query: string }) => r.query);
      setDemoState({ busy: false, msg: d.already ? 'The demo trip already exists.' : 'Demo trip ready. Check each pin, then reload.', missed });
    } catch {
      setDemoState({ busy: false, msg: 'Setup failed', missed: [] });
    }
  }
  useEffect(() => { setLinkOff(new URLSearchParams(window.location.search).get('link') === 'off'); }, []);
  const [tripName, setTripName] = useState('');
  const [tripStartDate, setTripStartDate] = useState('');
  const [tripEndDate, setTripEndDate] = useState('');
  const [legCountry, setLegCountry] = useState('');
  const [legCity, setLegCity] = useState('');
  const [legStartDate, setLegStartDate] = useState('');
  const [legEndDate, setLegEndDate] = useState('');
  const [legHotel, setLegHotel] = useState('');
  const [creatingTrip, setCreatingTrip] = useState(false);
  const [createTripError, setCreateTripError] = useState<string | null>(null);
  const router = useRouter();

  const fetchTrips = useCallback(async () => {
    const { data: tripsData } = await supabase
      .from('trips')
      .select('id, name, start_date, end_date, trip_legs(country, leg_order)')
      .order('start_date', { ascending: true });
    if (tripsData) {
      setTrips(tripsData.map((t: any) => {
        const legs = (t.trip_legs || []).slice().sort((a: any, b: any) => a.leg_order - b.leg_order);
        const countries: string[] = [];
        for (const leg of legs) {
          if (leg.country && !countries.includes(leg.country)) countries.push(leg.country);
        }
        return { id: t.id, name: t.name, start_date: t.start_date, end_date: t.end_date, countries };
      }));
    }
    setTripsLoaded(true);
  }, []);

  useEffect(() => {
    async function loadPlaces() {
      try {
        setPlaces(await fetchAllPlaces());
      } catch (err) {
        setError(`Couldn't load places: ${err instanceof Error ? err.message : 'unknown error'}`);
      }
      setMounted(true);
    }
    loadPlaces();
    fetchTrips();
  }, [fetchTrips]);

  const existingCountries = useMemo(() => {
    return Array.from(new Set(places.map(p => p.country).filter(Boolean))).sort();
  }, [places]);

  const existingCitiesForCountry = useMemo(() => {
    if (!legCountry) return [];
    return Array.from(new Set(
      places.filter(p => p.country === legCountry).map(p => p.city).filter(Boolean)
    )).sort();
  }, [places, legCountry]);

  useEffect(() => {
    if (tripStartDate && !legStartDate) setLegStartDate(tripStartDate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tripStartDate]);

  useEffect(() => {
    if (tripEndDate && !legEndDate) setLegEndDate(tripEndDate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tripEndDate]);

  const closeNewTripModal = () => {
    if (creatingTrip) return;
    setShowNewTripModal(false);
    setTripName('');
    setTripStartDate('');
    setTripEndDate('');
    setLegCountry('');
    setLegCity('');
    setLegStartDate('');
    setLegEndDate('');
    setLegHotel('');
    setCreateTripError(null);
  };

  useEffect(() => {
    if (!showNewTripModal) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') closeNewTripModal(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showNewTripModal]);

  const handleCreateTrip = async () => {
    setCreatingTrip(true);
    setCreateTripError(null);

    try {
      const { data: newTrip, error: tripError } = await supabase
        .from('trips')
        .insert({
          board_id: WISHLIST_BOARD_ID,
          name: tripName.trim(),
          start_date: tripStartDate,
          end_date: tripEndDate,
        })
        .select('id')
        .single();

      if (tripError || !newTrip) {
        throw new Error(tripError?.message || 'Failed to create trip');
      }

      const { error: legError } = await supabase
        .from('trip_legs')
        .insert({
          trip_id: newTrip.id,
          city: legCity.trim(),
          country: legCountry.trim(),
          start_date: legStartDate,
          end_date: legEndDate,
          leg_order: 0,
          hotel: legHotel.trim() || null,
        });

      if (legError) {
        throw new Error(legError.message || 'Failed to create first leg');
      }

      await fetchTrips();

      setCreatingTrip(false);
      closeNewTripModal();

      router.push(`/projects/tripplanner/trip/${newTrip.id}`);
      return;
    } catch (err: any) {
      console.error('[create trip]', err);
      setCreateTripError(err?.message || 'Something went wrong. Try again.');
    } finally {
      setCreatingTrip(false);
    }
  };

  async function handleDelete(id: string) {
    const { error: delError } = await supabase.from('places').delete().eq('id', id);
    if (delError) { setError(`Couldn't delete: ${delError.message}`); return; }
    setPlaces(prev => prev.filter(p => p.id !== id));
    if (selectedId === id) setSelectedId(null);
  }

  function handleUpdate(updated: SavedPlace) {
    setPlaces(prev => prev.map(p => p.id === updated.id ? updated : p));
  }

  const handleHover = useCallback((id: string | null) => setHoveredId(id), []);

  useEffect(() => {
    async function handleFlyToCity(e: Event) {
      const city = (e as CustomEvent<{ city: string }>).detail?.city;
      if (!city) return;
      try {
        const res = await fetch(`https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(city)}.json?types=place&limit=1&access_token=${MAPBOX_TOKEN}`);
        const data = await res.json();
        const feature = data?.features?.[0];
        if (feature?.center) {
          setFocus({ lng: feature.center[0], lat: feature.center[1], zoom: 11, nonce: Date.now() });
        }
      } catch { /* ignore */ }
    }
    window.addEventListener('flyToCity', handleFlyToCity);
    return () => window.removeEventListener('flyToCity', handleFlyToCity);
  }, []);

  function handleCardClick(place: SavedPlace) {
    setSelectedId(place.id);
    if (place.geo) {
      setFocus({ lat: place.geo.lat, lng: place.geo.lng, nonce: Date.now() });
      setMobileView('map');
    } else {
      setInfoPlace(place);
    }
  }

  const uniqueCountries = Array.from(new Set(places.map(p => p.country).filter(Boolean))).sort();

  function handleCountryClick(country: string) {
    setActiveCountry(activeCountry === country ? null : country);
  }

  function notifySaved(n: number) {
    setSaveNotice(n === 0 ? 'Already saved, nothing new added.' : `Saved ${n} place${n === 1 ? '' : 's'}.`);
    setTimeout(() => setSaveNotice(null), 3500);
  }

  async function savePlaceWithGeo(place: ExtractedPlace, tiktokUrl: string, geo: PlacesResult | null): Promise<number> {
    const duplicate = geo
      ? findDuplicate(places, { name: place.name, google_place_id: geo.place_id, lat: geo.lat, lng: geo.lng })
      : places.find(p => p.name.toLowerCase() === place.name.toLowerCase() && p.city.toLowerCase() === place.city.toLowerCase());
    if (duplicate) return 0;

    try {
      const saved = await insertPlaces([{
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
        tiktok_url: tiktokUrl,
        source_handle: place.source_handle ?? null,
      }]);
      setPlaces(prev => [...saved, ...prev]);
      return saved.length;
    } catch (err) {
      setError(`Couldn't save "${place.name}": ${err instanceof Error ? err.message : 'unknown error'}`);
      return 0;
    }
  }

  async function handleManualAdd() {
    if (!manualName.trim() || !manualCity.trim()) return;
    setManualLoading(true);

    let geoResults: PlacesResult[] = [];
    try {
      const res = await fetch('/projects/tripplanner/api/places', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: manualName.trim(), city: manualCity.trim(), country: '' }),
      });
      if (res.ok) {
        const data = await res.json();
        geoResults = Array.isArray(data) ? data : [];
      }
    } catch { /* saves without a pin below */ }

    if (geoResults.length > 1) {
      setManualLoading(false);
      setManualGeoResults(geoResults);
      return;
    }
    await saveManualPlaces(geoResults);
  }

  async function saveManualPlaces(geoResults: PlacesResult[]) {
    setManualLoading(true);
    const targets: (PlacesResult | null)[] = geoResults.length > 0 ? geoResults : [null];
    try {
      const saved = await insertPlaces(targets.map(geo => ({
        name: manualName.trim(),
        city: manualCity.trim(),
        // Country used to be saved empty here, which hid manual places from every trip.
        country: geo?.country || '',
        category: manualCategory,
        lat: geo?.lat ?? null,
        lng: geo?.lng ?? null,
        address: geo?.address ?? null,
        google_place_id: geo?.place_id ?? null,
        neighbourhood: geo?.neighbourhood ?? null,
      })));
      setPlaces(prev => [...saved, ...prev]);
      notifySaved(saved.length);
      setManualName('');
      setManualCity('');
      setManualCategory('Restaurant');
      setShowManualForm(false);
      setManualGeoResults(null);
    } catch (err) {
      setError(`Couldn't save: ${err instanceof Error ? err.message : 'unknown error'}`);
    }
    setManualLoading(false);
  }

  const countryPlaces = places.filter(p => activeCountry === null || p.country === activeCountry);
  const filteredPlaces = countryPlaces.filter(p => {
    const q = search.trim().toLowerCase();
    const matchSearch = q === '' ||
      [p.name, p.city, p.vibe, p.neighbourhood, ...(p.tags || [])].some(v => v?.toLowerCase().includes(q));
    return matchSearch && categoryMatches(p, activeCategory);
  });

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!url.trim()) return;
    setLoadingStage('Starting...');
    setError(null);

    try {
      const res = await fetch('/projects/tripplanner/api/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim() }),
      });

      if (!res.ok || !res.body) {
        const data = await res.json();
        setError(data.error ?? 'Something went wrong.');
        setLoadingStage(null);
        return;
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
          const eventMatch = part.match(/^event: (\w+)/m);
          const dataMatch = part.match(/^data: (.+)/m);
          if (!eventMatch || !dataMatch) continue;
          const event = eventMatch[1];
          const data = JSON.parse(dataMatch[1]);

          if (event === 'status') {
            setLoadingStage(data.stage);
          } else if (event === 'error') {
            setError(data.error ?? 'Something went wrong.');
            setLoadingStage(null);
            return;
          } else if (event === 'result') {
            const incoming: ExtractedPlace[] = data.places;
            if (incoming.length === 0) {
              setError("Couldn't extract places automatically. Try adding them manually below ↓");
              setLoadingStage(null);
              setShowManualForm(true);
              return;
            }

            const tiktokUrl = url.trim();
            let savedCount = 0;
            let queued = 0;
            for (const place of incoming) {
              if (place.geoAll && place.geoAll.length >= 2) {
                setPlaceConfirmQueue(prev => [...prev, { place, tiktokUrl }]);
                queued++;
              } else {
                const geo = place.geoAll?.length === 1 ? place.geoAll[0] : (place.geo ?? null);
                savedCount += await savePlaceWithGeo(place, tiktokUrl, geo);
              }
            }
            if (queued === 0) notifySaved(savedCount);
            setUrl('');
            setLoadingStage(null);
          }
        }
      }
    } catch {
      setError('Network error. Check your connection and try again.');
      setLoadingStage(null);
    }
  }

  const loading = loadingStage !== null;

  return (
    <div className="relative flex h-full flex-col bg-white">
      <GlobeLoader show={!(access.loaded && tripsLoaded && mounted && (mapReady || !waitForMap))} />
      {infoPlace && <InfoModal place={infoPlace} readOnly={!owner} onClose={() => setInfoPlace(null)} onUpdate={handleUpdate} />}
      {showImport && (
        <ImportModal
          onClose={() => setShowImport(false)}
          onImported={saved => setPlaces(prev => mergePlaces(prev, saved))}
          existingPlaces={places}
          countrySuggestions={existingCountries}
        />
      )}

      <header className="border-b border-gray-100 px-6 py-4 shrink-0">
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight text-gray-900">TripPlanner</h1>
          {access.loaded && <TripSignIn owner={owner} />}
        </div>
        {linkOff && (
          <p className="mt-2 text-xs text-amber-600">That share link has been switched off or has ended. Ask for a new one.</p>
        )}
        {access.loaded && !owner && (
          <p className="mt-1 text-xs text-gray-500">A look around with a sample Barcelona trip. Open it to see the map, the day plan and travel times.</p>
        )}
      </header>

      <div className="flex md:hidden border-b border-gray-100 shrink-0">
        <button onClick={() => setMobileView('list')} className={`flex-1 py-2.5 text-sm font-medium transition ${mobileView === 'list' ? 'text-sky-600 border-b-2 border-sky-500' : 'text-gray-400'}`}>List</button>
        <button onClick={() => setMobileView('map')} className={`flex-1 py-2.5 text-sm font-medium transition ${mobileView === 'map' ? 'text-sky-600 border-b-2 border-sky-500' : 'text-gray-400'}`}>Map</button>
      </div>

      <div className="flex flex-1 overflow-hidden">
        <div className={`trip-pane w-full md:w-[420px] md:flex flex-col border-r border-gray-100 overflow-y-auto ${mobileView === 'list' ? 'flex' : 'hidden'}`}>
          {/* Trips and their schedules live in each trip's own page now. */}
          {(
          <>
          <div className="p-4 border-b border-gray-100">
            <button
              onClick={() => setTripsCollapsed(v => !v)}
              className="flex items-center justify-between w-full text-left mb-3"
            >
              <span className="text-xs font-semibold text-gray-500">
                Trips {trips.length > 0 && `(${trips.length})`}
              </span>
              <svg
                className={`w-4 h-4 text-gray-400 transition-transform ${tripsCollapsed ? '-rotate-90' : ''}`}
                fill="none" stroke="currentColor" viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>

            {!tripsCollapsed && (
              <div className="space-y-2">
                {owner && <button
                  onClick={() => setShowNewTripModal(true)}
                  className="w-full rounded-xl border-2 border-dashed border-gray-300 bg-white px-4 py-3 text-sm font-medium text-gray-500 hover:border-sky-400 hover:bg-sky-50 hover:text-sky-600 transition text-left"
                >
                  + New Trip
                </button>}
                {owner && access.demo.length === 0 && (
                  <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800">
                    <p>Visitors see a sample trip. None exists yet.</p>
                    <button onClick={setUpDemo} disabled={demoState.busy} className="mt-2 rounded-lg bg-amber-500 px-3 py-1.5 font-medium text-white hover:bg-amber-600 disabled:opacity-50">
                      {demoState.busy ? 'Setting up…' : 'Set up the Barcelona demo'}
                    </button>
                    {demoState.msg && <p className="mt-2">{demoState.msg}</p>}
                    {demoState.missed.length > 0 && <p className="mt-1">Not found on Google: {demoState.missed.join(', ')}</p>}
                  </div>
                )}

                {trips.map(trip => (
                  <button
                    key={trip.id}
                    onClick={() => router.push(`/projects/tripplanner/trip/${trip.id}`)}
                    className="w-full rounded-xl border border-gray-200 bg-white px-4 py-3 text-left hover:border-sky-400 hover:shadow-xs transition"
                  >
                    <p className="text-sm font-semibold text-gray-900">{trip.name}</p>
                    <p className="text-xs text-gray-500 mt-0.5">
                      {formatTripDates(trip.start_date, trip.end_date)} · {trip.countries.join(', ') || 'No legs yet'}
                    </p>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="p-4 space-y-3">
            {owner && (<>
            <form onSubmit={handleSubmit} className="flex gap-2">
              <input type="text" value={url} onChange={(e) => setUrl(e.target.value)} disabled={loading} placeholder="Paste a TikTok or Instagram link" className="flex-1 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 outline-hidden transition focus:border-sky-400 focus:bg-white focus:ring-2 focus:ring-sky-100 disabled:opacity-50" />
              <button type="submit" disabled={!url.trim() || loading} className="min-w-[120px] rounded-lg bg-sky-500 px-3 py-2 text-sm font-medium text-white transition hover:bg-sky-600 disabled:cursor-not-allowed disabled:opacity-40">
                {loading ? (
                  <span className="flex items-center justify-center gap-1.5">
                    <svg className="h-3.5 w-3.5 animate-spin shrink-0" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                    </svg>
                    <span className="truncate text-xs">{loadingStage}</span>
                  </span>
                ) : 'Save'}
              </button>
            </form>

            {error && <p className="text-sm text-red-500">{error}</p>}
            {saveNotice && <p className="text-sm text-green-600">{saveNotice}</p>}

            <div>
              <div className="flex items-center gap-4">
                <button onClick={() => { setShowManualForm(v => !v); setError(null); }} className="text-xs text-sky-500 hover:text-sky-700 font-medium transition">
                  {showManualForm ? '✕ Cancel' : '+ Add place manually'}
                </button>
                <button onClick={() => setShowImport(true)} className="text-xs text-sky-500 hover:text-sky-700 font-medium transition">
                  + Import a list
                </button>
              </div>
              {showManualForm && (
                <div className="mt-2 rounded-xl border border-sky-100 bg-sky-50 p-3 space-y-2">
                  <input type="text" value={manualName} onChange={(e) => setManualName(e.target.value)} placeholder="Place name (e.g. Apartment Coffee)" className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 placeholder-gray-400 outline-hidden focus:border-sky-400 focus:ring-2 focus:ring-sky-100" />
                  <input type="text" value={manualCity} onChange={(e) => setManualCity(e.target.value)} placeholder="City (e.g. Singapore)" className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 placeholder-gray-400 outline-hidden focus:border-sky-400 focus:ring-2 focus:ring-sky-100" />
                  <select value={manualCategory} onChange={(e) => setManualCategory(e.target.value as Category)} className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 outline-hidden focus:border-sky-400 focus:ring-2 focus:ring-sky-100">
                    {CATEGORY_KEYS.map(k => <option key={k} value={k}>{CATEGORIES[k].emoji} {CATEGORIES[k].label}</option>)}
                  </select>
                  <button onClick={handleManualAdd} disabled={!manualName.trim() || !manualCity.trim() || manualLoading} className="w-full rounded-lg bg-sky-500 px-3 py-2 text-sm font-medium text-white transition hover:bg-sky-600 disabled:opacity-40 disabled:cursor-not-allowed">
                    {manualLoading ? 'Adding...' : 'Add place'}
                  </button>
                  {manualGeoResults && (
                    <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 space-y-2">
                      <p className="text-xs text-amber-800 font-medium">Found {manualGeoResults.length} locations for "{manualName}" in {manualCity}. Add all branches?</p>
                      <div className="flex gap-2">
                        <button onClick={() => saveManualPlaces(manualGeoResults)} className="flex-1 rounded-lg bg-sky-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-600 transition">Yes, add all {manualGeoResults.length}</button>
                        <button onClick={() => saveManualPlaces([manualGeoResults[0]])} className="flex-1 rounded-lg bg-gray-100 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-200 transition">No, just the first</button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            </>)}

            <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search places" className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 outline-hidden transition focus:border-sky-400 focus:bg-white focus:ring-2 focus:ring-sky-100" />

            <CategoryChips places={countryPlaces} active={activeCategory} onChange={setActiveCategory} />

            {mounted && uniqueCountries.length > 1 && (
              <div className="flex gap-2 flex-wrap">
                {uniqueCountries.map(country => (
                  <button key={country} onClick={() => handleCountryClick(country)} className={`rounded-full px-3 py-1 text-xs font-medium transition ${activeCountry === country ? 'bg-sky-500 text-white' : 'bg-sky-50 text-sky-600 hover:bg-sky-100'}`}>{country}</button>
                ))}
              </div>
            )}

            {placeConfirmQueue.length > 0 && (() => {
              const item = placeConfirmQueue[0];
              const topResults = item.place.geoAll.slice(0, 3);
              return (
                <div className="rounded-lg bg-sky-50 border border-sky-200 p-3 space-y-2">
                  <p className="text-xs text-sky-800 font-medium">Multiple results for &quot;{item.place.name}&quot; — pick the right one:</p>
                  <div className="space-y-1.5">
                    {topResults.map((geo, i) => (
                      <button
                        key={i}
                        onClick={async () => {
                          notifySaved(await savePlaceWithGeo(item.place, item.tiktokUrl, geo));
                          setPlaceConfirmQueue(prev => prev.slice(1));
                        }}
                        className="w-full text-left rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm hover:border-sky-400 hover:bg-sky-50 transition"
                      >
                        <p className="font-medium text-gray-900">{geo.address || item.place.name}</p>
                        <p className="text-xs text-gray-400">{[geo.name, geo.neighbourhood].filter(Boolean).join(' · ')}</p>
                      </button>
                    ))}
                  </div>
                  <button
                    onClick={() => setPlaceConfirmQueue(prev => prev.slice(1))}
                    className="w-full rounded-lg bg-gray-100 px-3 py-1.5 text-xs font-medium text-gray-500 hover:bg-gray-200 transition"
                  >
                    Skip this place
                  </button>
                </div>
              );
            })()}
          </div>

          <div className="px-4 pb-4 space-y-3">
            {!mounted || filteredPlaces.length === 0 ? (
              <div className="rounded-xl border border-dashed border-gray-200 bg-gray-50 px-6 py-16 text-center">
                <p className="text-sm text-gray-400">{places.length === 0 ? 'Your saved places will appear here' : 'No places match your search'}</p>
              </div>
            ) : (
              filteredPlaces.map(place => (
                <PlaceCard key={place.id} place={place} onDelete={owner ? handleDelete : undefined} onHover={handleHover} isHighlighted={hoveredId === place.id} isSelected={selectedId === place.id} onInfo={setInfoPlace} onClick={handleCardClick} />
              ))
            )}
          </div>
          </>
          )}
        </div>

        <div className={`flex-1 ${mobileView === 'map' ? 'flex' : 'hidden'} md:flex`}>
          {mounted && (
            <PlacesMap
              onReady={() => setMapReady(true)}
              places={filteredPlaces}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onInfo={setInfoPlace}
              fitKey={`${activeCountry}|${activeCategory}`}
              focus={focus}
              showGeocoder
            />
          )}
        </div>
      </div>

      {showNewTripModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={closeNewTripModal}
        >
          <div
            className="w-full max-w-md rounded-2xl bg-white shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4">
              <h2 className="text-base font-semibold text-gray-900">New Trip</h2>
              <button
                onClick={closeNewTripModal}
                className="rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition"
              >
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="space-y-4 px-5 py-5">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Trip name</label>
                <input
                  type="text"
                  value={tripName}
                  onChange={(e) => setTripName(e.target.value)}
                  placeholder="e.g. Vietnam, Korea trip"
                  className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 outline-hidden focus:border-sky-400 focus:bg-white focus:ring-2 focus:ring-sky-100"
                  autoFocus
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Start date</label>
                  <input
                    type="date"
                    value={tripStartDate}
                    onChange={(e) => setTripStartDate(e.target.value)}
                    className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-900 outline-hidden focus:border-sky-400 focus:bg-white focus:ring-2 focus:ring-sky-100"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">End date</label>
                  <input
                    type="date"
                    value={tripEndDate}
                    onChange={(e) => setTripEndDate(e.target.value)}
                    className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-900 outline-hidden focus:border-sky-400 focus:bg-white focus:ring-2 focus:ring-sky-100"
                  />
                </div>
              </div>

              <div className="flex items-center gap-3 pt-2">
                <span className="text-xs font-semibold text-gray-400">First leg</span>
                <div className="h-px flex-1 bg-gray-100" />
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Country</label>
                <input
                  type="text"
                  value={legCountry}
                  onChange={(e) => setLegCountry(e.target.value)}
                  placeholder="e.g. Vietnam"
                  list="country-suggestions"
                  className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 outline-hidden focus:border-sky-400 focus:bg-white focus:ring-2 focus:ring-sky-100"
                />
                <datalist id="country-suggestions">
                  {existingCountries.map(c => <option key={c} value={c} />)}
                </datalist>
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">City</label>
                <input
                  type="text"
                  value={legCity}
                  onChange={(e) => setLegCity(e.target.value)}
                  placeholder={legCountry ? `e.g. cities in ${legCountry}` : 'e.g. Hanoi'}
                  list="city-suggestions"
                  className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 outline-hidden focus:border-sky-400 focus:bg-white focus:ring-2 focus:ring-sky-100"
                />
                <datalist id="city-suggestions">
                  {existingCitiesForCountry.map(c => <option key={c} value={c} />)}
                </datalist>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Leg start</label>
                  <input
                    type="date"
                    value={legStartDate}
                    onChange={(e) => setLegStartDate(e.target.value)}
                    className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-900 outline-hidden focus:border-sky-400 focus:bg-white focus:ring-2 focus:ring-sky-100"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Leg end</label>
                  <input
                    type="date"
                    value={legEndDate}
                    onChange={(e) => setLegEndDate(e.target.value)}
                    className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-900 outline-hidden focus:border-sky-400 focus:bg-white focus:ring-2 focus:ring-sky-100"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Hotel (optional)</label>
                <input
                  type="text"
                  value={legHotel}
                  onChange={(e) => setLegHotel(e.target.value)}
                  placeholder="e.g. LaHomestay Hàng Đậu"
                  className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 outline-hidden focus:border-sky-400 focus:bg-white focus:ring-2 focus:ring-sky-100"
                />
              </div>
            </div>

            <div className="border-t border-gray-100 px-5 py-3 space-y-2">
              {createTripError && (
                <p className="text-xs text-red-500">{createTripError}</p>
              )}
              <div className="flex justify-end gap-2">
                <button
                  onClick={closeNewTripModal}
                  disabled={creatingTrip}
                  className="rounded-lg px-3 py-1.5 text-sm font-medium text-gray-500 hover:bg-gray-100 transition disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Cancel
                </button>
                <button
                  onClick={handleCreateTrip}
                  disabled={creatingTrip || !tripName.trim() || !tripStartDate || !tripEndDate || !legCountry.trim() || !legCity.trim() || !legStartDate || !legEndDate}
                  className="min-w-[100px] rounded-lg bg-sky-500 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-sky-600 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {creatingTrip ? (
                    <span className="flex items-center justify-center gap-1.5">
                      <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                      </svg>
                      <span>Creating...</span>
                    </span>
                  ) : 'Create'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
