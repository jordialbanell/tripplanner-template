// Builds an .ics calendar for a trip: one event per stop of each day's chosen plan, flights,
// and the hotel stay. Times are worked out exactly like the day planner does
// (app/projects/tripplanner/_components/DayPlanner.tsx), using the travel times it has cached.
// Server only: reads with the service key, so callers must check the link token first.
import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { sharedDb } from '@/lib/shared-db';
import {
  AIRPORTS, AIRPORT_ARRIVAL_BUFFER, AIRPORT_DEPARTURE_BUFFER, DEFAULT_DAY_START,
  computeDay, dayHops, defaultMinutes, fmtTime, parseFlight, toMinutes, tripDates,
  type LatLng, type PlanStop, type TimeRule, type TripFlight,
} from '@/lib/trip/dayPlan';
import { hopKey, localToIso, modeInUse, zoneFor, MODE_LABEL, type DayTravel, type HopCache } from '@/lib/trip/travel';
import { getCategory } from '@/app/projects/tripplanner/_components/placeTypes';

const BAGS_MINUTES = 30;

// ---------- link token ----------
// The feed URL carries a token derived from the trip id, so the link can't be guessed.
function secret(): string {
  const s = process.env.PROJECTS_OWNER_SECRET;
  if (!s) throw new Error('PROJECTS_OWNER_SECRET not set');
  return s;
}
export function calendarToken(tripId: string): string {
  return createHmac('sha256', secret()).update(`trip-calendar:${tripId}`).digest('base64url').slice(0, 32);
}
export function checkCalendarToken(tripId: string, token: string): boolean {
  const want = Buffer.from(calendarToken(tripId));
  const got = Buffer.from(token || '');
  return want.length === got.length && timingSafeEqual(want, got);
}

// ---------- time zones ----------
// Indonesia spans three zones; Bali and east of it is UTC+8 (Asia/Makassar), not Jakarta.
export function zoneForPlace(country: string | null | undefined, lng: number | null | undefined): string | null {
  const c = (country || '').trim().toLowerCase();
  if (c === 'indonesia' && lng != null) {
    if (lng >= 126.5) return 'Asia/Jayapura';
    if (lng >= 114.4) return 'Asia/Makassar';
    return 'Asia/Jakarta';
  }
  return zoneFor(country);
}

// ---------- ics text ----------
const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/([,;])/g, '\\$1');

// Lines longer than 75 bytes are folded (RFC 5545), never splitting a character.
function fold(line: string): string {
  const out: string[] = [];
  let cur = '';
  let bytes = 0;
  for (const ch of line) {
    const b = Buffer.byteLength(ch);
    if (bytes + b > (out.length ? 74 : 75)) { out.push(cur); cur = ''; bytes = 0; }
    cur += ch; bytes += b;
  }
  out.push(cur);
  return out.join('\r\n ');
}

const utcStamp = (iso: string) => iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '');

// date + minutes after midnight (can pass 1440) -> ICS date-time: UTC when the zone is known,
// otherwise "floating" local time.
function when(date: string, minutes: number, zone: string | null): string {
  const iso = localToIso(date, minutes, zone);
  if (iso) return utcStamp(iso);
  const d = new Date(Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10)) + Math.round(minutes) * 60_000);
  return d.toISOString().slice(0, 19).replace(/[-:]/g, '');
}

interface Ev {
  uid: string;
  date: string;
  start: number;          // minutes after midnight
  end: number;
  zone: string | null;
  title: string;
  location?: string | null;
  geo?: LatLng | null;
  description?: string;
  alarmMinutes?: number;  // reminder this long before
}

// ---------- rows ----------
interface DayRow {
  id: string; date: string; start_time: string | null; start_kind: string | null; bags_minutes: number | null;
  plan_name: string | null; plan_active: boolean | null; created_at: string; travel_options: DayTravel | null;
}
interface StopRow {
  id: string; day_id: string; place_id: string | null; name: string; address: string | null;
  lat: number | null; lng: number | null; duration_minutes: number | null; stop_order: number;
  fixed_time: string | null; arrive_by: string | null; note: string | null; kind: 'hotel' | 'custom' | null;
}
interface LegRow {
  id: string; city: string; country: string | null; start_date: string | null; end_date: string | null;
  hotel: string | null; hotel_lat: number | null; hotel_lng: number | null; leg_order: number;
}
interface PlaceRow { id: string; category: string | null; emoji: string | null; address: string | null; google_place_id: string | null }

