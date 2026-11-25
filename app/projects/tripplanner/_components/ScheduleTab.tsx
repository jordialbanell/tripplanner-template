'use client';

import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/lib/trip/supabase';

// ─── Types ───────────────────────────────────────────────────────────

export type AssignedTo = 'Both' | 'Me' | 'GF';
export type Direction = 'Arriving' | 'Departing';

export interface Flight {
  number: string;
  date: string;
  assignedTo: AssignedTo;
  direction: Direction;
  departureAirport?: string;
  arrivalAirport?: string;
  departureTime?: string;
  arrivalTime?: string;
}

interface Trip {
  id: string;
  name: string;
  start_date: string;
  end_date: string;
  legs?: TripLeg[];
}

interface SavedFlight {
  id: string;
  flight_number: string;
}

interface SavedPlace {
  id: string;
  name: string;
  category: string;
  city: string;
  lat: number | null;
  lng: number | null;
  address: string | null;
  vibe: string | null;
  tags: string[] | null;
  source_handle: string | null;
}

interface SelectedStop {
  place_id: string | null;
  name: string;
  address: string;
  lat: number;
  lng: number;
  category: string;
  duration_minutes: number;
  from_saved: boolean;
  vibe?: string | null;
  tags?: string[] | null;
  source_handle?: string | null;
}

interface DayStop {
  id: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  duration_minutes: number;
  start_time: string;
  stop_order: number;
  place_id: string | null;
  transport_to_next: string | null;
  travel_minutes_to_next: number | null;
}

interface TravelOption {
  mode: string;
  duration_minutes: number | null;
  duration_text: string | null;
}

interface TripDay {
  id: string;
  trip_id: string;
  day_date: string;
  day_order: number;
  leg_id: string | null;
}

type TripLeg = {
  id: string;
  trip_id: string;
  city: string;
  start_date: string | null;
  end_date: string | null;
  leg_order: number;
  hotel: string | null;
  country: string;
};

export type LegInput = { id?: string; city: string; country: string; start_date: string; end_date: string; hotel: string };

export const EMPTY_LEG: LegInput = { city: '', country: '', start_date: '', end_date: '', hotel: '' };

export function legsMissingCountry(legs: LegInput[]) {
  return legs.some(l => l.city.trim() && !l.country.trim());
}

// ─── Constants ───────────────────────────────────────────────────────

export const INPUT_CLASS = 'w-full rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-900 placeholder-gray-300 outline-hidden transition focus:border-gray-400 focus:ring-1 focus:ring-gray-200';
export const LABEL_CLASS = 'block text-xs font-medium text-gray-400 mb-1.5';

const CATEGORY_EMOJI: Record<string, string> = {
  restaurant: '🍴', café: '☕', cafe: '☕', hotel: '🏨', attraction: '🎭',
};

const DEFAULT_DURATION: Record<string, number> = {
  restaurant: 60, café: 45, cafe: 45, hotel: 30, attraction: 120,
};

const MODE_EMOJI: Record<string, string> = {
  transit: '🚇', walking: '🚶', driving: '🚗',
};

// ─── Helpers ─────────────────────────────────────────────────────────

