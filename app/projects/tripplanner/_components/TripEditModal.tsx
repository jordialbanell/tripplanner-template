'use client';

// Edit a trip's name, dates, cities (with hotel) and flights from inside the trip view.
import { useEffect, useState } from 'react';
import { supabase } from '@/lib/trip/supabase';
import {
  FlightFields, LegsFields, saveFlights, parseFlightString, legsMissingCountry,
  INPUT_CLASS, LABEL_CLASS, EMPTY_LEG, type Flight, type LegInput,
} from '@/app/projects/tripplanner/_components/ScheduleTab';

export interface EditableLeg {
  id: string;
  city: string;
  country: string;
  start_date: string | null;
  end_date: string | null;
  hotel: string | null;
}

interface Props {
  trip: { id: string; name: string; start_date: string; end_date: string; legs: EditableLeg[] };
  onClose: () => void;
  onSaved: () => void;     // parent reloads the trip
  onDeleted: () => void;
  canDelete?: boolean;     // only the owner can delete a trip
}

const NEW_FLIGHT: Flight = { number: '', date: '', assignedTo: 'Both', direction: 'Arriving' };

export function TripEditModal({ trip, onClose, onSaved, onDeleted, canDelete = false }: Props) {
  const [name, setName] = useState(trip.name);
  const [start, setStart] = useState(trip.start_date);
  const [end, setEnd] = useState(trip.end_date);
  const [legs, setLegs] = useState<LegInput[]>(
    trip.legs.length
      ? trip.legs.map(l => ({ id: l.id, city: l.city, country: l.country || '', start_date: l.start_date || '', end_date: l.end_date || '', hotel: l.hotel || '' }))
      : [{ ...EMPTY_LEG }],
  );
  const [flights, setFlights] = useState<Flight[]>([{ ...NEW_FLIGHT }]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    supabase.from('trip_flights').select('flight_number').eq('trip_id', trip.id).then(({ data }) => {
      if (data && data.length) setFlights(data.map((r: { flight_number: string }) => parseFlightString(r.flight_number)));
    });
  }, [trip.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !saving) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, saving]);

  async function handleSave() {
    if (legsMissingCountry(legs)) { setError('Add a country for each city'); return; }
    setSaving(true); setError(null);
    const fail = (msg: string) => { setError(msg); setSaving(false); };

    const { error: tripErr } = await supabase.from('trips').update({ name, start_date: start, end_date: end }).eq('id', trip.id);
    if (tripErr) return fail(tripErr.message);

    const flightErr = await saveFlights(trip.id, flights);
    if (flightErr) return fail(flightErr.message);

    // Update legs in place so day plans keep their links. A changed hotel is re-pinned.
    const kept = legs.filter(l => l.city.trim());
    for (let i = 0; i < kept.length; i++) {
      const l = kept[i];
      const before = trip.legs.find(x => x.id === l.id);
      const hotelChanged = (before?.hotel || '') !== l.hotel.trim();
      const row = {
        trip_id: trip.id, city: l.city.trim(), country: l.country.trim(),
        start_date: l.start_date || null, end_date: l.end_date || null, leg_order: i, hotel: l.hotel.trim() || null,
        ...(hotelChanged ? { hotel_lat: null, hotel_lng: null, hotel_place_id: null } : {}),
      };
      const { error: legErr } = l.id
        ? await supabase.from('trip_legs').update(row).eq('id', l.id)
        : await supabase.from('trip_legs').insert(row);
      if (legErr) return fail(legErr.message);
    }
    const keptIds = new Set(kept.map(l => l.id).filter(Boolean));
    const removed = trip.legs.map(l => l.id).filter(id => !keptIds.has(id));
    if (removed.length) {
      const { error: delErr } = await supabase.from('trip_legs').delete().in('id', removed);
      if (delErr) return fail(delErr.message);
    }

    setSaving(false);
    onSaved();
  }

  async function handleDelete() {
    if (!canDelete) return;
    setSaving(true);
    const { data: days } = await supabase.from('trip_days').select('id').eq('trip_id', trip.id);
    const dayIds = (days || []).map((d: { id: string }) => d.id);
    if (dayIds.length) await supabase.from('trip_stops').delete().in('day_id', dayIds);
    await supabase.from('trip_days').delete().eq('trip_id', trip.id);
    await supabase.from('trip_flights').delete().eq('trip_id', trip.id);
    await supabase.from('trip_excluded_places').delete().eq('trip_id', trip.id);
    await supabase.from('trip_included_places').delete().eq('trip_id', trip.id);
    await supabase.from('trip_legs').delete().eq('trip_id', trip.id);
    const { error: err } = await supabase.from('trips').delete().eq('id', trip.id);
    if (err) { setError(err.message); setSaving(false); return; }
    onDeleted();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center sm:p-4" onClick={() => !saving && onClose()}>
      <div className="flex max-h-[92dvh] w-full max-w-lg flex-col rounded-t-2xl bg-white shadow-xl sm:rounded-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4">
          <h2 className="text-base font-semibold text-gray-900">Edit trip</h2>
          <button onClick={onClose} disabled={saving} className="text-sm text-gray-400 hover:text-gray-600">Close</button>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto px-5 py-5">
          <div>
            <label className={LABEL_CLASS}>Trip name</label>
            <input value={name} onChange={e => setName(e.target.value)} className={INPUT_CLASS} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className={LABEL_CLASS}>Start</label><input type="date" value={start} onChange={e => setStart(e.target.value)} className={INPUT_CLASS} /></div>
            <div><label className={LABEL_CLASS}>End</label><input type="date" value={end} onChange={e => setEnd(e.target.value)} className={INPUT_CLASS} /></div>
          </div>
          <LegsFields legs={legs} onChange={setLegs} />
          <FlightFields flights={flights} onChange={setFlights} tripStart={start} tripEnd={end} />

          <div className={canDelete ? 'border-t border-gray-100 pt-4' : 'hidden'}>
            {!confirmDelete ? (
              <button onClick={() => setConfirmDelete(true)} className="text-xs font-medium text-red-500 hover:text-red-600">Delete this trip</button>
            ) : (
              <div className="flex items-center gap-3 rounded-lg bg-red-50 px-3 py-2">
                <span className="flex-1 text-xs text-red-700">Delete the trip, its days and flights? Your places stay.</span>
                <button onClick={() => setConfirmDelete(false)} className="text-xs text-gray-500">Cancel</button>
                <button onClick={handleDelete} disabled={saving} className="rounded-md bg-red-600 px-2.5 py-1 text-xs font-medium text-white">Delete</button>
              </div>
            )}
          </div>
        </div>

        <div className="space-y-2 border-t border-gray-100 px-5 py-4">
          {error && <p className="text-center text-sm text-red-500">{error}</p>}
          <button onClick={handleSave} disabled={saving || !name.trim() || !start || !end}
            className="w-full rounded-lg bg-gray-900 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-gray-800 disabled:opacity-40">
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </div>
    </div>
  );
}
