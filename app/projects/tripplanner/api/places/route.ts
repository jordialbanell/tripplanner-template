import { NextRequest, NextResponse } from 'next/server';
import { searchPlaces } from '@/lib/trip/google';
import { requirePaid } from '@/lib/trip/access';

export interface PlacesResult {
  address: string;
  lat: number;
  lng: number;
  place_id: string;
  google_maps_url: string;
  name: string;
  city: string;
  country: string;
  neighbourhood: string | null;
  types: string[];
}

export async function lookupPlaces(name: string, city: string, country: string): Promise<PlacesResult[]> {
  const textQuery = [name, city, country].filter(Boolean).join(', ');
  const hits = await searchPlaces(textQuery, 10);

  // Prefer results in the requested city, but never filter everything away.
  let filtered = hits;
  if (city) {
    const cityLower = city.toLowerCase();
    const inCity = hits.filter(h => h.address.toLowerCase().includes(cityLower) || h.city.toLowerCase() === cityLower);
    if (inCity.length > 0) filtered = inCity;
  }

  return filtered.map(h => ({
    address: h.address,
    lat: h.lat,
    lng: h.lng,
    place_id: h.place_id,
    google_maps_url: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(h.name)}&query_place_id=${h.place_id}`,
    name: h.name,
    city: h.city,
    country: h.country,
    neighbourhood: h.neighbourhood,
    types: h.types,
  }));
}

export async function POST(req: NextRequest) {
  const denied = await requirePaid('places');
  if (denied) return denied;
  let name: string, city: string, country: string;
  try {
    const body = await req.json();
    name    = body?.name?.trim()    ?? '';
    city    = body?.city?.trim()    ?? '';
    country = body?.country?.trim() ?? '';
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!name) return NextResponse.json({ error: '`name` is required' }, { status: 400 });

  try {
    const results = await lookupPlaces(name, city, country);
    if (results.length === 0) return NextResponse.json({ error: 'No places found' }, { status: 404 });
    return NextResponse.json(results);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
