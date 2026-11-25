'use client';

import { useEffect, useState } from 'react';

// "Add to calendar": a subscribe link that keeps Apple Calendar in sync with the trip,
// plus a one-off .ics download as a backup.
export function CalendarModal({ tripId, onClose }: { tripId: string; onClose: () => void }) {
  const [links, setLinks] = useState<{ subscribe: string; https: string; download: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    fetch(`/projects/tripplanner/api/calendar/link?tripId=${tripId}`)
      .then(async r => { const d = await r.json(); if (!r.ok) throw new Error(d.error || 'Could not make the link'); setLinks(d); })
      .catch(e => setError(e instanceof Error ? e.message : 'Could not make the link'));
  }, [tripId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function copy() {
    if (!links) return;
    try { await navigator.clipboard.writeText(links.https); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* ignore */ }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center sm:p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-t-2xl bg-white p-5 shadow-xl sm:rounded-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-gray-900">Add to calendar</h2>
          <button onClick={onClose} className="text-sm text-gray-400 hover:text-gray-600">Close</button>
        </div>
        <p className="mt-1 text-[13px] text-gray-500">Every stop of each day&apos;s chosen plan, your flights and the hotel, with reminders before bookings.</p>

        {error && <p className="mt-4 text-sm text-red-500">{error}</p>}
        {!links && !error && <p className="mt-4 text-sm text-gray-400">Making your link…</p>}

        {links && (
          <div className="mt-4 space-y-3">
            <div className="rounded-xl border border-gray-200 p-3">
              <p className="text-sm font-medium text-gray-900">Subscribe (stays in sync)</p>
              <p className="mt-0.5 text-[12px] text-gray-500">Changes you make here show up in your calendar. Apple decides how often it checks, so it can take a while.</p>
              <div className="mt-2.5 flex flex-wrap gap-2">
                <a href={links.subscribe} className="rounded-lg bg-gray-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-gray-700">Subscribe in Apple Calendar</a>
                <button onClick={copy} className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50">{copied ? '✓ Copied' : 'Copy link'}</button>
              </div>
              <p className="mt-2 text-[11px] text-gray-400">Google Calendar: Other calendars, + , From URL, paste the copied link.</p>
            </div>
            <div className="rounded-xl border border-gray-200 p-3">
              <p className="text-sm font-medium text-gray-900">Download once (backup)</p>
              <p className="mt-0.5 text-[12px] text-gray-500">A snapshot of today&apos;s plan. Later changes won&apos;t update it.</p>
              <a href={links.download} className="mt-2.5 inline-block rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50">Download .ics</a>
            </div>
            <p className="text-[11px] text-gray-400">Anyone with the link can see the trip&apos;s plan, so share it like a password.</p>
          </div>
        )}
      </div>
    </div>
  );
}