const hhmm = (t: string | null) => (t ? t.slice(0, 5) : null);
const ruleOf = (s: StopRow): TimeRule => (s.fixed_time ? 'exact' : s.arrive_by ? 'by' : 'flexible');

export async function buildTripCalendar(tripId: string): Promise<{ ics: string; name: string } | null> {
  const db = sharedDb();
  const { data: trip } = await db.from('trips').select('id, name, start_date, end_date').eq('id', tripId).single();
  if (!trip) return null;

  const [legsRes, daysRes, flightsRes] = await Promise.all([
    db.from('trip_legs').select('id, city, country, start_date, end_date, hotel, hotel_lat, hotel_lng, leg_order').eq('trip_id', tripId),
    db.from('trip_days').select('id, date, start_time, start_kind, bags_minutes, plan_name, plan_active, created_at, travel_options').eq('trip_id', tripId),
    db.from('trip_flights').select('flight_number').eq('trip_id', tripId),
  ]);
  const legs = ((legsRes.data || []) as LegRow[]).sort((a, b) => a.leg_order - b.leg_order);
  const days = (daysRes.data || []) as DayRow[];
  const dayIds = days.map(d => d.id);
  const stops = dayIds.length
    ? (((await db.from('trip_stops')
        .select('id, day_id, place_id, name, address, lat, lng, duration_minutes, stop_order, fixed_time, arrive_by, note, kind')
        .in('day_id', dayIds)).data || []) as StopRow[])
    : [];
  const placeIds = Array.from(new Set(stops.map(s => s.place_id).filter((x): x is string => !!x)));
  const places = new Map<string, PlaceRow>();
  if (placeIds.length) {
    const { data } = await db.from('places').select('id, category, emoji, address, google_place_id').in('id', placeIds);
    (data || []).forEach(p => places.set(p.id as string, p as PlaceRow));
  }

  const dates = tripDates(trip.start_date, trip.end_date);
  const flights = ((flightsRes.data || []) as { flight_number: string }[])
    .map(r => parseFlight(r.flight_number)).filter((f): f is TripFlight => !!f);
  // Same rule as the planner: a flight on the last day of a multi-day trip is the way home.
  const dirOf = (f: TripFlight) =>
    f.direction === 'Arriving' && dates.length > 1 && f.date === dates[dates.length - 1] ? 'Departing' : f.direction;
  const legFor = (date: string) => legs.find(l => l.start_date && l.end_date && l.start_date <= date && date <= l.end_date) ?? legs[0];
  const countOf = (id: string) => stops.filter(s => s.day_id === id).length;
  // The plan in use for a date: the active one, else Main (the unnamed row with the most stops).
  const dayFor = (date: string): DayRow | undefined => {
    const rows = days.filter(d => d.date === date);
    const main = rows.filter(d => !d.plan_name).sort((a, b) => countOf(b.id) - countOf(a.id))[0];
    const named = rows.filter(d => d.plan_name).sort((a, b) => a.created_at.localeCompare(b.created_at));
    const plans = main ? [main, ...named] : named;
    return plans.find(p => p.plan_active) ?? plans[0];
  };

  const events: Ev[] = [];

  // The hotel for each leg, as an all-day block is noisy on phones: one short event at check-in instead.
  for (const leg of legs) {
    if (!leg.hotel || !leg.start_date) continue;
    const zone = zoneForPlace(leg.country, leg.hotel_lng);
    events.push({
      uid: `hotel-${leg.id}`, date: leg.start_date, start: 15 * 60, end: 15 * 60 + 15, zone,
      title: `🏨 Hotel: ${leg.hotel}`,
      location: `${leg.hotel}, ${leg.city}`,
      geo: leg.hotel_lat != null && leg.hotel_lng != null ? { lat: leg.hotel_lat, lng: leg.hotel_lng } : null,
      description: `Staying in ${leg.city}${leg.end_date ? ` until ${leg.end_date}` : ''}. Usual check-in time shown; check your booking.`,
    });
  }

  for (const date of dates) {
    const day = dayFor(date);
    const leg = legFor(date);
    const zone = zoneForPlace(leg?.country, leg?.hotel_lng);
    const hotelPos: LatLng | null = leg?.hotel_lat != null && leg?.hotel_lng != null ? { lat: leg.hotel_lat, lng: leg.hotel_lng } : null;
    const dayStops = day ? stops.filter(s => s.day_id === day.id).sort((a, b) => a.stop_order - b.stop_order) : [];
    const arrival = flights.find(f => dirOf(f) === 'Arriving' && f.date === date);
    const departure = flights.find(f => dirOf(f) === 'Departing' && f.date === date);

    const landAt = toMinutes(arrival?.arrives);
    const flightStart = landAt != null ? landAt + AIRPORT_ARRIVAL_BUFFER : null;
    const customStart = day?.start_kind === 'custom' ? hhmm(day.start_time) : null;
    const fromFlight = flightStart != null;
    const startTime = customStart ?? (fromFlight ? fmtTime(flightStart!) : hhmm(day?.start_time ?? null) ?? DEFAULT_DAY_START);
    const travel: DayTravel = day?.travel_options ?? {};
    // Airports outside the built-in list are looked up by the planner in the browser and not
    // saved, so recover their position from the cached hop that starts or ends there.
    const known = new Set([hotelPos, ...dayStops.map(s => (s.lat != null && s.lng != null ? { lat: s.lat, lng: s.lng } : null))]
      .filter((p): p is LatLng => !!p).map(p => hopKey(p, p).split('>')[0]));
    const parsePt = (k: string): LatLng | null => { const [a, b] = k.split(',').map(Number); return Number.isFinite(a) && Number.isFinite(b) ? { lat: a, lng: b } : null; };
    const fromCache = (side: 0 | 1): LatLng | null => {
      for (const key of Object.keys(travel)) {
        const ends = key.split('>');
        if (ends.length === 2 && !known.has(ends[side]) && known.has(ends[1 - side])) return parsePt(ends[side]);
      }
      return null;
    };
    const arrivalAirport = arrival?.to ? AIRPORTS[arrival.to] ?? fromCache(0) : null;
    const departureAirport = departure?.from ? AIRPORTS[departure.from] ?? fromCache(1) : null;
    const startPos = fromFlight ? arrivalAirport : hotelPos;
    const endPos = departure ? departureAirport : hotelPos;

    const BAGS = '__bags';
    const base: PlanStop[] = [
      ...(fromFlight && hotelPos ? [{ id: BAGS, name: 'Drop bags', pos: hotelPos, minutes: day?.bags_minutes ?? BAGS_MINUTES, rule: 'flexible' as TimeRule, time: null }] : []),
      ...dayStops.map(s => ({
        id: s.id, name: s.name,
        pos: s.kind === 'hotel' ? hotelPos : s.lat != null && s.lng != null ? { lat: s.lat, lng: s.lng } : null,
        minutes: s.duration_minutes ?? defaultMinutes(s.place_id ? places.get(s.place_id)?.category : null),
        rule: ruleOf(s), time: hhmm(s.fixed_time ?? s.arrive_by),
      })),
    ];
    const showBack = dayStops.length > 0 || !!departure;
    const hops = dayHops(startPos, base, showBack ? endPos : null);
    const cacheFor = (h: { from: LatLng; to: LatLng } | null): HopCache | undefined => (h ? travel[hopKey(h.from, h.to)] : undefined);
    const minutesFor = (c?: HopCache) => { const m = c ? modeInUse(c) : null; return c && m ? c.result[m].minutes : null; };
    const plan = base.map((s, i) => ({ ...s, travelMinutes: minutesFor(cacheFor(hops.into[i])) }));
    const timing = computeDay(startTime, startPos, plan, endPos, minutesFor(cacheFor(hops.back)));

    if (arrival && landAt != null) {
      events.push({
        uid: `flight-in-${arrival.number}-${date}`, date, start: landAt, end: landAt + 15, zone,
        title: `🛬 ${arrival.number} lands${arrival.to ? ` at ${arrival.to}` : ''}`,
        location: arrival.to ? `${arrival.to} airport` : null,
        description: `${arrival.from ?? '?'} ${arrival.departs ?? ''} > ${arrival.to ?? '?'} ${arrival.arrives ?? ''} (local times)`,
      });
    }

    base.forEach((s, i) => {
      const t = timing.stops[i];
      if (!t) return;
      if (s.id === BAGS) {
        events.push({
          uid: `bags-${day?.id ?? date}`, date, start: t.arrive, end: t.leave, zone,
          title: '🧳 Drop bags at the hotel', location: leg?.hotel ?? null, geo: hotelPos,
        });
        return;
      }
      const row = dayStops.find(x => x.id === s.id)!;
      const place = row.place_id ? places.get(row.place_id) : undefined;
      const cat = getCategory(place?.category);
      const emoji = row.kind === 'hotel' ? '🛏️' : row.kind === 'custom' ? '📍' : place?.emoji || cat.emoji;
      const travelIn = t.travelIn != null ? `${t.travelEstimated ? '~' : ''}${t.travelIn} min from the previous stop` : null;
      const hopCache = cacheFor(hops.into[i]);
      const mode = hopCache ? modeInUse(hopCache) : null;
      const desc = [
        s.rule === 'exact' && s.time ? `📌 Booked for ${s.time}` : null,
        s.rule === 'by' && s.time ? `⏰ Be there by ${s.time}` : null,
        t.late ? `⚠️ The plan gets you there ${t.late} min late` : null,
        row.note ? `Note: ${row.note}` : null,
        travelIn ? `${travelIn}${mode ? ` (${MODE_LABEL[mode]})` : ''}` : null,
        row.kind === 'hotel' ? null : place?.google_place_id
          ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(row.name)}&query_place_id=${place.google_place_id}`
          : s.pos ? `https://www.google.com/maps/search/?api=1&query=${s.pos.lat},${s.pos.lng}` : null,
      ].filter(Boolean).join('\n');
      events.push({
        uid: `stop-${row.id}`, date, start: t.arrive, end: Math.max(t.leave, t.arrive + 5), zone,
        title: `${emoji} ${row.kind === 'hotel' ? 'Rest at the hotel' : row.name}${s.rule === 'exact' ? ' (booked)' : ''}`,
        location: row.kind === 'hotel' ? leg?.hotel ?? null : row.address || place?.address || null,
        geo: s.pos,
        description: desc,
        alarmMinutes: s.rule === 'exact' ? 60 : s.rule === 'by' ? 30 : undefined,
      });
    });

    if (departure) {
      const takeOff = toMinutes(departure.departs);
      if (timing.backAt != null && timing.backTravel != null && dayStops.length) {
        events.push({
          uid: `to-airport-${day?.id ?? date}`, date, start: timing.backAt - timing.backTravel, end: timing.backAt, zone,
          title: `🚕 To ${departure.from ?? 'the airport'} for ${departure.number}`,
          description: takeOff != null ? `Be at the airport by ${fmtTime(takeOff - AIRPORT_DEPARTURE_BUFFER)}` : undefined,
        });
      }
      if (takeOff != null) {
        events.push({
          uid: `flight-out-${departure.number}-${date}`, date, start: takeOff, end: takeOff + 15, zone,
          title: `🛫 ${departure.number} departs${departure.from ? ` ${departure.from}` : ''}`,
          location: departure.from ? `${departure.from} airport` : null,
          description: `${departure.from ?? '?'} ${departure.departs ?? ''} > ${departure.to ?? '?'} ${departure.arrives ?? ''} (local times)\nBe at the airport by ${fmtTime(takeOff - AIRPORT_DEPARTURE_BUFFER)}`,
          alarmMinutes: AIRPORT_DEPARTURE_BUFFER + 60,
        });
      }
    }
  }

  const stamp = utcStamp(new Date().toISOString());
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//TripPlanner//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    `X-WR-CALNAME:${esc(trip.name)}`, 'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H',
  ];
  for (const e of events) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${e.uid}@tripplanner.app`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${when(e.date, e.start, e.zone)}`,
      `DTEND:${when(e.date, e.end, e.zone)}`,
      `SUMMARY:${esc(e.title)}`,
    );
    if (e.location) lines.push(`LOCATION:${esc(e.location)}`);
    if (e.geo) lines.push(`GEO:${e.geo.lat.toFixed(6)};${e.geo.lng.toFixed(6)}`);
    if (e.description) lines.push(`DESCRIPTION:${esc(e.description)}`);
    if (e.alarmMinutes) lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${esc(e.title)}`, `TRIGGER:-PT${e.alarmMinutes}M`, 'END:VALARM');
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return { ics: lines.map(fold).join('\r\n') + '\r\n', name: trip.name };
}
