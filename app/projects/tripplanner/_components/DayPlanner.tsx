'use client';

// Day planner inside the trip view: one tab per trip day, an ordered list of stops
// from the hotel, estimated arrival times, and "be there by" deadlines.
import { BedDouble, MapPin, PlaneLanding, PlaneTakeoff, Sunset } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '@/lib/trip/supabase';
import type { WeatherDay } from '@/lib/trip/weather';
import { findDuplicate, insertPlaces } from '@/lib/trip/places';
import { buildChatContext, describeChange, type ChatCodes, type ChatDay, type ChatProposal } from '@/lib/trip/chatContext';
import { ScheduleChat } from '@/app/projects/tripplanner/_components/ScheduleChat';
import { amapLinks, getCategory, googleMapsUrl, normalizeCategory, type Category, type SavedPlace } from '@/app/projects/tripplanner/_components/placeTypes';
import {
  computeDay, dayHops, dayLabel, defaultMinutes, fmtDuration, fmtTime, parseFlight, toMinutes, tripDates,
  AIRPORTS, AIRPORT_ARRIVAL_BUFFER, AIRPORT_DEPARTURE_BUFFER, DEFAULT_DAY_START,
  type LatLng, type PlanStop, type TimeRule, type TripFlight,
} from '@/lib/trip/dayPlan';
import {
  defaultMode, fmtEuro, hopKey, localToIso, modeInUse, zoneFor, MODE_EMOJI, MODE_LABEL,
  type DayTravel, type HopCache, type HopMode, type HopResult,
} from '@/lib/trip/travel';

const BAGS_STOP_ID = '__bags';
const DAY_COLS = 'id, date, day_number, leg_id, start_time, start_kind, bags_minutes, plan_name, plan_active, created_at';
const STOP_COLS = 'id, day_id, place_id, name, address, lat, lng, duration_minutes, stop_order, fixed_time, arrive_by, duration_source, note, kind';
// travel_options is read separately-tolerant: until the column exists the planner still works.
let hasTravelColumn = true;
const dayCols = () => (hasTravelColumn ? `${DAY_COLS}, travel_options` : DAY_COLS);
const missingColumn = (msg?: string) => !!msg && msg.includes('travel_options');
const BAGS_MINUTES = 30;
const HOTEL_REST_MINUTES = 60;
// Singular names for the exported day list.
const TYPE_NAME: Record<Category, string> = {
  Restaurant: 'Restaurant', Snacks: 'Snacks', Café: 'Café', Bar: 'Bar', Shopping: 'Shopping', Museum: 'Museum',
  Attraction: 'Sight', Nature: 'Nature', Area: 'Area', Photobooth: 'Photobooth', Hotel: 'Hotel',
};
const mapsSearch = (q: string) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;

export interface PlannerLeg {
  id: string;
  city: string;
  country?: string | null;
  start_date: string | null;
  end_date: string | null;
  hotel: string | null;
  hotel_lat: number | null;
  hotel_lng: number | null;
}

interface DayRow {
  id: string;
  date: string;
  day_number: number;
  leg_id: string | null;
  start_time: string | null;
  start_kind: string | null;
  bags_minutes: number | null;        // time at the hotel dropping bags on an arrival day
  plan_name: string | null;           // null = the day's Main plan; named rows are alternative plans
  plan_active: boolean | null;        // the plan currently in use for that date
  created_at: string;
  travel_options: DayTravel | null;   // real travel times per hop, see lib/travel.ts
}

interface StopRow {
  id: string;
  day_id: string;
  place_id: string | null;
  name: string;
  address: string | null;
  lat: number | null;
  lng: number | null;
  duration_minutes: number | null;
  stop_order: number;
  fixed_time: string | null;
  arrive_by: string | null;
  duration_source: string | null;
  note: string | null;
  kind: 'hotel' | 'custom' | null;    // null = a saved place
}

interface OneOffHit { lat: number; lng: number; name: string; address: string | null }

interface Props {
  tripId: string;
  startDate: string;
  endDate: string;
  legs: PlannerLeg[];
  places: SavedPlace[];                 // the trip's places, for the picker and emojis
  onFocusPlace?: (place: SavedPlace) => void;
  addRequest?: { place: SavedPlace; nonce: number; date?: string } | null;   // "+ Add to day" from the map or search; date = a specific day
  goToDate?: { date: string; nonce: number } | null;           // open this day (from the search bar)
  onActiveDayChange?: (label: string) => void;
  onAdded?: (place: SavedPlace, dayLabel: string) => void;
  onRouteChange?: (route: { lat: number; lng: number; label: string | null }[]) => void;
  readOnly?: boolean;                  // view links and visitors: look, don't change
  onEditTrip?: () => void;             // opens Edit trip (used by the missing-flight notes)
  tripName?: string;                   // for the schedule chat
  onPlacesCreated?: (saved: SavedPlace[]) => void; // places the chat saved from Google
  onPlannedChange?: (p: { byPlace: Record<string, string[]>; activeDate: string }) => void; // saved places in each date's chosen plan
  onAddHandled?: () => void;           // clears addRequest so a remount can't replay it
  weather?: Record<string, WeatherDay>; // forecast per date, for the sunset line
}

const hhmm = (t: string | null) => (t ? t.slice(0, 5) : null);

function ruleOf(s: StopRow): TimeRule {
  if (s.fixed_time) return 'exact';
  if (s.arrive_by) return 'by';
  return 'flexible';
}

