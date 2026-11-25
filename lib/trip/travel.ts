// Client-safe travel helpers for the day planner: hop keys, the cached
// per-day travel data, the default mode rule, and local time to UTC.
import type { HopMode, HopResult, Fare } from '@/lib/trip/routes';
import type { LatLng } from '@/lib/trip/dayPlan';

export type { HopMode, HopResult, Fare };

// Hops up to this many minutes on foot default to walking.
export const WALK_LIMIT_MINUTES = 45;

export interface HopCache {
  at: string;            // ISO departure time sent to Google
  result: HopResult;
  chosen?: HopMode;      // what the owner picked; missing = not chosen yet
}

// trip_days.travel_options: one entry per hop, keyed by its two end points.
export type DayTravel = Record<string, HopCache>;

const r4 = (n: number) => n.toFixed(4);
export function hopKey(from: LatLng, to: LatLng): string {
  return `${r4(from.lat)},${r4(from.lng)}>${r4(to.lat)},${r4(to.lng)}`;
}

// Walk if it's 45 min or less, else transit, else taxi.
export function defaultMode(r: HopResult): HopMode | null {
  if (r.walk.minutes != null && r.walk.minutes <= WALK_LIMIT_MINUTES) return 'walk';
  if (r.transit.minutes != null) return 'transit';
  if (r.drive.minutes != null) return 'drive';
  if (r.walk.minutes != null) return 'walk';
  return null;
}

export function modeInUse(c: HopCache): HopMode | null {
  if (c.chosen && c.result[c.chosen]?.minutes != null) return c.chosen;
  return defaultMode(c.result);
}

export const MODE_EMOJI: Record<HopMode, string> = { walk: '🚶', transit: '🚇', drive: '🚕' };
export const MODE_LABEL: Record<HopMode, string> = { walk: 'Walk', transit: 'MTR / transit', drive: 'Taxi' };

export function fmtEuro(f: Fare | null): { eur: string | null; local: string | null } {
  if (!f) return { eur: null, local: null };
  const local = `${f.currency === 'HKD' ? 'HK$' : f.currency + ' '}${f.amount % 1 === 0 ? f.amount : f.amount.toFixed(1)}`;
  const eur = f.eur != null ? `€${f.eur.toFixed(2)}` : null;
  return { eur, local };
}

// ── Local time to an absolute time ───────────────────────────────────
// Google needs a real instant, so "Sat 31 Oct 10:00 in Hong Kong" needs the trip's time zone.
const COUNTRY_TZ: Record<string, string> = {
  'hong kong': 'Asia/Hong_Kong', singapore: 'Asia/Singapore', china: 'Asia/Shanghai',
  'south korea': 'Asia/Seoul', korea: 'Asia/Seoul', japan: 'Asia/Tokyo', taiwan: 'Asia/Taipei',
  vietnam: 'Asia/Ho_Chi_Minh', thailand: 'Asia/Bangkok', malaysia: 'Asia/Kuala_Lumpur',
  indonesia: 'Asia/Jakarta', philippines: 'Asia/Manila', macau: 'Asia/Macau',
  'united kingdom': 'Europe/London', uk: 'Europe/London', spain: 'Europe/Madrid', france: 'Europe/Paris',
  italy: 'Europe/Rome', portugal: 'Europe/Lisbon', germany: 'Europe/Berlin', netherlands: 'Europe/Amsterdam',
};

export function zoneFor(country: string | null | undefined): string | null {
  return country ? COUNTRY_TZ[country.trim().toLowerCase()] ?? null : null;
}

// date "2026-10-31" + minutes after midnight (can pass 1440) in a time zone -> ISO instant.
export function localToIso(date: string, minutes: number, zone: string | null): string | null {
  if (!zone) return null;
  const base = Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10)) + Math.round(minutes) * 60_000;
  // Offset of the zone at that moment: format the instant in the zone and compare.
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(base));
  const get = (t: string) => Number(parts.find(p => p.type === t)?.value);
  const asLocal = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
  const offset = asLocal - base;
  return new Date(base - offset).toISOString();
}
