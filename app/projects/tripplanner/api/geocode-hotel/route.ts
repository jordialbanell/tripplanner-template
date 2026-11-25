import { NextRequest, NextResponse } from 'next/server';
import { searchPlaces } from '@/lib/trip/google';
import { requirePaid } from '@/lib/trip/access';

// Finds a hotel's coordinates from "Hotel name, City, Country".
export async function POST(req: NextRequest) {
  const denied = await requirePaid('hotel');
  if (denied) return denied;
  const { query, limit } = await req.json().catch(() => ({ query: '' }));
  if (!query || typeof query !== 'string') {
    return NextResponse.json({ error: 'query is required' }, { status: 400 });
  }
  try {
    // With a limit: a short list of matches (one-off stops in the day planner).
    if (typeof limit === 'number') {
      const hits = await searchPlaces(query, Math.min(Math.max(1, limit), 6));
      return NextResponse.json({ results: hits.map(h => ({ lat: h.lat, lng: h.lng, name: h.name, address: h.address })) });
    }
    const [hit] = await searchPlaces(query, 1);
    if (!hit) return NextResponse.json({ error: 'Hotel not found' }, { status: 404 });
    return NextResponse.json({ lat: hit.lat, lng: hit.lng, place_id: hit.place_id, name: hit.name, address: hit.address });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Lookup failed' }, { status: 502 });
  }
}
