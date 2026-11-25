'use client';

import { CATEGORY_KEYS, getCategory, isCategory, type SavedPlace } from '@/app/projects/tripplanner/_components/placeTypes';

const chipBase = 'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition whitespace-nowrap';

// Only shows categories that actually exist in `places`, with counts.
export function CategoryChips({ places, active, onChange, mustGoOnly, onMustGoChange }: {
  places: SavedPlace[];
  active: string | null;
  onChange: (cat: string | null) => void;
  mustGoOnly?: boolean;
  onMustGoChange?: (v: boolean) => void;
}) {
  const counts = new Map<string, number>();
  for (const p of places) {
    const key = isCategory(p.category) ? p.category : 'Attraction';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const present = CATEGORY_KEYS.filter(k => counts.has(k));
  const mustGoCount = places.filter(p => p.must_go).length;

  return (
    <div className="flex flex-wrap gap-1.5">
      <button onClick={() => onChange(null)}
        className={`${chipBase} ${active === null ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
        All <span className="opacity-60">{places.length}</span>
      </button>
      {onMustGoChange && mustGoCount > 0 && (
        <button onClick={() => onMustGoChange(!mustGoOnly)}
          className={`${chipBase} ${mustGoOnly ? 'bg-amber-400 text-white' : 'bg-amber-50 text-amber-700 hover:bg-amber-100'}`}>
          ★ Must-go <span className="opacity-70">{mustGoCount}</span>
        </button>
      )}
      {present.map(key => {
        const cat = getCategory(key);
        const on = active === key;
        return (
          <button key={key} onClick={() => onChange(on ? null : key)}
            className={`${chipBase} ${on ? 'text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
            style={on ? { background: cat.color } : undefined}>
            <span>{cat.emoji}</span>{cat.label} <span className="opacity-60">{counts.get(key)}</span>
          </button>
        );
      })}
    </div>
  );
}

export function categoryMatches(place: SavedPlace, active: string | null): boolean {
  if (active === null) return true;
  const key = isCategory(place.category) ? place.category : 'Attraction';
  return key === active;
}
