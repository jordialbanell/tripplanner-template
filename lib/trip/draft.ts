// Server-only: builds the "Draft my days" menu prompts from the trip's own data and
// checks what the model sends back. Prompts are fixed here; the browser only sends
// a step name, a model id and ids it already received (guardrail: no free text).
import 'server-only';
import { sharedDb } from '@/lib/shared-db';
import { distanceKm, type LatLng } from '@/lib/trip/dayPlan';
import { normalizeCategory, type Category } from '@/app/projects/tripplanner/_components/placeTypes';

export type DraftStep = 'vibe' | 'area' | 'see' | 'lunch' | 'snack' | 'dinner' | 'after';
export const DRAFT_STEPS: DraftStep[] = ['vibe', 'area', 'see', 'lunch', 'snack', 'dinner', 'after'];

// For the later steps the server shortlists real candidates near the day so far,
// and the model only chooses among them and says why.
const PICK_STEPS: Record<Exclude<DraftStep, 'vibe' | 'area'>, { cats: Category[]; ask: string; count: string }> = {
  see:    { cats: ['Attraction', 'Museum', 'Shopping', 'Nature', 'Photobooth'], ask: 'things to see or do in the area (not food)', count: '4 to 6' },
  lunch:  { cats: ['Restaurant', 'Snacks'], ask: 'a lunch spot near the stops chosen so far', count: '3 or 4' },
  snack:  { cats: ['Café', 'Snacks'], ask: 'an afternoon coffee, tea or snack stop', count: '3 or 4' },
  dinner: { cats: ['Restaurant'], ask: 'a dinner spot', count: '3 or 4' },
  after:  { cats: ['Bar', 'Snacks', 'Nature', 'Attraction'], ask: 'something for after dinner: a bar, dessert or a night view', count: '3 or 4' },
};

export interface TripPlace {
  id: string;
  code: string;          // short code sent to the model instead of the uuid: p1, p2...
  name: string;
  category: string;
  cat: Category | null;
  area: string;
  mustGo: boolean;
  score: number | null;  // research "worth visiting" /10
  pos: LatLng | null;
}

export interface TripContext {
  tripName: string;
  city: string;
  hotel: string | null;
  hotelPos: LatLng | null;
  days: number;
  places: TripPlace[];
}

