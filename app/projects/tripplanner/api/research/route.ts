import Anthropic from '@anthropic-ai/sdk';
import { NextRequest, NextResponse } from 'next/server';
import { requirePaid } from '@/lib/trip/access';

export const maxDuration = 60;

const client = new Anthropic({ apiKey: process.env.TRIP_ANTHROPIC_API_KEY });

export interface ResearchResult {
  worth_visiting: number;
  time_to_spend: string;
  entrance_fee: string;
  summary: string;
  basis: string;
  travel_time_car?: string;
  travel_time_bike?: string;
  travel_time_walk?: string;
  photos?: string[];
  google_maps_url: string;
}

async function fetchGooglePhotos(placeId: string): Promise<string[]> {
  const key = process.env.TRIP_GOOGLE_PLACES_API_KEY;
  if (!key) return [];
  try {
    const detailRes = await fetch(`https://places.googleapis.com/v1/places/${placeId}?fields=photos`, {
      headers: { 'X-Goog-Api-Key': key },
    });
    if (!detailRes.ok) return [];
    const detail = await detailRes.json() as { photos?: Array<{ name: string }> };
    const names = (detail.photos || []).slice(0, 3).map(p => p.name);
    const urls: string[] = [];
    for (const name of names) {
      const mediaRes = await fetch(`https://places.googleapis.com/v1/${name}/media?maxWidthPx=800&skipHttpRedirect=true`, {
        headers: { 'X-Goog-Api-Key': key },
      });
      if (!mediaRes.ok) continue;
      const data = await mediaRes.json() as { photoUri?: string };
      if (data.photoUri) urls.push(data.photoUri);
    }
    return urls;
  } catch {
    return [];
  }
}

function stripCite(s: unknown): string {
  return typeof s === 'string' ? s.replace(/<cite[^>]*>|<\/cite>/g, '') : '';
}

export async function POST(req: NextRequest) {
  const denied = await requirePaid('research');
  if (denied) return denied;
  const { name, city, address, hotelCity, google_place_id } = await req.json();
  console.log('[research] incoming body:', JSON.stringify({ google_place_id, hotelCity, placeName: name }));
  if (!name) return NextResponse.json({ error: 'name required' }, { status: 400 });

  const locationHint = [address, city].filter(Boolean).join(', ');

  const schemaLines = [
    '  "worth_visiting": <number 1-10>,',
    '  "time_to_spend": "<e.g. \'1-2 hours\'>",',
    '  "entrance_fee": "<\'Free\' or a price like \'$15 / 350,000 VND\'>",',
    '  "summary": "<exactly 2 sentences>",',
    '  "basis": "<short phrase explaining what the score is based on, e.g. \'based on visitor reviews and travel guides\'>"',
  ];
  if (hotelCity) {
    schemaLines.splice(4, 0,
      '  "travel_time_car": "<e.g. \'25 min\'>",',
      '  "travel_time_bike": "<e.g. \'40 min\'>",',
      '  "travel_time_walk": "<e.g. \'2 hours\'>",',
    );
  }

  const travellerLine = hotelCity
    ? `\nThe traveller is staying in ${hotelCity}. Include travel_time_car, travel_time_bike, and travel_time_walk fields estimating travel time from there to this place for each mode. Short strings like "25 min" or "2 hours".`
    : '';

  const prompt = `Research this place and reply with ONLY a JSON object (no prose, no code fences) matching:
{
${schemaLines.join('\n')}
}${travellerLine}

Place: ${name}${locationHint ? ` (${locationHint})` : ''}`;

  try {
    console.log('[research] attempting photos fetch for place_id:', google_place_id);
    const photosPromise = google_place_id ? fetchGooglePhotos(google_place_id) : Promise.resolve<string[]>([]);
    const res = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
      messages: [{ role: 'user', content: prompt }],
    });

    let text = '';
    for (const block of res.content) {
      if (block.type === 'text') text = block.text;
    }

    // Claude replies in prose (no data) when it can't find the place online.
    const notFound = google_place_id
      ? "Couldn't find enough about this place online. Check the name, then try again."
      : "Couldn't find this place. Check the name or re-pin it, save, then try again.";
    const match = text.match(/\{[\s\S]*\}/);
    let parsed: ResearchResult;
    try {
      if (!match) throw new Error('no json');
      parsed = JSON.parse(match[0]) as ResearchResult;
    } catch {
      console.log('[research] no usable JSON for', name, '|', text.slice(0, 300));
      return NextResponse.json({ error: notFound }, { status: 422 });
    }
    parsed.summary = stripCite(parsed.summary);
    parsed.basis = stripCite(parsed.basis);
    if (parsed.travel_time_car) parsed.travel_time_car = stripCite(parsed.travel_time_car);
    if (parsed.travel_time_bike) parsed.travel_time_bike = stripCite(parsed.travel_time_bike);
    if (parsed.travel_time_walk) parsed.travel_time_walk = stripCite(parsed.travel_time_walk);
    parsed.time_to_spend = stripCite(parsed.time_to_spend);
    parsed.entrance_fee = stripCite(parsed.entrance_fee);
    parsed.photos = await photosPromise;
    const destination = encodeURIComponent([name, address].filter(Boolean).join(' '));
    parsed.google_maps_url = hotelCity
      ? `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(hotelCity)}&destination=${destination}`
      : `https://www.google.com/maps/dir/?api=1&destination=${destination}`;
    return NextResponse.json(parsed);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Research failed' }, { status: 500 });
  }
}
