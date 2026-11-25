// Pure day-planning maths: no React, no Supabase, so it can be tested on its own.
import { normalizeCategory, type Category } from '@/app/projects/tripplanner/_components/placeTypes';

// Starting visit lengths per category (minutes). Editable per stop in the app.
export const DEFAULT_MINUTES: Record<Category, number> = {
  Restaurant: 75,
  Snacks: 20,
  Café: 40,
  Bar: 90,
  Shopping: 45,
  Museum: 90,
  Attraction: 60,
  Nature: 120,
  Area: 60,
  Photobooth: 15,
  Hotel: 30,
};

export const DEFAULT_DAY_START = '09:30';

export function defaultMinutes(category: string | null | undefined): number {
  const c = normalizeCategory(category);
  return c ? DEFAULT_MINUTES[c] : 60;
}

// "09:30" or "09:30:00" -> 570. Returns null for empty or invalid input.
export function toMinutes(t: string | null | undefined): number | null {
  if (!t) return null;
  const m = t.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

// 570 -> "09:30". Past midnight wraps and is marked: 1450 -> "00:10 (+1)".
export function fmtTime(mins: number): string {
  const day = Math.floor(mins / 1440);
  const m = ((Math.round(mins) % 1440) + 1440) % 1440;
  const hh = String(Math.floor(m / 60)).padStart(2, '0');
  const mm = String(m % 60).padStart(2, '0');
  return `${hh}:${mm}${day > 0 ? ' (+1)' : ''}`;
}

export function fmtDuration(mins: number): string {
  const m = Math.round(mins);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h} h ${r} min` : `${h} h`;
}

export interface LatLng { lat: number; lng: number }

export function distanceKm(a: LatLng, b: LatLng): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// Rough placeholder until real Google times are fetched for a hop (step 1c).
// Streets are ~1.3x the straight line. Walk at 4.8 km/h under 1.2 km, else ~transit.
export function roughTravel(a: LatLng | null, b: LatLng | null): { mode: 'walk' | 'transit'; minutes: number } | null {
  if (!a || !b) return null;
  const km = distanceKm(a, b) * 1.3;
  if (km <= 1.2) return { mode: 'walk', minutes: Math.max(1, Math.ceil((km / 4.8) * 60)) };
  if (km <= 10) return { mode: 'transit', minutes: Math.ceil(10 + (km / 25) * 60) };
  return { mode: 'transit', minutes: Math.ceil(10 + (km / 45) * 60) }; // airport trains and highways
}

export type TimeRule = 'flexible' | 'exact' | 'by';

export interface PlanStop {
  id: string;
  name: string;
  pos: LatLng | null;
  minutes: number;          // time spent there
  rule: TimeRule;
  time: string | null;      // HH:MM for 'exact' or 'by'
  travelMinutes?: number | null; // real time for the hop INTO this stop, when known
}

export interface StopTiming {
  id: string;
  travelIn: number | null;     // minutes to get here from the previous point
  travelEstimated: boolean;    // true when travelIn is the rough placeholder
  arrive: number;              // estimated arrival, minutes after midnight
  leave: number;
  late: number;                // minutes late for an 'exact' or 'by' time (0 if fine)
  spare: number;               // minutes spare before an 'exact' or 'by' time
}

export interface DayTiming {
  stops: StopTiming[];
  backTravel: number | null;
  backEstimated: boolean;
  backAt: number | null;
}

// Works forward from the day's start: arrival = previous leave + travel.
// 'exact' waits until that time if you're early. 'by' only checks you make it.
export function computeDay(
  startTime: string, startPos: LatLng | null, stops: PlanStop[], endPos: LatLng | null,
  backTravelMinutes: number | null = null,
): DayTiming {
  let clock = toMinutes(startTime) ?? toMinutes(DEFAULT_DAY_START)!;
  let prev: LatLng | null = startPos;
  const out: StopTiming[] = [];

  for (const s of stops) {
    const real = s.travelMinutes ?? null;
    const rough = real == null ? roughTravel(prev, s.pos) : null;
    const travelIn = real ?? rough?.minutes ?? null;
    let arrive = clock + (travelIn ?? 0);
    let late = 0;
    let spare = 0;
    const target = toMinutes(s.time);
    if (target != null && s.rule === 'exact') {
      if (arrive > target) late = arrive - target;
      else { spare = target - arrive; arrive = target; }
    } else if (target != null && s.rule === 'by') {
      if (arrive > target) late = arrive - target;
      else spare = target - arrive;
    }
    const leave = arrive + s.minutes;
    out.push({ id: s.id, travelIn, travelEstimated: real == null && travelIn != null, arrive, leave, late, spare });
    clock = leave;
    prev = s.pos ?? prev;
  }

  const back = backTravelMinutes ?? (endPos ? roughTravel(prev, endPos)?.minutes ?? null : null);
  return {
    stops: out,
    backTravel: back,
    backEstimated: backTravelMinutes == null,
    backAt: back != null ? clock + back : null,
  };
}

// The two end points of every hop in a day: one into each stop, then the way back.
// Mirrors computeDay: a stop without a pin is skipped as a starting point.
export function dayHops(startPos: LatLng | null, stops: PlanStop[], endPos: LatLng | null): {
  into: (({ from: LatLng; to: LatLng }) | null)[];
  back: { from: LatLng; to: LatLng } | null;
} {
  let prev = startPos;
  const into = stops.map(s => {
    const hop = prev && s.pos ? { from: prev, to: s.pos } : null;
    prev = s.pos ?? prev;
    return hop;
  });
  return { into, back: prev && endPos ? { from: prev, to: endPos } : null };
}

// Every date of the trip, inclusive: ["2026-10-30", ..., "2026-11-02"].
export function tripDates(start: string, end: string): string[] {
  const out: string[] = [];
  const d = new Date(start + 'T00:00:00Z');
  const last = new Date(end + 'T00:00:00Z');
  while (d <= last && out.length < 60) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

export function dayLabel(date: string): { weekday: string; day: string; month: string } {
  const d = new Date(date + 'T00:00:00Z');
  return {
    weekday: d.toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' }),
    day: String(d.getUTCDate()),
    month: d.toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' }),
  };
}

// ── Flights ──────────────────────────────────────────────────────────
// trip_flights.flight_number encodes everything as text:
// "CX690 | 30/10/2026 | Both | Arriving | SIN-HKG | 07:55-11:55"

export const AIRPORT_ARRIVAL_BUFFER = 45;  // landing to out of the terminal
export const AIRPORT_DEPARTURE_BUFFER = 120; // be at the airport this long before take-off

export interface TripFlight {
  number: string;
  date: string;                 // YYYY-MM-DD, departure date
  direction: 'Arriving' | 'Departing';
  from: string | null;
  to: string | null;
  departs: string | null;       // HH:MM local
  arrives: string | null;       // HH:MM local
}

export function parseFlight(encoded: string): TripFlight | null {
  const parts = encoded.split('|').map(p => p.trim());
  const m = parts[1]?.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!parts[0] || !m) return null;
  const clean = (v: string | undefined) => (v && v !== '?' ? v : null);
  const [from, to] = (parts[4] || '').split('-').map(x => x?.trim());
  const [departs, arrives] = (parts[5] || '').split('-').map(x => x?.trim());
  return {
    number: parts[0],
    date: `${m[3]}-${m[2]}-${m[1]}`,
    direction: parts[3] === 'Departing' ? 'Departing' : 'Arriving',
    from: clean(from), to: clean(to),
    departs: clean(departs), arrives: clean(arrives),
  };
}

// Main airports, so the common case needs no lookup. Anything else is geocoded.
export const AIRPORTS: Record<string, LatLng> = {
  HKG: { lat: 22.3155, lng: 113.9367 }, // Terminal 1 / Airport Express, not the airfield centre
  SIN: { lat: 1.3644, lng: 103.9915 },
  PVG: { lat: 31.1443, lng: 121.8083 },
  SHA: { lat: 31.1979, lng: 121.3363 },
  ICN: { lat: 37.4602, lng: 126.4407 },
  GMP: { lat: 37.5583, lng: 126.7906 },
  HND: { lat: 35.5494, lng: 139.7798 },
  NRT: { lat: 35.772, lng: 140.3929 },
  BKK: { lat: 13.69, lng: 100.7501 },
  TPE: { lat: 25.0797, lng: 121.2342 },
  HAN: { lat: 21.2187, lng: 105.8042 },
  SGN: { lat: 10.8188, lng: 106.652 },
  LHR: { lat: 51.47, lng: -0.4543 },
  BCN: { lat: 41.2974, lng: 2.0833 },
};
