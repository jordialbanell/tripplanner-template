import { NextRequest, NextResponse } from 'next/server';
import { canEditTrip, getAccess } from '@/lib/trip/access';
import { calendarToken } from '@/lib/trip/calendar';

// Hands out the calendar link to people who can edit the trip (the owner or an edit link).
export async function GET(req: NextRequest) {
  const tripId = req.nextUrl.searchParams.get('tripId') || '';
  if (!/^[0-9a-f-]{36}$/i.test(tripId)) return NextResponse.json({ error: 'Bad trip' }, { status: 400 });
  const access = await getAccess();
  if (!canEditTrip(access, tripId)) return NextResponse.json({ error: 'Not allowed' }, { status: 403 });
  const host = req.headers.get('x-forwarded-host') || req.nextUrl.host;
  const path = `/projects/tripplanner/api/calendar/${tripId}?k=${calendarToken(tripId)}`;
  return NextResponse.json({
    subscribe: `webcal://${host}${path}`,
    https: `https://${host}${path}`,
    download: `https://${host}${path}&download=1`,
  });
}
