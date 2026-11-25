import { NextRequest, NextResponse } from 'next/server';
import { requirePaid } from '@/lib/trip/access';

interface LatLng {
  lat: number;
  lng: number;
}

interface TravelTimeResult {
  mode: string;
  duration_minutes: number | null;
  duration_text: string | null;
}

export async function POST(req: NextRequest) {
  const denied = await requirePaid('travel');
  if (denied) return denied;
  const apiKey = process.env.TRIP_GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: 'Google API key not configured' }, { status: 500 });
  }

  let origin: LatLng, destination: LatLng, modes: string[];
  try {
    const body = await req.json();
    origin = body.origin;
    destination = body.destination;
    modes = body.modes || ['transit', 'walking', 'driving'];
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!origin?.lat || !origin?.lng || !destination?.lat || !destination?.lng) {
    return NextResponse.json({ error: 'origin and destination with lat/lng are required' }, { status: 400 });
  }

  const results: TravelTimeResult[] = [];

  for (const mode of modes) {
    try {
      const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${origin.lat},${origin.lng}&destinations=${destination.lat},${destination.lng}&mode=${mode}&key=${apiKey}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      const data = await res.json();
      const element = data?.rows?.[0]?.elements?.[0];
      if (element?.status === 'OK') {
        results.push({
          mode,
          duration_minutes: Math.round((element.duration?.value || 0) / 60),
          duration_text: element.duration?.text || null,
        });
      } else {
        results.push({ mode, duration_minutes: null, duration_text: null });
      }
    } catch {
      results.push({ mode, duration_minutes: null, duration_text: null });
    }
  }

  return NextResponse.json(results);
}
