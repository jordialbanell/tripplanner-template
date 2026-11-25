// Finds saved places that are probably the same place saved twice, and merges them.
// A pair counts as a duplicate when Google gave them the same id, when their names match
// (ignoring case, punctuation, word order and a trailing plural), or when they sit within 60 m
// and their names overlap. Groups marked "Not the same" are remembered on this device.
import { supabase } from './supabase';
import type { SavedPlace } from '@/app/projects/tripplanner/_components/placeTypes';

function metres(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// "Changles 624" and "624 Changle" both become "624 changle".
function nameKey(name: string) {
  const base = name.toLowerCase().replace(/\(.*?\)|（.*?）/g, ' ');
  const words = base.split(/[^a-z0-9一-鿿]+/).filter(Boolean)
    .map(w => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w));
  return words.sort().join(' ');
}

// Chinese characters minus ones in almost every name (上海, 店, 路, 号, 馆…).
function cjk(name: string) {
  return (name.match(/[一-鿿]/g) || []).filter(ch => !'上海店路号馆餐厅咖啡面中国的'.includes(ch)).join('');
}

// Words too common to say two places are the same.
const COMMON = new Set(['the', 'and', 'shanghai', 'coffee', 'cafe', 'restaurant', 'bar', 'road', 'shop', 'store',
  'house', 'kitchen', 'noodle', 'noodles', 'bakery', 'market', 'plaza', 'mall', 'centre', 'center', 'branch',
  'hotel', 'dim', 'sum', 'tea', 'lane', 'street', 'new', 'old', 'gallery', 'museum', 'park', 'china']);

function namesOverlap(a: SavedPlace, b: SavedPlace) {
  const ka = nameKey(a.name), kb = nameKey(b.name);
  if (!ka || !kb) return false;
  if (ka === kb || ka.includes(kb) || kb.includes(ka)) return true;
  const wa = new Set(ka.split(' ').filter(w => w.length > 2 && !COMMON.has(w)));
  if (kb.split(' ').some(w => wa.has(w))) return true;
  const ca = cjk(a.name), cb = cjk(b.name);
  if (ca.length >= 2 && cb.length >= 2) {
    let shared = 0;
    for (const ch of new Set(ca)) if (cb.includes(ch)) shared++;
    if (shared >= 2) return true;
  }
  return false;
}

function isDuplicate(a: SavedPlace, b: SavedPlace) {
  if (a.google_place_id && a.google_place_id === b.google_place_id) return true;
  const far = a.geo && b.geo ? metres(a.geo, b.geo) : null;
  const same = nameKey(a.name) !== '' && nameKey(a.name) === nameKey(b.name);
  if (same) return true; // even far apart: a wrong pin, or a chain's branches ("Not the same" hides those)
  return far != null && far < 60 && namesOverlap(a, b);
}

/** Groups of two or more places that look like the same place. */
export function findDuplicateGroups(places: SavedPlace[]): SavedPlace[][] {
  const parent = places.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < places.length; i++) {
    for (let j = i + 1; j < places.length; j++) {
      if (isDuplicate(places[i], places[j])) parent[find(i)] = find(j);
    }
  }
  const groups = new Map<number, SavedPlace[]>();
  places.forEach((p, i) => {
    const r = find(i);
    groups.set(r, [...(groups.get(r) ?? []), p]);
  });
  return Array.from(groups.values()).filter(g => g.length > 1);
}

/** How many day-plan stops point at each place. */
export async function stopCounts(placeIds: string[]): Promise<Record<string, number>> {
  if (!placeIds.length) return {};
  const { data } = await supabase.from('trip_stops').select('place_id').in('place_id', placeIds);
  const out: Record<string, number> = {};
  for (const r of (data ?? []) as { place_id: string }[]) out[r.place_id] = (out[r.place_id] ?? 0) + 1;
  return out;
}