export function DayPlanner({ tripId, startDate, endDate, legs, places, onFocusPlace, addRequest, onActiveDayChange, onAdded, onRouteChange, readOnly = false, onEditTrip, tripName, onPlacesCreated, onPlannedChange, onAddHandled, weather, goToDate }: Props) {
  const dates = useMemo(() => tripDates(startDate, endDate), [startDate, endDate]);
  const [activeDate, setActiveDate] = useState<string>(dates[0] ?? '');
  const [days, setDays] = useState<DayRow[]>([]);
  const [stops, setStops] = useState<StopRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [pickQuery, setPickQuery] = useState('');
  const [editingTime, setEditingTime] = useState<string | null>(null);
  const [flights, setFlights] = useState<TripFlight[]>([]);
  const [flightsLoaded, setFlightsLoaded] = useState(false);
  const [airportPos, setAirportPos] = useState<Record<string, LatLng>>(AIRPORTS);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  const [fetchingTimes, setFetchingTimes] = useState<{ done: number; total: number } | null>(null);
  const [editingNote, setEditingNote] = useState<string | null>(null);
  const [oneOff, setOneOff] = useState<{ loading: boolean; hits: OneOffHit[]; error: string | null } | null>(null);

  const placeById = useMemo(() => new Map(places.map(p => [p.id, p])), [places]);

  const load = useCallback(async () => {
    setLoading(true);
    let { data: dayData, error: dayErr } = await supabase.from('trip_days').select(dayCols()).eq('trip_id', tripId);
    if (dayErr && missingColumn(dayErr.message)) {
      hasTravelColumn = false;
      ({ data: dayData, error: dayErr } = await supabase.from('trip_days').select(dayCols()).eq('trip_id', tripId));
    }
    if (dayErr) { setError(dayErr.message); setLoading(false); return; }
    const dayRows = (dayData || []) as unknown as DayRow[];
    setDays(dayRows);
    if (dayRows.length > 0) {
      const { data: stopData, error: stopErr } = await supabase
        .from('trip_stops')
        .select(STOP_COLS)
        .in('day_id', dayRows.map(d => d.id));
      if (stopErr) { setError(stopErr.message); setLoading(false); return; }
      setStops((stopData || []) as StopRow[]);
    } else {
      setStops([]);
    }
    setError(null);
    setLoading(false);
  }, [tripId]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    supabase.from('trip_flights').select('flight_number').eq('trip_id', tripId).then(({ data }) => {
      setFlights((data || []).map((r: { flight_number: string }) => parseFlight(r.flight_number)).filter((f: TripFlight | null): f is TripFlight => !!f));
      setFlightsLoaded(true);
    });
  }, [tripId]);

  // Airports not in the built-in list are looked up once.
  useEffect(() => {
    const codes = Array.from(new Set(flights.flatMap(f => [f.from, f.to]).filter((c): c is string => !!c)))
      .filter(c => !airportPos[c]);
    codes.forEach(async code => {
      try {
        const res = await fetch('/projects/tripplanner/api/geocode-hotel', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: `${code} international airport` }),
        });
        if (!res.ok) return;
        const hit = await res.json() as { lat: number; lng: number };
        setAirportPos(prev => ({ ...prev, [code]: { lat: hit.lat, lng: hit.lng } }));
      } catch { /* ignore: falls back to no travel estimate */ }
    });
  }, [flights, airportPos]);
  useEffect(() => { if (!dates.includes(activeDate) && dates[0]) setActiveDate(dates[0]); }, [dates, activeDate]);

  const legFor = useCallback((date: string): PlannerLeg | undefined =>
    legs.find(l => l.start_date && l.end_date && l.start_date <= date && date <= l.end_date) ?? legs[0], [legs]);

  // Plans for a date: Main (unnamed row) first, then named plans in the order they were made.
  // Old duplicate unnamed rows are collapsed: only the one with the most stops counts as Main.
  const plansFor = useCallback((date: string): DayRow[] => {
    const rows = days.filter(d => d.date === date);
    const count = (id: string) => stops.filter(s => s.day_id === id).length;
    const main = rows.filter(d => !d.plan_name).sort((a, b) => count(b.id) - count(a.id))[0];
    const named = rows.filter(d => d.plan_name).sort((a, b) => a.created_at.localeCompare(b.created_at));
    return main ? [main, ...named] : named;
  }, [days, stops]);
  // Visitors can flip between plans without saving; this holds their pick per date.
  const [viewPlan, setViewPlan] = useState<Record<string, string>>({});
  const dayFor = useCallback((date: string): DayRow | undefined => {
    const plans = plansFor(date);
    return plans.find(p => p.id === viewPlan[date]) ?? plans.find(p => p.plan_active) ?? plans[0];
  }, [plansFor, viewPlan]);
  const day = dayFor(activeDate);
  const plans = plansFor(activeDate);
  const [planForm, setPlanForm] = useState<{ mode: 'new' | 'rename'; name: string } | null>(null);
  const [confirmDeletePlan, setConfirmDeletePlan] = useState(false);
  const [swapOpen, setSwapOpen] = useState(false);
  const activeLabel = activeDate ? (() => { const l = dayLabel(activeDate); return `${l.weekday} ${l.day}`; })() : '';
  useEffect(() => { if (activeLabel) onActiveDayChange?.(activeLabel); }, [activeLabel, onActiveDayChange]);
  const leg = legFor(activeDate);
  const hotelPos: LatLng | null = leg?.hotel_lat != null && leg?.hotel_lng != null ? { lat: leg.hotel_lat, lng: leg.hotel_lng } : null;
  const dayStops = useMemo(
    () => (day ? stops.filter(s => s.day_id === day.id).sort((a, b) => a.stop_order - b.stop_order) : []),
    [stops, day],
  );
  // The Arriving/Departing toggle defaults to Arriving, so a flight home saved without touching it
  // would "land" on the last day. A flight on the trip's last day (of a multi-day trip) is the way home.
  const dirOf = (f: TripFlight): TripFlight['direction'] =>
    f.direction === 'Arriving' && dates.length > 1 && f.date === dates[dates.length - 1] ? 'Departing' : f.direction;
  const arrival = flights.find(f => dirOf(f) === 'Arriving' && f.date === activeDate);
  const departure = flights.find(f => dirOf(f) === 'Departing' && f.date === activeDate);
  // Nudges when the first / last day has no flight, so the normal start and hotel end aren't silent guesses.
  const missingArrival = !readOnly && flightsLoaded && activeDate === dates[0] && !flights.some(f => dirOf(f) === 'Arriving');
  const missingDeparture = !readOnly && flightsLoaded && dates.length > 0 && activeDate === dates[dates.length - 1]
    && !flights.some(f => dirOf(f) === 'Departing');
  const addFlightsLink = onEditTrip
    ? <button onClick={onEditTrip} className="font-medium text-sky-600 underline-offset-2 hover:underline">Add flights in Edit trip</button>
    : <span>Add flights in Edit trip</span>;
  const landAt = toMinutes(arrival?.arrives);
  const flightStart = landAt != null ? landAt + AIRPORT_ARRIVAL_BUFFER : null;
  const customStart = day?.start_kind === 'custom' ? hhmm(day.start_time) : null;
  const arrivalAirport = arrival?.to ? airportPos[arrival.to] ?? null : null;
  const departureAirport = departure?.from ? airportPos[departure.from] ?? null : null;
  const takeOff = toMinutes(departure?.departs);
  const airportBy = takeOff != null ? takeOff - AIRPORT_DEPARTURE_BUFFER : null;

  const fromFlight = flightStart != null;
  const startTime = customStart
    ?? (fromFlight ? fmtTime(flightStart!) : hhmm(day?.start_time ?? null) ?? DEFAULT_DAY_START);
  const startPos = fromFlight ? arrivalAirport : hotelPos;
  const endPos = departure ? departureAirport : hotelPos;

  const bagsStop: PlanStop[] = fromFlight && hotelPos
    ? [{ id: BAGS_STOP_ID, name: 'Drop bags', pos: hotelPos, minutes: day?.bags_minutes ?? BAGS_MINUTES, rule: 'flexible', time: null }]
    : [];

  const baseStops: PlanStop[] = [...bagsStop, ...dayStops.map(s => ({
    id: s.id,
    name: s.name,
    // Hotel rests follow the leg's hotel, so changing the hotel moves them too.
    pos: s.kind === 'hotel' ? hotelPos : s.lat != null && s.lng != null ? { lat: s.lat, lng: s.lng } : null,
    minutes: s.duration_minutes ?? 60,
    rule: ruleOf(s),
    time: hhmm(s.fixed_time ?? s.arrive_by),
  }))];

  // Real travel times: cached per hop on the day, keyed by the hop's two end points.
  const travel: DayTravel = day?.travel_options ?? {};
  const showBack = dayStops.length > 0 || !!departure;
  const hops = dayHops(startPos, baseStops, showBack ? endPos : null);
  const cacheFor = (h: { from: LatLng; to: LatLng } | null): HopCache | undefined => (h ? travel[hopKey(h.from, h.to)] : undefined);
  const minutesFor = (c: HopCache | undefined): number | null => {
    const m = c ? modeInUse(c) : null;
    return c && m ? c.result[m].minutes : null;
  };
  const planStops: PlanStop[] = baseStops.map((s, i) => ({ ...s, travelMinutes: minutesFor(cacheFor(hops.into[i])) }));
  const timing = computeDay(startTime, startPos, planStops, endPos, minutesFor(cacheFor(hops.back)));
  const hopCacheById = new Map(baseStops.map((s, i) => [s.id, { hop: hops.into[i], cache: cacheFor(hops.into[i]) }]));
  const backCache = cacheFor(hops.back);
  const allHops = [...hops.into, hops.back].filter((h): h is { from: LatLng; to: LatLng } => !!h);
  const missingHops = allHops.filter(h => !travel[hopKey(h.from, h.to)]).length;
  const zone = zoneFor(leg?.country);

  // Tell the map the day's route: start, numbered stops, then the end point.
  const routePoints: { lat: number; lng: number; label: string | null; airport?: boolean }[] = [];
  if (startPos) routePoints.push({ ...startPos, label: null, ...(fromFlight ? { airport: true } : {}) });
  let stopNo = 0;
  const pinNo = new Map<string, number>();   // stop id -> its number on the map
  for (const s of baseStops) {
    if (!s.pos) continue;
    if (s.id !== BAGS_STOP_ID) pinNo.set(s.id, ++stopNo);
    routePoints.push({ ...s.pos, label: s.id === BAGS_STOP_ID ? null : String(stopNo) });
  }
  if (showBack && endPos) routePoints.push({ ...endPos, label: null, ...(departure ? { airport: true } : {}) });
  const routeSig = loading ? '' : JSON.stringify(routePoints);
  useEffect(() => {
    if (routeSig) onRouteChange?.(JSON.parse(routeSig));
  }, [routeSig, onRouteChange]);
  useEffect(() => () => onRouteChange?.([]), [onRouteChange]);
  // Saved places in each date's chosen plan (the highlighted plan chip), for fading pins on the map.
  const plannedSig = loading ? '' : JSON.stringify((() => {
    const byPlace: Record<string, string[]> = {};
    for (const date of dates) {
      const d = dayFor(date);
      if (!d) continue;
      for (const st of stops) if (st.day_id === d.id && st.place_id) (byPlace[st.place_id] ??= []).includes(date) || byPlace[st.place_id].push(date);
    }
    return { byPlace, activeDate };
  })());
  useEffect(() => {
    if (plannedSig) onPlannedChange?.(JSON.parse(plannedSig));
  }, [plannedSig, onPlannedChange]);
  const bagsTiming = timing.stops.find(t => t.id === BAGS_STOP_ID);
  const endLate = airportBy != null && timing.backAt != null ? timing.backAt - airportBy : null;
  const timingById = new Map(timing.stops.map(t => [t.id, t]));
  // Sunset sits before the first stop you reach after it, or after the last stop.
  const sunsetAt = toMinutes(weather?.[activeDate]?.sunset);
  const sunsetBefore = sunsetAt == null ? -1 : (() => {
    const i = dayStops.findIndex(st => { const tt = timingById.get(st.id); return tt != null && tt.arrive > sunsetAt; });
    return i === -1 ? dayStops.length : i;
  })();

  // Days are created the first time you touch them.
  const creatingDay = useRef<Map<string, Promise<DayRow | null>>>(new Map());
  async function ensureDay(): Promise<DayRow | null> {
    if (day) return day;
    // Two quick taps must not create two rows for the same date.
    const pending = creatingDay.current.get(activeDate);
    if (pending) return pending;
    const p = createDay();
    creatingDay.current.set(activeDate, p);
    try { return await p; } finally { creatingDay.current.delete(activeDate); }
  }

  async function createDay(): Promise<DayRow | null> {
    const { data, error: err } = await supabase.from('trip_days').insert({
      trip_id: tripId,
      date: activeDate,
      day_number: dates.indexOf(activeDate) + 1,
      leg_id: leg?.id ?? null,
      start_time: DEFAULT_DAY_START,
      start_kind: 'hotel',
    }).select(dayCols()).single();
    if (err || !data) { setError(err?.message || 'Could not create the day'); return null; }
    setDays(prev => [...prev, data as unknown as DayRow]);
    return data as unknown as DayRow;
  }

  // ---- Alternative plans for a day (e.g. a rainy-day plan) ----
  async function setActivePlan(date: string, id: string) {
    if (readOnly) { setViewPlan(prev => ({ ...prev, [date]: id })); return; }
    setViewPlan(prev => { const n = { ...prev }; delete n[date]; return n; });
    const ids = plansFor(date).map(p => p.id);
    setDays(prev => prev.map(x => (ids.includes(x.id) ? { ...x, plan_active: x.id === id } : x)));
    const others = ids.filter(x => x !== id);
    const results = await Promise.all([
      supabase.from('trip_days').update({ plan_active: true }).eq('id', id),
      ...(others.length ? [supabase.from('trip_days').update({ plan_active: false }).in('id', others)] : []),
    ]);
    const failed = results.find(r => r.error);
    if (failed?.error) setError(planError(failed.error.message));
  }

  function planError(msg: string) {
    return msg.includes('plan_') ? 'Plans need one database change first (supabase/010_day_plans.sql). Run it, then reload.' : msg;
  }

  async function addPlan(name: string) {
    const clean = name.trim();
    if (!clean) return;
    const main = await ensureDay();   // make sure Main exists, so it isn't lost
    if (!main) return;
    const { data, error: err } = await supabase.from('trip_days').insert({
      trip_id: tripId,
      date: activeDate,
      day_number: dates.indexOf(activeDate) + 1,
      leg_id: leg?.id ?? null,
      start_time: main.start_time ?? DEFAULT_DAY_START,
      start_kind: main.start_kind ?? 'hotel',
      bags_minutes: main.bags_minutes,
      plan_name: clean,
      plan_active: false,
    }).select(dayCols()).single();
    if (err || !data) { setError(planError(err?.message || 'Could not add the plan')); return; }
    const row = data as unknown as DayRow;
    setDays(prev => [...prev, row]);
    setPlanForm(null);
    // New plan becomes the one in use.
    const ids = [...plansFor(activeDate).map(p => p.id)];
    setDays(prev => prev.map(x => (x.id === row.id ? { ...x, plan_active: true } : ids.includes(x.id) ? { ...x, plan_active: false } : x)));
    await Promise.all([
      supabase.from('trip_days').update({ plan_active: true }).eq('id', row.id),
      ...(ids.length ? [supabase.from('trip_days').update({ plan_active: false }).in('id', ids)] : []),
    ]);
  }

  async function renamePlan(name: string) {
    const clean = name.trim();
    if (!day || !day.plan_name || !clean) { setPlanForm(null); return; }
    setDays(prev => prev.map(x => (x.id === day.id ? { ...x, plan_name: clean } : x)));
    setPlanForm(null);
    const { error: err } = await supabase.from('trip_days').update({ plan_name: clean }).eq('id', day.id);
    if (err) setError(planError(err.message));
  }

  // Only named plans can be deleted; Main always stays.
  async function deletePlan() {
    if (!day || !day.plan_name) return;
    const gone = day;
    const main = plansFor(activeDate).find(p => p.id !== gone.id);
    setConfirmDeletePlan(false);
    setStops(prev => prev.filter(s => s.day_id !== gone.id));
    setDays(prev => prev.filter(x => x.id !== gone.id));
    const { error: stopErr } = await supabase.from('trip_stops').delete().eq('day_id', gone.id);
    if (stopErr) { setError(stopErr.message); return; }
    const { error: dayErr } = await supabase.from('trip_days').delete().eq('id', gone.id);
    if (dayErr) { setError(dayErr.message); return; }
    if (main) await setActivePlan(activeDate, main.id);
  }

  async function setStartTime(value: string) {
    const d = await ensureDay();
    if (!d || !value) return;
    const kind = fromFlight ? 'custom' : 'hotel';
    setDays(prev => prev.map(x => (x.id === d.id ? { ...x, start_time: value, start_kind: kind } : x)));
    const { error: err } = await supabase.from('trip_days').update({ start_time: value, start_kind: kind }).eq('id', d.id);
    if (err) setError(err.message);
  }

  async function resetToFlight() {
    if (!day) return;
    setDays(prev => prev.map(x => (x.id === day.id ? { ...x, start_kind: 'airport' } : x)));
    const { error: err } = await supabase.from('trip_days').update({ start_kind: 'airport' }).eq('id', day.id);
    if (err) setError(err.message);
  }

  async function saveTravel(d: DayRow, next: DayTravel) {
    setDays(prev => prev.map(x => (x.id === d.id ? { ...x, travel_options: next } : x)));
    const { error: err } = await supabase.from('trip_days').update({ travel_options: next }).eq('id', d.id);
    if (err) setError(missingColumn(err.message)
      ? 'Real times need one database change first (trip_days.travel_options). Run the SQL, then reload.'
      : err.message);
  }

  // Fetches walk / transit / taxi for every hop of the day that has no cached result yet.
  async function getRealTimes() {
    const d = await ensureDay();
    if (!d) return;
    const leaveAt = (i: number) => (i === 0 ? toMinutes(startTime) ?? 0 : timing.stops[i - 1].leave);
    const lastLeave = timing.stops.length ? timing.stops[timing.stops.length - 1].leave : toMinutes(startTime) ?? 0;
    const jobs: { hop: { from: LatLng; to: LatLng }; mins: number }[] = [];
    hops.into.forEach((h, i) => { if (h && !travel[hopKey(h.from, h.to)]) jobs.push({ hop: h, mins: leaveAt(i) }); });
    if (hops.back && !travel[hopKey(hops.back.from, hops.back.to)]) jobs.push({ hop: hops.back, mins: lastLeave });
    if (!jobs.length) return;

    setFetchingTimes({ done: 0, total: jobs.length });
    const fresh: DayTravel = {};
    let firstError: string | null = null;
    await Promise.all(jobs.map(async ({ hop, mins }) => {
      const at = localToIso(activeDate, mins, zone);
      try {
        const res = await fetch('/projects/tripplanner/api/routes', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: hop.from, to: hop.to, time: at }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
        const result = data as HopResult;
        const anyRoute = result.walk.minutes != null || result.transit.minutes != null || result.drive.minutes != null;
        if (!anyRoute) {
          firstError ??= result.walk.error || result.transit.error || result.drive.error || 'Google found no route for a hop';
          return;
        }
        fresh[hopKey(hop.from, hop.to)] = { at: at ?? '', result };
      } catch (e) {
        firstError ??= e instanceof Error ? e.message : 'Could not get travel times';
      } finally {
        setFetchingTimes(p => (p ? { ...p, done: p.done + 1 } : p));
      }
    }));

    // Keep only hops that are still in the day, plus the new ones.
    const keep = new Set(allHops.map(h => hopKey(h.from, h.to)));
    const merged: DayTravel = {};
    for (const [k, v] of Object.entries({ ...(d.travel_options ?? {}), ...fresh })) if (keep.has(k)) merged[k] = v;
    await saveTravel(d, merged);
    setFetchingTimes(null);
    if (firstError) setError(`Some travel times failed: ${firstError}`);
  }

  async function chooseMode(hop: { from: LatLng; to: LatLng }, mode: HopMode) {
    if (!day) return;
    const key = hopKey(hop.from, hop.to);
    const current = day.travel_options?.[key];
    if (!current) return;
    await saveTravel(day, { ...(day.travel_options ?? {}), [key]: { ...current, chosen: mode } });
  }

  async function addStop(place: SavedPlace) {
    const d = await ensureDay();
    if (!d) return;
    const order = dayStops.length ? Math.max(...dayStops.map(s => s.stop_order)) + 1 : 0;
    const { data, error: err } = await supabase.from('trip_stops').insert({
      day_id: d.id,
      place_id: place.id,
      name: place.name,
      address: place.geo?.address ?? null,
      lat: place.geo?.lat ?? null,
      lng: place.geo?.lng ?? null,
      duration_minutes: defaultMinutes(place.category),
      duration_source: 'default',
      stop_order: order,
    }).select(STOP_COLS).single();
    if (err || !data) { setError(err?.message || 'Could not add the stop'); return; }
    setStops(prev => [...prev, data as StopRow]);
    closePicker();
    onAdded?.(place, activeLabel);
  }

  // Stops that aren't saved places: back to the hotel to rest, or a one-off stop.
  async function addOtherStop(row: { kind: 'hotel' | 'custom'; name: string; address: string | null; lat: number | null; lng: number | null; minutes: number }) {
    const d = await ensureDay();
    if (!d) return;
    const order = dayStops.length ? Math.max(...dayStops.map(s => s.stop_order)) + 1 : 0;
    const { data, error: err } = await supabase.from('trip_stops').insert({
      day_id: d.id,
      place_id: null,
      kind: row.kind,
      name: row.name,
      address: row.address,
      lat: row.lat,
      lng: row.lng,
      duration_minutes: row.minutes,
      duration_source: 'default',
      stop_order: order,
    }).select(STOP_COLS).single();
    if (err || !data) {
      setError(err?.message?.includes('kind')
        ? 'This needs one database change first (supabase/009_stop_notes_kinds.sql). Run it, then reload.'
        : err?.message || 'Could not add the stop');
      return;
    }
    setStops(prev => [...prev, data as StopRow]);
    closePicker();
  }

  function addHotelRest() {
    addOtherStop({ kind: 'hotel', name: 'Rest at the hotel', address: leg?.hotel ?? null,
      lat: hotelPos?.lat ?? null, lng: hotelPos?.lng ?? null, minutes: HOTEL_REST_MINUTES });
  }

  async function findOneOff() {
    const q = pickQuery.trim();
    if (!q) return;
    setOneOff({ loading: true, hits: [], error: null });
    try {
      const res = await fetch('/projects/tripplanner/api/geocode-hotel', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: [q, leg?.city, leg?.country].filter(Boolean).join(', '), limit: 5 }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      setOneOff({ loading: false, hits: (data.results || []) as OneOffHit[], error: null });
    } catch (e) {
      setOneOff({ loading: false, hits: [], error: e instanceof Error ? e.message : 'Search failed' });
    }
  }

  function closePicker() {
    setPicking(false);
    setPickQuery('');
    setOneOff(null);
  }

  async function setBagsMinutes(value: number) {
    const d = await ensureDay();
    if (!d) return;
    setDays(prev => prev.map(x => (x.id === d.id ? { ...x, bags_minutes: value } : x)));
    const { error: err } = await supabase.from('trip_days').update({ bags_minutes: value }).eq('id', d.id);
    if (err) setError(err.message);
  }

  function saveNote(stop: StopRow, text: string) {
    const note = text.trim() || null;
    setEditingNote(null);
    if (note === (stop.note ?? null)) return;
    updateStop(stop.id, { note });
  }

  const handledAdd = useRef<number | null>(null);
  useEffect(() => {
    if (readOnly || !addRequest || loading || handledAdd.current === addRequest.nonce) return;
    // A request for another day: switch to it first, then add on the next render.
    if (addRequest.date && addRequest.date !== activeDate && dates.includes(addRequest.date)) {
      setActiveDate(addRequest.date);
      return;
    }
    handledAdd.current = addRequest.nonce;
    onAddHandled?.();
    // Only fresh requests (the last few seconds): an old one must never be replayed onto a day.
    if (Date.now() - addRequest.nonce > 10_000) return;
    addStop(addRequest.place);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addRequest, loading, activeDate]);

  useEffect(() => {
    if (goToDate && dates.includes(goToDate.date)) setActiveDate(goToDate.date);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goToDate]);

  async function updateStop(id: string, patch: Partial<StopRow>) {
    setStops(prev => prev.map(s => (s.id === id ? { ...s, ...patch } : s)));
    const { error: err } = await supabase.from('trip_stops').update(patch).eq('id', id);
    if (err) setError(err.message);
  }

  async function removeStop(id: string) {
    setStops(prev => prev.filter(s => s.id !== id));
    const { error: err } = await supabase.from('trip_stops').delete().eq('id', id);
    if (err) setError(err.message);
  }

  async function move(index: number, dir: -1 | 1) {
    await reorder(index, index + dir);
  }

  // Moves the stop at `from` so it ends up at position `to`.
  async function reorder(from: number, to: number) {
    if (from === to || from < 0 || to < 0 || from >= dayStops.length || to >= dayStops.length) return;
    const reordered = [...dayStops];
    const [moved] = reordered.splice(from, 1);
    reordered.splice(to, 0, moved);
    const withOrder = reordered.map((s, i) => ({ ...s, stop_order: i }));
    setStops(prev => prev.map(s => withOrder.find(w => w.id === s.id) ?? s));
    const results = await Promise.all(withOrder.map(s =>
      supabase.from('trip_stops').update({ stop_order: s.stop_order }).eq('id', s.id)));
    const failed = results.find(r => r.error);
    if (failed?.error) setError(failed.error.message);
  }

  function setRule(stop: StopRow, rule: TimeRule, time: string | null) {
    if (rule === 'flexible') updateStop(stop.id, { fixed_time: null, arrive_by: null });
    else if (rule === 'exact') updateStop(stop.id, { fixed_time: time, arrive_by: null });
    else updateStop(stop.id, { arrive_by: time, fixed_time: null });
  }

  const usedIds = new Set(dayStops.map(s => s.place_id));
  const pickList = useMemo(() => {
    const q = pickQuery.trim().toLowerCase();
    return places
      .filter(p => p.category !== 'Hotel')
      .filter(p => !q || [p.name, p.neighbourhood, p.city, ...(p.tags || [])].some(v => v?.toLowerCase().includes(q)))
      .sort((a, b) => Number(b.must_go) - Number(a.must_go) || a.name.localeCompare(b.name))
      .slice(0, 40);
  }, [places, pickQuery]);

  const lastLeave = timing.stops.length ? timing.stops[timing.stops.length - 1].leave : null;

  // ---- Export: the day as a numbered list (name, Google Maps link, type) ----
  const [copied, setCopied] = useState<'ok' | 'manual' | null>(null);
  function dayAsText(): string {
    const l = dayLabel(activeDate);
    const planName = plans.length > 1 ? ` · ${day?.plan_name || 'Main'} plan` : '';
    // In mainland China, links open Amap (Google Maps doesn't work there); elsewhere, Google Maps.
    const amapAt = (name: string, lat: number | null | undefined, lng: number | null | undefined) =>
      amapLinks({ name, geo: lat != null && lng != null ? { lat, lng, address: null } : undefined, city: leg?.city ?? '', country: leg?.country ?? '' })?.web ?? null;
    const hotelLink = leg?.hotel
      ? amapAt(leg.hotel, leg.hotel_lat, leg.hotel_lng) ?? mapsSearch([leg.hotel, leg.city].filter(Boolean).join(', '))
      : null;
    const span = (id: string) => { const t = timingById.get(id); return t ? `${fmtTime(t.arrive)}–${fmtTime(t.leave)}` : ''; };
    const items: { name: string; link: string | null; type: string; when: string; extra?: string }[] = [];
    if (bagsTiming && leg?.hotel) items.push({ name: leg.hotel, link: hotelLink, type: 'Hotel, drop bags', when: span(BAGS_STOP_ID) });
    for (const s of dayStops) {
      const t = timingById.get(s.id);
      const rule = ruleOf(s);
      const ruleTime = hhmm(s.fixed_time ?? s.arrive_by);
      const extra = [
        rule === 'exact' && ruleTime ? `booked ${ruleTime}` : null,
        rule === 'by' && ruleTime ? `be there by ${ruleTime}` : null,
        t?.late ? `${t.late} min late` : null,
        s.note ? s.note : null,
      ].filter(Boolean).join(' · ') || undefined;
      if (s.kind === 'hotel') {
        items.push({ name: leg?.hotel || 'Hotel', link: hotelLink, type: 'Hotel, rest', when: span(s.id), extra });
      } else if (s.kind === 'custom') {
        const link = amapAt(s.name, s.lat, s.lng)
          ?? (s.address || s.lat == null ? mapsSearch([s.name, s.address].filter(Boolean).join(', ')) : mapsSearch(`${s.lat},${s.lng}`));
        items.push({ name: s.name, link, type: 'One-off stop', when: span(s.id), extra });
      } else {
        const place = s.place_id ? placeById.get(s.place_id) : undefined;
        const cat = normalizeCategory(place?.category);
        const link = (place ? amapLinks(place)?.web : amapAt(s.name, s.lat, s.lng))
          ?? (place ? googleMapsUrl(place) : s.lat != null ? mapsSearch(`${s.lat},${s.lng}`) : mapsSearch(s.name));
        items.push({ name: s.name, link, type: cat ? TYPE_NAME[cat] : 'Place', when: span(s.id), extra });
      }
    }

    const head: string[] = [];
    if (fromFlight && arrival) {
      head.push(`${arrival.arrives} ${arrival.number} lands at ${arrival.to || 'the airport'}`);
      head.push(`${startTime} Out of the airport`);
    } else {
      head.push(`${startTime} Start${leg?.hotel ? ` at ${leg.hotel}` : ''}`);
    }

    const tail: string[] = [];
    const last = timing.stops.length ? timing.stops[timing.stops.length - 1] : null;
    if (departure) {
      if (last && timing.backTravel != null) tail.push(`${fmtTime(last.leave)} Leave for ${departure.from || 'the airport'} (${timing.backEstimated ? '~' : ''}${fmtDuration(timing.backTravel)})`);
      if (timing.backAt != null) {
        const lateNote = endLate != null && endLate > 0 ? `, ${endLate} min after the ${fmtTime(airportBy!)} cut-off` : '';
        tail.push(`${fmtTime(timing.backAt)} Arrive at ${departure.from || 'the airport'}${lateNote}`);
      } else if (airportBy != null) {
        tail.push(`${fmtTime(airportBy)} Be at ${departure.from || 'the airport'}`);
      }
      tail.push(`${departure.departs ?? '?'} ${departure.number} departs ${departure.from || ''}${departure.to ? ` to ${departure.to}` : ''}`.replace(/\s+/g, ' ').trim());
    } else if (timing.backAt != null && dayStops.length) {
      tail.push(`${fmtTime(timing.backAt)} Back at ${leg?.hotel || 'the hotel'}`);
    }

    const lines = items.map((it, i) =>
      `${i + 1}. ${it.when ? `${it.when} ` : ''}${it.name} (${it.type})${it.extra ? `, ${it.extra}` : ''}${it.link ? `\n   ${it.link}` : ''}`);
    return [`${l.weekday} ${l.day} ${l.month}${planName}`, '', ...head, '', ...lines, ...(tail.length ? ['', ...tail] : [])].join('\n');
  }
  async function copyDay() {
    try {
      await navigator.clipboard.writeText(dayAsText());
      setCopied('ok');
      setTimeout(() => setCopied(c => (c === 'ok' ? null : c)), 2000);
    } catch {
      setCopied('manual');   // clipboard blocked: show the text to copy by hand
    }
  }

  // Swap two days' plans (all plans on each date), stops and all. Nothing is deleted:
  // the day rows just trade dates.
  async function swapDays(a: string, b: string) {
    setSwapOpen(false);
    if (a === b) return;
    const moves = [
      ...days.filter(d => d.date === a).map(d => ({ id: d.id, date: b, leg: d.leg_id })),
      ...days.filter(d => d.date === b).map(d => ({ id: d.id, date: a, leg: d.leg_id })),
    ];
    if (!moves.length) return;
    const patch = (m: { date: string; leg: string | null }) => ({
      date: m.date, day_number: dates.indexOf(m.date) + 1, leg_id: legFor(m.date)?.id ?? m.leg,
    });
    const results = await Promise.all(moves.map(m => supabase.from('trip_days').update(patch(m)).eq('id', m.id)));
    const failed = results.find(r => r.error);
    if (failed?.error) { setError(`Couldn't swap the days: ${failed.error.message}`); await load(); return; }
    const byId = new Map(moves.map(m => [m.id, patch(m)]));
    setDays(prev => prev.map(d => (byId.has(d.id) ? { ...d, ...byId.get(d.id)! } : d)));
    setViewPlan({});
  }

  // ---- Schedule chat ----
  function chatContext() {
    const chatDays: ChatDay[] = dates.map(date => {
      const d = dayFor(date);
      const lg = legFor(date);
      return {
        date,
        hotel: lg?.hotel ?? null,
        city: lg?.city ?? null,
        startTime: hhmm(d?.start_time ?? null) ?? DEFAULT_DAY_START,
        arrival: flights.find(f => dirOf(f) === 'Arriving' && f.date === date) ?? null,
        departure: flights.find(f => dirOf(f) === 'Departing' && f.date === date) ?? null,
        stops: d ? stops.filter(s => s.day_id === d.id).sort((a, b) => a.stop_order - b.stop_order) : [],
      };
    });
    return buildChatContext(tripName || 'Trip', chatDays, places);
  }

  // A place the chat suggested that isn't saved yet: find it on Google, reuse a saved twin, else save it.
  async function placeFromName(name: string, category: string | undefined, date: string): Promise<SavedPlace | null> {
    const lg = legFor(date);
    let hit: { name: string; lat: number; lng: number; address: string; place_id: string; country: string; neighbourhood: string | null } | null = null;
    try {
      const res = await fetch('/projects/tripplanner/api/places', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, city: lg?.city ?? '', country: lg?.country ?? '' }),
      });
      if (res.ok) { const data = await res.json(); hit = Array.isArray(data) && data[0] ? data[0] : null; }
    } catch { /* handled below */ }
    if (!hit) return null;
    const twin = findDuplicate(places, { name: hit.name, google_place_id: hit.place_id, lat: hit.lat, lng: hit.lng });
    if (twin) return twin;
    const saved = await insertPlaces([{
      name: hit.name,
      city: lg?.city ?? '',
      country: hit.country || lg?.country || '',
      category: normalizeCategory(category) ?? 'Attraction',
      lat: hit.lat, lng: hit.lng, address: hit.address,
      google_place_id: hit.place_id, neighbourhood: hit.neighbourhood,
    }]);
    if (saved.length) onPlacesCreated?.(saved);
    return saved[0] ?? null;
  }

  async function applyChatProposal(proposal: ChatProposal, codes: ChatCodes): Promise<string> {
    const done: string[] = [];
    const failed: string[] = [];
    // Work on copies: day id per date, stop ids per day in order, the day each stop is on.
    const dayIdOf = new Map<string, string>();
    const order = new Map<string, string[]>();
    for (const date of dates) {
      const d = dayFor(date);
      if (!d) continue;
      dayIdOf.set(date, d.id);
      order.set(d.id, stops.filter(s => s.day_id === d.id).sort((a, b) => a.stop_order - b.stop_order).map(s => s.id));
    }
    const dayOfStop = new Map(stops.map(s => [s.id, s.day_id]));
    const touched = new Set<string>();

    async function dayIdFor(date: string): Promise<string> {
      if (!dates.includes(date)) throw new Error('that day is not in the trip');
      const have = dayIdOf.get(date);
      if (have) return have;
      const { data, error: err } = await supabase.from('trip_days').insert({
        trip_id: tripId, date, day_number: dates.indexOf(date) + 1, leg_id: legFor(date)?.id ?? null,
        start_time: DEFAULT_DAY_START, start_kind: 'hotel',
      }).select('id').single();
      if (err || !data) throw new Error(err?.message || 'could not create the day');
      const id = (data as { id: string }).id;
      dayIdOf.set(date, id);
      order.set(id, []);
      return id;
    }
    const putAt = (list: string[], id: string, position?: number) => {
      const i = position && position > 0 ? Math.min(position - 1, list.length) : list.length;
      list.splice(i, 0, id);
    };

    for (const c of proposal.changes) {
      const label = describeChange(c, codes);
      if (!label) continue;
      try {
        if (c.action === 'remove' || c.action === 'move') {
          const st = codes.stops.get(c.stop!)!;
          const from = dayOfStop.get(st.id);
          if (from) { order.set(from, (order.get(from) || []).filter(x => x !== st.id)); touched.add(from); }
          if (c.action === 'remove') {
            const { error: err } = await supabase.from('trip_stops').delete().eq('id', st.id);
            if (err) throw new Error(err.message);
          } else {
            const target = await dayIdFor(c.date || st.date);
            putAt(order.get(target)!, st.id, c.position);
            dayOfStop.set(st.id, target);
            touched.add(target);
          }
        } else {
          if (!c.date) throw new Error('no day given');
          const target = await dayIdFor(c.date);
          let place = c.place ? codes.places.get(c.place) ?? null : null;
          if (!place && c.new_place) place = await placeFromName(c.new_place.trim(), c.category, c.date);
          if (!place) throw new Error("couldn't find it on Google");
          const { data, error: err } = await supabase.from('trip_stops').insert({
            day_id: target, place_id: place.id, name: place.name,
            address: place.geo?.address ?? null, lat: place.geo?.lat ?? null, lng: place.geo?.lng ?? null,
            duration_minutes: defaultMinutes(place.category), duration_source: 'default', stop_order: 999,
          }).select('id').single();
          if (err || !data) throw new Error(err?.message || 'could not add the stop');
          const id = (data as { id: string }).id;
          putAt(order.get(target)!, id, c.position);
          dayOfStop.set(id, target);
          touched.add(target);
        }
        done.push(label);
      } catch (e) {
        failed.push(`${label}: ${e instanceof Error ? e.message : 'failed'}`);
      }
    }

    // Save the new order (and day) of every stop on the days that changed.
    const writes = Array.from(touched).flatMap(dayId => (order.get(dayId) || []).map((id, i) =>
      supabase.from('trip_stops').update({ day_id: dayId, stop_order: i }).eq('id', id)));
    const results = await Promise.all(writes);
    const bad = results.find(r => r.error);
    if (bad?.error) failed.push(`Saving the order: ${bad.error.message}`);
    await load();

    if (!done.length && failed.length) throw new Error(`Nothing applied. ${failed.join('. ')}`);
    return [
      `Done: ${done.length} change${done.length === 1 ? '' : 's'} applied.`,
      failed.length ? `Couldn't do: ${failed.join('; ')}.` : '',
    ].filter(Boolean).join(' ');
  }

  return (
    <div className="flex flex-col">
      {!readOnly && <ScheduleChat tripId={tripId} buildContext={chatContext} apply={applyChatProposal} />}
      {/* Day tabs */}
      <div className="sticky top-0 z-10 border-b border-gray-100 bg-white/95 px-4 pb-3 pt-3 backdrop-blur-sm">
        <div className="flex gap-1.5 overflow-x-auto">
          {dates.map((date, i) => {
            const l = dayLabel(date);
            const count = (() => { const d = dayFor(date); return d ? stops.filter(s => s.day_id === d.id).length : 0; })();
            const active = date === activeDate;
            return (
              <button key={date} onClick={() => { setActiveDate(date); closePicker(); setPlanForm(null); setConfirmDeletePlan(false); setSwapOpen(false); setCopied(null); }}
                className={`flex min-w-[64px] shrink-0 flex-col items-center rounded-lg border px-2.5 py-1.5 transition ${
                  active ? 'border-gray-900 bg-gray-900 text-white' : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300'}`}>
                <span className={`text-[10px] font-medium ${active ? 'text-gray-300' : 'text-gray-400'}`}>Day {i + 1}</span>
                <span className="text-sm font-semibold">{l.weekday} {l.day}</span>
                <span className={`text-[10px] ${active ? 'text-gray-300' : 'text-gray-400'}`}>{count ? `${count} stop${count === 1 ? '' : 's'}` : l.month}{plansFor(date).length > 1 ? ` · ${plansFor(date).length} plans` : ''}</span>
              </button>
            );
          })}
        </div>

        {/* Plans for this day */}
        {!loading && (plans.length > 1 || !readOnly) && (
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            {(plans.length ? plans : [null]).map(p => {
              const active = p ? p.id === day?.id : true;
              const n = p ? stops.filter(s => s.day_id === p.id).length : 0;
              return (
                <button key={p?.id ?? 'main'} onClick={() => p && setActivePlan(activeDate, p.id)}
                  className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition ${
                    active ? 'bg-sky-500 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
                  {p?.plan_name || 'Main'}
                  {plans.length > 1 && <span className={`ml-1 ${active ? 'text-sky-100' : 'text-gray-400'}`}>{n}</span>}
                </button>
              );
            })}
            {!readOnly && !planForm && (
              <button onClick={() => { setPlanForm({ mode: 'new', name: '' }); setConfirmDeletePlan(false); }}
                className="rounded-full border border-dashed border-gray-300 px-2.5 py-1 text-[11px] font-medium text-sky-600 transition hover:border-sky-300 hover:bg-sky-50">
                + Plan
              </button>
            )}
            {!readOnly && !planForm && !swapOpen && dates.length > 1 && (
              <button onClick={() => { setSwapOpen(true); setConfirmDeletePlan(false); }}
                className="rounded-full px-2.5 py-1 text-[11px] font-medium text-gray-400 transition hover:bg-gray-100 hover:text-gray-600">
                ⇄ Swap day
              </button>
            )}
            {swapOpen && (
              <div className="flex w-full flex-wrap items-center gap-1.5 pt-1">
                <span className="text-[11px] text-gray-500">Swap {activeLabel} with</span>
                {dates.filter(d => d !== activeDate).map(d => {
                  const l = dayLabel(d);
                  return (
                    <button key={d} onClick={() => swapDays(activeDate, d)}
                      className="rounded-full bg-gray-900 px-2.5 py-1 text-[11px] font-medium text-white transition hover:bg-gray-700">
                      {l.weekday} {l.day}
                    </button>
                  );
                })}
                <button onClick={() => setSwapOpen(false)} className="text-[11px] text-gray-400 hover:text-gray-600">Cancel</button>
                <p className="w-full text-[10px] text-gray-400">Both days keep their stops and times; they just trade dates.</p>
              </div>
            )}
            {!readOnly && !planForm && day?.plan_name && (
              <span className="ml-auto flex items-center gap-2 text-[11px]">
                <button onClick={() => { setPlanForm({ mode: 'rename', name: day.plan_name ?? '' }); setConfirmDeletePlan(false); }}
                  className="font-medium text-gray-400 hover:text-gray-600">Rename</button>
                {confirmDeletePlan ? (
                  <>
                    <button onClick={deletePlan} className="font-medium text-red-600">Delete &ldquo;{day.plan_name}&rdquo; and its stops</button>
                    <button onClick={() => setConfirmDeletePlan(false)} className="text-gray-400">Keep</button>
                  </>
                ) : (
                  <button onClick={() => setConfirmDeletePlan(true)} className="font-medium text-gray-400 hover:text-red-600">Delete plan</button>
                )}
              </span>
            )}
            {planForm && (
              <form className="flex w-full items-center gap-2 pt-1"
                onSubmit={e => { e.preventDefault(); if (planForm.mode === 'new') addPlan(planForm.name); else renamePlan(planForm.name); }}>
                <input autoFocus value={planForm.name} onChange={e => setPlanForm({ ...planForm, name: e.target.value })}
                  placeholder={planForm.mode === 'new' ? 'Plan name, e.g. Rainy day' : 'Plan name'} maxLength={40}
                  className="min-w-0 flex-1 rounded-lg border border-gray-200 bg-gray-50 px-2.5 py-1 text-xs outline-hidden focus:border-sky-400 focus:bg-white" />
                <button type="submit" disabled={!planForm.name.trim()}
                  className="rounded-lg bg-sky-500 px-3 py-1 text-xs font-medium text-white hover:bg-sky-600 disabled:opacity-40">
                  {planForm.mode === 'new' ? 'Add' : 'Save'}
                </button>
                <button type="button" onClick={() => setPlanForm(null)} className="text-xs text-gray-400 hover:text-gray-600">Cancel</button>
              </form>
            )}
            {planForm?.mode === 'new' && <p className="w-full text-[10px] text-gray-400">Starts empty. Your other plans stay saved.</p>}
            {!planForm && plans.length > 1 && (
              <p className="w-full text-[10px] text-gray-400">The highlighted plan is the one you&apos;re going with: its places fade on the map.</p>
            )}
          </div>
        )}
      </div>

      <div className="px-4 pb-8 pt-4">
        {error && (
          <div className="mb-3 flex items-start justify-between gap-2 rounded-lg bg-red-50 p-3 text-xs text-red-600">
            <span>{error}</span>
            <button onClick={() => setError(null)} className="shrink-0 font-medium">Dismiss</button>
          </div>
        )}

        {loading ? (
          <p className="py-10 text-center text-sm text-gray-400">Loading days…</p>
        ) : (
          <>
            {/* Real travel times */}
            {(dayStops.length > 0 || (!readOnly && allHops.length > 0)) && (
              <div className="mb-2 flex items-center justify-end gap-2">
                {dayStops.length > 0 && (
                  <button onClick={copyDay}
                    className="mr-auto rounded-full bg-gray-100 px-3 py-1 text-[11px] font-medium text-gray-600 transition hover:bg-gray-200">
                    {copied === 'ok' ? 'Copied' : 'Copy day as list'}
                  </button>
                )}
                {!readOnly && allHops.length > 0 && (<>
                {fetchingTimes ? (
                  <span className="text-[11px] text-gray-400">Getting travel times… {fetchingTimes.done}/{fetchingTimes.total}</span>
                ) : missingHops > 0 ? (
                  <button onClick={getRealTimes}
                    className="rounded-full bg-sky-50 px-3 py-1 text-[11px] font-medium text-sky-700 transition hover:bg-sky-100">
                    Get real times · {missingHops} {missingHops === 1 ? 'hop' : 'hops'}
                  </button>
                ) : (
                  <span className="text-[11px] text-gray-400">✓ Real travel times</span>
                )}
                </>)}
              </div>
            )}
            {copied === 'manual' && (
              <div className="mb-3 rounded-lg border border-gray-200 bg-gray-50 p-2">
                <div className="mb-1 flex items-center justify-between text-[11px] text-gray-500">
                  <span>Couldn&apos;t copy automatically. Select all and copy:</span>
                  <button onClick={() => setCopied(null)} className="font-medium text-gray-400 hover:text-gray-600">Close</button>
                </div>
                <textarea readOnly value={dayAsText()} rows={8} onFocus={e => e.target.select()}
                  className="w-full resize-y rounded-sm bg-white p-2 font-mono text-[11px] text-gray-700 outline-hidden" />
              </div>
            )}

            {/* Start */}
            <div className="flex items-center gap-3 rounded-xl border border-gray-200 bg-gray-50 px-3 py-2.5">
              {fromFlight ? <PlaneLanding className="h-5 w-5 shrink-0 text-gray-500" strokeWidth={1.5} aria-hidden /> : <BedDouble className="h-5 w-5 shrink-0 text-gray-500" strokeWidth={1.5} aria-hidden />}
              <div className="min-w-0 flex-1">
                <p className="text-[11px] font-medium text-gray-400">
                  {fromFlight ? `${arrival!.number} lands ${arrival!.arrives}` : departure ? 'Check out' : 'Start'}
                </p>
                <p className="truncate text-sm font-medium text-gray-900">
                  {fromFlight
                    ? `Out of ${arrival!.to || 'the airport'} ${customStart ? 'at' : `+${AIRPORT_ARRIVAL_BUFFER} min,`} ${startTime}`
                    : leg?.hotel || 'Hotel not set'}
                </p>
              </div>
              {readOnly ? (
                <span className="px-2 py-1 text-sm font-semibold tabular-nums text-gray-900">{startTime}</span>
              ) : (
                <TimeField value={startTime} onCommit={setStartTime}
                  className="w-[64px] rounded-lg border border-gray-200 bg-white px-2 py-1 text-center text-sm font-semibold tabular-nums text-gray-900 outline-hidden focus:border-sky-400" />
              )}
            </div>
            {!readOnly && fromFlight && customStart && (
              <button onClick={resetToFlight} className="mt-1.5 text-[11px] font-medium text-sky-600 hover:text-sky-700">
                Reset to landing + {AIRPORT_ARRIVAL_BUFFER} min
              </button>
            )}
            {arrival && !fromFlight && (
              <p className="mt-1.5 text-[11px] text-amber-600">
                {arrival.number} lands today but has no arrival time. Add it in the trip&apos;s flights to start the day from the airport.
              </p>
            )}
            {missingArrival && (
              <p className="mt-1.5 text-[11px] text-amber-600">
                No arrival flight added, so this day starts from the hotel at a normal time. {addFlightsLink}
              </p>
            )}
            {!hotelPos && leg?.hotel && (
              <p className="mt-1.5 text-[11px] text-gray-400">Finding the hotel on the map. Travel from the hotel shows once it&apos;s pinned.</p>
            )}

            {/* Arrival day: straight to the hotel first */}
            {bagsTiming && (
              <>
                <Hop minutes={bagsTiming.travelIn} estimated={bagsTiming.travelEstimated}
                  cache={hopCacheById.get(BAGS_STOP_ID)?.cache}
                  onChoose={readOnly ? undefined : m => { const h = hopCacheById.get(BAGS_STOP_ID)?.hop; if (h) chooseMode(h, m); }} />
                <div className="flex items-center gap-3 rounded-xl border border-gray-200 bg-white px-3 py-2.5">
                  <div className="w-12 shrink-0 text-right">
                    <p className="text-sm font-semibold tabular-nums text-gray-900">{fmtTime(bagsTiming.arrive)}</p>
                    <p className="text-[10px] tabular-nums text-gray-400">to {fmtTime(bagsTiming.leave)}</p>
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-gray-900">Drop bags</p>
                    <p className="truncate text-[11px] text-gray-400">{leg?.hotel}</p>
                  </div>
                  {readOnly ? (
                    <span className="shrink-0 rounded-full bg-gray-100 px-2 py-0.5 text-[11px] text-gray-600">{day?.bags_minutes ?? BAGS_MINUTES} min</span>
                  ) : (
                    <label className="flex shrink-0 items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-[11px] text-gray-600">
                      Stay
                      <MinutesField value={day?.bags_minutes ?? BAGS_MINUTES} onCommit={setBagsMinutes} />
                      min
                    </label>
                  )}
                </div>
              </>
            )}

            {/* Stops */}
            {dayStops.map((s, i) => {
              const t = timingById.get(s.id)!;
              const place = s.place_id ? placeById.get(s.place_id) : undefined;
              const cat = getCategory(place?.category);
              const rule = ruleOf(s);
              const ruleTime = hhmm(s.fixed_time ?? s.arrive_by);
              const isEditing = editingTime === s.id;
              return (
                <div key={s.id}
                  draggable={!readOnly}
                  onDragStart={readOnly ? undefined : e => { setDragFrom(i); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', s.id); }}
                  onDragOver={readOnly ? undefined : e => { if (dragFrom == null) return; e.preventDefault(); if (dragOver !== i) setDragOver(i); }}
                  onDrop={readOnly ? undefined : e => { e.preventDefault(); if (dragFrom != null) reorder(dragFrom, i); setDragFrom(null); setDragOver(null); }}
                  onDragEnd={readOnly ? undefined : () => { setDragFrom(null); setDragOver(null); }}
                  className={`transition-opacity ${dragFrom === i ? 'opacity-40' : ''}`}>
                  {sunsetBefore === i && <SunsetLine time={weather![activeDate].sunset!} />}
                  <Hop minutes={t.travelIn} estimated={t.travelEstimated}
                    cache={hopCacheById.get(s.id)?.cache}
                    onChoose={readOnly ? undefined : m => { const h = hopCacheById.get(s.id)?.hop; if (h) chooseMode(h, m); }} />
                  <div className={`rounded-xl border bg-white px-3 py-2.5 ${readOnly ? '' : 'md:cursor-grab md:active:cursor-grabbing'} ${
                    dragOver === i && dragFrom !== null && dragFrom !== i
                      ? (dragFrom > i ? 'border-sky-400 ring-2 ring-sky-100 shadow-[0_-3px_0_0_#38bdf8]' : 'border-sky-400 ring-2 ring-sky-100 shadow-[0_3px_0_0_#38bdf8]')
                      : t.late ? 'border-red-200' : 'border-gray-200'}`}>
                    <div className="flex items-start gap-3">
                      <div className="w-12 shrink-0 pt-0.5 text-right">
                        <p className="text-sm font-semibold tabular-nums text-gray-900">{fmtTime(t.arrive)}</p>
                        <p className="text-[10px] tabular-nums text-gray-400">to {fmtTime(t.leave)}</p>
                      </div>
                      <button className="min-w-0 flex-1 text-left" onClick={() => place && onFocusPlace?.(place)}>
                        <p className="truncate text-sm font-medium text-gray-900">
                          {pinNo.has(s.id) && (
                            <span title="Number on the map" className="mr-1.5 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-gray-900 px-1 align-[1px] text-[10px] font-semibold tabular-nums text-white">
                              {pinNo.get(s.id)}
                            </span>
                          )}
                          <span className="mr-1">{s.kind === 'hotel' ? '🛏️' : s.kind === 'custom' ? '📍' : place?.emoji || cat.emoji}</span>{s.name}
                          {place?.must_go && <span className="ml-1 text-amber-500">★</span>}
                        </p>
                        <p className="truncate text-[11px] text-gray-400">
                          {s.kind === 'hotel' ? (leg?.hotel || 'Hotel not set')
                            : s.kind === 'custom' ? (s.address || (s.lat == null ? 'One-off stop, no location' : 'One-off stop'))
                            : place?.neighbourhood || place?.city || cat.label}
                        </p>
                      </button>
                      <div className={readOnly ? 'hidden' : 'flex shrink-0 items-center gap-0.5 text-gray-300'}>
                        <IconBtn label="Move up" disabled={i === 0} onClick={() => move(i, -1)}>↑</IconBtn>
                        <IconBtn label="Move down" disabled={i === dayStops.length - 1} onClick={() => move(i, 1)}>↓</IconBtn>
                        <IconBtn label="Remove" onClick={() => removeStop(s.id)}>✕</IconBtn>
                      </div>
                    </div>

                    <div className="mt-2 flex flex-wrap items-center gap-1.5 pl-[60px]">
                      {readOnly ? (
                        <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] text-gray-600">Stay {s.duration_minutes ?? 60} min</span>
                      ) : (
                      <label className="flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-[11px] text-gray-600">
                        Stay
                        <MinutesField value={s.duration_minutes ?? 60}
                          onCommit={v => updateStop(s.id, { duration_minutes: v, duration_source: 'user' })} />
                        min
                      </label>
                      )}
                      {readOnly ? (rule !== 'flexible' && (
                        <span className="rounded-full bg-sky-50 px-2 py-0.5 text-[11px] font-medium text-sky-700">
                          {rule === 'exact' ? `At ${ruleTime}` : `By ${ruleTime}`}
                        </span>
                      )) : (
                      <button onClick={() => setEditingTime(isEditing ? null : s.id)}
                        className={`rounded-full px-2 py-0.5 text-[11px] font-medium transition ${
                          rule === 'flexible' ? 'bg-gray-100 text-gray-500 hover:bg-gray-200' : 'bg-sky-50 text-sky-700 hover:bg-sky-100'}`}>
                        {rule === 'exact' ? `At ${ruleTime}` : rule === 'by' ? `By ${ruleTime}` : 'Flexible time'}
                      </button>
                      )}
                      {t.late > 0 && <span className="text-[11px] font-medium text-red-600">{fmtDuration(t.late)} late</span>}
                      {t.late === 0 && rule !== 'flexible' && t.spare > 0 && (
                        <span className="text-[11px] font-medium text-emerald-600">{fmtDuration(t.spare)} spare</span>
                      )}
                      {t.late === 0 && rule !== 'flexible' && t.spare === 0 && (
                        <span className="text-[11px] font-medium text-emerald-600">On time</span>
                      )}
                    </div>

                    {isEditing && !readOnly && (
                      <TimeRuleEditor rule={rule} time={ruleTime}
                        onChange={(r, tm) => setRule(s, r, tm)} onDone={() => setEditingTime(null)} />
                    )}

                    {/* Notes: what to do there */}
                    {editingNote === s.id && !readOnly ? (
                      <div className="mt-2 ml-[60px]">
                        <textarea autoFocus defaultValue={s.note ?? ''} rows={3}
                          placeholder="What to do here: order the crab, ask for the rooftop, book ahead…"
                          onBlur={e => saveNote(s, e.target.value)}
                          onKeyDown={e => {
                            if (e.key === 'Escape') setEditingNote(null);
                            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) (e.target as HTMLTextAreaElement).blur();
                          }}
                          className="w-full resize-y rounded-lg border border-gray-200 bg-gray-50 px-2.5 py-1.5 text-xs text-gray-800 outline-hidden focus:border-sky-400 focus:bg-white" />
                        <p className="mt-0.5 text-[10px] text-gray-400">Saves when you tap away.</p>
                      </div>
                    ) : s.note ? (
                      <button disabled={readOnly} onClick={() => setEditingNote(s.id)}
                        className="mt-2 ml-[60px] block w-[calc(100%-60px)] whitespace-pre-wrap rounded-lg bg-amber-50/70 px-2.5 py-1.5 text-left text-xs leading-relaxed text-gray-700 enabled:hover:bg-amber-50">
                        {s.note}
                      </button>
                    ) : !readOnly && (
                      <button onClick={() => setEditingNote(s.id)}
                        className="mt-1.5 ml-[60px] text-[11px] font-medium text-gray-400 transition hover:text-sky-600">
                        + Note
                      </button>
                    )}
                  </div>
                </div>
              );
            })}

            {dayStops.length > 0 && sunsetBefore === dayStops.length && <SunsetLine time={weather![activeDate].sunset!} />}

            {/* End: back to the hotel, or the airport on a departure day */}
            {(dayStops.length > 0 || departure) && (
              <>
                <Hop minutes={timing.backTravel} estimated={timing.backEstimated}
                  cache={backCache} onChoose={readOnly ? undefined : m => { if (hops.back) chooseMode(hops.back, m); }} />
                <div className={`rounded-xl border px-3 py-2.5 ${
                  departure ? (endLate != null && endLate > 0 ? 'border-red-200 bg-white' : 'border-gray-200 bg-white') : 'border-dashed border-gray-200'}`}>
                  <div className="flex items-center gap-3">
                    <span className="w-12 shrink-0 text-right text-sm font-semibold tabular-nums text-gray-500">
                      {timing.backAt != null ? fmtTime(timing.backAt) : lastLeave != null ? fmtTime(lastLeave) : ''}
                    </span>
                    <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-sm text-gray-600">
                      {departure ? <PlaneTakeoff className="h-3.5 w-3.5 shrink-0" strokeWidth={1.5} aria-hidden /> : <BedDouble className="h-3.5 w-3.5 shrink-0" strokeWidth={1.5} aria-hidden />}
                      {departure
                        ? `${departure.from || 'Airport'} for ${departure.number}${departure.departs ? ` (${departure.departs})` : ''}`
                        : `Back at ${leg?.hotel || 'the hotel'}`}
                    </span>
                  </div>
                  {departure && airportBy != null && (
                    <p className="mt-1 pl-[60px] text-[11px] font-medium">
                      <span className="text-gray-500">By {fmtTime(airportBy)} · </span>
                      {endLate == null ? <span className="text-gray-400">add stops to check timing</span>
                        : endLate > 0 ? <span className="text-red-600">{fmtDuration(endLate)} late</span>
                        : <span className="text-emerald-600">{fmtDuration(-endLate)} spare</span>}
                    </p>
                  )}
                  {departure && airportBy == null && (
                    <p className="mt-1 pl-[60px] text-[11px] text-amber-600">No departure time saved for {departure.number}.</p>
                  )}
                  {missingDeparture && (
                    <p className="mt-1 pl-[60px] text-[11px] text-amber-600">No flight home added, so this day ends at the hotel. {addFlightsLink}</p>
                  )}
                </div>
              </>
            )}

            {/* Add stop */}
            <div className={readOnly ? 'hidden' : 'mt-3'}>
              {!picking ? (
                <button onClick={() => setPicking(true)}
                  className="w-full rounded-xl border border-dashed border-gray-300 py-2.5 text-sm font-medium text-sky-600 transition hover:border-sky-300 hover:bg-sky-50">
                  + Add stop
                </button>
              ) : (
                <div className="rounded-xl border border-gray-200 bg-white p-2">
                  <div className="flex gap-2">
                    <input autoFocus value={pickQuery} onChange={e => { setPickQuery(e.target.value); setOneOff(null); }} placeholder="Search your places…"
                      className="flex-1 rounded-lg border border-gray-200 bg-gray-50 px-3 py-1.5 text-sm outline-hidden focus:border-sky-400 focus:bg-white" />
                    <button onClick={closePicker} className="px-2 text-xs text-gray-400 hover:text-gray-600">Cancel</button>
                  </div>
                  <div className="mt-2 max-h-80 overflow-y-auto">
                    {!pickQuery.trim() && (
                      <button onClick={addHotelRest}
                        className="mb-1 flex w-full items-center gap-2 rounded-lg border-b border-gray-100 px-2 py-2 text-left transition hover:bg-gray-50">
                        <BedDouble className="h-4 w-4 shrink-0 text-gray-500" strokeWidth={1.5} aria-hidden />
                        <span className="min-w-0 flex-1 truncate text-sm font-medium text-gray-800">Back to the hotel to rest</span>
                        <span className="shrink-0 truncate text-[11px] text-gray-400">{leg?.hotel || 'Hotel not set'}</span>
                      </button>
                    )}
                    {pickList.length === 0 && <p className="py-3 text-center text-xs text-gray-400">None of your places match.</p>}
                    {pickList.map(p => {
                      const c = getCategory(p.category);
                      const used = usedIds.has(p.id);
                      return (
                        <button key={p.id} onClick={() => addStop(p)}
                          className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition hover:bg-gray-50">
                          <span>{p.emoji || c.emoji}</span>
                          <span className="min-w-0 flex-1 truncate text-sm text-gray-800">
                            {p.name}{p.must_go && <span className="ml-1 text-amber-500">★</span>}
                          </span>
                          <span className="shrink-0 text-[11px] text-gray-400">{used ? 'in this day' : p.neighbourhood || ''}</span>
                        </button>
                      );
                    })}

                    {/* One-off stop: not saved to your places or the map's pins */}
                    {pickQuery.trim() && (
                      <div className="mt-1 border-t border-gray-100 pt-2">
                        {!oneOff ? (
                          <button onClick={findOneOff}
                            className="w-full rounded-lg px-2 py-1.5 text-left text-xs font-medium text-sky-600 transition hover:bg-sky-50">
                            <span className="inline-flex items-center gap-1.5"><MapPin className="h-3.5 w-3.5 shrink-0" strokeWidth={1.5} aria-hidden />Add &ldquo;{pickQuery.trim()}&rdquo; as a one-off stop</span>
                            <span className="block text-[11px] font-normal text-gray-400">Only on this day. Not saved to your places.</span>
                          </button>
                        ) : oneOff.loading ? (
                          <p className="px-2 py-1.5 text-xs text-gray-400">Looking it up…</p>
                        ) : (
                          <>
                            <p className="px-2 pb-1 text-[10px] font-medium text-gray-400">One-off stop: pick the right one</p>
                            {oneOff.error && <p className="px-2 pb-1 text-[11px] text-red-600">{oneOff.error}</p>}
                            {oneOff.hits.map((h, i) => (
                              <button key={i}
                                onClick={() => addOtherStop({ kind: 'custom', name: h.name, address: h.address, lat: h.lat, lng: h.lng, minutes: 60 })}
                                className="flex w-full flex-col rounded-lg px-2 py-1.5 text-left transition hover:bg-gray-50">
                                <span className="flex items-center gap-1.5 truncate text-sm text-gray-800"><MapPin className="h-3.5 w-3.5 shrink-0 text-gray-400" strokeWidth={1.5} aria-hidden />{h.name}</span>
                                {h.address && <span className="truncate text-[11px] text-gray-400">{h.address}</span>}
                              </button>
                            ))}
                            <button
                              onClick={() => addOtherStop({ kind: 'custom', name: pickQuery.trim(), address: null, lat: null, lng: null, minutes: 60 })}
                              className="w-full rounded-lg px-2 py-1.5 text-left text-[11px] font-medium text-gray-500 transition hover:bg-gray-50">
                              {oneOff.hits.length ? 'None of these: add' : 'Nothing found: add'} &ldquo;{pickQuery.trim()}&rdquo; without a location
                            </button>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>

            {dayStops.length === 0 && !picking && (
              <p className="mt-3 text-center text-xs text-gray-400">{readOnly ? 'Nothing planned for this day yet.' : 'Nothing planned yet. Add your first stop.'}</p>
            )}
            {!readOnly && (
            <a href={`/projects/tripplanner/trip/${tripId}/lab`} className="mt-4 block text-[11px] font-medium text-gray-400 transition hover:text-sky-600">
              Model lab: compare AI models for drafting days
            </a>
            )}
            {dayStops.length > 0 && (
              <p className="mt-2 text-[11px] leading-relaxed text-gray-400">
                Times marked ~ are rough estimates from distance. Tap Get real times for walk, MTR and taxi times from Google, then tap any hop to choose how you go. Prices are approximate.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function SunsetLine({ time }: { time: string }) {
  return (
    <div className="my-1.5 flex items-center gap-2 px-1 text-[11px] font-medium text-amber-600" aria-label={`Sunset at ${time}`}>
      <span className="h-px flex-1 bg-amber-200" />
      <span className="inline-flex items-center gap-1"><Sunset className="h-3.5 w-3.5 shrink-0" strokeWidth={1.5} aria-hidden />Sunset {time}</span>
      <span className="h-px flex-1 bg-amber-200" />
    </div>
  );
}

function Price({ result, mode }: { result: HopResult; mode: HopMode }) {
  const f = result[mode].fare;
  const { eur, local } = fmtEuro(f);
  if (!eur && !local) return null;
  return (
    <>
      {eur && <span>{f?.estimated ? '~' : ''}{eur}{f?.estimated ? ' est.' : ''}</span>}
      {local && <span className="ml-1 text-[10px] text-gray-400">({local})</span>}
    </>
  );
}

function Hop({ minutes, estimated, cache, onChoose }: {
  minutes: number | null; estimated: boolean; cache?: HopCache; onChoose?: (m: HopMode) => void;
}) {
  const [open, setOpen] = useState(false);
  const mode = cache ? modeInUse(cache) : null;

  if (!cache || !mode) {
    return (
      <div className="flex items-center gap-2 py-1 pl-[26px]">
        <div className="h-5 w-px bg-gray-200" />
        <span className="text-[11px] text-gray-400">
          {minutes == null ? 'Travel time unknown' : `${estimated ? '~' : ''}${fmtDuration(minutes)}`}
        </span>
      </div>
    );
  }

  const suggested = defaultMode(cache.result);
  if (!onChoose) {
    // View only: show how the hop is made, without the picker.
    return (
      <div className="flex items-center gap-2 py-1 pl-[26px]">
        <div className="h-5 w-px bg-gray-200" />
        <span className="flex items-center gap-1 px-1.5 text-[11px] text-gray-600">
          <span>{MODE_EMOJI[mode]}</span>
          <span className="font-medium text-gray-800">{fmtDuration(cache.result[mode].minutes ?? 0)}</span>
          {cache.chosen && mode !== 'walk' && (<><span className="text-gray-300">·</span><Price result={cache.result} mode={mode} /></>)}
        </span>
      </div>
    );
  }
  return (
    <div className="py-1 pl-[26px]">
      <div className="flex items-center gap-2">
        <div className="h-5 w-px bg-gray-200" />
        <button onClick={() => setOpen(o => !o)}
          className="flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] text-gray-600 transition hover:bg-gray-100">
          <span>{MODE_EMOJI[mode]}</span>
          <span className="font-medium text-gray-800">{fmtDuration(cache.result[mode].minutes ?? 0)}</span>
          <span className="text-gray-300">·</span>
          {cache.chosen
            ? (mode === 'walk' ? <span>walk</span> : <Price result={cache.result} mode={mode} />)
            : <span className="text-amber-600">not chosen</span>}
          <span className={`ml-0.5 text-[9px] text-gray-400 transition ${open ? 'rotate-180' : ''}`}>▾</span>
        </button>
      </div>
      {open && (
        <div className="mb-1 mt-1 flex flex-wrap gap-1.5 pl-3">
          {(['walk', 'transit', 'drive'] as HopMode[]).map(m => {
            const r = cache.result[m];
            const none = r.minutes == null;
            const chosen = cache.chosen === m;
            const isSuggested = !cache.chosen && suggested === m;
            return (
              <button key={m} disabled={none}
                onClick={() => { onChoose?.(m); setOpen(false); }}
                title={MODE_LABEL[m]}
                className={`flex min-w-[88px] flex-col items-start rounded-lg border px-2.5 py-1.5 text-left transition disabled:opacity-40 ${
                  chosen ? 'border-gray-900 bg-gray-900 text-white'
                    : isSuggested ? 'border-sky-300 bg-sky-50 text-gray-800 hover:border-sky-400'
                    : 'border-gray-200 bg-white text-gray-800 hover:border-gray-300'}`}>
                <span className="text-xs font-medium">
                  {MODE_EMOJI[m]} {none ? 'No route' : fmtDuration(r.minutes!)}
                </span>
                {!none && (
                  <span className={`text-[11px] ${chosen ? 'text-gray-300' : 'text-gray-500'}`}>
                    {m === 'walk' ? 'Free'
                      : r.fare ? <Price result={cache.result} mode={m} />
                      : m === 'transit' ? 'Fare not given' : 'Fare unknown'}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function IconBtn({ children, label, onClick, disabled }: { children: React.ReactNode; label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button aria-label={label} title={label} onClick={onClick} disabled={disabled}
      className="flex h-6 w-6 items-center justify-center rounded-sm text-xs transition hover:bg-gray-100 hover:text-gray-600 disabled:opacity-30 disabled:hover:bg-transparent">
      {children}
    </button>
  );
}

function TimeRuleEditor({ rule, time, onChange, onDone }: {
  rule: TimeRule; time: string | null; onChange: (rule: TimeRule, time: string | null) => void; onDone: () => void;
}) {
  const [r, setR] = useState<TimeRule>(rule);
  const [tm, setTm] = useState<string>(time || '19:30');
  const options: { key: TimeRule; label: string; hint: string }[] = [
    { key: 'flexible', label: 'Flexible', hint: 'Arrive whenever the day gets there' },
    { key: 'by', label: 'Be there by', hint: 'A deadline: warns you if you run late' },
    { key: 'exact', label: 'At exactly', hint: 'A booking: the clock resets to this time' },
  ];
  return (
    <div className="mt-2 ml-[60px] space-y-2 rounded-lg bg-gray-50 p-2.5">
      <div className="flex flex-wrap gap-1.5">
        {options.map(o => (
          <button key={o.key} onClick={() => setR(o.key)} title={o.hint}
            className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition ${r === o.key ? 'bg-gray-900 text-white' : 'bg-white text-gray-600 ring-1 ring-gray-200'}`}>
            {o.label}
          </button>
        ))}
      </div>
      <p className="text-[11px] text-gray-400">{options.find(o => o.key === r)?.hint}</p>
      <div className="flex items-center gap-2">
        {r !== 'flexible' && (
          <TimeField value={tm} onCommit={setTm} autoFocus
            className="w-[64px] rounded-lg border border-gray-200 bg-white px-2 py-1 text-center text-sm tabular-nums outline-hidden focus:border-sky-400" />
        )}
        <button onClick={() => { onChange(r, r === 'flexible' ? null : tm); onDone(); }}
          className="ml-auto rounded-lg bg-sky-500 px-3 py-1 text-xs font-medium text-white hover:bg-sky-600">
          Save
        </button>
      </div>
    </div>
  );
}

// Typed times: "10", "930", "1030", "10:30" or "9.30" all work. Saved on Enter or when you leave
// the box; Esc puts the old time back. No scroll-wheel or arrow-key changes.
export function parseTime(raw: string): string | null {
  const t = raw.trim().replace(/[.h]/gi, ':');
  let h: number, m: number;
  const colon = t.match(/^(\d{1,2}):(\d{1,2})$/);
  if (colon) { h = Number(colon[1]); m = Number(colon[2]); }
  else if (/^\d{1,4}$/.test(t)) {
    if (t.length <= 2) { h = Number(t); m = 0; }
    else { h = Number(t.slice(0, t.length - 2)); m = Number(t.slice(-2)); }
  } else return null;
  if (h > 23 || m > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function TimeField({ value, onCommit, className, autoFocus }: {
  value: string; onCommit: (v: string) => void; className?: string; autoFocus?: boolean;
}) {
  const [text, setText] = useState(value);
  const [bad, setBad] = useState(false);
  useEffect(() => { setText(value); setBad(false); }, [value]);
  function commit() {
    const v = parseTime(text);
    if (!v) { setBad(!!text.trim()); setText(value); return; }
    setBad(false);
    setText(v);
    if (v !== value) onCommit(v);
  }
  return (
    <input type="text" inputMode="numeric" value={text} autoFocus={autoFocus} aria-label="Time (HH:MM)"
      onFocus={e => e.currentTarget.select()}
      onChange={e => setText(e.target.value.replace(/[^\d:.h]/gi, '').slice(0, 5))}
      onBlur={commit}
      onKeyDown={e => {
        if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); }
        if (e.key === 'Escape') { setText(value); e.currentTarget.blur(); }
      }}
      title={bad ? 'Type a time like 10, 930 or 10:30' : undefined}
      className={`${className ?? ''} ${bad ? 'border-red-300' : ''}`} />
  );
}

// Minutes typed as a number, saved on Enter or leaving the box. No scroll-wheel changes.
function MinutesField({ value, onCommit }: { value: number; onCommit: (v: number) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => { setText(String(value)); }, [value]);
  function commit() {
    const n = Math.round(Number(text));
    if (!text.trim() || !Number.isFinite(n)) { setText(String(value)); return; }
    const v = Math.min(Math.max(n, 0), 1440);
    setText(String(v));
    if (v !== value) onCommit(v);
  }
  return (
    <input type="text" inputMode="numeric" value={text} aria-label="Minutes"
      onFocus={e => e.currentTarget.select()}
      onChange={e => setText(e.target.value.replace(/\D/g, '').slice(0, 4))}
      onBlur={commit}
      onKeyDown={e => {
        if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); }
        if (e.key === 'Escape') { setText(String(value)); e.currentTarget.blur(); }
      }}
      className="w-10 bg-transparent text-right font-medium tabular-nums text-gray-900 outline-hidden" />
  );
}
