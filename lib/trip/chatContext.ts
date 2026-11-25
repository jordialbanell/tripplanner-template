// Turns a trip into compact text for the schedule chat. Places get codes p1.., stops s1..,
// so the model can propose changes without seeing database ids.
import { dayLabel, defaultMinutes, distanceKm, type TripFlight } from './dayPlan';
import type { SavedPlace } from '@/app/projects/tripplanner/_components/placeTypes';

export interface ChatStop {
  id: string;
  name: string;
  place_id: string | null;
  duration_minutes: number | null;
  fixed_time: string | null;
  arrive_by: string | null;
  note: string | null;
  kind: 'hotel' | 'custom' | null;
  lat: number | null;
  lng: number | null;
}

export interface ChatDay {
  date: string;
  hotel: string | null;
  city: string | null;
  startTime: string | null;           // planned day start, HH:MM
  arrival: TripFlight | null;         // flying in that day
  departure: TripFlight | null;       // flying home that day
  stops: ChatStop[];                  // in order
}

export interface ChatCodes {
  places: Map<string, SavedPlace>;    // p1 -> place
  stops: Map<string, { id: string; name: string; date: string }>; // s1 -> stop
}

const hhmm = (t: string | null) => (t ? t.slice(0, 5) : null);
const clip = (s: string | null | undefined, n: number) => {
  const t = (s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

export function buildChatContext(tripName: string, days: ChatDay[], places: SavedPlace[]): { text: string; codes: ChatCodes } {
  const codes: ChatCodes = { places: new Map(), stops: new Map() };
  const codeOfPlace = new Map<string, string>();
  // Must-gos first so they're never cut off by the length cap.
  const sorted = [...places].sort((a, b) => Number(b.must_go) - Number(a.must_go) || a.name.localeCompare(b.name));
  sorted.forEach((p, i) => { const c = `p${i + 1}`; codes.places.set(c, p); codeOfPlace.set(p.id, c); });

  const plannedOn = new Map<string, string[]>();
  const lines: string[] = [`Trip: ${tripName}`];
  let s = 0;
  lines.push('', 'SCHEDULE');
  for (const d of days) {
    const l = dayLabel(d.date);
    lines.push(`${d.date} (${l.weekday} ${l.day} ${l.month})${d.city ? `, ${d.city}` : ''}${d.hotel ? `, hotel: ${d.hotel}` : ''}`);
    if (d.arrival) lines.push(`  Flight in: ${d.arrival.number} ${d.arrival.from ?? '?'} to ${d.arrival.to ?? '?'}, lands ${d.arrival.arrives ?? '?'}`);
    else if (d.startTime) lines.push(`  Day starts ${d.startTime} at the hotel`);
    if (!d.stops.length) lines.push('  (nothing planned)');
    let prev: { lat: number; lng: number } | null = null;
    for (const st of d.stops) {
      const code = `s${++s}`;
      codes.stops.set(code, { id: st.id, name: st.name, date: d.date });
      const p = st.place_id ? places.find(x => x.id === st.place_id) : undefined;
      const pc = st.place_id ? codeOfPlace.get(st.place_id) : undefined;
      if (st.place_id) plannedOn.set(st.place_id, [...(plannedOn.get(st.place_id) || []), d.date]);
      const kind = st.kind === 'hotel' ? 'back to hotel' : p?.category || (st.kind === 'custom' ? 'one-off stop' : '');
      const mins = st.duration_minutes ?? defaultMinutes(p?.category);
      const rule = st.fixed_time ? `, at exactly ${hhmm(st.fixed_time)}` : st.arrive_by ? `, be there by ${hhmm(st.arrive_by)}` : '';
      const here = st.lat != null && st.lng != null ? { lat: st.lat, lng: st.lng } : null;
      const km = prev && here ? `, ${distanceKm(prev, here).toFixed(1)} km from previous` : '';
      if (here) prev = here;
      lines.push(`  ${code}: ${st.name}${pc ? ` [${pc}]` : ''}${kind ? ` (${kind})` : ''}, stay ${mins} min${rule}${km}${st.note ? `, note: ${clip(st.note, 80)}` : ''}`);
    }
    if (d.departure) lines.push(`  Flight home: ${d.departure.number} leaves ${d.departure.from ?? '?'} at ${d.departure.departs ?? '?'} (be at the airport 2 h before)`);
  }

  lines.push('', 'SAVED PLACES (codes in brackets; MUST GO = the user marked it as unmissable)');
  for (const [code, p] of codes.places) {
    const bits = [
      p.category,
      p.must_go ? 'MUST GO' : '',
      p.neighbourhood || p.city,
      p.research?.worth_visiting != null ? `worth visiting ${p.research.worth_visiting}/10` : '',
      plannedOn.has(p.id) ? `planned ${plannedOn.get(p.id)!.join(', ')}` : 'not planned',
    ].filter(Boolean).join(', ');
    const extra = [clip(p.description, 110), p.personal_note ? `their note: ${clip(p.personal_note, 80)}` : ''].filter(Boolean).join(' | ');
    lines.push(`[${code}] ${p.name}: ${bits}${extra ? `. ${extra}` : ''}`);
  }
  return { text: lines.join('\n'), codes };
}

export interface ChatChange {
  action: 'add' | 'remove' | 'move';
  place?: string;
  new_place?: string;
  category?: string;
  stop?: string;
  date?: string;
  position?: number;
}

export interface ChatProposal { summary: string; changes: ChatChange[] }

const dayName = (date?: string) => {
  if (!date) return 'the last day';
  const l = dayLabel(date);
  return `${l.weekday} ${l.day}`;
};

// One readable line per change, or null when the change points at something that doesn't exist.
export function describeChange(c: ChatChange, codes: ChatCodes): string | null {
  const at = c.position ? ` (stop ${c.position})` : '';
  if (c.action === 'add') {
    const p = c.place ? codes.places.get(c.place) : undefined;
    if (p) return `Add ${p.name} to ${dayName(c.date)}${at}`;
    if (c.new_place?.trim()) return `Add ${c.new_place.trim()} to ${dayName(c.date)}${at} (new, saved from Google)`;
    return null;
  }
  const st = c.stop ? codes.stops.get(c.stop) : undefined;
  if (!st) return null;
  if (c.action === 'remove') return `Remove ${st.name} from ${dayName(st.date)}`;
  if (c.action === 'move') return `Move ${st.name} to ${dayName(c.date || st.date)}${at}`;
  return null;
}
