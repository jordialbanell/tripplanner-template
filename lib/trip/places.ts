import { supabase } from '@/lib/trip/supabase';
import { normalizeCategory, type SavedPlace } from '@/app/projects/tripplanner/_components/placeTypes';

// places.board_id is NOT NULL. Boards are no longer a user-facing concept, so
// every place goes on the single vestigial Wishlist board.
export { WISHLIST_BOARD_ID } from './constants';
import { WISHLIST_BOARD_ID } from './constants';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function rowToPlace(row: any): SavedPlace {
  return {
    id: row.id,
    created_at: row.created_at,
    name: row.name || '',
    city: row.city || '',
    country: row.country || '',
    category: normalizeCategory(row.category) ?? 'Attraction',
    emoji: row.emoji || null,
    vibe: row.vibe || '',
    description: row.description || '',
    source_handle: row.source_handle || null,
    geo: row.lat != null && row.lng != null ? { lat: row.lat, lng: row.lng, address: row.address ?? null } : undefined,
    tags: row.tags || [],
    been_here: !!row.been_here,
    rating: row.rating || null,
    personal_note: row.personal_note || '',
    tiktok_url: row.tiktok_url || '',
    google_place_id: row.google_place_id || null,
    must_go: !!row.must_go,
    neighbourhood: row.neighbourhood || null,
    research: row.research || null,
    photo_url: row.photo_url ?? null,
  };
}

export interface NewPlace {
  name: string;
  city: string;
  country: string;
  category: string;
  lat: number | null;
  lng: number | null;
  address: string | null;
  google_place_id: string | null;
  neighbourhood: string | null;
  vibe?: string;
  description?: string;
  tiktok_url?: string;
  source_handle?: string | null;
  must_go?: boolean;
  emoji?: string | null;
  personal_note?: string;
}

// Ask Claude for short descriptions of places that don't have one, and save them.
// Returns the updated places. Places Claude doesn't know stay without one.
export async function fillDescriptions(
  places: SavedPlace[],
  onProgress: (done: number, total: number) => void,
): Promise<SavedPlace[]> {
  const BATCH = 12;
  const batches: SavedPlace[][] = [];
  for (let i = 0; i < places.length; i += BATCH) batches.push(places.slice(i, i + BATCH));
  const updated: SavedPlace[] = [];
  let done = 0;
  let next = 0;

  async function worker() {
    while (next < batches.length) {
      const batch = batches[next++];
      try {
        const res = await fetch('/projects/tripplanner/api/describe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            places: batch.map(p => ({
              id: p.id, name: p.name, category: p.category, neighbourhood: p.neighbourhood,
              city: p.city, country: p.country, address: p.geo?.address ?? null,
              google_place_id: p.google_place_id ?? null,
            })),
          }),
        });
        const data = await res.json().catch(() => ({}));
        const results: { id: string; description: string | null }[] = data.results || [];
        await Promise.all(results.filter(r => r.description).map(async r => {
          const { error } = await supabase.from('places').update({ description: r.description }).eq('id', r.id);
          const place = batch.find(p => p.id === r.id);
          if (!error && place) updated.push({ ...place, description: r.description! });
        }));
      } catch { /* skip this batch; the button stays available to retry */ }
      done += batch.length;
      onProgress(done, places.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, batches.length) }, worker));
  return updated;
}

export async function fetchAllPlaces(): Promise<SavedPlace[]> {
  const { data, error } = await supabase.from('places').select('*').order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return (data || []).map(rowToPlace);
}

export async function insertPlaces(places: NewPlace[]): Promise<SavedPlace[]> {
  if (places.length === 0) return [];
  const rows = places.map(p => ({
    board_id: WISHLIST_BOARD_ID,
    name: p.name,
    city: p.city,
    country: p.country,
    category: p.category,
    lat: p.lat,
    lng: p.lng,
    address: p.address,
    google_place_id: p.google_place_id,
    neighbourhood: p.neighbourhood,
    vibe: p.vibe ?? '',
    description: p.description ?? null,
    tiktok_url: p.tiktok_url ?? '',
    source_handle: p.source_handle ?? null,
    must_go: p.must_go ?? false,
    emoji: p.emoji ?? null,
    tags: [],
    been_here: false,
    rating: null,
    personal_note: p.personal_note ?? '',
  }));
  const { data, error } = await supabase.from('places').insert(rows).select();
  if (error) throw new Error(error.message);
  return (data || []).map(rowToPlace);
}

// Add new places and swap in updated ones (e.g. an existing place that got a note).
export function mergePlaces(prev: SavedPlace[], changed: SavedPlace[]): SavedPlace[] {
  const byId = new Map(changed.map(p => [p.id, p]));
  const fresh = changed.filter(c => !prev.some(p => p.id === c.id));
  return [...fresh, ...prev.map(p => byId.get(p.id) ?? p)];
}

// Two places are the same if Google says so, or if they sit within ~50 m and share a name start.
export function findDuplicate(
  existing: SavedPlace[],
  candidate: { name: string; google_place_id?: string | null; lat?: number | null; lng?: number | null },
): SavedPlace | undefined {
  return existing.find(p => {
    if (candidate.google_place_id && p.google_place_id === candidate.google_place_id) return true;
    if (p.geo && candidate.lat != null && candidate.lng != null) {
      const close = Math.abs(p.geo.lat - candidate.lat) < 0.0005 && Math.abs(p.geo.lng - candidate.lng) < 0.0005;
      const a = p.name.toLowerCase().slice(0, 6);
      const b = candidate.name.toLowerCase().slice(0, 6);
      return close && (a === b || p.name.toLowerCase().includes(candidate.name.toLowerCase()));
    }
    return false;
  });
}
