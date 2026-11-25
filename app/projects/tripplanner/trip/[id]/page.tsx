'use client';

import { CalendarDays, Droplets } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import dynamic from 'next/dynamic';
import { supabase } from '@/lib/trip/supabase';
import { fetchAllPlaces, fillDescriptions, mergePlaces } from '@/lib/trip/places';
import { autoPlacePhotos } from '@/lib/trip/photos';
import { toGcj02 } from '@/lib/trip/chinaCoords';
import { PlaceCard } from '@/app/projects/tripplanner/_components/PlaceCard';
import { CalendarModal } from '@/app/projects/tripplanner/_components/CalendarModal';
import { InfoModal } from '@/app/projects/tripplanner/_components/InfoModal';
import { ImportModal } from '@/app/projects/tripplanner/_components/ImportModal';
import { DuplicatesModal } from '@/app/projects/tripplanner/_components/DuplicatesModal';
import { openDuplicateGroups } from '@/lib/trip/duplicates';
import { DayPlanner } from '@/app/projects/tripplanner/_components/DayPlanner';
import { TripEditModal } from '@/app/projects/tripplanner/_components/TripEditModal';
import { AddPlaceModal } from '@/app/projects/tripplanner/_components/AddPlaceModal';
import { ShareModal } from '@/app/projects/tripplanner/_components/ShareModal';
import { GlobeLoader, useMapShownOnLoad } from '@/app/projects/tripplanner/_components/GlobeLoader';
import { useTripAccess, canEditTrip } from '@/app/projects/tripplanner/_components/useTripAccess';
import { CategoryChips, categoryMatches } from '@/app/projects/tripplanner/_components/CategoryChips';
import { CATEGORY_KEYS, getCategory, sameText, type SavedPlace } from '@/app/projects/tripplanner/_components/placeTypes';
import { dayLabel, tripDates } from '@/lib/trip/dayPlan';
import { fetchWeather, weatherLook, type WeatherDay } from '@/lib/trip/weather';
import { useMyLocation, metresBetween, fmtDistance } from '@/app/projects/tripplanner/_components/useMyLocation';
import type { FocusRequest, RoutePoint } from '@/app/projects/tripplanner/_components/PlacesMap';

// Mapbox touches `window`, so load the map on the client only.
const PlacesMap = dynamic(() => import('@/app/projects/tripplanner/_components/PlacesMap').then(m => m.PlacesMap), { ssr: false });

interface TripLeg {
  id: string;
  city: string;
  country: string;
  start_date: string;
  end_date: string;
  leg_order: number;
  hotel: string | null;
  hotel_lat: number | null;
  hotel_lng: number | null;
}

interface Trip {
  id: string;
  name: string;
  start_date: string;
  end_date: string;
  legs: TripLeg[];
}

function formatTripDates(start: string, end: string): string {
  if (!start || !end) return '';
  const s = new Date(start + 'T00:00:00');
  const e = new Date(end + 'T00:00:00');
  const sameYear = s.getFullYear() === e.getFullYear();
  const sameMonth = sameYear && s.getMonth() === e.getMonth();
  const m = (d: Date) => d.toLocaleString('en-US', { month: 'short' });
  if (sameMonth) return `${m(s)} ${s.getDate()}–${e.getDate()}`;
  if (sameYear) return `${m(s)} ${s.getDate()} – ${m(e)} ${e.getDate()}`;
  return `${m(s)} ${s.getDate()}, ${s.getFullYear()} – ${m(e)} ${e.getDate()}, ${e.getFullYear()}`;
}

const categoryRank = (c: string) => {
  const i = (CATEGORY_KEYS as readonly string[]).indexOf(c);
  return i === -1 ? 99 : i;
};

