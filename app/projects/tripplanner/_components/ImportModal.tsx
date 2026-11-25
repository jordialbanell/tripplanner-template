'use client';

import { CircleCheck } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { parsePastedList } from '@/lib/trip/parseList';
import { findDuplicate, insertPlaces, type NewPlace } from '@/lib/trip/places';
import { supabase } from '@/lib/trip/supabase';
import { CATEGORIES, CATEGORY_KEYS, getCategory, type SavedPlace } from '@/app/projects/tripplanner/_components/placeTypes';
import type { ImportCandidate } from '@/app/projects/tripplanner/api/import/route';
import type { PlaceHit } from '@/lib/trip/google';

const BATCH_SIZE = 8;
const PARALLEL = 4;

type Item = { key: string; raw: string; hint: string | null };

// One batch, retried once. Vercel returns an HTML error page on timeouts, so read text first.
async function lookupBatch(batch: Item[], city: string, country: string): Promise<{ candidates: ImportCandidate[]; skipped: string[] }> {
  let lastError = 'failed';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch('/projects/tripplanner/api/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: batch, city, country }),
      });
      const body = await res.text();
      let data: { candidates?: ImportCandidate[]; skipped?: string[]; error?: string } = {};
      try { data = JSON.parse(body); } catch { throw new Error(res.status === 504 ? 'timed out' : `server error (${res.status})`); }
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      return { candidates: data.candidates || [], skipped: data.skipped || [] };
    } catch (err) {
      lastError = err instanceof Error ? err.message : 'failed';
    }
  }
  throw new Error(lastError);
}

interface Row {
  c: ImportCandidate;
  include: boolean;
  category: string;
  mustGo: boolean;
  chosen: PlaceHit | null;
  duplicate: SavedPlace | undefined;
  tip: string | null;
}

type Stage = 'paste' | 'working' | 'review' | 'saving' | 'done';