const same = (a?: string | null, b?: string | null) => (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase();

export async function loadTripContext(tripId: string): Promise<TripContext> {
  const { data: trip, error } = await sharedDb()
    .from('trips')
    .select('name, start_date, end_date, trip_legs(city, country, hotel, hotel_lat, hotel_lng, leg_order)')
    .eq('id', tripId).single();
  if (error || !trip) throw new Error('Trip not found');
  const legs = ((trip.trip_legs ?? []) as { city: string; country: string; hotel: string | null; hotel_lat: number | null; hotel_lng: number | null; leg_order: number }[])
    .sort((a, b) => a.leg_order - b.leg_order);
  const countries = legs.map(l => l.country);
  const { data: rows, error: pErr } = await sharedDb()
    .from('places')
    .select('id, name, category, neighbourhood, city, country, must_go, research, lat, lng');
  if (pErr) throw new Error(pErr.message);
  const places = (rows ?? [])
    .filter(p => countries.some(c => same(c, p.country)))
    .filter(p => !same(p.category, 'Hotel') && !same(p.category, 'Area'))
    .map((p, i) => ({
      id: p.id as string,
      code: `p${i + 1}`,
      name: p.name as string,
      category: (p.category as string) || 'Place',
      cat: normalizeCategory(p.category as string),
      area: (p.neighbourhood as string) || (p.city as string) || '',
      mustGo: !!p.must_go,
      score: typeof p.research?.worth_visiting === 'number' ? p.research.worth_visiting : null,
      pos: p.lat != null && p.lng != null ? { lat: p.lat as number, lng: p.lng as number } : null,
    }));
  const first = legs[0];
  const days = Math.round((new Date(trip.end_date).getTime() - new Date(trip.start_date).getTime()) / 86_400_000) + 1;
  return {
    tripName: trip.name,
    city: first?.city ?? '',
    hotel: first?.hotel ?? null,
    hotelPos: first?.hotel_lat != null && first?.hotel_lng != null ? { lat: first.hotel_lat, lng: first.hotel_lng } : null,
    days,
    places,
  };
}

function placeLines(places: TripPlace[]): string {
  return places.map(p => [p.code, p.name, p.category, p.area || '?', p.mustGo ? 'MUST-GO' : '', p.score != null ? `${p.score}/10` : '']
    .filter(Boolean).join(' | ')).join('\n');
}

const SYSTEM = [
  'You help plan one day of a city trip by writing multiple-choice options.',
  'Use ONLY the places listed, referring to them by their code (p1, p2...). Never invent places or codes.',
  'Keep every text short and concrete. No emojis. No markdown.',
  'Reply with JSON only, no other text, in exactly this shape:',
  '{"options":[{"title":"...","blurb":"...","place_codes":["p1","p2"]}]}',
].join('\n');

export function buildPrompt(
  step: DraftStep, ctx: TripContext, pickedIds: string[] = [], usedIds: string[] = [],
): { system: string; prompt: string; candidates: number } {
  const header = `Trip: ${ctx.days} days in ${ctx.city}. Staying at ${ctx.hotel ?? 'a hotel'}.`;
  if (step === 'vibe') {
    return {
      system: SYSTEM,
      prompt: [
        header,
        'Saved places (code | name | category | area | must-go | worth-visiting score):',
        placeLines(ctx.places),
        '',
        'Task: offer 4 different "vibes" for a day, based on what these specific places have in common.',
        'Name each vibe after the real places and areas in it (specific to this city), not generic travel themes.',
        'Each option groups 4 to 10 places that fit together and can be visited on the same day. Prefer MUST-GO and higher scores.',
        'The 4 options should not share more than 2 places with each other.',
        'title: 2 to 5 words. blurb: one sentence, max 15 words, saying what the day feels like and naming one highlight.',
      ].join('\n'),
      candidates: ctx.places.length,
    };
  }
  if (step !== 'area') return buildPickPrompt(step, ctx, header, pickedIds, usedIds);
  // area: places from the chosen vibe come first, all places stay available.
  const picked = new Set(pickedIds);
  const chosen = ctx.places.filter(p => picked.has(p.id));
  return {
    system: SYSTEM,
    prompt: [
      header,
      'Saved places (code | name | category | area | must-go | worth-visiting score):',
      placeLines(ctx.places),
      '',
      chosen.length ? `The traveller chose this vibe, built from: ${chosen.map(p => p.code).join(', ')}.` : 'No vibe chosen yet.',
      'Task: offer 3 or 4 areas (neighbourhoods) to explore for this day, each walkable on foot.',
      'title: the area name as locals say it. blurb: one line, max 12 words, what the area is like (for a first-time visitor).',
      'place_codes: the saved places in or right next to that area, best first. Include at least 2 per area.',
    ].join('\n'),
    candidates: ctx.places.length,
  };
}

function buildPickPrompt(
  step: Exclude<DraftStep, 'vibe' | 'area'>, ctx: TripContext, header: string, anchorIds: string[], usedIds: string[],
) {
  const cfg = PICK_STEPS[step];
  const used = new Set(usedIds);
  const anchorPts = ctx.places.filter(p => anchorIds.includes(p.id) && p.pos).map(p => p.pos!);
  const centre = anchorPts.length
    ? { lat: anchorPts.reduce((a, p) => a + p.lat, 0) / anchorPts.length, lng: anchorPts.reduce((a, p) => a + p.lng, 0) / anchorPts.length }
    : ctx.hotelPos;
  const pool = ctx.places
    .filter(p => p.pos && !used.has(p.id) && p.cat && cfg.cats.includes(p.cat))
    .map(p => ({ p, km: centre ? distanceKm(centre, p.pos!) : 0 }));
  // Nearby first; widen the circle if it's too empty.
  let near = pool.filter(x => x.km <= 2.5);
  if (near.length < 4) near = pool.filter(x => x.km <= 5);
  if (near.length < 4) near = pool;
  near.sort((a, b) => Number(b.p.mustGo) - Number(a.p.mustGo) || a.km - b.km);
  const shortlist = near.slice(0, 14);
  const lines = shortlist.map(({ p, km }) => [p.code, p.name, p.category, p.area || '?', `${km.toFixed(1)} km away`, p.mustGo ? 'MUST-GO' : '', p.score != null ? `${p.score}/10` : '']
    .filter(Boolean).join(' | ')).join('\n');
  const sofar = ctx.places.filter(p => used.has(p.id)).map(p => p.name);
  return {
    system: SYSTEM,
    prompt: [
      header,
      sofar.length ? `Already planned today: ${sofar.join(', ')}.` : 'Nothing planned yet today.',
      `Candidates for ${cfg.ask} (code | name | category | area | distance from today's stops | must-go | score):`,
      lines || '(none)',
      '',
      `Task: offer ${cfg.count} options, ONE place per option, chosen only from these candidates. Prefer MUST-GO, closer and higher scores.`,
      'title: the place name. blurb: one line, max 12 words, why it fits this moment of the day.',
      'place_codes: exactly one code per option.',
    ].join('\n'),
    candidates: shortlist.length,
  };
}

export interface DraftOption {
  title: string;
  blurb: string;
  placeIds: string[];
  km: number | null;     // straight-line distance from the hotel to the middle of the option's places
}

export interface ParseResult {
  options: DraftOption[];
  validJson: boolean;
  unknownCodes: string[]; // codes the model made up
}

export function parseOptions(text: string | null, ctx: TripContext): ParseResult {
  const empty: ParseResult = { options: [], validJson: false, unknownCodes: [] };
  if (!text) return empty;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return empty;
  let data: { options?: { title?: unknown; blurb?: unknown; place_codes?: unknown }[] };
  const parsedJson = tolerantJson(text.slice(start));
  if (!parsedJson) return empty;
  data = parsedJson as typeof data;
  if (!Array.isArray(data.options)) return empty;
  const byCode = new Map(ctx.places.map(p => [p.code.toLowerCase(), p]));
  const unknown: string[] = [];
  const options = data.options.slice(0, 6).map(o => {
    const codes = Array.isArray(o.place_codes) ? o.place_codes.map(c => String(c).trim().toLowerCase()) : [];
    const places = codes.map(c => {
      const hit = byCode.get(c);
      if (!hit) unknown.push(c);
      return hit;
    }).filter((p): p is TripPlace => !!p);
    const pts = places.map(p => p.pos).filter((x): x is LatLng => !!x);
    const mid = pts.length ? { lat: median(pts.map(x => x.lat)), lng: median(pts.map(x => x.lng)) } : null;
    return {
      title: String(o.title ?? '').slice(0, 60),
      blurb: String(o.blurb ?? '').slice(0, 160),
      placeIds: Array.from(new Set(places.map(p => p.id))),
      km: ctx.hotelPos && mid ? Math.round(distanceKm(ctx.hotelPos, mid) * 10) / 10 : null,
    };
  }).filter(o => o.title && o.placeIds.length > 0);
  return { options, validJson: true, unknownCodes: unknown };
}

function median(xs: number[]): number {
  const v = [...xs].sort((a, b) => a - b);
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

// Models sometimes slip on one bracket or leave a trailing comma, or stop mid-answer.
// Try the text as is, then with trailing commas removed, then with missing closers added.
function tolerantJson(text: string): unknown | null {
  const end = text.lastIndexOf('}');
  const candidates = [end >= 0 ? text.slice(0, end + 1) : text];
  const noTrailing = (t: string) => t.replace(/,\s*([}\]])/g, '$1');
  candidates.push(noTrailing(candidates[0]));
  // Close whatever is still open, ignoring brackets inside strings.
  const closeOpen = (t: string) => {
    const stack: string[] = [];
    let inStr = false, esc = false;
    for (const ch of t) {
      if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true;
      else if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']');
      else if ((ch === '}' || ch === ']') && stack.length) stack.pop();
    }
    return (inStr ? t + '"' : t) + stack.reverse().join('');
  };
  candidates.push(closeOpen(noTrailing(text.trim().replace(/,\s*$/, ''))));
  // Last resort: cut back to the last complete option and close the rest.
  const lastObj = text.lastIndexOf('}');
  if (lastObj > 0) candidates.push(closeOpen(noTrailing(text.slice(0, lastObj + 1))));
  for (const c of candidates) {
    try { return JSON.parse(c); } catch { /* try the next */ }
  }
  return null;
}