/** The one to keep: on a plan first, then the one with the most details, then the oldest. */
export function pickKeeper(group: SavedPlace[], stops: Record<string, number>): SavedPlace {
  const score = (p: SavedPlace) =>
    (stops[p.id] ?? 0) * 10 + (p.personal_note ? 3 : 0) + (p.photo_url && p.photo_url !== 'none' ? 2 : 0) +
    (p.geo ? 2 : 0) + (p.vibe ? 1 : 0) + (p.google_place_id ? 1 : 0) + (p.must_go ? 1 : 0);
  return [...group].sort((a, b) => score(b) - score(a) || (a.created_at ?? '').localeCompare(b.created_at ?? ''))[0];
}

/**
 * Folds `dupes` into `keep`: plan stops move over, notes and tags are combined, missing
 * details (pin, photo, description, source) are filled from the duplicates, then the
 * duplicates are deleted. Owner only.
 */
export async function mergeInto(keep: SavedPlace, dupes: SavedPlace[]): Promise<string | null> {
  const ids = dupes.map(d => d.id);
  if (!ids.length) return null;

  const r1 = await supabase.from('trip_stops').update({ place_id: keep.id }).in('place_id', ids);
  if (r1.error) return r1.error.message;

  const all = [keep, ...dupes];
  const notes = Array.from(new Set(all.map(p => p.personal_note?.trim()).filter(Boolean) as string[]));
  const tags = Array.from(new Set(all.flatMap(p => p.tags ?? [])));
  const firstWith = <T,>(get: (p: SavedPlace) => T | null | undefined) => all.map(get).find(v => v != null && v !== '' && v !== 'none') ?? null;
  const geo = keep.geo ?? dupes.find(d => d.geo)?.geo ?? null;

  const values: Record<string, unknown> = {
    personal_note: notes.join(' · ') || null,
    tags,
    must_go: all.some(p => p.must_go),
    been_here: all.some(p => p.been_here),
  };
  const rating = Math.max(...all.map(p => p.rating ?? 0));
  if (rating > 0) values.rating = rating;
  if (!keep.photo_url || keep.photo_url === 'none') { const v = firstWith(p => p.photo_url); if (v) values.photo_url = v; }
  if (!keep.vibe) { const v = firstWith(p => p.vibe); if (v) values.vibe = v; }
  if (!keep.description) { const v = firstWith(p => p.description); if (v) values.description = v; }
  if (!keep.tiktok_url) { const v = firstWith(p => p.tiktok_url); if (v) values.tiktok_url = v; }
  if (!keep.source_handle) { const v = firstWith(p => p.source_handle); if (v) values.source_handle = v; }
  if (!keep.geo && geo) {
    values.lat = geo.lat; values.lng = geo.lng;
    if (geo.address) values.address = geo.address;
  }
  const r2 = await supabase.from('places').update(values).eq('id', keep.id);
  if (r2.error) return r2.error.message;

  await supabase.from('trip_included_places').delete().in('place_id', ids);
  await supabase.from('trip_excluded_places').delete().in('place_id', ids);
  const r3 = await supabase.from('places').delete().in('id', ids);
  if (r3.error) return r3.error.message;
  return null;
}

const SKIP_KEY = 'tp-not-dupes-v1';
const groupKey = (g: SavedPlace[]) => g.map(p => p.id).sort().join('|');

export function skippedGroups(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(SKIP_KEY) || '[]')); } catch { return new Set(); }
}

export function markNotDuplicates(g: SavedPlace[]) {
  try {
    const s = skippedGroups(); s.add(groupKey(g));
    localStorage.setItem(SKIP_KEY, JSON.stringify(Array.from(s)));
  } catch { /* storage blocked */ }
}

/** Duplicate groups minus the ones marked "Not the same" on this device. */
export function openDuplicateGroups(places: SavedPlace[]): SavedPlace[][] {
  const skip = skippedGroups();
  return findDuplicateGroups(places).filter(g => !skip.has(groupKey(g)));
}