export function ImportModal({ onClose, onImported, existingPlaces, defaultCity = '', defaultCountry = '', countrySuggestions = [] }: {
  onClose: () => void;
  onImported: (places: SavedPlace[]) => void;
  existingPlaces: SavedPlace[];
  defaultCity?: string;
  defaultCountry?: string;
  countrySuggestions?: string[];
}) {
  const [stage, setStage] = useState<Stage>('paste');
  const [text, setText] = useState('');
  const [city, setCity] = useState(defaultCity);
  const [country, setCountry] = useState(defaultCountry);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [rows, setRows] = useState<Row[]>([]);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [failed, setFailed] = useState<Item[]>([]);
  const [savedCount, setSavedCount] = useState(0);
  const [notedCount, setNotedCount] = useState(0);

  const parsed = useMemo(() => parsePastedList(text), [text]);
  const busy = stage === 'working' || stage === 'saving';

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  async function runLookup(items: Item[]): Promise<{ candidates: ImportCandidate[]; skipped: string[]; failedItems: Item[]; errs: string[] }> {
    const batches: Item[][] = [];
    for (let i = 0; i < items.length; i += BATCH_SIZE) batches.push(items.slice(i, i + BATCH_SIZE));
    setProgress({ done: 0, total: items.length });

    const candidates: ImportCandidate[] = [];
    const skipped: string[] = [];
    const failedItems: Item[] = [];
    const errs: string[] = [];
    let next = 0;

    async function worker() {
      while (next < batches.length) {
        const batch = batches[next++];
        try {
          const r = await lookupBatch(batch, city.trim(), country.trim());
          candidates.push(...r.candidates);
          skipped.push(...r.skipped);
        } catch (err) {
          failedItems.push(...batch);
          errs.push(`${batch.length} places couldn't be checked (${err instanceof Error ? err.message : 'failed'}): ${batch.map(b => b.raw).join(', ')}`);
        }
        setProgress(p => ({ ...p, done: p.done + batch.length }));
      }
    }
    await Promise.all(Array.from({ length: Math.min(PARALLEL, batches.length) }, worker));
    return { candidates, skipped, failedItems, errs };
  }

  function toRows(candidates: ImportCandidate[]): Row[] {
    const order = new Map(parsed.items.map((it, i) => [it.key, i]));
    const tips = new Map(parsed.items.map(it => [it.key, it.tip]));
    return candidates
      .slice()
      .sort((a, b) => (order.get(a.key.split('-')[0]) ?? 0) - (order.get(b.key.split('-')[0]) ?? 0))
      .map(c => {
        const duplicate = c.match
          ? findDuplicate(existingPlaces, { name: c.name, google_place_id: c.match.place_id, lat: c.match.lat, lng: c.match.lng })
          : undefined;
        return { c, include: !!c.match && !duplicate, category: c.category, mustGo: false, chosen: c.match, duplicate, tip: tips.get(c.key.split('-')[0]) ?? null };
      });
  }

  async function findPlaces() {
    setStage('working');
    setErrors([]);
    const items = parsed.items.map(({ key, raw, hint }) => ({ key, raw, hint }));
    const r = await runLookup(items);
    setRows(toRows(r.candidates));
    setSkipped(r.skipped);
    setFailed(r.failedItems);
    setErrors(r.errs);
    setStage('review');
  }

  async function retryFailed() {
    const items = failed;
    setStage('working');
    const r = await runLookup(items);
    setRows(prev => [...prev, ...toRows(r.candidates)]);
    setSkipped(prev => [...prev, ...r.skipped]);
    setFailed(r.failedItems);
    setErrors(r.errs);
    setStage('review');
  }

  function update(key: string, patch: Partial<Row>) {
    setRows(prev => prev.map(r => (r.c.key === key ? { ...r, ...patch } : r)));
  }

  async function save() {
    const chosen = rows.filter(r => r.include);
    setStage('saving');
    const newPlaces: NewPlace[] = chosen.map(r => ({
      name: r.c.name,
      city: city.trim() || r.chosen?.city || '',
      country: country.trim() || r.chosen?.country || '',
      category: r.category,
      lat: r.chosen?.lat ?? null,
      lng: r.chosen?.lng ?? null,
      address: r.chosen?.address ?? null,
      google_place_id: r.chosen?.place_id ?? null,
      neighbourhood: r.chosen?.neighbourhood ?? null,
      must_go: r.mustGo,
      description: r.c.description ?? undefined,
      personal_note: r.tip ?? undefined,
    }));
    try {
      const saved: SavedPlace[] = [];
      for (let i = 0; i < newPlaces.length; i += 50) saved.push(...(await insertPlaces(newPlaces.slice(i, i + 50))));
      // Places you already had: add the tip to their note instead of making a copy.
      const noted: SavedPlace[] = [];
      for (const r of noteOnly) {
        const p = r.duplicate!;
        const note = p.personal_note?.trim() ? `${p.personal_note.trim()}\n${r.tip}` : r.tip!;
        const { error } = await supabase.from('places').update({ personal_note: note }).eq('id', p.id);
        if (!error) noted.push({ ...p, personal_note: note });
      }
      setSavedCount(saved.length);
      setNotedCount(noted.length);
      onImported([...saved, ...noted]);
      setStage('done');
    } catch (err) {
      setErrors([`Saving failed: ${err instanceof Error ? err.message : 'unknown error'}`]);
      setStage('review');
    }
  }

  const isDoubtful = (r: Row) => r.c.confidence !== 'high' || r.c.uncertain;
  const needsLook = rows.filter(r => !r.duplicate && isDoubtful(r));
  const ready = rows.filter(r => !r.duplicate && !isDoubtful(r));
  const dupes = rows.filter(r => r.duplicate);
  const includeCount = rows.filter(r => r.include).length;
  // Tips for places already saved: added to their note on Save (if the note doesn't have it yet).
  const noteOnly = rows.filter(r => !r.include && r.duplicate && r.tip && !(r.duplicate.personal_note || '').includes(r.tip));
  const saveLabel = [
    includeCount > 0 && `${includeCount} place${includeCount === 1 ? '' : 's'}`,
    noteOnly.length > 0 && `${noteOnly.length} note${noteOnly.length === 1 ? '' : 's'}`,
  ].filter(Boolean).join(' + ');

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center sm:p-4" onClick={() => !busy && onClose()}>
      <div className="flex max-h-[92vh] w-full flex-col rounded-t-2xl bg-white shadow-xl sm:max-w-2xl sm:rounded-2xl" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-gray-900">Import a list</h2>
            <p className="text-xs text-gray-500">
              {stage === 'paste' && 'Paste columns from Google Sheets, or one place per line'}
              {stage === 'working' && 'Cleaning up names and finding each place…'}
              {stage === 'review' && `${rows.length} places found. Untick anything you don't want.`}
              {stage === 'saving' && 'Saving…'}
              {stage === 'done' && 'All done'}
            </p>
          </div>
          <button onClick={onClose} disabled={busy} className="rounded-md p-1 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 disabled:opacity-30" aria-label="Close">
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {stage === 'paste' && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-xs font-medium text-gray-600">City</label>
                  <input value={city} onChange={e => setCity(e.target.value)} placeholder="e.g. Hong Kong"
                    className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 outline-hidden focus:border-sky-400 focus:bg-white focus:ring-2 focus:ring-sky-100" />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-gray-600">Country</label>
                  <input value={country} onChange={e => setCountry(e.target.value)} placeholder="e.g. Hong Kong" list="import-countries"
                    className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 outline-hidden focus:border-sky-400 focus:bg-white focus:ring-2 focus:ring-sky-100" />
                  <datalist id="import-countries">{countrySuggestions.map(c => <option key={c} value={c} />)}</datalist>
                </div>
              </div>
              <textarea value={text} onChange={e => setText(e.target.value)} rows={10} autoFocus
                placeholder={'Select the columns in Google Sheets, copy, and paste here.\n\nOr one place per line, with an optional tip after a dash:\nNook Cafe\nLau Sum Kee - get the wonton noodles\nM+ Museum - go on a weekday'}
                className="w-full resize-none rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 font-mono text-xs text-gray-900 outline-hidden focus:border-sky-400 focus:bg-white focus:ring-2 focus:ring-sky-100" />
              {parsed.items.length > 0 && (
                <div className="rounded-lg bg-sky-50 p-3 text-xs text-sky-800">
                  <p className="font-medium">{parsed.items.length} entries detected</p>
                  {parsed.headers.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {parsed.headers.map(h => (
                        <span key={h.text} className="rounded-full bg-white px-2 py-0.5 text-sky-700">
                          {h.category ? `${CATEGORIES[h.category].emoji} ` : ''}{h.text} · {h.count}
                        </span>
                      ))}
                    </div>
                  )}
                  <p className="mt-2 text-sky-700/80">
                    Column names become categories. Typos are handled automatically.
                    {parsed.items.some(it => it.tip) && ` ${parsed.items.filter(it => it.tip).length} tip${parsed.items.filter(it => it.tip).length === 1 ? '' : 's'} (after a dash) will be saved as notes.`}
                  </p>
                </div>
              )}
            </div>
          )}

          {stage === 'working' && (
            <div className="py-10 text-center">
              <div className="mx-auto h-1.5 w-full max-w-sm overflow-hidden rounded-full bg-gray-100">
                <div className="h-full rounded-full bg-sky-500 transition-[width] duration-500"
                  style={{ width: `${progress.total ? Math.max(6, (progress.done / progress.total) * 100) : 6}%` }} />
              </div>
              <p className="mt-3 text-sm text-gray-500">Checked {progress.done} of {progress.total}</p>
              <p className="mt-1 text-xs text-gray-400">Usually under a minute</p>
            </div>
          )}

          {(stage === 'review' || stage === 'saving') && (
            <div className="space-y-5">
              {errors.length > 0 && (
                <div className="space-y-2 rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700">
                  {errors.map((e, i) => <p key={i}>{e}</p>)}
                  {failed.length > 0 && stage === 'review' && (
                    <button onClick={retryFailed} className="rounded-md bg-white px-3 py-1.5 font-medium text-red-700 shadow-xs ring-1 ring-red-200 hover:bg-red-100">
                      Retry {failed.length} place{failed.length === 1 ? '' : 's'}
                    </button>
                  )}
                </div>
              )}
              <Section title="Needs a look" subtitle="Unsure match, renamed, or recategorised" rows={needsLook} update={update} tone="amber" />
              <Section title="Ready" subtitle="Confident matches" rows={ready} update={update} tone="green" />
              <Section title="Already saved" subtitle="Skipped by default" rows={dupes} update={update} tone="gray" />
              {skipped.length > 0 && (
                <details className="text-xs text-gray-500">
                  <summary className="cursor-pointer">Ignored {skipped.length} line{skipped.length === 1 ? '' : 's'} that aren&apos;t places</summary>
                  <ul className="mt-2 list-disc space-y-0.5 pl-5">{skipped.map((s, i) => <li key={i}>{s}</li>)}</ul>
                </details>
              )}
            </div>
          )}

          {stage === 'done' && (
            <div className="py-10 text-center">
              <CircleCheck className="mx-auto h-8 w-8 text-gray-400" strokeWidth={1.5} aria-hidden />
              <p className="mt-2 text-sm font-medium text-gray-900">Added {savedCount} place{savedCount === 1 ? '' : 's'}{notedCount > 0 ? `, and a note to ${notedCount} you already had` : ''}</p>
              <p className="mt-1 text-xs text-gray-500">Tap any pin later to star it as a must-go.</p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t border-gray-100 px-5 py-3">
          {stage === 'paste' && (
            <>
              <button onClick={onClose} className="rounded-lg px-3 py-1.5 text-sm font-medium text-gray-500 hover:bg-gray-100">Cancel</button>
              <button onClick={findPlaces} disabled={parsed.items.length === 0 || !city.trim()}
                className="rounded-lg bg-sky-500 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-sky-600 disabled:cursor-not-allowed disabled:opacity-40">
                Find {parsed.items.length || ''} places
              </button>
            </>
          )}
          {(stage === 'review' || stage === 'saving') && (
            <>
              <button onClick={() => setStage('paste')} disabled={busy} className="mr-auto rounded-lg px-3 py-1.5 text-sm font-medium text-gray-500 hover:bg-gray-100 disabled:opacity-40">Back</button>
              <button onClick={save} disabled={busy || (includeCount === 0 && noteOnly.length === 0)}
                className="rounded-lg bg-sky-500 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-sky-600 disabled:cursor-not-allowed disabled:opacity-40">
                {stage === 'saving' ? 'Saving…' : `Save ${saveLabel || '0 places'}`}
              </button>
            </>
          )}
          {stage === 'done' && (
            <button onClick={onClose} className="rounded-lg bg-gray-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-gray-800">Show me the map</button>
          )}
        </div>
      </div>
    </div>
  );
}