export default function TripPage() {
  const params = useParams();
  const router = useRouter();
  const tripId = params?.id as string;

  const [trip, setTrip] = useState<Trip | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  const [places, setPlaces] = useState<SavedPlace[]>([]);
  const [loadingPlaces, setLoadingPlaces] = useState(true);
  const [mapReady, setMapReady] = useState(false);
  const waitForMap = useMapShownOnLoad();
  const [placesError, setPlacesError] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [activeArea, setActiveArea] = useState<string | null>(null);
  const [mustGoOnly, setMustGoOnly] = useState(false);
  const [showAllAreas, setShowAllAreas] = useState(false);
  const [nearestFirst, setNearestFirst] = useState(false);
  const [newestFirst, setNewestFirst] = useState(false);
  const myLoc = useMyLocation();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [infoPlace, setInfoPlace] = useState<SavedPlace | null>(null);
  const [focus, setFocus] = useState<FocusRequest | null>(null);
  const [mobileView, setMobileView] = useState<'list' | 'map'>('list');
  const [panel, setPanelState] = useState<'places' | 'schedule'>('places');
  useEffect(() => {
    const read = () => setPanelState(window.location.hash === '#schedule' ? 'schedule' : 'places');
    read();
    window.addEventListener('hashchange', read);
    return () => window.removeEventListener('hashchange', read);
  }, []);
  function setPanel(next: 'places' | 'schedule') {
    setPanelState(next);
    history.replaceState(null, '', next === 'schedule' ? '#schedule' : window.location.pathname);
  }
  const [showImport, setShowImport] = useState(false);
  const [showDupes, setShowDupes] = useState(false);
  const [describing, setDescribing] = useState<{ done: number; total: number } | null>(null);
  const [describeTried, setDescribeTried] = useState(false);
  const cardRefs = useRef(new Map<string, HTMLDivElement>());

  const [reloadKey, setReloadKey] = useState(0);
  const [dayRoute, setDayRoute] = useState<RoutePoint[]>([]);
  const [planned, setPlanned] = useState<{ byPlace: Record<string, string[]>; activeDate: string }>({ byPlace: {}, activeDate: '' });
  const [showEdit, setShowEdit] = useState(false);
  const [showShare, setShowShare] = useState(false);
  const [showCalendar, setShowCalendar] = useState(false);
  const access = useTripAccess();
  const editable = canEditTrip(access, tripId);
  const [showAdd, setShowAdd] = useState(false);
  const [planDay, setPlanDay] = useState('');
  const [addRequest, setAddRequest] = useState<{ place: SavedPlace; nonce: number; date?: string } | null>(null);
  const [goToDate, setGoToDate] = useState<{ date: string; nonce: number } | null>(null);
  const [quietPin, setQuietPin] = useState(false); // a search result: show the pin, no popup card
  const [toast, setToast] = useState<string | null>(null);
  const [weather, setWeather] = useState<Record<string, WeatherDay>>({});
  const dimmed = useMemo(() => {
    const out = new globalThis.Map<string, string>();
    for (const [id, ds] of Object.entries(planned.byPlace)) {
      if (panel === 'schedule' && ds.includes(planned.activeDate)) continue;
      out.set(id, ds.map(d => { const l = dayLabel(d); return `${l.weekday} ${l.day}`; }).join(', '));
    }
    return out;
  }, [planned, panel]);
  function flash(msg: string) { setToast(msg); setTimeout(() => setToast(null), 2200); }

  // Weather for each trip day, taken at the hotel of the leg that covers it.
  const weatherSpots = useMemo(() => {
    if (!trip) return [] as { lat: number; lng: number; dates: string[] }[];
    const anyPin = places.find(p => p.geo?.lat != null && p.geo?.lng != null && trip.legs.some(l => sameText(l.country, p.country ?? '')));
    const bySpot = new globalThis.Map<string, { lat: number; lng: number; dates: string[] }>();
    for (const date of tripDates(trip.start_date, trip.end_date)) {
      const leg = trip.legs.find(l => l.start_date && l.end_date && l.start_date <= date && date <= l.end_date) ?? trip.legs[0];
      const lat = leg?.hotel_lat ?? anyPin?.geo?.lat;
      const lng = leg?.hotel_lng ?? anyPin?.geo?.lng;
      if (lat == null || lng == null) continue;
      const key = `${lat.toFixed(2)},${lng.toFixed(2)}`;
      if (!bySpot.has(key)) bySpot.set(key, { lat, lng, dates: [] });
      bySpot.get(key)!.dates.push(date);
    }
    return Array.from(bySpot.values());
  }, [trip, places]);
  const weatherKey = weatherSpots.map(s => `${s.lat.toFixed(2)},${s.lng.toFixed(2)}:${s.dates.join(',')}`).join('|');
  useEffect(() => {
    if (!weatherSpots.length) return;
    let cancelled = false;
    Promise.all(weatherSpots.map(async s => {
      const days = await fetchWeather(s.lat, s.lng);
      return days.filter(d => s.dates.includes(d.date));
    })).then(lists => {
      if (cancelled) return;
      const out: Record<string, WeatherDay> = {};
      for (const d of lists.flat()) out[d.date] = d;
      setWeather(out);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weatherKey]);

  // Owner only (the server refuses everyone else). Deleting a place removes it everywhere, not just this trip.
  async function handleDeletePlace(id: string) {
    const { error } = await supabase.from('places').delete().eq('id', id);
    if (error) { flash(`Couldn't delete: ${error.message}`); return; }
    setPlaces(prev => prev.filter(p => p.id !== id));
    if (selectedId === id) setSelectedId(null);
    if (infoPlace?.id === id) setInfoPlace(null);
    flash('Place deleted');
  }

  useEffect(() => {
    if (!tripId) return;
    (async () => {
      if (reloadKey === 0) setLoading(true);
      const { data, error } = await supabase
        .from('trips')
        .select('id, name, start_date, end_date, trip_legs(id, city, country, start_date, end_date, leg_order, hotel, hotel_lat, hotel_lng)')
        .eq('id', tripId)
        .single();
      if (error || !data) {
        console.error('[trip fetch]', error);
        setNotFound(true);
        setLoading(false);
        return;
      }
      const legs = (data.trip_legs || []).slice().sort((a: TripLeg, b: TripLeg) => a.leg_order - b.leg_order);
      setTrip({ id: data.id, name: data.name, start_date: data.start_date, end_date: data.end_date, legs });
      setLoading(false);
    })();
  }, [tripId, reloadKey]);

  const loadPlaces = useCallback(async () => {
    setLoadingPlaces(true);
    try {
      setPlaces(await fetchAllPlaces());
      setPlacesError(null);
    } catch (err) {
      setPlacesError(err instanceof Error ? err.message : 'Could not load places');
    }
    setLoadingPlaces(false);
  }, []);

  useEffect(() => { if (trip) loadPlaces(); }, [trip, loadPlaces]);

  // Pin each leg's hotel once: look it up on Google the first time, then keep the coordinates.
  const hotelTried = useRef(new Set<string>());
  useEffect(() => {
    if (!trip) return;
    const missing = trip.legs.filter(l => l.hotel?.trim() && (l.hotel_lat == null || l.hotel_lng == null) && !hotelTried.current.has(`${l.id}|${l.hotel}`));
    if (missing.length === 0) return;
    missing.forEach(l => hotelTried.current.add(`${l.id}|${l.hotel}`));
    (async () => {
      const updated = await Promise.all(trip.legs.map(async l => {
        if (!missing.includes(l)) return l;
        try {
          const res = await fetch('/projects/tripplanner/api/geocode-hotel', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: `${l.hotel}, ${l.city}, ${l.country}` }),
          });
          if (!res.ok) return l;
          const hit = await res.json() as { lat: number; lng: number; place_id: string };
          await supabase.from('trip_legs').update({ hotel_lat: hit.lat, hotel_lng: hit.lng, hotel_place_id: hit.place_id }).eq('id', l.id);
          return { ...l, hotel_lat: hit.lat, hotel_lng: hit.lng };
        } catch { return l; }
      }));
      setTrip(t => (t ? { ...t, legs: updated } : t));
    })();
  }, [trip]);

  const hotelPins = useMemo(
    () => (trip?.legs || [])
      .filter(l => l.hotel && l.hotel_lat != null && l.hotel_lng != null)
      .map(l => ({ name: l.hotel as string, lat: l.hotel_lat as number, lng: l.hotel_lng as number })),
    [trip?.legs],
  );

  const tripCountries = useMemo(() => Array.from(new Set((trip?.legs || []).map(l => l.country))), [trip?.legs]);

  const tripPlaces = useMemo(
    () => places.filter(p => tripCountries.some(c => sameText(c, p.country))),
    [places, tripCountries],
  );
  const [dupesTick, setDupesTick] = useState(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const dupeGroups = useMemo(() => openDuplicateGroups(tripPlaces), [tripPlaces, dupesTick]);

  // Places with no photo get a Google one in the background (the owner only, a few at a time).
  // Each place is tried once per visit; places Google has nothing for are saved as 'none'.
  const photoTried = useRef(new Set<string>());
  useEffect(() => {
    if (!access.owner || loadingPlaces) return;
    const todo = tripPlaces.filter(p => p.photo_url == null && !photoTried.current.has(p.id)).map(p => p.id);
    if (!todo.length) return;
    let live = true;
    (async () => {
      for (let i = 0; i < todo.length && live; i += 6) {
        const batch = todo.slice(i, i + 6);
        batch.forEach(id => photoTried.current.add(id));
        try {
          const got = await autoPlacePhotos(batch, tripId);
          setPlaces(prev => prev.map(p => (got[p.id] ? { ...p, photo_url: got[p.id] } : p)));
        } catch { return; } // e.g. column not added yet: stop quietly
      }
    })();
    return () => { live = false; };
  }, [access.owner, loadingPlaces, tripPlaces, tripId]);

  // Neighbourhood chips (Central, Sham Shui Po...). Fall back to cities for multi-city trips.
  const areaOf = useCallback((p: SavedPlace) => p.neighbourhood || p.city || '', []);
  const areas = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of tripPlaces) {
      const a = areaOf(p);
      if (a) counts.set(a, (counts.get(a) ?? 0) + 1);
    }
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  }, [tripPlaces, areaOf]);

  // Chips reflect everything except the chip's own filter, so counts stay honest.
  const placesForChips = useMemo(
    () => tripPlaces.filter(p => (activeArea === null || areaOf(p) === activeArea)),
    [tripPlaces, activeArea, areaOf],
  );

  // Straight-line distance from you to each pinned place (only while location is on).
  const distances = useMemo(() => {
    const out = new globalThis.Map<string, number>();
    if (!myLoc.me) return out;
    const me = toGcj02(myLoc.me.lat, myLoc.me.lng); // same grid as stored places in China
    for (const p of tripPlaces) if (p.geo) out.set(p.id, metresBetween(me, p.geo));
    return out;
  }, [myLoc.me, tripPlaces]);
  const sortByDistance = nearestFirst && distances.size > 0;

  const filteredPlaces = useMemo(() => {
    const q = search.trim().toLowerCase();
    return placesForChips
      .filter(p => categoryMatches(p, activeCategory))
      .filter(p => !mustGoOnly || p.must_go)
      .filter(p => !q || [p.name, p.city, p.vibe, p.neighbourhood, p.personal_note, ...(p.tags || [])]
        .some(v => v?.toLowerCase().includes(q)))
      .sort((a, b) => (newestFirst
        ? (b.created_at ?? '').localeCompare(a.created_at ?? '')
        : sortByDistance
        ? (distances.get(a.id) ?? Infinity) - (distances.get(b.id) ?? Infinity)
        : Number(b.must_go) - Number(a.must_go) ||
          categoryRank(a.category) - categoryRank(b.category) ||
          a.name.localeCompare(b.name)));
  }, [placesForChips, activeCategory, mustGoOnly, search, sortByDistance, distances, newestFirst]);

  const fitKey = `${panel}|${trip?.id}|${activeCategory}|${activeArea}|${mustGoOnly}|${tripPlaces.length}`;

  function selectPlace(place: SavedPlace, fromMap: boolean) {
    setQuietPin(false);
    setSelectedId(place.id);
    if (fromMap) {
      cardRefs.current.get(place.id)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } else if (place.geo) {
      setFocus({ lat: place.geo.lat, lng: place.geo.lng, nonce: Date.now() });
      setMobileView('map');
    } else {
      setInfoPlace(place);
    }
  }

  const missingDescriptions = tripPlaces.filter(p => !p.description && p.category !== 'Area');

  async function runDescribe() {
    setDescribing({ done: 0, total: missingDescriptions.length });
    const updated = await fillDescriptions(missingDescriptions, (done, total) => setDescribing({ done, total }));
    const byId = new Map(updated.map(p => [p.id, p]));
    setPlaces(prev => prev.map(p => byId.get(p.id) ?? p));
    setDescribing(null);
    setDescribeTried(true);
  }

  function handleUpdatePlace(updated: SavedPlace) {
    const before = places.find(p => p.id === updated.id);
    setPlaces(prev => prev.map(p => (p.id === updated.id ? updated : p)));
    // A rename or re-pin also changes the planned stops: reload the planner so it shows them.
    if (before && (before.name !== updated.name || before.geo?.lat !== updated.geo?.lat || before.geo?.lng !== updated.geo?.lng)) {
      setReloadKey(k => k + 1);
    }
  }

  if (loading) {
    return (
      <main className="relative h-full bg-white">
        <GlobeLoader show label="Loading the trip" />
      </main>
    );
  }

  if (notFound || !trip) {
    return (
      <main className="flex min-h-full flex-col items-center justify-center bg-gray-50 p-8">
        <h1 className="mb-2 text-xl font-semibold text-gray-900">Trip not found</h1>
        <p className="mb-6 text-sm text-gray-500">This trip doesn&apos;t exist or has been deleted.</p>
        <button onClick={() => router.push('/projects/tripplanner')} className="rounded-lg bg-sky-500 px-4 py-2 text-sm font-medium text-white transition hover:bg-sky-600">
          Back to all places
        </button>
      </main>
    );
  }

  const firstLeg = trip.legs[0];
  const visibleAreas = showAllAreas ? areas : areas.slice(0, 8);

  return (
    <main className="relative flex h-full flex-col bg-gray-50">
      <GlobeLoader show={loadingPlaces || (waitForMap && !mapReady) || !access.loaded} label="Loading the trip" />
      {/* Top bar */}
      <header className="trip-header flex shrink-0 items-center gap-3 border-b border-gray-200 bg-white px-4 py-3 sm:px-5">
        <button onClick={() => router.push('/projects/tripplanner')} className="flex shrink-0 items-center gap-1 text-sm text-gray-500 transition hover:text-gray-900" aria-label="All places">
          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
          <span className="hidden sm:inline">All places</span>
        </button>

        <div className="flex min-w-0 flex-1 flex-col sm:flex-none sm:flex-row sm:items-baseline sm:gap-2.5">
          <h1 className="truncate text-base font-semibold leading-tight text-gray-900">{trip.name}</h1>
          <span className="shrink-0 text-xs text-gray-500 sm:text-sm">{formatTripDates(trip.start_date, trip.end_date)}</span>
        </div>

        {trip.legs.length > 0 && (
          <div className="ml-1 hidden items-center gap-1.5 md:flex">
            {trip.legs.map(leg => (
              <span key={leg.id} className="rounded-full bg-sky-50 px-2.5 py-0.5 text-xs font-medium text-sky-600" title={leg.hotel ? `Staying at ${leg.hotel}` : undefined}>
                {leg.city}
              </span>
            ))}
          </div>
        )}

        <div className="ml-auto flex shrink-0 items-center gap-1.5 sm:gap-2">
          {access.loaded && !editable && (
            <span className="rounded-full bg-gray-100 px-2.5 py-1 text-[11px] font-medium text-gray-500" title="You can look around but not change this trip">View only</span>
          )}
          {access.owner && (
            <button onClick={() => setShowShare(true)} className="rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs font-medium text-gray-600 transition hover:bg-gray-50 sm:px-3">
              Share
            </button>
          )}
          {editable && (<>
          <button onClick={() => setShowCalendar(true)} aria-label="Add to calendar" title="Add to calendar"
            className="rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs font-medium text-gray-600 transition hover:bg-gray-50 sm:px-3">
            <span className="inline-flex items-center gap-1.5"><CalendarDays className="h-4 w-4" strokeWidth={1.5} aria-hidden /><span className="hidden sm:inline">Calendar</span></span>
          </button>
          <button onClick={() => setShowEdit(true)} aria-label="Edit trip"
            className="rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs font-medium text-gray-600 transition hover:bg-gray-50 sm:px-3">
            <span className="sm:hidden">Edit</span><span className="hidden sm:inline">Edit trip</span>
          </button>
          <button onClick={() => setShowAdd(true)} aria-label="Add places"
            className="rounded-lg bg-sky-500 px-2.5 py-1.5 text-xs font-medium text-white transition hover:bg-sky-600 sm:px-3">
            <span className="sm:hidden">+ Add</span><span className="hidden sm:inline">+ Add places</span>
          </button>
          </>)}
        </div>
      </header>

      <div className="relative z-30 flex shrink-0 flex-col border-b border-gray-200 bg-white md:flex-row md:items-center">
        <TripSearch
          places={tripPlaces}
          dates={tripDates(trip.start_date, trip.end_date)}
          plannedOn={planned.byPlace}
          editable={editable}
          onFocus={p => {
            if (!p.geo) { flash(`${p.name} has no pin on the map yet`); return; }
            setSelectedId(p.id);
            setQuietPin(true);
            setFocus({ lat: p.geo.lat, lng: p.geo.lng, nonce: Date.now() });
            setMobileView('map');
          }}
          onOpenDay={date => { setPanel('schedule'); setMobileView('list'); setGoToDate({ date, nonce: Date.now() }); }}
          onAddToDay={(p, date) => setAddRequest({ place: p, nonce: Date.now(), date })}
          onAddNew={() => setShowAdd(true)}
        />
        <WeatherStrip dates={tripDates(trip.start_date, trip.end_date)} weather={weather}
          activeLabel={panel === 'schedule' ? planDay : todayLabel()} />
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Left panel */}
        <aside className={`trip-pane w-full shrink-0 flex-col overflow-y-auto border-r border-gray-200 bg-white md:flex md:w-[420px] ${mobileView === 'list' ? 'flex' : 'hidden'}`}>
          <div className="hidden shrink-0 gap-1 border-b border-gray-100 px-4 pt-3 md:flex">
            {(['places', 'schedule'] as const).map(v => (
              <button key={v} onClick={() => setPanel(v)}
                className={`-mb-px border-b-2 px-3 pb-2 text-sm font-medium capitalize transition ${
                  panel === v ? 'border-gray-900 text-gray-900' : 'border-transparent text-gray-400 hover:text-gray-600'}`}>
                {v === 'places' ? `Places · ${tripPlaces.length}` : 'Schedule'}
              </button>
            ))}
          </div>

          {/* The planner stays loaded on both tabs: the chat globe and the faded "already planned"
              pins need it. It's only shown on Schedule. */}
          <div className={panel === 'schedule' ? '' : 'hidden'}>
            <DayPlanner
              key={reloadKey}
              tripId={trip.id}
              startDate={trip.start_date}
              endDate={trip.end_date}
              legs={trip.legs}
              places={tripPlaces}
              onFocusPlace={p => selectPlace(p, false)}
              addRequest={addRequest}
              onActiveDayChange={setPlanDay}
              onRouteChange={setDayRoute}
              readOnly={!editable}
              onEditTrip={editable ? () => setShowEdit(true) : undefined}
              onAdded={(p, label) => { setSelectedId(null); flash(`Added ${p.name} to ${label}`); }}
              tripName={trip.name}
              onPlacesCreated={saved => setPlaces(prev => [...saved, ...prev])}
              onPlannedChange={setPlanned}
              onAddHandled={() => setAddRequest(null)}
              goToDate={goToDate}
              weather={weather}
            />
          </div>
          {panel !== 'schedule' && (<>
          <div className="sticky top-0 z-10 space-y-2.5 border-b border-gray-100 bg-white/95 px-4 py-3 backdrop-blur-sm">
            <div className="flex gap-2">
            <input type="text" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search name, area or tag"
              className="min-w-0 flex-1 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 outline-hidden transition focus:border-sky-400 focus:bg-white focus:ring-2 focus:ring-sky-100" />
            <button
              onClick={() => { if (!nearestFirst) myLoc.start(); setNearestFirst(v => !v); setNewestFirst(false); }}
              aria-pressed={nearestFirst}
              title="Sort by distance from where you are"
              className={`flex shrink-0 items-center gap-1 rounded-lg border px-2.5 text-xs font-medium transition ${
                nearestFirst ? 'border-sky-500 bg-sky-500 text-white' : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50'}`}>
              {nearestFirst && myLoc.status === 'asking'
                ? <span className="h-3 w-3 animate-spin rounded-full border-2 border-white/40 border-t-white" />
                : <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="round"><path d="M21 3L3 10.5l7.5 3 3 7.5L21 3z" /></svg>}
              Nearest
            </button>
            <button
              onClick={() => { setNewestFirst(v => !v); setNearestFirst(false); }}
              aria-pressed={newestFirst}
              title="Show your latest saves first"
              className={`shrink-0 rounded-lg border px-2.5 text-xs font-medium transition ${
                newestFirst ? 'border-sky-500 bg-sky-500 text-white' : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50'}`}>
              Newest
            </button>
            </div>
            {nearestFirst && (myLoc.status === 'denied' || myLoc.status === 'unavailable') && (
              <p className="text-xs text-amber-700">
                {myLoc.status === 'denied'
                  ? 'Location is blocked. Allow it for this site in your browser settings.'
                  : "Couldn't find your location."}
              </p>
            )}

            <CategoryChips places={placesForChips} active={activeCategory} onChange={setActiveCategory}
              mustGoOnly={mustGoOnly} onMustGoChange={setMustGoOnly} />

            {areas.length > 1 && (
              <div className="flex flex-wrap gap-1.5">
                {visibleAreas.map(([area, count]) => (
                  <button key={area} onClick={() => setActiveArea(activeArea === area ? null : area)}
                    className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium transition ${activeArea === area ? 'bg-sky-500 text-white' : 'bg-sky-50 text-sky-700 hover:bg-sky-100'}`}>
                    {area} <span className="opacity-60">{count}</span>
                  </button>
                ))}
                {areas.length > 8 && (
                  <button onClick={() => setShowAllAreas(v => !v)} className="px-1 text-[11px] font-medium text-gray-400 hover:text-gray-600">
                    {showAllAreas ? 'Less' : `+${areas.length - 8} more`}
                  </button>
                )}
              </div>
            )}
          </div>

          <div className="space-y-2.5 px-4 pb-6 pt-3">
            {editable && !loadingPlaces && missingDescriptions.length > 0 && (
              <div className="flex items-center justify-between gap-3 rounded-lg bg-violet-50 px-3 py-2 text-xs text-violet-800">
                <span>
                  {describing
                    ? `Writing descriptions… ${describing.done} of ${describing.total}`
                    : describeTried
                      ? `${missingDescriptions.length} place${missingDescriptions.length === 1 ? '' : 's'} Claude didn't know well enough to describe`
                      : `${missingDescriptions.length} place${missingDescriptions.length === 1 ? ' has' : 's have'} no description yet`}
                </span>
                {!describing && !describeTried && (
                  <button onClick={runDescribe} className="shrink-0 rounded-md bg-gray-900 px-2.5 py-1 font-medium text-white transition-colors hover:bg-gray-700">
                    Add descriptions
                  </button>
                )}
              </div>
            )}
            {access.owner && !loadingPlaces && dupeGroups.length > 0 && (
              <div className="flex items-center justify-between gap-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
                <span>{dupeGroups.length} place{dupeGroups.length === 1 ? ' looks' : 's look'} saved more than once</span>
                <button onClick={() => setShowDupes(true)} className="shrink-0 rounded-md bg-amber-500 px-2.5 py-1 font-medium text-white hover:bg-amber-600">
                  Review
                </button>
              </div>
            )}
            {placesError && <p className="rounded-lg bg-red-50 p-3 text-xs text-red-600">Couldn&apos;t load places: {placesError}</p>}
            {loadingPlaces ? (
              <div className="flex justify-center py-10 text-gray-400"><Spinner /></div>
            ) : tripPlaces.length === 0 ? (
              <div className="rounded-xl border border-dashed border-gray-200 bg-gray-50 px-6 py-12 text-center">
                <p className="text-sm text-gray-500">No places in {tripCountries.join(', ') || 'this trip'} yet.</p>
                <button onClick={() => setShowImport(true)} className="mt-3 rounded-lg bg-sky-500 px-4 py-2 text-sm font-medium text-white transition hover:bg-sky-600">
                  Import a list
                </button>
                <p className="mt-2 text-xs text-gray-400">or paste TikTok / Instagram links on the home page</p>
              </div>
            ) : filteredPlaces.length === 0 ? (
              <div className="rounded-xl border border-dashed border-gray-200 bg-gray-50 px-6 py-12 text-center text-sm text-gray-400">
                No places match these filters.
              </div>
            ) : (
              filteredPlaces.map(place => (
                <PlaceCard
                  key={place.id}
                  ref={el => { if (el) cardRefs.current.set(place.id, el); else cardRefs.current.delete(place.id); }}
                  place={place}
                  isSelected={selectedId === place.id}
                  onClick={p => selectPlace(p, false)}
                  onInfo={setInfoPlace}
                  onDelete={access.owner ? handleDeletePlace : undefined}
                  distance={(() => { const d = distances.get(place.id); return d != null && d <= 50000 ? fmtDistance(d) : undefined; })()}
                />
              ))
            )}
          </div>
          </>)}
        </aside>

        {/* Map */}
        <section className={`relative flex-1 md:block ${mobileView === 'map' ? 'block' : 'hidden'}`}>
          <PlacesMap
            onReady={() => setMapReady(true)}
            places={panel === 'schedule' ? tripPlaces : filteredPlaces}
            hotels={hotelPins}
            route={panel === 'schedule' ? dayRoute : null}
            routeDay={planDay}
            plannedOn={dimmed}
            popupAction={editable && panel === 'schedule' && planDay
              ? { label: `+ Add to ${planDay}`, onClick: p => setAddRequest({ place: p, nonce: Date.now() }) }
              : null}
            selectedId={selectedId}
            hidePopup={quietPin}
            onSelect={id => {
              setQuietPin(false);
              if (!id) { setSelectedId(null); return; }
              const p = (panel === 'schedule' ? tripPlaces : filteredPlaces).find(x => x.id === id);
              if (p) { if (panel === 'schedule') setSelectedId(p.id); else selectPlace(p, true); }
            }}
            onInfo={setInfoPlace}
            fitKey={fitKey}
            focus={focus}
            fallbackQuery={firstLeg ? [firstLeg.city, firstLeg.country].filter(Boolean).join(', ') : undefined}
            me={myLoc.me}
            locateStatus={myLoc.status}
            onLocate={myLoc.start}
          />
        </section>
      </div>

      {/* Mobile bottom bar: Places / Schedule / Map. The map keeps the last list tab's behaviour. */}
      <nav className="trip-mobile-nav flex shrink-0 border-t border-gray-200 bg-white pb-[env(safe-area-inset-bottom)] md:hidden">
        {([
          { key: 'places', label: `Places · ${tripPlaces.length}`, active: mobileView === 'list' && panel === 'places',
            onClick: () => { setPanel('places'); setMobileView('list'); },
            icon: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M4 6h16M4 12h16M4 18h10" /> },
          { key: 'schedule', label: 'Schedule', active: mobileView === 'list' && panel === 'schedule',
            onClick: () => { setPanel('schedule'); setMobileView('list'); },
            icon: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M8 3v3m8-3v3M4 9h16M5 6h14a1 1 0 011 1v12a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1z" /> },
          { key: 'map', label: 'Map', active: mobileView === 'map',
            onClick: () => setMobileView('map'),
            icon: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M9 4L3 6v14l6-2 6 2 6-2V4l-6 2-6-2zm0 0v14m6-12v14" /> },
        ]).map(t => (
          <button key={t.key} onClick={t.onClick}
            className={`flex flex-1 flex-col items-center gap-0.5 pb-2 pt-2 text-[11px] font-medium transition ${t.active ? 'text-sky-600' : 'text-gray-400'}`}>
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">{t.icon}</svg>
            {t.label}
          </button>
        ))}
      </nav>

      {toast && (
        <div className="pointer-events-none fixed bottom-20 left-1/2 md:bottom-6 z-50 -translate-x-1/2 rounded-full bg-gray-900 px-4 py-2 text-xs font-medium text-white shadow-lg">
          {toast}
        </div>
      )}

      {showCalendar && trip && <CalendarModal tripId={trip.id} onClose={() => setShowCalendar(false)} />}
      {showShare && trip && (
        <ShareModal tripId={trip.id} tripName={trip.name} onClose={() => setShowShare(false)} />
      )}

      {showEdit && (
        <TripEditModal
          trip={trip}
          canDelete={access.owner}
          onClose={() => setShowEdit(false)}
          onSaved={() => { setShowEdit(false); setReloadKey(k => k + 1); flash('Trip saved'); }}
          onDeleted={() => router.push('/projects/tripplanner')}
        />
      )}

      {showAdd && (
        <AddPlaceModal
          existingPlaces={places}
          defaultCity={firstLeg?.city ?? ''}
          defaultCountry={firstLeg?.country ?? ''}
          onSaved={saved => setPlaces(prev => [...saved, ...prev])}
          onImportList={() => { setShowAdd(false); setShowImport(true); }}
          onClose={() => setShowAdd(false)}
        />
      )}

      {infoPlace && (
        <InfoModal place={infoPlace} tripId={tripId} hotel={firstLeg?.hotel} readOnly={!editable} onClose={() => setInfoPlace(null)} onUpdate={handleUpdatePlace} />
      )}

      {showDupes && (
        <DuplicatesModal
          places={tripPlaces}
          onClose={() => setShowDupes(false)}
          onSkipped={() => setDupesTick(t => t + 1)}
          onMerged={removed => {
            setPlaces(prev => prev.filter(p => !removed.includes(p.id)));
            fetchAllPlaces().then(setPlaces).catch(() => {});
            flash(`Merged ${removed.length} duplicate${removed.length === 1 ? '' : 's'}`);
          }}
        />
      )}
      {showImport && (
        <ImportModal
          onClose={() => setShowImport(false)}
          onImported={saved => setPlaces(prev => mergePlaces(prev, saved))}
          existingPlaces={places}
          defaultCity={firstLeg?.city ?? ''}
          defaultCountry={firstLeg?.country ?? ''}
        />
      )}
    </main>
  );
}

function Spinner() {
  return (
    <svg className="h-5 w-5 animate-spin" viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
    </svg>
  );
}

// Fixed strip under the top bar: one chip per trip day with the forecast. The day open in the
// schedule is highlighted. Days past the 16-day forecast show a dash.
function WeatherStrip({ dates, weather, activeLabel }: { dates: string[]; weather: Record<string, WeatherDay>; activeLabel: string }) {
  if (!dates.some(d => weather[d])) return null;
  return (
    <div className="trip-weather flex min-w-0 flex-1 gap-1.5 overflow-x-auto px-4 pb-2 [scrollbar-width:none] sm:px-5 md:py-2 md:pl-0">
      {dates.map(date => {
        const l = dayLabel(date);
        const label = `${l.weekday} ${l.day}`;
        const w = weather[date];
        const look = w ? weatherLook(w.code) : null;
        const active = label === activeLabel;
        return (
          <div key={date} title={w ? `${look!.label}${w.rain != null ? `, ${w.rain}% chance of rain` : ''}${w.sunset ? `, sunset ${w.sunset}` : ''}` : 'No forecast yet'}
            className={`flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${
              active ? 'border-sky-200 bg-sky-50 text-sky-800' : 'border-gray-200 bg-white text-gray-600'}`}>
            <span className={`font-medium ${active ? 'text-sky-700' : 'text-gray-500'}`}>{label}</span>
            {w ? (<>
              <span aria-hidden>{look!.emoji}</span>
              <span className="tabular-nums"><span className="font-semibold text-gray-900">{w.hi}°</span><span className="text-gray-400"> {w.lo}°</span></span>
              {w.rain != null && w.rain >= 20 && <span className="inline-flex items-center gap-0.5 tabular-nums text-sky-600"><Droplets className="h-3 w-3" strokeWidth={1.5} aria-label="Chance of rain" />{w.rain}%</span>}
            </>) : <span className="text-gray-300">–</span>}
          </div>
        );
      })}
    </div>
  );
}

function todayLabel(): string {
  const d = new Date();
  const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const l = dayLabel(iso);
  return `${l.weekday} ${l.day}`;
}

// Always-visible search over the trip's saved places. Each hit says which days it's on (in the plan
// you're going with); if it's on none, you can add it to a day from here.
function TripSearch({ places, dates, plannedOn, editable, onFocus, onOpenDay, onAddToDay, onAddNew }: {
  places: SavedPlace[];
  dates: string[];
  plannedOn: Record<string, string[]>;
  editable: boolean;
  onFocus: (p: SavedPlace) => void;
  onOpenDay: (date: string) => void;
  onAddToDay: (p: SavedPlace, date: string) => void;
  onAddNew: () => void;
}) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [picking, setPicking] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent | TouchEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('touchstart', onDown); };
  }, [open]);

  const term = q.trim().toLowerCase();
  const hits = useMemo(() => {
    if (!term) return [];
    const score = (p: SavedPlace) => {
      const name = p.name.toLowerCase();
      if (name.startsWith(term)) return 0;
      if (name.includes(term)) return 1;
      return 2;
    };
    return places
      .filter(p => [p.name, p.geo?.address, p.neighbourhood, p.city, p.personal_note, ...(p.tags ?? [])]
        .some(v => v?.toLowerCase().includes(term)))
      .sort((a, b) => score(a) - score(b) || a.name.localeCompare(b.name))
      .slice(0, 8);
  }, [places, term]);

  const label = (d: string) => { const l = dayLabel(d); return `${l.weekday} ${l.day}`; };

  return (
    <div ref={box} className="relative px-4 py-2 sm:px-5 md:w-80 md:shrink-0">
      <div className="flex items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-2.5 py-1.5 focus-within:border-sky-400 focus-within:bg-white">
        <svg className="h-4 w-4 shrink-0 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.3-4.3M17 10.5a6.5 6.5 0 11-13 0 6.5 6.5 0 0113 0z" /></svg>
        <input value={q} placeholder="Search your places"
          onChange={e => { setQ(e.target.value); setOpen(true); setPicking(null); }}
          onFocus={() => setOpen(true)}
          onKeyDown={e => { if (e.key === 'Escape') { setOpen(false); (e.target as HTMLInputElement).blur(); } }}
          className="min-w-0 flex-1 bg-transparent text-sm text-gray-900 outline-hidden placeholder:text-gray-400" />
        {q && <button onClick={() => { setQ(''); setPicking(null); }} aria-label="Clear search" className="text-xs text-gray-400 hover:text-gray-600">✕</button>}
      </div>

      {open && term && (
        <div className="absolute left-4 right-4 top-full z-40 mt-1 max-h-[70vh] overflow-y-auto rounded-xl border border-gray-200 bg-white shadow-lg sm:left-5 sm:right-5 md:w-[420px] md:right-auto">
          {hits.length === 0 ? (
            <div className="px-3 py-3 text-sm text-gray-500">
              No saved place matches &ldquo;{q.trim()}&rdquo;.
              {editable && (
                <button onClick={() => { setOpen(false); onAddNew(); }} className="mt-2 block font-medium text-sky-600 hover:text-sky-700">+ Add it as a new place</button>
              )}
            </div>
          ) : hits.map(p => {
            const on = (plannedOn[p.id] ?? []).slice().sort();
            const cat = getCategory(p.category);
            return (
              <div key={p.id} className="border-b border-gray-100 px-3 py-2.5 last:border-b-0">
                <div className="flex items-start gap-2">
                  <button onClick={() => { onFocus(p); setOpen(false); }} className="min-w-0 flex-1 text-left">
                    <p className="truncate text-sm font-medium text-gray-900"><span className="mr-1">{p.emoji || cat.emoji}</span>{p.name}</p>
                    <p className="truncate text-[11px] text-gray-400">{p.neighbourhood || p.city || cat.label}</p>
                  </button>
                  <div className="flex shrink-0 flex-wrap justify-end gap-1 pt-0.5">
                    {on.length > 0 ? on.map(d => (
                      <button key={d} onClick={() => { onOpenDay(d); setOpen(false); }}
                        className="rounded-full bg-sky-50 px-2 py-0.5 text-[11px] font-medium text-sky-700 hover:bg-sky-100">{label(d)}</button>
                    )) : editable ? (
                      <button onClick={() => setPicking(picking === p.id ? null : p.id)}
                        className="rounded-full border border-dashed border-gray-300 px-2 py-0.5 text-[11px] font-medium text-gray-500 hover:border-sky-400 hover:text-sky-600">+ Add to a day</button>
                    ) : <span className="text-[11px] text-gray-400">Not planned</span>}
                  </div>
                </div>
                {picking === p.id && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {dates.map(d => (
                      <button key={d} onClick={() => { onAddToDay(p, d); setPicking(null); setOpen(false); setQ(''); }}
                        className="rounded-full bg-gray-100 px-2.5 py-1 text-[11px] font-medium text-gray-700 hover:bg-sky-50 hover:text-sky-700">{label(d)}</button>
                    ))}
                  </div>
                )}
                {on.length > 0 && editable && picking !== p.id && (
                  <button onClick={() => setPicking(p.id)} className="mt-1 text-[11px] text-gray-400 hover:text-sky-600">+ Another day</button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
