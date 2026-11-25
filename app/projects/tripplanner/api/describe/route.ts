import { NextRequest, NextResponse } from 'next/server';
import { askForList, DESCRIPTION_RULES } from '@/lib/trip/claude';
import { getPlaceReviews, type PlaceReviews } from '@/lib/trip/google';
import { converse } from '@/lib/trip/bedrock';
import { requirePaid } from '@/lib/trip/access';

// Writes short descriptions for places a traveller saved.
// 1. Places with a Google id: fetch Google's summary + reviews (free under 1,000 a month)
//    and have Nova Lite on Bedrock turn them into one or two lines (a fraction of a cent).
// 2. Places Google has nothing on: Claude from its own knowledge, no web search (old path).
// The client saves the results.
export const maxDuration = 60;

const NOVA_MODEL = process.env.DESCRIBE_MODEL_ID || 'amazon.nova-lite-v1:0';

export interface DescribeInput {
  id: string;
  name: string;
  category: string;
  neighbourhood: string | null;
  city: string;
  country: string;
  address: string | null;
  google_place_id?: string | null;
}

interface Described { i: number; description: string | null }

function label(p: DescribeInput) {
  return `${p.name} (${p.category}${p.neighbourhood ? `, ${p.neighbourhood}` : ''}, ${[p.city, p.country].filter(Boolean).join(', ')})`;
}

// Tolerant JSON-array parse: models sometimes wrap it in prose or code fences.
function parseArray(text: string | null): Described[] {
  if (!text) return [];
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  try {
    const arr = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function clean(s: unknown): string | null {
  if (typeof s !== 'string') return null;
  const t = s.replace(/\s+/g, ' ').replace(/[—–]/g, ',').trim();
  if (!t || /^null$/i.test(t)) return null;
  return t;
}

async function fromReviews(items: { place: DescribeInput; data: PlaceReviews }[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (items.length === 0) return out;

  const blocks = items.map(({ place, data }, i) => {
    const lines = [`${i}. ${label(place)}`];
    if (data.summary) lines.push(`   Google summary: ${data.summary}`);
    data.reviews.forEach(r => lines.push(`   Review: ${r}`));
    return lines.join('\n');
  }).join('\n\n');

  const prompt = `Write a short description for each place below, for a traveller deciding whether to go.

Rules:
- One or two short sentences, max 30 words.
- Say what the place is and what it is known for. For food and drink, name what to order if the reviews agree on it.
- Use ONLY the Google summary and reviews given. Never add facts that are not in them.
- Plain and specific. No hype words like "hidden gem", "must-visit", "amazing". No dashes.
- If the reviews don't make clear what the place is, use null.

Reply with ONLY a JSON array, no prose: [{"i": 0, "description": "..."}, ...]

Places:
${blocks}`;

  const res = await converse(NOVA_MODEL, prompt, { maxTokens: 120 * items.length + 100, temperature: 0.3, timeoutMs: 40_000 });
  if (res.error) console.log('[describe] nova error', res.error);
  console.log('[describe] nova', JSON.stringify({ n: items.length, ms: res.latencyMs, in: res.inputTokens, out: res.outputTokens }));
  for (const e of parseArray(res.text)) {
    const item = typeof e?.i === 'number' ? items[e.i] : undefined;
    const d = clean(e?.description);
    if (item && d) out.set(item.place.id, d);
  }
  return out;
}

async function fromClaudeMemory(places: DescribeInput[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (places.length === 0) return out;
  const list = places
    .map((p, i) => `${i}. ${label(p)}${p.address ? ` at ${p.address}` : ''}`)
    .join('\n');
  const prompt = `Write a short description for each of these places a traveller saved to visit.

For each numbered place, record "i" (the number) and ${DESCRIPTION_RULES}

Places:
${list}`;
  try {
    const entries = await askForList<Described>(prompt, {
      name: 'record_descriptions',
      description: 'Record one description per place.',
      itemSchema: {
        type: 'object',
        properties: { i: { type: 'integer' }, description: { type: ['string', 'null'] } },
        required: ['i', 'description'],
      },
    }, 'describe');
    for (const e of entries) {
      const d = clean(e.description);
      if (typeof e.i === 'number' && places[e.i] && d) out.set(places[e.i].id, d);
    }
  } catch (err) {
    console.log('[describe] claude error', err instanceof Error ? err.message : err);
  }
  return out;
}

export async function POST(req: NextRequest) {
  let places: DescribeInput[];
  try {
    const body = await req.json();
    places = Array.isArray(body?.places) ? body.places : [];
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (places.length === 0) return NextResponse.json({ error: 'No places' }, { status: 400 });
  if (places.length > 15) return NextResponse.json({ error: 'At most 15 places per request' }, { status: 400 });
  const denied = await requirePaid('describe', null, places.length);
  if (denied) return denied;

  // Step 1: Google reviews for every place that has a Google id.
  const fetched = await Promise.all(places.map(async place => ({
    place,
    data: place.google_place_id ? await getPlaceReviews(place.google_place_id) : null,
  })));
  const withReviews = fetched.filter((f): f is { place: DescribeInput; data: PlaceReviews } =>
    !!f.data && (f.data.reviews.length > 0 || !!f.data.summary));

  const described = await fromReviews(withReviews);

  // Step 2: anything still blank goes to Claude's own knowledge.
  const leftover = places.filter(p => !described.has(p.id));
  const fromMemory = await fromClaudeMemory(leftover);
  fromMemory.forEach((d, id) => described.set(id, d));

  console.log('[describe] done', JSON.stringify({
    total: places.length, reviews: withReviews.length,
    nova: described.size - fromMemory.size, claude: fromMemory.size, blank: places.length - described.size,
  }));

  const results = places.map(p => ({ id: p.id, description: described.get(p.id) ?? null }));
  return NextResponse.json({ results });
}
