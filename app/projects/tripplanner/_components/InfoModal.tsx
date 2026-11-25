'use client';

import { Bike, Car, Footprints, MapPin } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { autoPlacePhotos, removePlacePhoto, uploadPlacePhoto } from '@/lib/trip/photos';
import { supabase } from '@/lib/trip/supabase';
import { CATEGORY_KEYS, CATEGORIES, PRESET_TAGS, getCategory, googleMapsUrl, amapLinks, isCategory, placePhoto, type ResearchResult, type SavedPlace } from '@/app/projects/tripplanner/_components/placeTypes';

export function InfoModal({ place, onClose, onUpdate, hotel, readOnly = false, tripId }: { place: SavedPlace; onClose: () => void; onUpdate: (updated: SavedPlace) => void; hotel?: string | null; readOnly?: boolean; tripId?: string }) {
  // Photo: your own (Add / Change), or a Google one found automatically when there's none.
  const [photoUrl, setPhotoUrl] = useState<string | null>(place.photo_url);
  const [photoBusy, setPhotoBusy] = useState<'finding' | 'uploading' | null>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const photo = placePhoto({ photo_url: photoUrl });
  // Saved straight away (not with "Save changes"), so tell the page now.
  const placeRef = useRef(place);
  function photoSaved(url: string) {
    setPhotoUrl(url);
    placeRef.current = { ...placeRef.current, photo_url: url };
    onUpdate(placeRef.current);
  }
  useEffect(() => {
    if (readOnly || place.photo_url) return;
    let live = true;
    setPhotoBusy('finding');
    autoPlacePhotos([place.id], tripId)
      .then(r => { if (live && r[place.id]) photoSaved(r[place.id]); })
      .catch(() => {})
      .finally(() => { if (live) setPhotoBusy(null); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [place.id]);
  async function pickPhoto(file: File | undefined) {
    if (!file) return;
    setPhotoBusy('uploading'); setPhotoError(null);
    try { photoSaved(await uploadPlacePhoto(place.id, file)); }
    catch (e) { setPhotoError(e instanceof Error ? e.message : 'Upload failed'); }
    setPhotoBusy(null);
  }
  async function dropPhoto() {
    if (!window.confirm('Remove this photo?')) return;
    try { await removePlacePhoto(place.id); photoSaved('none'); }
    catch (e) { setPhotoError(e instanceof Error ? e.message : 'Could not remove'); }
  }

  const [rating, setRating] = useState<number | null>(place.rating);
  const [beenHere, setBeenHere] = useState(place.been_here);
  const [note, setNote] = useState(place.personal_note || '');
  const [tags, setTags] = useState<string[]>(place.tags || []);
  const [tagInput, setTagInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [mustGo, setMustGo] = useState(place.must_go);
  const [category, setCategory] = useState<string>(isCategory(place.category) ? place.category : 'Attraction');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [research, setResearch] = useState<ResearchResult | null>(place.research);
  const [description, setDescription] = useState(place.description || '');
  const [researching, setResearching] = useState(false);
  const [researchError, setResearchError] = useState<string | null>(null);
  // Rename and re-pin. Changes are staged here and saved with "Save changes".
  const [name, setName] = useState(place.name);
  const [editingName, setEditingName] = useState(false);
  const [repinOpen, setRepinOpen] = useState(false);
  const [repinQuery, setRepinQuery] = useState(place.name);
  const [repinResults, setRepinResults] = useState<PinHit[] | null>(null);
  const [repinLoading, setRepinLoading] = useState(false);
  const [repinError, setRepinError] = useState<string | null>(null);
  const [newPin, setNewPin] = useState<PinHit | null>(null);

  async function searchPins() {
    const q = repinQuery.trim();
    if (!q) return;
    setRepinLoading(true); setRepinError(null); setRepinResults(null);
    try {
      const res = await fetch('/projects/tripplanner/api/places', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: q, city: place.city, country: place.country }),
      });
      const data = await res.json();
      if (!res.ok) setRepinError(res.status === 404 ? 'Google found nothing. Try adding the street or area.' : data.error || 'Search failed');
      else setRepinResults(data as PinHit[]);
    } catch (e) {
      setRepinError(e instanceof Error ? e.message : 'Search failed');
    }
    setRepinLoading(false);
  }

  function pickPin(hit: PinHit) {
    setNewPin(hit);
    if (!editingName && name === place.name) setName(hit.name);
    setRepinOpen(false);
  }

  async function runResearch() {
    setResearching(true); setResearchError(null);
    try {
      const res = await fetch('/projects/tripplanner/api/research', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: place.name, address: place.geo?.address || '', city: place.city, hotelCity: hotel ? `${hotel}, ${place.city}` : null, google_place_id: place.google_place_id || null }),
      });
      const data = await res.json();
      if (!res.ok) {
        setResearchError(data.error || 'Research failed');
      } else {
        // Save it so it's only ever paid for once.
        const saved: ResearchResult = { ...data, researched_at: new Date().toISOString() };
        setResearch(saved);
        // The card shows `description`, not research: fill it from the research summary if empty.
        const summary = typeof saved.summary === 'string' ? saved.summary.trim() : '';
        const fillDescription = !description && !!summary;
        const patch: Record<string, unknown> = { research: saved };
        if (fillDescription) patch.description = summary;
        const { error } = await supabase.from('places').update(patch).eq('id', place.id);
        if (!error) {
          if (fillDescription) setDescription(summary);
          onUpdate({ ...placeRef.current, research: saved, ...(fillDescription ? { description: summary } : {}) });
        }
      }
    } catch (e) {
      setResearchError(e instanceof Error ? e.message : 'Research failed');
    }
    setResearching(false);
  }

  function toggleTag(tag: string) {
    setTags(prev => prev.includes(tag) ? prev.filter(t => t !== tag) : [...prev, tag]);
  }

  function addCustomTag() {
    const t = tagInput.trim().toLowerCase();
    if (t && !tags.includes(t)) setTags(prev => [...prev, t]);
    setTagInput('');
  }

  async function handleSave() {
    setSaving(true);
    const cleanName = name.trim() || place.name;
    const pin = newPin
      ? { lat: newPin.lat, lng: newPin.lng, address: newPin.address, google_place_id: newPin.place_id,
          neighbourhood: newPin.neighbourhood ?? place.neighbourhood, research: null }
      : {};
    const updates = {
      rating: beenHere ? rating : null, been_here: beenHere, personal_note: note, tags, must_go: mustGo, category,
      name: cleanName, ...pin,
    };
    const { error } = await supabase.from('places').update(updates).eq('id', place.id);
    if (error) { setSaving(false); setSaveError(error.message); return; }

    // Stops planned at this place keep their own copy of name and position.
    if (newPin || cleanName !== place.name) {
      const stopPatch: Record<string, unknown> = { name: cleanName };
      if (newPin) Object.assign(stopPatch, { lat: newPin.lat, lng: newPin.lng, address: newPin.address });
      await supabase.from('trip_stops').update(stopPatch).eq('place_id', place.id);
    }
    setSaving(false);

    onUpdate({
      ...placeRef.current,
      description, rating: updates.rating, been_here: beenHere, personal_note: note, tags, must_go: mustGo, category, name: cleanName,
      ...(newPin ? {
        geo: { lat: newPin.lat, lng: newPin.lng, address: newPin.address },
        google_place_id: newPin.place_id,
        neighbourhood: newPin.neighbourhood ?? place.neighbourhood,
        research: null,
      } : { research }),
    });
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl max-w-md w-full p-6 space-y-4 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <input ref={fileRef} type="file" accept="image/*" className="hidden"
          onChange={e => { pickPhoto(e.target.files?.[0]); e.target.value = ''; }} />
        {photo ? (
          <div className="relative -mx-6 -mt-6 mb-1 overflow-hidden rounded-t-2xl bg-gray-100">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={photo} alt={place.name} className="aspect-[16/10] w-full object-cover" />
            {!readOnly && (
              <div className="absolute bottom-2 right-2 flex gap-1.5">
                <button onClick={() => fileRef.current?.click()} disabled={!!photoBusy}
                  className="rounded-full bg-white/90 px-3 py-1 text-xs font-medium text-gray-700 shadow-sm backdrop-blur hover:bg-white disabled:opacity-60">
                  {photoBusy === 'uploading' ? 'Uploading…' : 'Change photo'}
                </button>
                <button onClick={dropPhoto} disabled={!!photoBusy} aria-label="Remove photo"
                  className="rounded-full bg-white/90 px-2.5 py-1 text-xs text-gray-500 shadow-sm backdrop-blur hover:bg-white hover:text-red-500">
                  ✕
                </button>
              </div>
            )}
          </div>
        ) : !readOnly && (
          <button onClick={() => fileRef.current?.click()} disabled={!!photoBusy}
            className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-gray-200 py-5 text-sm text-gray-400 transition hover:border-sky-300 hover:text-sky-600 disabled:opacity-70">
            {photoBusy === 'finding' ? (
              <><span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-gray-300 border-t-sky-500" />Finding a photo…</>
            ) : photoBusy === 'uploading' ? 'Uploading…' : '+ Add photo'}
          </button>
        )}
        {photoError && <p className="-mt-2 text-xs text-red-500">{photoError}</p>}
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            {editingName ? (
              <input autoFocus value={name} onChange={e => setName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && setEditingName(false)} onBlur={() => setEditingName(false)}
                className="w-full rounded-lg border border-sky-300 px-2 py-1 text-lg font-semibold text-gray-900 outline-hidden ring-2 ring-sky-100" />
            ) : (
              <button onClick={() => { if (!readOnly) setEditingName(true); }} className="group text-left" title={readOnly ? undefined : 'Rename'}>
                <h2 className="inline font-semibold text-gray-900 text-lg leading-snug">{name}</h2>
                <span className="ml-1.5 text-xs text-gray-300 group-hover:text-sky-500">✎</span>
              </button>
            )}
            {place.source_handle && (
              <a
                href={place.tiktok_url || '#'}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-sky-500 hover:text-sky-700 transition"
              >
                @{place.source_handle}
              </a>
            )}
          </div>
          <div className="flex items-center gap-1 shrink-0">
          {readOnly ? (
            mustGo && <span className="rounded-full bg-amber-400 px-2.5 py-1 text-xs font-medium text-white">★ Must-go</span>
          ) : (
          <button
            onClick={() => setMustGo(v => !v)}
            className={`rounded-full px-2.5 py-1 text-xs font-medium transition ${mustGo ? 'bg-amber-400 text-white' : 'bg-amber-50 text-amber-700 hover:bg-amber-100'}`}
            title="Mark as a must-go"
          >
            ★ {mustGo ? 'Must-go' : 'Must-go?'}
          </button>
          )}
          <button onClick={onClose} className="text-gray-300 hover:text-gray-500 transition p-1" aria-label="Close">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
            </svg>
          </button>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {readOnly ? (
            <span className="shrink-0 text-xs font-medium" style={{ color: getCategory(category).color }}>
              {getCategory(category).emoji} {getCategory(category).label}
            </span>
          ) : (
          <select
            value={category}
            onChange={e => setCategory(e.target.value)}
            className="rounded-lg border border-gray-200 bg-white px-2 py-1 text-xs font-medium outline-hidden focus:border-sky-400"
            style={{ color: getCategory(category).color }}
          >
            {CATEGORY_KEYS.map(k => <option key={k} value={k}>{CATEGORIES[k].emoji} {CATEGORIES[k].label}</option>)}
          </select>
          )}
          <p className="text-sm text-gray-500 truncate">{[place.neighbourhood, place.city, place.country].filter(Boolean).join(', ')}</p>
        </div>
        {newPin ? (
          <div className="rounded-lg bg-sky-50 px-3 py-2 text-xs text-sky-800">
            <span className="font-medium">New pin:</span> {newPin.address}
            <button onClick={() => { setNewPin(null); setName(place.name); }} className="ml-2 text-sky-600 underline">Undo</button>
            <p className="mt-0.5 text-[11px] text-sky-600">Saved when you press Save changes.</p>
          </div>
        ) : (
          place.geo?.address && <p className="text-xs text-gray-400">{place.geo.address}</p>
        )}
        {readOnly ? null : !repinOpen ? (
          <button onClick={() => { setRepinOpen(true); setRepinResults(null); }}
            className="text-xs text-gray-400 transition hover:text-sky-600">
            Wrong place on the map? Re-pin it
          </button>
        ) : (
          <div className="space-y-2 rounded-lg border border-gray-200 p-2.5">
            <div className="flex gap-2">
              <input autoFocus value={repinQuery} onChange={e => setRepinQuery(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && searchPins()}
                placeholder="Name plus street or area"
                className="flex-1 rounded-lg border border-gray-200 bg-gray-50 px-3 py-1.5 text-xs outline-hidden focus:border-sky-400 focus:bg-white" />
              <button onClick={searchPins} disabled={repinLoading}
                className="rounded-lg bg-sky-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-600 disabled:opacity-40">
                {repinLoading ? '…' : 'Search'}
              </button>
              <button onClick={() => setRepinOpen(false)} className="px-1 text-xs text-gray-400 hover:text-gray-600">Cancel</button>
            </div>
            <p className="text-[11px] text-gray-400">Searching Google in {[place.city, place.country].filter(Boolean).join(', ')}.</p>
            {repinError && <p className="text-xs text-red-500">{repinError}</p>}
            {repinResults && (
              <div className="max-h-56 space-y-1 overflow-y-auto">
                {repinResults.map(hit => {
                  const current = hit.place_id === place.google_place_id;
                  return (
                    <button key={hit.place_id} onClick={() => pickPin(hit)} disabled={current}
                      className="block w-full rounded-lg px-2 py-1.5 text-left transition hover:bg-gray-50 disabled:opacity-50">
                      <p className="text-sm text-gray-800">{hit.name}{current && <span className="ml-1 text-[11px] text-gray-400">(current pin)</span>}</p>
                      <p className="truncate text-[11px] text-gray-400">{hit.address}</p>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
        {place.vibe && <p className="text-xs italic text-gray-400">{place.vibe}</p>}
        {description && <p className="text-sm text-gray-700 leading-relaxed border-t border-gray-100 pt-3">{description}</p>}

        {(() => {
          const amap = amapLinks(place);
          return amap ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <a href={amap.app} className="rounded-full bg-sky-500 px-3 py-1 text-xs font-medium text-white transition hover:bg-sky-600">
                Open in Amap
              </a>
              <a href={amap.web} target="_blank" rel="noopener noreferrer" className="text-xs text-gray-400 transition hover:text-sky-600">Amap web</a>
              <a href={googleMapsUrl(place)} target="_blank" rel="noopener noreferrer" className="text-xs text-gray-400 transition hover:text-sky-600">Google Maps</a>
            </div>
          ) : (
            <a href={googleMapsUrl(place)} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5 text-xs text-sky-500 hover:text-sky-700 transition">
              <MapPin className="inline-block h-3.5 w-3.5 shrink-0 align-[-2px]" strokeWidth={1.5} aria-hidden />Open in Google Maps
            </a>
          );
        })()}

        {place.tiktok_url && (
          <a href={place.tiktok_url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5 text-xs text-sky-500 hover:text-sky-700 transition">
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor"><path d="M19.59 6.69a4.83 4.83 0 01-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 01-2.88 2.5 2.89 2.89 0 01-2.89-2.89 2.89 2.89 0 012.89-2.89c.28 0 .54.04.79.1V9.01a6.33 6.33 0 00-.79-.05 6.34 6.34 0 00-6.34 6.34 6.34 6.34 0 006.34 6.34 6.34 6.34 0 006.33-6.34V8.69a8.18 8.18 0 004.78 1.52V6.76a4.85 4.85 0 01-1.01-.07z"/></svg>
            Watch on TikTok / Instagram
          </a>
        )}

        {readOnly ? (
          <>
            {(beenHere || tags.length > 0 || note.trim()) && (
              <div className="border-t border-gray-100 pt-3 space-y-3">
                {beenHere && (
                  <p className="text-sm text-gray-700">
                    <span className="font-medium text-green-600">✓ Been here</span>
                    {rating ? <span className="ml-2 text-yellow-400">{'★'.repeat(rating)}<span className="text-gray-200">{'★'.repeat(5 - rating)}</span></span> : null}
                  </p>
                )}
                {tags.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {tags.map(tag => (
                      <span key={tag} className="rounded-full bg-gray-100 px-2.5 py-1 text-xs font-medium text-gray-600">{tag}</span>
                    ))}
                  </div>
                )}
                {note.trim() && <p className="whitespace-pre-wrap text-sm text-gray-700">{note}</p>}
              </div>
            )}
          </>
        ) : (
          <>
        <div className="border-t border-gray-100 pt-3 space-y-2">
          <label className="text-xs font-medium text-gray-500">Been here?</label>
          <div className="flex gap-2">
            <button
              onClick={() => setBeenHere(true)}
              className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium transition border ${beenHere ? 'bg-green-500 text-white border-green-500' : 'bg-white text-gray-400 border-gray-200 hover:border-green-300'}`}
            >
              ✓ Yes
            </button>
            <button
              onClick={() => setBeenHere(false)}
              className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium transition border ${!beenHere ? 'bg-gray-100 text-gray-600 border-gray-200' : 'bg-white text-gray-400 border-gray-200 hover:border-gray-300'}`}
            >
              Not yet
            </button>
          </div>
        </div>

        {beenHere && (
          <div className="space-y-2">
            <label className="text-xs font-medium text-gray-500">Rating</label>
            <div className="flex gap-1">
              {[1,2,3,4,5].map(star => (
                <button key={star} onClick={() => setRating(rating === star ? null : star)} className={`text-2xl transition-colors ${star <= (rating ?? 0) ? 'text-yellow-400' : 'text-gray-200'}`}>★</button>
              ))}
            </div>
          </div>
        )}

        <div className="space-y-2">
          <label className="text-xs font-medium text-gray-500">Tags</label>
          <div className="flex flex-wrap gap-1.5">
            {PRESET_TAGS.map(tag => (
              <button key={tag} onClick={() => toggleTag(tag)} className={`rounded-full px-2.5 py-1 text-xs font-medium transition ${tags.includes(tag) ? 'bg-sky-500 text-white' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'}`}>
                {tag}
              </button>
            ))}
          </div>
          <div className="flex gap-2">
            <input
              type="text"
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addCustomTag()}
              placeholder="Add a tag"
              className="flex-1 rounded-lg border border-gray-200 bg-gray-50 px-3 py-1.5 text-xs text-gray-900 placeholder-gray-400 outline-hidden focus:border-sky-400 focus:ring-2 focus:ring-sky-100"
            />
            <button onClick={addCustomTag} className="rounded-lg bg-gray-100 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-200 transition">Add</button>
          </div>
          {tags.filter(t => !PRESET_TAGS.includes(t)).length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {tags.filter(t => !PRESET_TAGS.includes(t)).map(tag => (
                <span key={tag} className="flex items-center gap-1 rounded-full bg-sky-500 text-white px-2.5 py-1 text-xs font-medium">
                  {tag}
                  <button onClick={() => setTags(prev => prev.filter(t2 => t2 !== tag))} className="hover:text-sky-200">×</button>
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="space-y-2">
          <label className="text-xs font-medium text-gray-500">Personal note</label>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Your notes on this place"
            rows={3}
            className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 outline-hidden focus:border-sky-400 focus:ring-2 focus:ring-sky-100 resize-none"
          />
        </div>

          </>
        )}

        <div className="border-t border-gray-100 pt-3 space-y-2">
          {!research && !readOnly && (
            <button onClick={runResearch} disabled={researching}
              className="w-full rounded-lg bg-gray-900 px-3 py-2 text-sm font-medium text-white transition hover:bg-gray-800 disabled:opacity-40">
              {researching ? 'Researching...' : 'Research this place'}
            </button>
          )}
          {researchError && <p className="text-xs text-red-500">{researchError}</p>}
          {research && (
            <div className="rounded-lg border border-gray-100 bg-gray-50 p-3 space-y-2">
              {research.photos && research.photos.length > 0 && (
                <div className="flex gap-2 overflow-x-auto -mx-3 px-3 pb-1">
                  {research.photos.map((url, i) => (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img key={i} src={url} alt="" className="h-28 w-40 shrink-0 rounded-md object-cover" />
                  ))}
                </div>
              )}
              {research.status && research.status !== 'open' && (
                <p className={`rounded-md px-2 py-1 text-xs font-medium ${research.status === 'closed' ? 'bg-red-50 text-red-700' : 'bg-amber-50 text-amber-800'}`}>
                  {research.status === 'closed' ? 'Closed' : research.status === 'moved' ? 'Moved' : 'Status unclear'}
                </p>
              )}
              {research.status_note && <p className="text-xs leading-relaxed text-amber-800">{research.status_note}</p>}
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="text-[11px] text-gray-400">Worth visiting</div>
                  {research.basis && <div className="text-[11px] text-gray-400 mt-0.5">{research.basis}</div>}
                </div>
                <span className="text-sm font-semibold text-gray-900 shrink-0">{research.worth_visiting}/10</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-gray-400">Time to spend</span>
                <span className="text-xs text-gray-700">{research.time_to_spend}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-gray-400">Price</span>
                <span className="text-xs text-gray-700">{research.entrance_fee}</span>
              </div>
              {(research.travel_time_car || research.travel_time_bike || research.travel_time_walk) && (
                <div className="space-y-1">
                  <span className="text-[11px] text-gray-400">Travel from hotel</span>
                  <div className="flex gap-3 text-xs text-gray-700">
                    {research.travel_time_car && <span className="inline-flex items-center gap-1"><Car className="inline-block h-3.5 w-3.5 shrink-0 align-[-2px]" strokeWidth={1.5} aria-hidden />{research.travel_time_car}</span>}
                    {research.travel_time_bike && <span className="inline-flex items-center gap-1"><Bike className="inline-block h-3.5 w-3.5 shrink-0 align-[-2px]" strokeWidth={1.5} aria-hidden />{research.travel_time_bike}</span>}
                    {research.travel_time_walk && <span className="inline-flex items-center gap-1"><Footprints className="inline-block h-3.5 w-3.5 shrink-0 align-[-2px]" strokeWidth={1.5} aria-hidden />{research.travel_time_walk}</span>}
                  </div>
                </div>
              )}
              <p className="text-xs text-gray-600 leading-relaxed border-t border-gray-200 pt-2">{research.summary}</p>
              {research.what_to_order && research.what_to_order.length > 0 && (
                <div>
                  <span className="text-[11px] text-gray-400">What to order</span>
                  <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-gray-700">
                    {research.what_to_order.map((item, i) => <li key={i}>{item}</li>)}
                  </ul>
                </div>
              )}
              {research.sources && research.sources.length > 0 && (
                <div className="flex flex-wrap gap-x-2 gap-y-0.5 text-[11px]">
                  <span className="text-gray-400">Sources:</span>
                  {research.sources.map((url, i) => {
                    let host = url;
                    try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { /* keep raw */ }
                    return <a key={i} href={url} target="_blank" rel="noopener noreferrer" className="text-sky-500 hover:text-sky-700">{host}</a>;
                  })}
                </div>
              )}
              {research.google_maps_url && (
                <a href={research.google_maps_url} target="_blank" rel="noopener noreferrer"
                  className="block w-full text-center rounded-lg bg-white border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-100 transition">
                  Open in Maps
                </a>
              )}
              <div className="flex items-center justify-between pt-1 text-[11px] text-gray-400">
                <span>{research.researched_at ? `Researched ${new Date(research.researched_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}` : ''}</span>
                <button onClick={runResearch} disabled={researching} className="hover:text-gray-600 disabled:opacity-40">
                  {researching ? 'Researching…' : 'Research again'}
                </button>
              </div>
            </div>
          )}
        </div>

        {saveError && <p className="text-xs text-red-500">Couldn&apos;t save: {saveError}</p>}
        {readOnly ? (
          <p className="text-center text-xs text-gray-400">View only</p>
        ) : (
        <button onClick={handleSave} disabled={saving} className="w-full rounded-lg bg-sky-500 px-3 py-2 text-sm font-medium text-white transition hover:bg-sky-600 disabled:opacity-40">
          {saving ? 'Saving...' : 'Save changes'}
        </button>
        )}
      </div>
    </div>
  );
}

interface PinHit {
  place_id: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  neighbourhood: string | null;
}