function normaliseCityName(city: string): string {
  return city.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

async function geocodeCity(city: string): Promise<{ lat: number; lng: number } | null> {
  const token = process.env.NEXT_PUBLIC_TRIP_MAPBOX_TOKEN;
  if (!token) return null;
  try {
    const res = await fetch(`https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(city)}.json?types=place&limit=1&access_token=${token}`);
    const data = await res.json();
    const center = data?.features?.[0]?.center;
    if (Array.isArray(center) && center.length === 2) return { lng: center[0], lat: center[1] };
  } catch { /* ignore */ }
  return null;
}

function formatDate(dateStr: string) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatShortDate(dateStr: string) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function addMinutes(time: string, mins: number): string {
  const [h, m] = time.split(':').map(Number);
  const total = h * 60 + m + mins;
  const hh = Math.floor(total / 60) % 24;
  const mm = total % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function formatDuration(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m}min`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}min`;
}

export function encodeFlightNumber(f: Flight): string {
  const dateStr = f.date ? new Date(f.date + 'T00:00:00').toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '';
  const route = (f.departureAirport || f.arrivalAirport || f.departureTime || f.arrivalTime) ? ` | ${f.departureAirport || '?'}-${f.arrivalAirport || '?'}` : '';
  const times = (f.departureTime || f.arrivalTime) ? ` | ${f.departureTime || '?'}-${f.arrivalTime || '?'}` : '';
  return `${f.number.trim()} | ${dateStr} | ${f.assignedTo} | ${f.direction}${route}${times}`;
}

export function parseFlightString(s: string): Flight {
  const parts = s.split('|').map(p => p.trim());
  let date = '';
  if (parts[1]) {
    const m = parts[1].match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (m) date = `${m[3]}-${m[2]}-${m[1]}`;
  }
  // Parse optional route (e.g. "SIN-PVG") and times (e.g. "08:25-14:30")
  let departureAirport = '', arrivalAirport = '', departureTime = '', arrivalTime = '';
  if (parts[4]) {
    const r = parts[4].split('-');
    departureAirport = r[0]?.trim() === '?' ? '' : r[0]?.trim() || '';
    arrivalAirport = r[1]?.trim() === '?' ? '' : r[1]?.trim() || '';
  }
  if (parts[5]) {
    const t = parts[5].split('-');
    departureTime = t[0]?.trim() === '?' ? '' : t[0]?.trim() || '';
    arrivalTime = t[1]?.trim() === '?' ? '' : t[1]?.trim() || '';
  }
  return {
    number: parts[0] || '',
    date,
    assignedTo: (['Both', 'Me', 'GF'].includes(parts[2]) ? parts[2] : 'Both') as AssignedTo,
    direction: (['Arriving', 'Departing'].includes(parts[3]) ? parts[3] : 'Arriving') as Direction,
    departureAirport: departureAirport || undefined,
    arrivalAirport: arrivalAirport || undefined,
    departureTime: departureTime || undefined,
    arrivalTime: arrivalTime || undefined,
  };
}

function getNextDate(trip: Trip, existingDays: TripDay[]): string {
  if (existingDays.length === 0) return trip.start_date;
  const dates = existingDays.map(d => d.day_date).sort();
  const last = new Date(dates[dates.length - 1] + 'T00:00:00');
  last.setDate(last.getDate() + 1);
  return last.toISOString().split('T')[0];
}

function hasMealGap(stops: DayStop[], startHour: number, endHour: number, categories: string[]): boolean {
  return !stops.some(s => {
    const [h] = s.start_time.split(':').map(Number);
    const endH = h + Math.floor(s.duration_minutes / 60);
    return categories.some(c => s.name.toLowerCase().includes(c)) && ((h >= startHour && h < endHour) || (endH > startHour && endH <= endHour));
  });
}

// ─── Shared components ──────────────────────────────────────────────

export function PillToggle<T extends string>({ options, value, onChange }: { options: T[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="flex gap-1">
      {options.map(opt => (
        <button key={opt} type="button" onClick={() => onChange(opt)}
          className={`rounded-full px-2 py-0.5 text-[12px] font-medium transition ${value === opt ? 'bg-gray-900 text-white' : 'border border-gray-200 text-gray-400 hover:text-gray-500'}`}
        >{opt}</button>
      ))}
    </div>
  );
}

interface FlightSegment { from: string; to: string; departs: string; arrives: string }

// First day = flying in, last day = flying home. Anything in between keeps the user's choice.
function guessDirection(date: string, current: Direction, tripStart?: string, tripEnd?: string): Direction {
  if (!date || !tripStart || !tripEnd || tripStart === tripEnd) return current;
  if (date === tripEnd) return 'Departing';
  if (date === tripStart) return 'Arriving';
  return current;
}

export function FlightFields({ flights, onChange, tripStart, tripEnd }: {
  flights: Flight[]; onChange: (flights: Flight[]) => void; tripStart?: string; tripEnd?: string;
}) {
  const [segments, setSegments] = useState<{ index: number; list: FlightSegment[] } | null>(null);
  const [lookupLoading, setLookupLoading] = useState<number | null>(null);
  const [lookupError, setLookupError] = useState<{ index: number; message: string } | null>(null);
  const [lookupNote, setLookupNote] = useState<{ index: number; message: string } | null>(null);

  function update<K extends keyof Flight>(i: number, field: K, value: Flight[K]) {
    onChange(flights.map((f, idx) => {
      if (idx !== i) return f;
      const next = { ...f, [field]: value };
      if (field === 'date') next.direction = guessDirection(String(value), f.direction, tripStart, tripEnd);
      return next;
    }));
  }

  function hhmmOf(t: string): string {
    const match = (t || '').match(/(\d{2}):(\d{2})/);
    return match ? `${match[1]}:${match[2]}` : '';
  }

  function pickSegment(i: number, g: FlightSegment) {
    onChange(flights.map((f, idx) => idx === i ? {
      ...f, departureAirport: g.from, arrivalAirport: g.to, departureTime: hhmmOf(g.departs), arrivalTime: hhmmOf(g.arrives),
    } : f));
  }

  async function lookupFlight(i: number) {
    const flight = flights[i];
    if (!flight.number.trim() || !flight.date) return;
    setLookupLoading(i);
    setLookupError(null);
    setLookupNote(null);
    try {
      const res = await fetch(`/projects/tripplanner/api/flights/lookup?flightNumber=${encodeURIComponent(flight.number.trim())}&date=${flight.date}`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'Flight not found' }));
        setLookupError({ index: i, message: data.error || 'Flight not found' });
        setLookupLoading(null);
        return;
      }
      const data = await res.json();
      const list: FlightSegment[] = Array.isArray(data.segments) ? data.segments : [];
      const direction = guessDirection(flight.date, flight.direction, tripStart, tripEnd);
      const multi = list.length > 1;
      setSegments(multi ? { index: i, list } : null);
      setLookupNote({ index: i, message: `Found online${data.note ? ` (${data.note})` : ''}.${multi ? ` It stops on the way (${[list[0].from, ...list.map(g => g.to)].join(' > ')}): pick your part below.` : ''} Check against your booking.` });
      // Multi-stop flight numbers: flying home you board at the first stop; flying in you get off at the last.
      const g: FlightSegment = multi
        ? (direction === 'Departing' ? list[0] : list[list.length - 1])
        : { from: data.departure_airport || '', to: data.arrival_airport || '', departs: data.departure_time || '', arrives: data.arrival_time || '' };
      onChange(flights.map((f, idx) => idx === i ? {
        ...f,
        direction,
        departureAirport: g.from,
        arrivalAirport: g.to,
        departureTime: hhmmOf(g.departs),
        arrivalTime: hhmmOf(g.arrives),
      } : f));
    } catch {
      setLookupError({ index: i, message: 'Network error, try again or enter times manually' });
    }
    setLookupLoading(null);
  }

  return (
    <div className="border-t border-gray-100 pt-5">
      <label className={LABEL_CLASS}>Flights</label>
      <p className="text-[12px] text-gray-400 mb-3">Add each leg separately. Only include flights arriving at or departing from your destination. Look up fills in the times, or type them in. Times are local.</p>
      <div className="space-y-4">
        {flights.map((flight, i) => (
          <div key={i} className="space-y-2 rounded-lg border border-gray-100 p-3">
            <div className="flex gap-2 items-start">
              <div className="flex-1 space-y-2">
                <div className="flex gap-2">
                  <input type="text" value={flight.number} onChange={e => update(i, 'number', e.target.value)} placeholder="SQ831" className={INPUT_CLASS} />
                  <button type="button" onClick={() => lookupFlight(i)}
                    disabled={!flight.number.trim() || !flight.date || lookupLoading === i}
                    className="shrink-0 rounded-lg bg-gray-100 px-2.5 py-2 text-xs font-medium text-gray-500 transition hover:bg-gray-200 disabled:opacity-40 disabled:cursor-not-allowed">
                    {lookupLoading === i ? (
                      <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" /></svg>
                    ) : 'Look up'}
                  </button>
                </div>
                <input type="date" value={flight.date} onChange={e => update(i, 'date', e.target.value)} className={INPUT_CLASS} />
              </div>
              {flights.length > 1 && (
                <button type="button" onClick={() => onChange(flights.filter((_, idx) => idx !== i))} className="mt-2 text-gray-300 hover:text-gray-500 transition">
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" /></svg>
                </button>
              )}
            </div>

            {lookupError?.index === i && (
              <p className="text-xs text-red-500">{lookupError.message}</p>
            )}

            {lookupNote?.index === i && !lookupError && (
              <p className="text-xs text-gray-400">{lookupNote.message}</p>
            )}

            {segments?.index === i && (
              <div className="flex flex-wrap gap-1.5">
                {segments.list.map((g, k) => {
                  const on = flight.departureAirport === g.from && flight.arrivalAirport === g.to;
                  return (
                    <button key={k} type="button" onClick={() => pickSegment(i, g)}
                      className={`rounded-full px-2.5 py-1 text-[12px] font-medium transition ${on ? 'bg-gray-900 text-white' : 'border border-gray-200 text-gray-500 hover:text-gray-700'}`}>
                      {g.from} &gt; {g.to}{g.departs ? ` · ${hhmmOf(g.departs)}` : ''}
                    </button>
                  );
                })}
              </div>
            )}

            {(
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-[11px] text-gray-400 mb-0.5">From</label>
                  <input type="text" value={flight.departureAirport || ''} onChange={e => update(i, 'departureAirport', e.target.value)} placeholder="SIN" className={INPUT_CLASS} />
                </div>
                <div>
                  <label className="block text-[11px] text-gray-400 mb-0.5">To</label>
                  <input type="text" value={flight.arrivalAirport || ''} onChange={e => update(i, 'arrivalAirport', e.target.value)} placeholder="PVG" className={INPUT_CLASS} />
                </div>
                <div>
                  <label className="block text-[11px] text-gray-400 mb-0.5">Departs</label>
                  <input type="time" value={flight.departureTime || ''} onChange={e => update(i, 'departureTime', e.target.value)} className={INPUT_CLASS} />
                </div>
                <div>
                  <label className="block text-[11px] text-gray-400 mb-0.5">Arrives</label>
                  <input type="time" value={flight.arrivalTime || ''} onChange={e => update(i, 'arrivalTime', e.target.value)} className={INPUT_CLASS} />
                </div>
              </div>
            )}

            <div className="flex gap-3 items-center">
              <PillToggle options={['Both', 'Me', 'GF'] as AssignedTo[]} value={flight.assignedTo} onChange={v => update(i, 'assignedTo', v)} />
              <PillToggle options={['Arriving', 'Departing'] as Direction[]} value={flight.direction} onChange={v => update(i, 'direction', v)} />
            </div>
          </div>
        ))}
      </div>
      <button type="button" onClick={() => onChange([...flights, { number: '', date: '', assignedTo: 'Both', direction: 'Arriving' }])}
        className="mt-2 text-xs text-sky-500 hover:text-sky-700 font-medium transition">+ Add another flight</button>
    </div>
  );
}