function Section({ title, subtitle, rows, update, tone }: {
  title: string; subtitle: string; rows: Row[]; tone: 'amber' | 'green' | 'gray';
  update: (key: string, patch: Partial<Row>) => void;
}) {
  if (rows.length === 0) return null;
  const dot = tone === 'amber' ? 'bg-amber-400' : tone === 'green' ? 'bg-green-500' : 'bg-gray-300';
  return (
    <div>
      <div className="mb-2 flex items-baseline gap-2">
        <span className={`h-2 w-2 rounded-full ${dot}`} />
        <h3 className="text-xs font-semibold text-gray-500">{title} · {rows.length}</h3>
        <span className="text-xs text-gray-400">{subtitle}</span>
      </div>
      <div className="divide-y divide-gray-100 rounded-xl border border-gray-100">
        {rows.map(r => <ReviewRow key={r.c.key} row={r} update={update} />)}
      </div>
    </div>
  );
}

function ReviewRow({ row, update }: { row: Row; update: (key: string, patch: Partial<Row>) => void }) {
  const { c } = row;
  const cat = getCategory(row.category);
  const options = [c.match, ...c.alternatives].filter(Boolean) as PlaceHit[];
  const renamed = c.raw.trim().toLowerCase() !== c.name.trim().toLowerCase();

  return (
    <div className={`flex items-start gap-3 px-3 py-2.5 ${row.include ? '' : 'opacity-50'}`}>
      <input type="checkbox" checked={row.include} onChange={e => update(c.key, { include: e.target.checked })}
        className="mt-1 h-4 w-4 shrink-0 accent-sky-500" aria-label={`Include ${c.name}`} />

      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-center gap-2">
          <p className="truncate text-sm font-medium text-gray-900">{c.name}</p>
          <button onClick={() => update(c.key, { mustGo: !row.mustGo })} title="Must-go"
            className={`shrink-0 text-sm leading-none transition ${row.mustGo ? 'text-amber-500' : 'text-gray-300 hover:text-amber-400'}`}>★</button>
        </div>

        {renamed && <p className="text-[11px] text-gray-400">from &ldquo;{c.raw}&rdquo;</p>}

        {row.chosen ? (
          options.length > 1 ? (
            <select
              value={row.chosen.place_id}
              onChange={e => update(c.key, { chosen: options.find(o => o.place_id === e.target.value) ?? null })}
              className="w-full max-w-full truncate rounded-md border border-gray-200 bg-white px-2 py-1 text-[11px] text-gray-600 outline-hidden focus:border-sky-400"
            >
              {options.map(o => (
                <option key={o.place_id} value={o.place_id}>{o.name}{o.neighbourhood ? ` · ${o.neighbourhood}` : ''} · {o.address}</option>
              ))}
            </select>
          ) : (
            <p className="truncate text-[11px] text-gray-500">
              {[looksDifferent(c.name, row.chosen.name) ? row.chosen.name : null, row.chosen.neighbourhood, row.chosen.address].filter(Boolean).join(' · ')}
            </p>
          )
        ) : (
          <p className="text-[11px] text-amber-700">Not found on Google. If you tick it, it saves without a pin.</p>
        )}

        {c.confidence === 'low' && row.chosen && <p className="text-[11px] text-amber-700">Google matched a different name. Check it&apos;s the right place.</p>}
        {c.note && <p className={`text-[11px] ${c.uncertain ? 'text-amber-700' : 'text-gray-400'}`}>{c.note}</p>}
        {row.tip && <p className="text-[11px] text-sky-700">Tip: {row.tip}</p>}
        {row.duplicate && <p className="text-[11px] text-gray-500">Already saved as &ldquo;{row.duplicate.name}&rdquo;{row.tip ? ', the tip will be added to its note' : ''}</p>}
      </div>

      <select value={row.category} onChange={e => update(c.key, { category: e.target.value })}
        className="shrink-0 rounded-md border border-gray-200 bg-white px-1.5 py-1 text-[11px] font-medium outline-hidden focus:border-sky-400"
        style={{ color: cat.color }}>
        {CATEGORY_KEYS.map(k => <option key={k} value={k}>{CATEGORIES[k].emoji} {CATEGORIES[k].label}</option>)}
      </select>
    </div>
  );
}

function looksDifferent(a: string, b: string): boolean {
  const n = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, '');
  return !!b && !n(b).includes(n(a)) && !n(a).includes(n(b));
}
