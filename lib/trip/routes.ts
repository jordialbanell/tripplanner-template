// Server-only Google Routes API helper. Never import from a client component:
// it reads GOOGLE_PLACES_API_KEY.
import { toEuroRate, inHongKong, hkTaxiFare } from '@/lib/trip/money';

// One hop = three calls (walk, transit, drive). Drive uses traffic (Pro tier).

export type HopMode = 'walk' | 'transit' | 'drive';

export interface LatLng { lat: number; lng: number }

export interface Fare {
  currency: string;     // local currency, e.g. HKD
  amount: number;       // in local currency
  eur: number | null;   // converted at the ECB daily rate, null if the rate lookup failed
  estimated: boolean;   // true for our taxi estimate, false for Google's transit fare
}

export interface ModeResult {
  minutes: number | null;          // null = no route for this mode
  meters: number | null;
  fare: Fare | null;               // transit: Google's fare when it can price every step; drive: taxi estimate (HK only)
  error?: string;                  // Google's message, for debugging
}

export type HopResult = Record<HopMode, ModeResult>;

const GOOGLE_MODE: Record<HopMode, string> = { walk: 'WALK', transit: 'TRANSIT', drive: 'DRIVE' };
const FIELD_MASK = 'routes.duration,routes.distanceMeters,routes.travelAdvisory.transitFare';

function point(p: LatLng) {
  return { location: { latLng: { latitude: p.lat, longitude: p.lng } } };
}

async function oneMode(mode: HopMode, from: LatLng, to: LatLng, departAt: Date | null, apiKey: string): Promise<ModeResult> {
  const body: Record<string, unknown> = {
    origin: point(from),
    destination: point(to),
    travelMode: GOOGLE_MODE[mode],
    languageCode: 'en',
    units: 'METRIC',
  };
  // Google rejects departure times in the past for driving, so only send future times.
  const future = departAt && departAt.getTime() > Date.now() + 60_000;
  if (mode === 'drive') {
    body.routingPreference = 'TRAFFIC_AWARE';
    if (future) body.departureTime = departAt!.toISOString();
  } else if (mode === 'transit' && future) {
    body.departureTime = departAt!.toISOString();
  }

  try {
    const res = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': FIELD_MASK,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const data = await res.json();
    if (!res.ok) {
      return { minutes: null, meters: null, fare: null, error: data?.error?.message || `HTTP ${res.status}` };
    }
    const route = data?.routes?.[0];
    if (!route) return { minutes: null, meters: null, fare: null };
    const secs = parseInt(String(route.duration || '0').replace('s', ''), 10);
    const f = route.travelAdvisory?.transitFare;
    const fare = f?.currencyCode
      ? { currency: f.currencyCode, amount: Number(f.units || 0) + (f.nanos || 0) / 1e9, eur: null, estimated: false }
      : null;
    return { minutes: Math.max(1, Math.round(secs / 60)), meters: route.distanceMeters ?? null, fare };
  } catch (e) {
    return { minutes: null, meters: null, fare: null, error: e instanceof Error ? e.message : 'fetch failed' };
  }
}

export async function computeHop(from: LatLng, to: LatLng, departAt: Date | null): Promise<HopResult> {
  const apiKey = process.env.TRIP_GOOGLE_PLACES_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_PLACES_API_KEY not set');
  const [walk, transit, drive] = await Promise.all([
    oneMode('walk', from, to, departAt, apiKey),
    oneMode('transit', from, to, departAt, apiKey),
    oneMode('drive', from, to, departAt, apiKey),
  ]);

  // Taxi estimate from the driven distance (Hong Kong tariff only, for now).
  if (drive.meters != null && inHongKong(from.lat, from.lng) && inHongKong(to.lat, to.lng)) {
    drive.fare = { currency: 'HKD', amount: hkTaxiFare(drive.meters), eur: null, estimated: true };
  }

  // Convert every fare to euros.
  for (const r of [transit, drive]) {
    if (!r.fare) continue;
    const rate = await toEuroRate(r.fare.currency);
    r.fare.eur = rate != null ? Math.round(r.fare.amount * rate * 100) / 100 : null;
  }
  return { walk, transit, drive };
}
