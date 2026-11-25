import { NextRequest, NextResponse } from 'next/server';
import { searchPlaces, categoryFromTypes, type PlaceHit } from '@/lib/trip/google';
import { askForList, DESCRIPTION_RULES } from '@/lib/trip/claude';
import { CATEGORY_GUIDE, normalizeCategory, type Category } from '@/app/projects/tripplanner/_components/placeTypes';
import { requirePaid } from '@/lib/trip/access';

// Each request handles one small batch (the client sends 8 names at a time), so this
// stays well inside Vercel Hobby's 60 s limit.
export const maxDuration = 60;

export interface ImportItem {
  key: string;          // stable id from the client
  raw: string;          // exactly what was in the sheet cell / line
  hint: string | null;  // the column header it sat under, if any
}

export interface ImportCandidate {
  key: string;          // `${item.key}` or `${item.key}-1` when one cell held two places
  raw: string;
  hint: string | null;
  name: string;         // cleaned name
  category: Category;
  note: string | null;  // why Claude changed something, or a warning
  uncertain: boolean;   // Claude could not tell which place is meant
  description: string | null;
  match: PlaceHit | null;
  alternatives: PlaceHit[];
  confidence: 'high' | 'low' | 'none';
}

interface Cleaned {
  i: number;
  is_place: boolean;
  name: string;
  query: string;
  category: string;
  uncertain?: boolean;
  note?: string | null;
  description?: string | null;
}

const ITEM_SCHEMA = {
  type: 'object',
  properties: {
    i: { type: 'integer', description: 'Entry number from the list' },
    is_place: { type: 'boolean', description: 'false for notes, sentences, headings, anything that is not a venue or area' },
    name: { type: 'string', description: 'Correct, properly capitalised real name' },
    query: { type: 'string', description: 'Best Google Maps search text, without city or country' },
    category: { type: 'string' },
    uncertain: { type: 'boolean', description: 'true ONLY if you cannot tell which place is meant. Chains with several branches are NOT uncertain.' },
    note: { type: ['string', 'null'], description: 'Very short note if you changed the category, split the entry, or are uncertain; otherwise null' },
    description: { type: ['string', 'null'], description: 'One or two short sentences for a traveller, or null if you do not know this place' },
  },
  required: ['i', 'is_place', 'name', 'query', 'category', 'uncertain', 'note', 'description'],
};

async function cleanWithClaude(items: ImportItem[], city: string, country: string): Promise<Cleaned[]> {
  const list = items
    .map((it, i) => `${i}. "${it.raw}"${it.hint ? ` (listed under column "${it.hint}")` : ''}`)
    .join('\n');

  const prompt = `You are cleaning up a travel wishlist someone typed quickly for a trip to ${city || 'an unknown city'}${country ? `, ${country}` : ''}. Entries have typos, abbreviations and sometimes two places merged into one cell.

For every numbered entry, record:
- "name": the real, properly capitalised name (fix typos using your knowledge of ${city || 'the city'}, e.g. "australia diary company" -> "Australia Dairy Company", "ladies market" -> "Ladies' Market"). Keep the name people actually use; do not replace a market or landmark with the street it is on.
- "query": the best Google Maps search text for exactly this place (add the branch or neighbourhood only if the entry mentions one, e.g. "Mak Man Kee Noodle Shop Jordan")
- "category": exactly one of these keys:
${CATEGORY_GUIDE}
  Use the column hint when it fits. If it is clearly wrong for this place (a garden under Areas, a mall under Restaurant), choose the right category and say so in "note".
- "uncertain": true only when you genuinely cannot tell which place is meant
- "is_place": false for notes, sentences, headings
- ${DESCRIPTION_RULES}

If one entry clearly contains two different places, record two entries with the same "i".

Entries:
${list}`;

  const entries = await askForList<Cleaned>(prompt, {
    name: 'record_places',
    description: 'Record the cleaned-up wishlist entries.',
    itemSchema: ITEM_SCHEMA,
  }, 'import');
  return entries.filter(c => typeof c.i === 'number' && c.i >= 0 && c.i < items.length);
}

function looseName(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');
}

function scoreConfidence(cleanedName: string, hit: PlaceHit, country: string): 'high' | 'low' {
  if (country && hit.country && hit.country.toLowerCase() !== country.toLowerCase()) return 'low';
  const a = looseName(cleanedName);
  const b = looseName(hit.name);
  if (!a || !b) return 'low';
  if (a.includes(b) || b.includes(a)) return 'high';
  // share a meaningful first word (e.g. "Kam Wah" vs "Kam Wah Cafe")
  const firstWord = cleanedName.toLowerCase().split(/\s+/)[0];
  if (firstWord.length >= 3 && hit.name.toLowerCase().includes(firstWord)) return 'high';
  return 'low';
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const idx = next++;
      out[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export async function POST(req: NextRequest) {
  let items: ImportItem[];
  let city: string;
  let country: string;
  try {
    const body = await req.json();
    items = Array.isArray(body?.items) ? body.items : [];
    city = (body?.city || '').trim();
    country = (body?.country || '').trim();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (items.length === 0) return NextResponse.json({ error: 'No items' }, { status: 400 });
  if (items.length > 40) return NextResponse.json({ error: 'Send at most 40 items per request' }, { status: 400 });
  const denied = await requirePaid('import', null, items.length);
  if (denied) return denied;

  let cleaned: Cleaned[];
  try {
    cleaned = await cleanWithClaude(items, city, country);
  } catch (err) {
    return NextResponse.json({ error: `Could not read the list: ${err instanceof Error ? err.message : 'unknown error'}` }, { status: 502 });
  }

  const seen = new Map<number, number>();
  const toLookup = cleaned
    .filter(c => c.is_place && c.name)
    .map(c => {
      const item = items[c.i];
      const n = seen.get(c.i) ?? 0;
      seen.set(c.i, n + 1);
      return { c, item, key: n === 0 ? item.key : `${item.key}-${n}` };
    });

  const candidates = await mapLimit(toLookup, 6, async ({ c, item, key }): Promise<ImportCandidate> => {
    let hits: PlaceHit[] = [];
    try {
      hits = await searchPlaces([c.query || c.name, city, country].filter(Boolean).join(', '), 4);
    } catch (err) {
      console.error('[import] lookup failed for', c.name, err);
    }
    const match = hits[0] ?? null;
    const category: Category = normalizeCategory(c.category)
      ?? (match ? categoryFromTypes(match.types) : null) ?? 'Attraction';
    return {
      key,
      raw: item.raw,
      hint: item.hint,
      name: c.name,
      category,
      note: c.note || null,
      uncertain: !!c.uncertain,
      description: c.description || null,
      match,
      alternatives: hits.slice(1),
      confidence: match ? scoreConfidence(c.name, match, country) : 'none',
    };
  });

  const skipped = items
    .filter((_, i) => !cleaned.some(c => c.i === i && c.is_place))
    .map(it => it.raw);

  return NextResponse.json({ candidates, skipped });
}
