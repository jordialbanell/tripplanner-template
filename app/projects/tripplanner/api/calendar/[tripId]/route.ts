import { connection, NextRequest, NextResponse } from 'next/server';
import { buildTripCalendar, checkCalendarToken } from '@/lib/trip/calendar';

// The trip as a calendar feed. Apple Calendar subscribes to this URL (webcal://) and re-reads it;
// ?download=1 serves the same file as a one-off download. The k token is the only access check,
// because calendar apps can't sign in.
export async function GET(req: NextRequest, { params }: { params: Promise<{ tripId: string }> }) {
  await connection(); // always fresh: never pre-rendered or cached
  const { tripId } = await params;
  const token = req.nextUrl.searchParams.get('k') || '';
  if (!/^[0-9a-f-]{36}$/i.test(tripId) || !checkCalendarToken(tripId, token)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  try {
    const cal = await buildTripCalendar(tripId);
    if (!cal) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const file = `${cal.name.replace(/[^\w\- ]+/g, '').trim() || 'trip'}.ics`;
    const download = req.nextUrl.searchParams.get('download') === '1';
    return new NextResponse(cal.ics, {
      headers: {
        'Content-Type': 'text/calendar; charset=utf-8',
        'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="${file}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (e) {
    console.error('[trip-calendar]', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'Could not build the calendar' }, { status: 500 });
  }
}
