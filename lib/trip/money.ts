// Server-side money helpers: euro conversion and taxi fare estimates.

// ── Euro conversion ──────────────────────────────────────────────────
// Frankfurter serves the European Central Bank's daily reference rates. Free, no key.
// Next caches the response for a day, so this is at most one call per currency per day.
export async function toEuroRate(currency: string): Promise<number | null> {
  if (currency === 'EUR') return 1;
  try {
    const res = await fetch(`https://api.frankfurter.dev/v1/latest?base=${encodeURIComponent(currency)}&symbols=EUR`, {
      next: { revalidate: 86400 },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const rate = data?.rates?.EUR;
    return typeof rate === 'number' ? rate : null;
  } catch {
    return null;
  }
}

// ── Hong Kong taxi estimate ──────────────────────────────────────────
// Official urban (red) taxi tariff, Transport Department, effective 14 July 2024
// (checked 6 Oct 2026): HK$29 for the first 2 km, then HK$2.1 per 200 m until the
// fare reaches HK$102.5, then HK$1.4 per 200 m.
// Not included: waiting time in traffic, tunnel tolls, luggage (HK$6/piece).
const HK_BOX = { minLat: 22.15, maxLat: 22.57, minLng: 113.83, maxLng: 114.44 };

export function inHongKong(lat: number, lng: number): boolean {
  return lat >= HK_BOX.minLat && lat <= HK_BOX.maxLat && lng >= HK_BOX.minLng && lng <= HK_BOX.maxLng;
}

export function hkTaxiFare(meters: number): number {
  if (meters <= 2000) return 29;
  const steps = Math.ceil((meters - 2000) / 200);
  const stepsToThreshold = 35; // (102.5 - 29) / 2.1
  const fare = 29 + 2.1 * Math.min(steps, stepsToThreshold) + 1.4 * Math.max(0, steps - stepsToThreshold);
  return Math.round(fare * 10) / 10;
}
