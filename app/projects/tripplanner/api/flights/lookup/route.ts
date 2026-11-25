import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { PRIMARY_MODEL, FALLBACK_MODEL } from '@/lib/trip/claude';
import { requirePaid } from '@/lib/trip/access';

// Flight lookup via Claude + web search (replaces AeroDataBox, whose subscription lapsed).
// Returns the scheduled airports and local times. It's a pre-fill: the user checks it.
export const maxDuration = 60;

const client = new Anthropic({ apiKey: process.env.TRIP_ANTHROPIC_API_KEY });

interface Segment { from: string; to: string; departs: string; arrives: string }

interface FlightResult {
  found: boolean;
  segments?: Segment[];
  departure_airport?: string;
  arrival_airport?: string;
  departure_time?: string;
  arrival_time?: string;
  note?: string;
}

function extractJsonObject(text: string): FlightResult | null {
  const end = text.lastIndexOf('}');
  if (end === -1) return null;
  let depth = 0;
  for (let i = end; i >= 0; i--) {
    if (text[i] === '}') depth++;
    else if (text[i] === '{' && --depth === 0) {
      try { return JSON.parse(text.slice(i, end + 1)); } catch { return null; }
    }
  }
  return null;
}

export async function GET(req: NextRequest) {
  const denied = await requirePaid('flights');
  if (denied) return denied;
  const { searchParams } = req.nextUrl;
  const flightNumber = searchParams.get('flightNumber')?.trim().replace(/\s+/g, '').toUpperCase();
  const date = searchParams.get('date')?.trim();

  if (!flightNumber || !date) {
    return NextResponse.json({ error: 'flightNumber and date are required' }, { status: 400 });
  }

  const prompt = `Find the scheduled departure and arrival for flight ${flightNumber} on ${date} (departure date, local time).
Search the web (airline timetable, FlightAware, Flightradar24, flight status sites). Use the regular schedule for that weekday if the exact date isn't listed yet.

Some flight numbers make a stop and keep the same number (e.g. KL836 Denpasar > Singapore > Amsterdam). List EVERY segment of the flight in order, each with its own airports and local times.

Reply with ONLY this JSON, nothing else:
{"found": true, "segments": [{"from": "SIN", "to": "HKG", "departs": "HH:MM", "arrives": "HH:MM"}], "note": "short note, e.g. arrives next day, or schedule may change"}
Airports are IATA codes. Times are 24h LOCAL time at each airport. A one-segment flight has one entry.
If you can't find this flight with confidence, reply {"found": false, "note": "why"}. Never guess times.`;

  let lastError = '';
  for (const model of [PRIMARY_MODEL, FALLBACK_MODEL]) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const messages: any[] = [{ role: 'user', content: prompt }];
      let text = '';
      // Server tools can pause a long turn; continue up to twice.
      for (let turn = 0; turn < 3; turn++) {
        const res = await client.messages.create({
          model,
          max_tokens: 1024,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 } as any],
          messages,
        });
        text = res.content.map(b => (b.type === 'text' ? b.text : '')).join('');
        if (res.stop_reason !== 'pause_turn') break;
        messages.push({ role: 'assistant', content: res.content });
      }

      console.log(`[flights/lookup] ${flightNumber} ${date} via ${model}: ${text}`);
      const result = extractJsonObject(text);
      if (!result) throw new Error('No JSON in reply');
      if (!result.found) {
        return NextResponse.json({ error: result.note ? `Not found: ${result.note}` : 'Flight not found, enter times manually' }, { status: 404 });
      }
      const segments = (result.segments || []).filter(g => g && g.from && g.to).map(g => ({
        from: String(g.from).toUpperCase(), to: String(g.to).toUpperCase(),
        departs: g.departs || '', arrives: g.arrives || '',
      }));
      if (segments.length) {
        const first = segments[0], last = segments[segments.length - 1];
        return NextResponse.json({
          segments,
          departure_airport: first.from, arrival_airport: last.to,
          departure_time: first.departs, arrival_time: last.arrives,
          note: result.note || '',
        });
      }
      return NextResponse.json({
        segments: [],
        departure_airport: result.departure_airport || '',
        arrival_airport: result.arrival_airport || '',
        departure_time: result.departure_time || '',
        arrival_time: result.arrival_time || '',
        note: result.note || '',
      });
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      console.error(`[flights/lookup] ${model} failed:`, lastError);
    }
  }
  return NextResponse.json({ error: `Lookup failed: ${lastError.slice(0, 160)}` }, { status: 502 });
}
