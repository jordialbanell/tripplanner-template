'use client';

// Review possible duplicate places and merge them. Each group shows every copy; the radio
// picks which one to keep (pre-selected: the one on a plan / with the most details).
// "Not the same" hides a group on this device. Owner only.
import { useEffect, useMemo, useState } from 'react';
import { getCategory, placePhoto, type SavedPlace } from './placeTypes';
import { markNotDuplicates, mergeInto, openDuplicateGroups, pickKeeper, stopCounts } from '@/lib/trip/duplicates';

export function DuplicatesModal({ places, onClose, onMerged, onSkipped }: {
  places: SavedPlace[];
  onClose: () => void;
  onMerged: (removedIds: string[]) => void;
  onSkipped: () => void;
}) {
  // Fixed for the life of the modal, so merging one group doesn't reshuffle the rest.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const groups = useMemo(() => openDuplicateGroups(places), []);
  const [stops, setStops] = useState<Record<string, number> | null>(null);
  const [keepers, setKeepers] = useState<Record<number, string>>({});
  const [skipped, setSkipped] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState<number | 'all' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    stopCounts(groups.flat().map(p => p.id)).then(setStops);
  }, [groups]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && busy == null) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const keeperOf = (i: number) => keepers[i] ?? (stops ? pickKeeper(groups[i], stops).id : groups[i][0].id);
  const open = groups.map((_, i) => i).filter(i => !skipped.has(i));

  async function merge(i: number) {
    const keep = groups[i].find(p => p.id === keeperOf(i))!;
    const dupes = groups[i].filter(p => p.id !== keep.id);
    const err = await mergeInto(keep, dupes);
    if (err) { setError(`${keep.name}: ${err}`); return false; }
    setSkipped(prev => new Set(prev).add(i));
    onMerged(dupes.map(d => d.id));
    return true;
  }

  async function mergeOne(i: number) {
    setBusy(i); setError(null);
    await merge(i);
    setBusy(null);
  }

  async function mergeAll() {
    setBusy('all'); setError(null);
    for (const i of open) { if (!(await merge(i))) break; }
    setBusy(null);
  }

  const fmtDate = (s?: string) => s ? new Date(s).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '';

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center" onClick={() => busy == null && onClose()}>
      <div className="flex max-h-[90vh] w-full max-w-lg flex-col rounded-t-2xl bg-white shadow-xl sm:rounded-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 border-b border-gray-100 px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-gray-900">Possible duplicates</h2>
            <p className="mt-0.5 text-xs text-gray-500">
              {open.length === 0 ? 'Nothing left to review.' : `${open.length} group${open.length === 1 ? '' : 's'}. Merging keeps the ticked one, moves plan stops to it and combines the notes.`}
            </p>
          </div>
          <button onClick={onClose} disabled={busy != null} aria-label="Close" className="text-gray-400 hover:text-gray-600 disabled:opacity-40">✕</button>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto px-5 py-4">
          {error && <p className="rounded-lg bg-red-50 p-3 text-xs text-red-600">Couldn&apos;t merge {error}</p>}
          {open.length === 0 && <p className="py-8 text-center text-sm text-gray-500">No duplicates found.</p>}
          {open.map(i => (
            <div key={i} className="rounded-xl border border-gray-200">
              {groups[i].map(p => {
                const cat = getCategory(p.category);
                const photo = placePhoto(p);
                const n = stops?.[p.id] ?? 0;
                return (
                  <label key={p.id} className="flex cursor-pointer items-start gap-3 border-b border-gray-100 px-3 py-2.5 last:border-b-0">
                    <input type="radio" name={`keep-${i}`} checked={keeperOf(i) === p.id} disabled={busy != null}
                      onChange={() => setKeepers(prev => ({ ...prev, [i]: p.id }))} className="mt-1 accent-sky-500" />
                    {photo
                      ? <img src={photo} alt="" className="h-10 w-10 shrink-0 rounded-md object-cover" />
                      : <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-gray-100 text-lg">{p.emoji || cat.emoji}</span>}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-gray-900">{p.name}</span>
                      <span className="block truncate text-[11px] text-gray-500">{p.geo?.address || 'No pin'}</span>
                      <span className="mt-0.5 flex flex-wrap gap-x-2 text-[11px] text-gray-400">
                        <span>Saved {fmtDate(p.created_at)}</span>
                        {n > 0 && <span className="text-sky-600">On {n} plan stop{n === 1 ? '' : 's'}</span>}
                        {p.personal_note && <span className="truncate">Note: {p.personal_note}</span>}
                      </span>
                    </span>
                  </label>
                );
              })}
              <div className="flex justify-end gap-2 bg-gray-50 px-3 py-2">
                <button onClick={() => { markNotDuplicates(groups[i]); setSkipped(prev => new Set(prev).add(i)); onSkipped(); }} disabled={busy != null}
                  className="rounded-md px-2.5 py-1 text-xs font-medium text-gray-500 hover:bg-gray-100 disabled:opacity-40">Not the same</button>
                <button onClick={() => mergeOne(i)} disabled={busy != null || !stops}
                  className="rounded-md bg-sky-500 px-3 py-1 text-xs font-medium text-white hover:bg-sky-600 disabled:opacity-40">
                  {busy === i ? 'Merging…' : 'Merge'}
                </button>
              </div>
            </div>
          ))}
        </div>

        {open.length > 1 && (
          <div className="border-t border-gray-100 px-5 py-3">
            <button onClick={mergeAll} disabled={busy != null || !stops}
              className="w-full rounded-lg bg-gray-900 py-2.5 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-40">
              {busy === 'all' ? 'Merging…' : `Merge all ${open.length}`}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