export async function saveFlights(tripId: string, flights: Flight[]) {
  await supabase.from('trip_flights').delete().eq('trip_id', tripId);
  const valid = flights.filter(f => f.number.trim());
  if (valid.length > 0) {
    const { error } = await supabase.from('trip_flights').insert(valid.map(f => ({ trip_id: tripId, flight_number: encodeFlightNumber(f) })));
    return error;
  }
  return null;
}

// ─── Place Picker ────────────────────────────────────────────────────

function PlacePicker({ boardId, activeCityFilter, selected, onToggle, onAddExternal }: {
  boardId?: string;
  activeCityFilter?: string | null;
  selected: Map<string, SelectedStop>;
  onToggle: (place: SavedPlace) => void;
  onAddExternal: (stop: SelectedStop) => void;
}) {
  const [places, setPlaces] = useState<SavedPlace[]>([]);
  const [search, setSearch] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<Array<{ name: string; address: string; lat: number; lng: number }>>([]);
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const PICKER_CATEGORIES = ['Restaurant', 'Café', 'Hotel', 'Attraction'] as const;

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const q = supabase.from('places').select('id, name, category, city, lat, lng, address, vibe, tags, source_handle');
      if (boardId) q.eq('board_id', boardId);
      const { data } = await q.order('name');
      if (cancelled || !data) return;
      const rows = data as SavedPlace[];
      if (!activeCityFilter) { setPlaces(rows); return; }
      const center = await geocodeCity(activeCityFilter);
      if (cancelled) return;
      if (center) {
        setPlaces(rows.filter(p => p.lat != null && p.lng != null && haversineKm(center.lat, center.lng, p.lat, p.lng) <= 80));
      } else {
        setPlaces(rows.filter(p => p.city && normaliseCityName(p.city) === normaliseCityName(activeCityFilter)));
      }
    }
    load();
    return () => { cancelled = true; };
  }, [boardId, activeCityFilter]);

  const filtered = places.filter(p => {
    const matchSearch = !search || p.name.toLowerCase().includes(search.toLowerCase()) || p.city?.toLowerCase().includes(search.toLowerCase());
    const matchCategory = activeCategory === null || p.category === activeCategory;
    return matchSearch && matchCategory;
  });

  async function handleSearch() {
    if (!search.trim()) return;
    setSearching(true);
    try {
      const res = await fetch('/projects/tripplanner/api/places', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: search, city: '', country: '' }) });
      if (res.ok) {
        const data = await res.json();
        setSearchResults(Array.isArray(data) ? data.map((r: { formattedAddress?: string; address?: string; lat: number; lng: number }) => ({ name: search, address: r.formattedAddress || r.address || '', lat: r.lat, lng: r.lng })) : []);
      }
    } catch { /* ignore */ }
    setSearching(false);
  }

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <input type="text" value={search} onChange={e => setSearch(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleSearch()}
          placeholder="Search saved places or Google" className={INPUT_CLASS} />
        <button type="button" onClick={handleSearch} disabled={searching}
          className="shrink-0 rounded-lg bg-gray-100 px-3 py-2 text-xs font-medium text-gray-500 transition hover:bg-gray-200 disabled:opacity-40">
          {searching ? '...' : 'Search'}
        </button>
      </div>

      <div className="flex gap-1.5 flex-wrap">
        <button type="button" onClick={() => setActiveCategory(null)}
          className={`rounded-full px-3 py-1 text-xs font-medium transition ${activeCategory === null ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'}`}>All</button>
        {PICKER_CATEGORIES.map(cat => (
          <button key={cat} type="button" onClick={() => setActiveCategory(activeCategory === cat ? null : cat)}
            className={`rounded-full px-3 py-1 text-xs font-medium transition ${activeCategory === cat ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'}`}>{cat}</button>
        ))}
      </div>

      {filtered.length > 0 && (
        <div className="space-y-1 max-h-48 overflow-y-auto">
          {filtered.map(p => {
            const isSelected = selected.has(p.id);
            return (
              <button key={p.id} type="button" onClick={() => onToggle(p)}
                className={`w-full text-left rounded-lg px-3 py-2 text-sm transition ${isSelected ? 'bg-sky-50 border border-sky-200' : 'hover:bg-gray-50 border border-transparent'}`}>
                <span className="mr-1.5">{CATEGORY_EMOJI[p.category?.toLowerCase()] || '📍'}</span>
                <span className="font-medium text-gray-900">{p.name}</span>
                {p.city && <span className="text-gray-400 ml-1.5">{p.city}</span>}
              </button>
            );
          })}
        </div>
      )}

      {searchResults.length > 0 && (
        <div className="border-t border-gray-100 pt-2">
          <p className="text-[11px] text-gray-400 mb-1">Google results</p>
          <div className="space-y-1 max-h-32 overflow-y-auto">
            {searchResults.map((r, i) => (
              <button key={i} type="button" onClick={() => {
                onAddExternal({ place_id: null, name: r.name, address: r.address, lat: r.lat, lng: r.lng, category: 'Attraction', duration_minutes: 60, from_saved: false });
                setSearchResults([]);
              }} className="w-full text-left rounded-lg px-3 py-2 text-sm hover:bg-gray-50 transition">
                <span className="mr-1.5">📍</span>
                <span className="text-gray-700">{r.address}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Day Planner (pick stops) ────────────────────────────────────────

function DayPlanner({ trip, boardId, activeCityFilter, activeLegId, existingDays, onDayCreated, onCancel }: {
  trip: Trip;
  boardId?: string;
  activeCityFilter?: string | null;
  activeLegId?: string | null;
  existingDays: TripDay[];
  onDayCreated: (day: TripDay) => void;
  onCancel: () => void;
}) {
  const [stops, setStops] = useState<Map<string, SelectedStop>>(new Map());
  const [orderedStops, setOrderedStops] = useState<SelectedStop[]>([]);
  const [startTime, setStartTime] = useState('09:00');
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dayDate = getNextDate(trip, existingDays);

  function togglePlace(place: SavedPlace) {
    const next = new Map(stops);
    const key = place.id;
    if (next.has(key)) {
      next.delete(key);
      setOrderedStops(prev => prev.filter(s => s.place_id !== place.id));
    } else {
      const stop: SelectedStop = {
        place_id: place.id, name: place.name, address: place.address || '',
        lat: place.lat || 0, lng: place.lng || 0, category: place.category || 'Attraction',
        duration_minutes: DEFAULT_DURATION[place.category?.toLowerCase()] || 60,
        from_saved: true, vibe: place.vibe, tags: place.tags, source_handle: place.source_handle,
      };
      next.set(key, stop);
      setOrderedStops(prev => [...prev, stop]);
    }
    setStops(next);
  }

  function addExternal(stop: SelectedStop) {
    const key = `ext_${Date.now()}`;
    const next = new Map(stops);
    next.set(key, stop);
    setStops(next);
    setOrderedStops(prev => [...prev, stop]);
  }

  function updateDuration(index: number, minutes: number) {
    setOrderedStops(prev => prev.map((s, i) => i === index ? { ...s, duration_minutes: Math.max(5, minutes) } : s));
  }

  async function buildDay() {
    if (orderedStops.length === 0) return;
    setBuilding(true);
    setError(null);

    try {
      // Fetch travel times between consecutive stops
      const travelTimes: Array<TravelOption[] | null> = [];
      for (let i = 0; i < orderedStops.length - 1; i++) {
        const origin = orderedStops[i];
        const dest = orderedStops[i + 1];
        if (origin.lat && origin.lng && dest.lat && dest.lng) {
          try {
            const res = await fetch('/projects/tripplanner/api/travel-time', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ origin: { lat: origin.lat, lng: origin.lng }, destination: { lat: dest.lat, lng: dest.lng }, modes: ['transit', 'walking', 'driving'] }),
            });
            if (res.ok) { travelTimes.push(await res.json()); } else { travelTimes.push(null); }
          } catch { travelTimes.push(null); }
        } else {
          travelTimes.push(null);
        }
      }

      // Create trip_days row
      const { data: day, error: dayErr } = await supabase.from('trip_days')
        .insert({ trip_id: trip.id, day_date: dayDate, day_order: existingDays.length + 1, leg_id: activeLegId || null })
        .select().single();
      if (dayErr || !day) { setError(dayErr?.message || 'Failed to create day'); setBuilding(false); return; }

      // Build timeline and insert stops
      let currentTime = startTime;
      const stopInserts = orderedStops.map((stop, i) => {
        const thisStart = currentTime;
        currentTime = addMinutes(currentTime, stop.duration_minutes);
        // Add travel time to next stop
        const travel = travelTimes[i];
        let bestMode: string | null = null;
        let bestMinutes: number | null = null;
        if (travel) {
          const valid = travel.filter(t => t.duration_minutes != null);
          if (valid.length > 0) {
            const best = valid.reduce((a, b) => (a.duration_minutes! < b.duration_minutes! ? a : b));
            bestMode = best.mode;
            bestMinutes = best.duration_minutes;
            currentTime = addMinutes(currentTime, bestMinutes || 0);
          }
        }
        return {
          day_id: (day as TripDay).id,
          place_id: stop.place_id,
          name: stop.name,
          address: stop.address,
          lat: stop.lat,
          lng: stop.lng,
          duration_minutes: stop.duration_minutes,
          start_time: thisStart,
          stop_order: i + 1,
          transport_to_next: bestMode,
          travel_minutes_to_next: bestMinutes,
        };
      });

      const { error: stopsErr } = await supabase.from('trip_stops').insert(stopInserts);
      if (stopsErr) { setError(stopsErr.message); setBuilding(false); return; }

      onDayCreated(day as TripDay);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    }
    setBuilding(false);
  }

  return (
    <div className="p-5 space-y-4">
      <button onClick={onCancel} className="text-xs text-gray-400 hover:text-gray-600 font-medium transition">&larr; Back</button>
      <div>
        <h3 className="text-sm font-semibold text-gray-900 mb-0.5">Plan {formatShortDate(dayDate)}</h3>
        <p className="text-[12px] text-gray-400">Pick your stops, set durations, then build your schedule.</p>
      </div>

      <div>
        <label className={LABEL_CLASS}>Start time</label>
        <input type="time" value={startTime} onChange={e => setStartTime(e.target.value)} className={INPUT_CLASS} />
      </div>

      <div>
        <label className={LABEL_CLASS}>Pick your stops</label>
        <p className="text-[12px] text-gray-400 mb-2">{activeCityFilter ? `Showing places from ${activeCityFilter}` : 'Showing all saved places'}</p>
        <PlacePicker boardId={boardId} activeCityFilter={activeCityFilter} selected={stops} onToggle={togglePlace} onAddExternal={addExternal} />
      </div>

      {orderedStops.length > 0 && (
        <div>
          <label className={LABEL_CLASS}>Your stops ({orderedStops.length})</label>
          <div className="space-y-2">
            {orderedStops.map((stop, i) => (
              <div key={i} className="flex items-center gap-2 rounded-lg border border-gray-100 p-2.5">
                <span className="text-sm">{CATEGORY_EMOJI[stop.category?.toLowerCase()] || '📍'}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900 truncate">{stop.name}</p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button type="button" onClick={() => updateDuration(i, stop.duration_minutes - 15)} className="text-gray-300 hover:text-gray-500 text-xs">-</button>
                  <span className="text-xs text-gray-500 w-12 text-center">{formatDuration(stop.duration_minutes)}</span>
                  <button type="button" onClick={() => updateDuration(i, stop.duration_minutes + 15)} className="text-gray-300 hover:text-gray-500 text-xs">+</button>
                </div>
                <button type="button" onClick={() => setOrderedStops(prev => prev.filter((_, idx) => idx !== i))} className="text-gray-300 hover:text-gray-500">
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" /></svg>
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {error && <p className="text-sm text-red-500">{error}</p>}

      <button onClick={buildDay} disabled={orderedStops.length === 0 || building}
        className="w-full rounded-lg bg-gray-900 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed">
        {building ? 'Building schedule...' : 'Build my day'}
      </button>
    </div>
  );
}

// ─── Day View (timeline) ─────────────────────────────────────────────

function DayView({ day, hotelCity, onBack, onAddStop }: { day: TripDay; hotelCity?: string | null; onBack: () => void; onAddStop: () => void }) {
  const [stops, setStops] = useState<DayStop[]>([]);
  const [loading, setLoading] = useState(true);
  const [travelOptions, setTravelOptions] = useState<Map<string, TravelOption[]>>(new Map());
  const [expandedTransit, setExpandedTransit] = useState<string | null>(null);
  const [placeDetail, setPlaceDetail] = useState<DayStop | null>(null);
  const [placeInfo, setPlaceInfo] = useState<{ vibe: string | null; tags: string[]; source_handle: string | null; city?: string | null; google_place_id?: string | null } | null>(null);
  const [research, setResearch] = useState<{ worth_visiting: number; time_to_spend: string; entrance_fee: string; summary: string; basis: string; travel_time_car?: string; travel_time_bike?: string; travel_time_walk?: string; photos?: string[]; google_maps_url: string } | null>(null);
  const [researching, setResearching] = useState(false);
  const [researchError, setResearchError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      const { data } = await supabase.from('trip_stops').select('*').eq('day_id', day.id).order('stop_order');
      if (data) setStops(data as DayStop[]);
      setLoading(false);
    }
    load();
  }, [day.id]);

  // Fetch travel options when expanding a transit card
  async function loadTravelOptions(stopId: string, origin: DayStop, dest: DayStop) {
    if (travelOptions.has(stopId)) { setExpandedTransit(expandedTransit === stopId ? null : stopId); return; }
    setExpandedTransit(stopId);
    try {
      const res = await fetch('/projects/tripplanner/api/travel-time', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ origin: { lat: origin.lat, lng: origin.lng }, destination: { lat: dest.lat, lng: dest.lng }, modes: ['transit', 'walking', 'driving'] }),
      });
      if (res.ok) {
        const data: TravelOption[] = await res.json();
        setTravelOptions(prev => new Map(prev).set(stopId, data));
      }
    } catch { /* ignore */ }
  }

  async function selectTransport(stopId: string, mode: string, minutes: number) {
    await supabase.from('trip_stops').update({ transport_to_next: mode, travel_minutes_to_next: minutes }).eq('id', stopId);
    setStops(prev => prev.map(s => s.id === stopId ? { ...s, transport_to_next: mode, travel_minutes_to_next: minutes } : s));
    setExpandedTransit(null);
  }

  async function showPlaceInfo(stop: DayStop) {
    if (!stop.place_id) return;
    setPlaceDetail(stop);
    setResearch(null); setResearchError(null);
    const { data } = await supabase.from('places').select('vibe, tags, source_handle, city, google_place_id').eq('id', stop.place_id).single();
    if (data) setPlaceInfo(data as { vibe: string | null; tags: string[]; source_handle: string | null; city: string | null; google_place_id: string | null });
  }

  async function runResearch() {
    if (!placeDetail) return;
    setResearching(true); setResearchError(null);
    try {
      const res = await fetch('/projects/tripplanner/api/research', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: placeDetail.name, address: placeDetail.address, city: placeInfo?.city || '', hotelCity: hotelCity || placeInfo?.city || '', google_place_id: placeInfo?.google_place_id || null }),
      });
      const data = await res.json();
      if (!res.ok) { setResearchError(data.error || 'Research failed'); }
      else setResearch(data);
    } catch (e) {
      setResearchError(e instanceof Error ? e.message : 'Research failed');
    }
    setResearching(false);
  }

  if (loading) return <div className="p-5"><p className="text-sm text-gray-400">Loading...</p></div>;

  // Meal gap warnings
  const hasLunchGap = stops.length > 0 && hasMealGap(stops, 12, 14, ['restaurant', 'café', 'cafe']);
  const hasDinnerGap = stops.length > 0 && hasMealGap(stops, 19, 21, ['restaurant']);

  return (
    <div className="p-5 space-y-3">
      <button onClick={onBack} className="text-xs text-gray-400 hover:text-gray-600 font-medium transition">&larr; Back</button>
      <h3 className="text-sm font-semibold text-gray-900">{formatShortDate(day.day_date)}</h3>

      {hasLunchGap && (
        <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-700">No lunch stop between 12:00–14:00 — add one?</div>
      )}
      {hasDinnerGap && (
        <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-700">No dinner stop between 19:00–21:00 — add one?</div>
      )}

      <div className="space-y-0">
        {stops.map((stop, i) => (
          <div key={stop.id}>
            {/* Stop card */}
            <div className="rounded-lg border border-gray-200 bg-white p-3 space-y-1.5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-xs text-gray-400 shrink-0">{stop.start_time}</span>
                  <p className="text-sm font-medium text-gray-900 truncate">{stop.name}</p>
                </div>
                <span className="text-[11px] text-gray-400 bg-gray-50 rounded-full px-2 py-0.5 shrink-0">{formatDuration(stop.duration_minutes)}</span>
              </div>
              {stop.place_id && (
                <button onClick={() => showPlaceInfo(stop)} className="text-[11px] text-violet-500 bg-violet-50 rounded-full px-2 py-0.5 font-medium">Saved</button>
              )}
            </div>

            {/* Transit card between stops */}
            {i < stops.length - 1 && (
              <div className="ml-4 border-l-2 border-gray-100 pl-3 py-1.5">
                <button onClick={() => loadTravelOptions(stop.id, stop, stops[i + 1])}
                  className="text-xs text-gray-400 hover:text-gray-600 transition">
                  {stop.transport_to_next
                    ? <span>{MODE_EMOJI[stop.transport_to_next] || '🚗'} {stop.travel_minutes_to_next} min</span>
                    : <span className="text-gray-300">tap to set transport</span>
                  }
                </button>
                {expandedTransit === stop.id && travelOptions.has(stop.id) && (
                  <div className="mt-1.5 space-y-1">
                    {travelOptions.get(stop.id)!.filter(t => t.duration_minutes != null).map(t => (
                      <button key={t.mode} onClick={() => selectTransport(stop.id, t.mode, t.duration_minutes!)}
                        className={`block w-full text-left rounded-md px-2.5 py-1.5 text-xs transition ${stop.transport_to_next === t.mode ? 'bg-gray-900 text-white' : 'bg-gray-50 text-gray-600 hover:bg-gray-100'}`}>
                        {MODE_EMOJI[t.mode] || ''} {t.duration_text || `${t.duration_minutes} min`}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      <button onClick={onAddStop}
        className="w-full rounded-lg border border-dashed border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-400 transition hover:border-gray-400 hover:text-gray-500">
        + Add stop
      </button>

      {/* Place info slide-up */}
      {placeDetail && placeInfo && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/20" onClick={() => { setPlaceDetail(null); setPlaceInfo(null); setResearch(null); setResearchError(null); }}>
          <div className="bg-white rounded-t-2xl w-full max-w-md p-5 space-y-2 pb-8" onClick={e => e.stopPropagation()}>
            <div className="flex justify-between items-start">
              <h4 className="text-sm font-semibold text-gray-900">{placeDetail.name}</h4>
              <button onClick={() => { setPlaceDetail(null); setPlaceInfo(null); setResearch(null); setResearchError(null); }} className="text-gray-300 hover:text-gray-500">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" /></svg>
              </button>
            </div>
            {placeInfo.vibe && <p className="text-xs italic text-gray-400">{placeInfo.vibe}</p>}
            {placeInfo.source_handle && <p className="text-xs text-sky-500">@{placeInfo.source_handle}</p>}
            {placeInfo.tags?.length > 0 && (
              <div className="flex gap-1.5 flex-wrap">
                {placeInfo.tags.map(t => <span key={t} className="text-[11px] bg-gray-100 text-gray-500 rounded-full px-2 py-0.5">{t}</span>)}
              </div>
            )}

            {!research && (
              <button onClick={runResearch} disabled={researching}
                className="w-full mt-2 rounded-lg bg-gray-900 px-3 py-2 text-xs font-medium text-white transition hover:bg-gray-800 disabled:opacity-40">
                {researching ? 'Researching...' : 'Research this place'}
              </button>
            )}
            {researchError && <p className="text-xs text-red-500">{researchError}</p>}

            {research && (
              <div className="mt-2 rounded-lg border border-gray-100 bg-gray-50 p-3 space-y-2">
                {research.photos && research.photos.length > 0 && (
                  <div className="flex gap-2 overflow-x-auto -mx-3 px-3 pb-1">
                    {research.photos.map((url, i) => (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img key={i} src={url} alt="" className="h-28 w-40 shrink-0 rounded-md object-cover" />
                    ))}
                  </div>
                )}
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="text-[11px] text-gray-400">Worth visiting</div>
                    {research.basis && <div className="text-[11px] text-gray-400 mt-0.5">{research.basis}</div>}
                  </div>
                  <span className="text-sm font-semibold text-gray-900 shrink-0">{research.worth_visiting}/10</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[11px] text-gray-400">Time to spend</span>
                  <span className="text-xs text-gray-700">{research.time_to_spend}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[11px] text-gray-400">Entrance fee</span>
                  <span className="text-xs text-gray-700">{research.entrance_fee}</span>
                </div>
                {(research.travel_time_car || research.travel_time_bike || research.travel_time_walk) && (
                  <div className="space-y-1">
                    <span className="text-[11px] text-gray-400">Travel from hotel</span>
                    <div className="flex gap-3 text-xs text-gray-700">
                      {research.travel_time_car && <span>🚗 {research.travel_time_car}</span>}
                      {research.travel_time_bike && <span>🚲 {research.travel_time_bike}</span>}
                      {research.travel_time_walk && <span>🚶 {research.travel_time_walk}</span>}
                    </div>
                  </div>
                )}
                <p className="text-xs text-gray-600 leading-relaxed border-t border-gray-200 pt-2">{research.summary}</p>
                {research.google_maps_url && (
                  <a href={research.google_maps_url} target="_blank" rel="noopener noreferrer"
                    className="block w-full text-center rounded-lg bg-white border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-100 transition">
                    Open in Maps
                  </a>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Trip View ──────────────────────────────────────────────────────

function TripView({ trip, boardId, activeCityFilter, onBack, onUpdated, onDeleted }: { trip: Trip; boardId?: string; activeCityFilter?: string | null; onBack: () => void; onUpdated: (t: Trip) => void; onDeleted: () => void }) {
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(trip.name);
  const [editStart, setEditStart] = useState(trip.start_date);
  const [editEnd, setEditEnd] = useState(trip.end_date);
  const [editFlights, setEditFlights] = useState<Flight[]>([]);
  const [editLegs, setEditLegs] = useState<LegInput[]>([{ ...EMPTY_LEG }]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [savedFlights, setSavedFlights] = useState<SavedFlight[]>([]);
  const [days, setDays] = useState<TripDay[]>([]);
  const [legs, setLegs] = useState<TripLeg[]>(trip.legs || []);
  const [activeLegId, setActiveLegId] = useState<string | null>(trip.legs && trip.legs.length > 0 ? trip.legs[0].id : null);
  const [planningDay, setPlanningDay] = useState(false);
  const [viewingDay, setViewingDay] = useState<TripDay | null>(null);

  const loadData = useCallback(async () => {
    const [flightsRes, daysRes, legsRes] = await Promise.all([
      supabase.from('trip_flights').select('id, flight_number').eq('trip_id', trip.id),
      supabase.from('trip_days').select('*').eq('trip_id', trip.id).order('day_order'),
      supabase.from('trip_legs').select('*').eq('trip_id', trip.id).order('leg_order'),
    ]);
    if (flightsRes.data) setSavedFlights(flightsRes.data);
    if (daysRes.data) setDays(daysRes.data as TripDay[]);
    if (legsRes.data) {
      const loadedLegs = legsRes.data as TripLeg[];
      setLegs(loadedLegs);
      setActiveLegId(prev => prev && loadedLegs.some(l => l.id === prev) ? prev : (loadedLegs[0]?.id ?? null));
    }
  }, [trip.id]);

  useEffect(() => { loadData(); }, [loadData]);

  function startEditing() {
    setEditName(trip.name); setEditStart(trip.start_date); setEditEnd(trip.end_date);
    setEditFlights(savedFlights.length > 0 ? savedFlights.map(f => parseFlightString(f.flight_number)) : [{ number: '', date: '', assignedTo: 'Both' as AssignedTo, direction: 'Arriving' as Direction }]);
    setEditLegs(legs.length > 0
      ? legs.map(l => ({ id: l.id, city: l.city, country: l.country || '', start_date: l.start_date || '', end_date: l.end_date || '', hotel: l.hotel || '' }))
      : [{ ...EMPTY_LEG }]);
    setError(null); setEditing(true);
  }

  async function handleSave() {
    if (legsMissingCountry(editLegs)) { setError('Add a country for each city'); return; }
    setSaving(true); setError(null);
    const { error: tripErr } = await supabase.from('trips').update({ name: editName, start_date: editStart, end_date: editEnd }).eq('id', trip.id);
    if (tripErr) { setError(tripErr.message); setSaving(false); return; }
    const flightErr = await saveFlights(trip.id, editFlights);
    if (flightErr) { setError(flightErr.message); setSaving(false); return; }
    // Update legs in place so trip_days.leg_id links survive. Never delete-then-insert.
    const keptLegs = editLegs.filter(l => l.city.trim());
    const rows = keptLegs.map((l, i) => ({ trip_id: trip.id, city: l.city.trim(), country: l.country.trim(), start_date: l.start_date || null, end_date: l.end_date || null, leg_order: i, hotel: l.hotel.trim() || null }));
    for (let i = 0; i < keptLegs.length; i++) {
      const id = keptLegs[i].id;
      const { error: legErr } = id
        ? await supabase.from('trip_legs').update(rows[i]).eq('id', id)
        : await supabase.from('trip_legs').insert(rows[i]);
      if (legErr) { setError(legErr.message); setSaving(false); return; }
    }
    const keptIds = new Set(keptLegs.map(l => l.id).filter(Boolean));
    const removedIds = legs.map(l => l.id).filter(id => !keptIds.has(id));
    if (removedIds.length > 0) {
      const { error: delErr } = await supabase.from('trip_legs').delete().in('id', removedIds);
      if (delErr) { setError(delErr.message); setSaving(false); return; }
    }
    await loadData();
    setSaving(false); setEditing(false);
    onUpdated({ ...trip, name: editName, start_date: editStart, end_date: editEnd });
  }

  async function handleDelete() {
    setDeleting(true);
    // Delete stops for all days
    for (const d of days) { await supabase.from('trip_stops').delete().eq('day_id', d.id); }
    await supabase.from('trip_days').delete().eq('trip_id', trip.id);
    await supabase.from('trip_flights').delete().eq('trip_id', trip.id);
    const { error: err } = await supabase.from('trips').delete().eq('id', trip.id);
    if (err) { setError(err.message); setDeleting(false); return; }
    onDeleted();
  }

  const activeLeg = legs.find(l => l.id === activeLegId) || null;
  const legCityFilter = activeLeg ? activeLeg.city : activeCityFilter;
  const visibleDays = activeLegId ? days.filter(d => d.leg_id === activeLegId) : days;

  // Sub-views
  if (planningDay) {
    return (
      <DayPlanner trip={trip} boardId={boardId} activeCityFilter={legCityFilter} activeLegId={activeLegId} existingDays={days}
        onDayCreated={(day) => { setDays(prev => [...prev, day]); setPlanningDay(false); setViewingDay(day); }}
        onCancel={() => setPlanningDay(false)} />
    );
  }

  if (viewingDay) {
    return (
      <DayView day={viewingDay} hotelCity={(() => { const l = legs.find(x => x.id === viewingDay.leg_id); return l?.hotel || l?.city || null; })()} onBack={() => setViewingDay(null)}
        onAddStop={() => { setViewingDay(null); setPlanningDay(true); }} />
    );
  }

  if (editing) {
    return (
      <div className="p-5 space-y-5">
        <div>
          <label className={LABEL_CLASS}>Trip name</label>
          <input type="text" value={editName} onChange={e => setEditName(e.target.value)} className={INPUT_CLASS} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div><label className={LABEL_CLASS}>Start date</label><input type="date" value={editStart} onChange={e => setEditStart(e.target.value)} className={INPUT_CLASS} /></div>
          <div><label className={LABEL_CLASS}>End date</label><input type="date" value={editEnd} onChange={e => setEditEnd(e.target.value)} className={INPUT_CLASS} /></div>
        </div>
        <LegsFields legs={editLegs} onChange={setEditLegs} />
        <FlightFields flights={editFlights} onChange={setEditFlights} />
        <div className="pt-2 space-y-3">
          <button onClick={handleSave} disabled={!editName.trim() || !editStart || !editEnd || saving}
            className="w-full rounded-lg bg-gray-900 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed">
            {saving ? 'Saving...' : 'Save Changes'}
          </button>
          {error && <p className="text-sm text-red-500 text-center">{error}</p>}
          <button onClick={() => { setEditing(false); setError(null); }} className="w-full text-sm text-gray-400 hover:text-gray-600 transition">Cancel</button>
        </div>
      </div>
    );
  }

  return (
    <div className="p-5 space-y-4">
      <button onClick={onBack} className="text-xs text-gray-400 hover:text-gray-600 font-medium transition">&larr; New trip</button>

      <div className="rounded-xl border border-gray-200 bg-white p-4 space-y-3">
        <div className="flex items-start justify-between">
          <div className="space-y-1">
            <h3 className="text-base font-semibold text-gray-900">{trip.name}</h3>
            <p className="text-xs text-gray-400">{formatDate(trip.start_date)} &ndash; {formatDate(trip.end_date)}</p>
          </div>
          <div className="flex gap-3 shrink-0">
            <button onClick={startEditing} className="text-xs text-gray-400 hover:text-gray-600 font-medium transition">Edit</button>
            <button onClick={() => setConfirmDelete(true)} className="text-xs text-red-400 hover:text-red-500 font-medium transition">Delete</button>
          </div>
        </div>

        {savedFlights.length > 0 && (
          <div className="border-t border-gray-100 pt-2 space-y-1">
            {savedFlights.map(f => <p key={f.id} className="text-xs text-gray-400">{f.flight_number}</p>)}
          </div>
        )}

        {confirmDelete && (
          <div className="border-t border-gray-100 pt-3 space-y-2">
            <p className="text-xs font-medium text-gray-600">Delete this trip?</p>
            {error && <p className="text-xs text-red-500">{error}</p>}
            <div className="flex gap-2">
              <button onClick={handleDelete} disabled={deleting}
                className="rounded-lg bg-red-500 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-red-600 disabled:opacity-40">
                {deleting ? 'Deleting...' : 'Yes, delete'}
              </button>
              <button onClick={() => setConfirmDelete(false)} className="text-xs text-gray-400 hover:text-gray-600 transition">Cancel</button>
            </div>
          </div>
        )}
      </div>

      {/* City leg tabs */}
      {legs.length > 0 ? (
        <div className="flex gap-1 flex-wrap">
          {legs.map(l => (
            <button key={l.id} onClick={() => { setActiveLegId(l.id); window.dispatchEvent(new CustomEvent('flyToCity', { detail: { city: l.city } })); }}
              className={`rounded-full px-2.5 py-1 text-xs font-medium transition ${activeLegId === l.id ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'}`}>
              {l.city}
            </button>
          ))}
        </div>
      ) : (
        <p className="text-xs text-gray-400">No cities added</p>
      )}

      {/* Planned days */}
      {visibleDays.length > 0 && (
        <div className="space-y-2">
          {visibleDays.map(d => (
            <button key={d.id} onClick={() => setViewingDay(d)}
              className="w-full text-left rounded-lg border border-gray-200 bg-white px-4 py-3 transition hover:border-gray-300">
              <span className="text-sm font-medium text-gray-900">{formatShortDate(d.day_date)}</span>
              <span className="text-xs text-gray-400 ml-2">Day {d.day_order}</span>
            </button>
          ))}
        </div>
      )}

      <button onClick={() => setPlanningDay(true)}
        className="w-full rounded-lg border border-dashed border-gray-300 px-4 py-3 text-sm font-medium text-gray-400 transition hover:border-gray-400 hover:text-gray-500">
        {visibleDays.length > 0 ? '+ Plan another day' : '+ Plan a day'}
      </button>
    </div>
  );
}

// ─── Legs Fields ─────────────────────────────────────────────────────

export function LegsFields({ legs, onChange }: { legs: LegInput[]; onChange: (legs: LegInput[]) => void }) {
  function update(i: number, field: keyof LegInput, value: string) {
    onChange(legs.map((l, idx) => idx === i ? { ...l, [field]: value } : l));
  }
  return (
    <div className="border-t border-gray-100 pt-5">
      <label className={LABEL_CLASS}>Cities</label>
      <div className="space-y-2">
        {legs.map((leg, i) => (
          <div key={i} className="flex gap-2 items-start rounded-lg border border-gray-100 p-2.5">
            <div className="flex-1 space-y-2">
              <div className="grid grid-cols-2 gap-2">
                <input type="text" value={leg.city} onChange={e => update(i, 'city', e.target.value)} placeholder="City, e.g. Hanoi" className={INPUT_CLASS} />
                <input type="text" value={leg.country} onChange={e => update(i, 'country', e.target.value)} placeholder="Country, e.g. Vietnam" className={INPUT_CLASS} />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <input type="date" value={leg.start_date} onChange={e => update(i, 'start_date', e.target.value)} className={INPUT_CLASS} />
                <input type="date" value={leg.end_date} onChange={e => update(i, 'end_date', e.target.value)} className={INPUT_CLASS} />
              </div>
              <input type="text" value={leg.hotel} onChange={e => update(i, 'hotel', e.target.value)} placeholder="Hotel" className={INPUT_CLASS} />
            </div>
            {legs.length > 1 && (
              <button type="button" onClick={() => onChange(legs.filter((_, idx) => idx !== i))} className="mt-2 text-gray-300 hover:text-gray-500 transition">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" /></svg>
              </button>
            )}
          </div>
        ))}
      </div>
      <button type="button" onClick={() => onChange([...legs, { ...EMPTY_LEG }])}
        className="mt-2 text-xs text-sky-500 hover:text-sky-700 font-medium transition">+ Add city</button>
    </div>
  );
}

// ─── New Trip Form ──────────────────────────────────────────────────

function NewTripForm({ boardId, onCancel, onCreated }: { boardId?: string; onCancel: () => void; onCreated: (trip: Trip) => void }) {
  const [name, setName] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [flights, setFlights] = useState<Flight[]>([{ number: '', date: '', assignedTo: 'Both', direction: 'Arriving' }]);
  const [tripLegs, setTripLegs] = useState<LegInput[]>([{ ...EMPTY_LEG }]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (legsMissingCountry(tripLegs)) { setError('Add a country for each city'); return; }
    setSaving(true); setError(null);
    const { data: trip, error: tripError } = await supabase.from('trips')
      .insert({ name, start_date: startDate, end_date: endDate, ...(boardId ? { board_id: boardId } : {}) })
      .select().single();
    if (tripError || !trip) { setError(tripError?.message || 'Failed to create trip'); setSaving(false); return; }
    const flightErr = await saveFlights(trip.id, flights);
    if (flightErr) { setError(flightErr.message); setSaving(false); return; }
    const legsToInsert = tripLegs
      .filter(l => l.city.trim())
      .map((l, i) => ({ trip_id: (trip as Trip).id, city: l.city.trim(), country: l.country.trim(), start_date: l.start_date || null, end_date: l.end_date || null, leg_order: i, hotel: l.hotel.trim() || null }));
    if (legsToInsert.length > 0) {
      const { error: legsErr } = await supabase.from('trip_legs').insert(legsToInsert);
      if (legsErr) { setError(legsErr.message); setSaving(false); return; }
    }
    const { data: legsData } = await supabase.from('trip_legs').select('*').eq('trip_id', (trip as Trip).id).order('leg_order');
    setSaving(false);
    setTripLegs([{ ...EMPTY_LEG }]);
    onCreated({ ...(trip as Trip), legs: (legsData as TripLeg[]) || [] });
  }

  return (
    <form onSubmit={handleSubmit} className="p-5 space-y-5">
      <div><label className={LABEL_CLASS}>Trip name</label><input type="text" value={name} onChange={e => setName(e.target.value)} placeholder="Shanghai trip" className={INPUT_CLASS} required /></div>
      <div className="grid grid-cols-2 gap-3">
        <div><label className={LABEL_CLASS}>Start date</label><input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} className={INPUT_CLASS} required /></div>
        <div><label className={LABEL_CLASS}>End date</label><input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} className={INPUT_CLASS} required /></div>
      </div>
      <LegsFields legs={tripLegs} onChange={setTripLegs} />
      <FlightFields flights={flights} onChange={setFlights} />
      <div className="pt-2 space-y-3">
        <button type="submit" disabled={!name.trim() || !startDate || !endDate || saving}
          className="w-full rounded-lg bg-gray-900 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed">
          {saving ? 'Creating...' : 'Create Trip'}
        </button>
        {error && <p className="text-sm text-red-500 text-center">{error}</p>}
        <button type="button" onClick={onCancel} className="w-full text-sm text-gray-400 hover:text-gray-600 transition">Cancel</button>
      </div>
    </form>
  );
}

// ─── Main ScheduleTab ───────────────────────────────────────────────

export default function ScheduleTab({ boardId, activeCityFilter }: { boardId?: string; activeCityFilter?: string | null }) {
  const [view, setView] = useState<'empty' | 'form' | 'trip'>('empty');
  const [activeTrip, setActiveTrip] = useState<Trip | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadTrips() {
      const query = supabase.from('trips').select('*').order('created_at', { ascending: false }).limit(1);
      if (boardId) query.eq('board_id', boardId);
      const { data } = await query;
      if (data && data.length > 0) {
        const trips = data as Trip[];
        const { data: legsData } = await supabase
          .from('trip_legs')
          .select('*')
          .in('trip_id', trips.map(t => t.id))
          .order('leg_order');
        trips.forEach(t => { t.legs = (legsData as TripLeg[] | null)?.filter(l => l.trip_id === t.id) || []; });
        setActiveTrip(trips[0]);
        setView('trip');
      }
      setLoading(false);
    }
    loadTrips();
  }, [boardId]);

  if (loading) return <div className="flex items-center justify-center h-full"><p className="text-sm text-gray-400">Loading...</p></div>;

  if (view === 'trip' && activeTrip) {
    return <TripView trip={activeTrip} boardId={boardId} activeCityFilter={activeCityFilter} onBack={() => { setActiveTrip(null); setView('form'); }} onUpdated={t => setActiveTrip(t)} onDeleted={() => { setActiveTrip(null); setView('empty'); }} />;
  }

  if (view === 'form') {
    return <NewTripForm boardId={boardId} onCancel={() => setView('empty')} onCreated={trip => { setActiveTrip(trip); setView('trip'); }} />;
  }

  return (
    <div className="flex flex-col items-center justify-center h-full p-8 text-center">
      <div className="w-12 h-12 rounded-full bg-gray-100 flex items-center justify-center mb-4">
        <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
        </svg>
      </div>
      <h3 className="text-sm font-medium text-gray-900 mb-1">No trips yet</h3>
      <p className="text-xs text-gray-400 mb-6">Plan your first trip to get started</p>
      <button onClick={() => setView('form')} className="rounded-lg bg-sky-500 px-4 py-2 text-sm font-medium text-white transition hover:bg-sky-600">+ New Trip</button>
    </div>
  );
}
