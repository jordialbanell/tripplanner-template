'use client';

import { useCallback, useEffect, useState } from 'react';

interface Link {
  id: string;
  role: 'view' | 'edit';
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  live: boolean;
  url: string | null;
  budgetUsd: number | null;
  usage: { today: number; total: number; usd: number; features: Record<string, number> } | null;
}

interface Meta { eurPerUsd: number | null; dailyCap: number; labels: Record<string, string>; spendTracked: boolean }

const BUDGETS = [2, 5, 10, 20, 50];

const API = '/projects/tripplanner/api/share';
const fmt = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

// the owner's share links for one trip: make a view or edit link, copy it, switch it off.
// Switching off is permanent; a new link always gets a new code.
export function ShareModal({ tripId, tripName, onClose }: { tripId: string; tripName: string; onClose: () => void }) {
  const [links, setLinks] = useState<Link[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [days, setDays] = useState<number>(0);
  const [copied, setCopied] = useState<string | null>(null);
  const [budget, setBudget] = useState<number>(5); // 0 = no limit
  const [meta, setMeta] = useState<Meta | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`${API}?tripId=${tripId}`, { cache: 'no-store' });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) { setError(d.setupNeeded ? 'Sharing needs a one-time database setup (supabase/007_trip_sharing.sql).' : d.error || 'Could not load links'); setLinks([]); return; }
    setLinks(d.links);
    setMeta({ eurPerUsd: d.eurPerUsd ?? null, dailyCap: d.dailyCap ?? 60, labels: d.labels || {}, spendTracked: d.spendTracked !== false });
  }, [tripId]);

  // Spend is stored in USD; shown in euros when today's rate is known.
  const money = (usd: number) => {
    const r = meta?.eurPerUsd;
    const v = r ? usd * r : usd;
    const sym = r ? '€' : 'US$';
    return v > 0 && v < 0.01 ? `<${sym}0.01` : `${sym}${v.toFixed(2)}`;
  };
  const budgetEur = (usd: number) => (meta?.eurPerUsd ? Math.round(usd * meta.eurPerUsd) : null);

  async function changeBudget(id: string, eur: number) {
    setBusy(true); setError(null);
    const res = await fetch(API, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, budgetEur: eur || null }) });
    const d = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) setError(d.error || 'Could not change the limit');
    load();
  }
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  async function create(role: 'view' | 'edit') {
    setBusy(true); setError(null);
    const res = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tripId, role, days: days || undefined, budgetEur: role === 'edit' && budget ? budget : undefined }) });
    const d = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setError(d.error || 'Could not create the link'); return; }
    await load();
    if (d.link?.url) copy(d.link.id, d.link.url);
  }

  async function switchOff(id: string) {
    if (!window.confirm('Switch this link off? Anyone using it loses access straight away. This can\'t be undone; you can always make a new link.')) return;
    setBusy(true);
    await fetch(API, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
    setBusy(false);
    load();
  }

  async function copy(id: string, url: string) {
    try { await navigator.clipboard.writeText(url); setCopied(id); setTimeout(() => setCopied(null), 2000); } catch { /* ignore */ }
  }

  const live = (links || []).filter(l => l.live);
  const old = (links || []).filter(l => !l.live);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="max-h-[90vh] w-full max-w-md space-y-4 overflow-y-auto rounded-2xl bg-white p-6 shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-base font-semibold text-gray-900">Share {tripName}</h2>
            <p className="mt-1 text-xs text-gray-500">Anyone with a link can open this trip only. View links can look; edit links can change it and use the AI tools (up to 60 calls a day, within the spending limit you set).</p>
          </div>
          <button onClick={onClose} aria-label="Close" className="text-gray-400 hover:text-gray-600">✕</button>
        </div>

        <div className="space-y-2">
          <div className="flex items-center gap-2 text-xs text-gray-500">
            <span>Link ends</span>
            <span className="relative inline-flex">
            <select value={days} onChange={e => setDays(Number(e.target.value))} className="appearance-none rounded-md border border-gray-200 bg-white py-1 pl-2 pr-7 text-xs text-gray-700">
              <option value={0}>never (until you switch it off)</option>
              <option value={7}>in 7 days</option>
              <option value={30}>in 30 days</option>
              <option value={90}>in 90 days</option>
            </select>
            <svg aria-hidden className="pointer-events-none absolute right-2 top-1/2 h-3 w-3 -translate-y-1/2 text-gray-400" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.17l3.71-3.94a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clipRule="evenodd" /></svg>
            </span>
          </div>
          <div className="flex items-center gap-2 text-xs text-gray-500">
            <span>Edit link spending limit</span>
            <span className="relative inline-flex">
            <select value={budget} onChange={e => setBudget(Number(e.target.value))} className="appearance-none rounded-md border border-gray-200 bg-white py-1 pl-2 pr-7 text-xs text-gray-700">
              {BUDGETS.map(b => <option key={b} value={b}>€{b} est.</option>)}
              <option value={0}>no limit</option>
            </select>
            <svg aria-hidden className="pointer-events-none absolute right-2 top-1/2 h-3 w-3 -translate-y-1/2 text-gray-400" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.17l3.71-3.94a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clipRule="evenodd" /></svg>
            </span>
          </div>
          <div className="flex gap-2">
            <button disabled={busy} onClick={() => create('view')} className="flex-1 rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50">New view link</button>
            <button disabled={busy} onClick={() => create('edit')} className="flex-1 rounded-lg bg-sky-500 px-3 py-2 text-sm font-medium text-white hover:bg-sky-600 disabled:opacity-50">New edit link</button>
          </div>
          {error && <p className="text-xs text-red-500">{error}</p>}
        </div>

        <div className="space-y-2">
          <p className="text-xs font-semibold text-gray-500">Live links</p>
          {links === null && <p className="text-xs text-gray-400">Loading…</p>}
          {links && live.length === 0 && <p className="text-xs text-gray-400">No live links. Only you can open this trip.</p>}
          {live.map(l => (
            <div key={l.id} className="rounded-lg border border-gray-200 px-3 py-2">
              <div className="flex items-center gap-2">
                <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${l.role === 'edit' ? 'bg-sky-50 text-sky-700' : 'bg-gray-100 text-gray-600'}`}>{l.role === 'edit' ? 'Edit' : 'View'}</span>
                <span className="min-w-0 flex-1 truncate text-xs text-gray-500">
                  Made {fmt(l.createdAt)}{l.expiresAt ? ` · ends ${fmt(l.expiresAt)}` : ''}
                </span>
                {l.url && (
                  <button onClick={() => copy(l.id, l.url!)} className="text-xs font-medium text-sky-600 hover:text-sky-700">{copied === l.id ? 'Copied' : 'Copy'}</button>
                )}
  <button disabled={busy} onClick={() => switchOff(l.id)} className="text-xs font-medium text-red-500 hover:text-red-600">Switch off</button>
              </div>
              {l.usage && <Spend link={l} meta={meta} money={money} budgetEur={budgetEur} busy={busy} onBudget={eur => changeBudget(l.id, eur)} />}
            </div>
          ))}
        </div>

        {old.length > 0 && (
          <details className="text-xs text-gray-400">
            <summary className="cursor-pointer">{old.length} switched-off or ended link{old.length === 1 ? '' : 's'}</summary>
            <ul className="mt-2 space-y-1">
              {old.map(l => (
                <li key={l.id}>{l.role === 'edit' ? 'Edit' : 'View'} link made {fmt(l.createdAt)}, {l.revokedAt ? `switched off ${fmt(l.revokedAt)}` : 'ended'}</li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </div>
  );
}

// Spend line under an edit link: estimate so far, calls, limit, and a per-feature breakdown.
function Spend({ link, meta, money, budgetEur, busy, onBudget }: {
  link: Link; meta: Meta | null; money: (usd: number) => string; budgetEur: (usd: number) => number | null;
  busy: boolean; onBudget: (eur: number) => void;
}) {
  const u = link.usage!;
  const cap = meta?.dailyCap ?? 60;
  const limit = link.budgetUsd;
  const pct = limit ? Math.min(100, (u.usd / limit) * 100) : 0;
  const current = limit ? budgetEur(limit) : 0;
  const options = Array.from(new Set([...BUDGETS, ...(current ? [current] : [])])).sort((a, b) => a - b);
  const features = Object.entries(u.features).sort((a, b) => b[1] - a[1]);
  return (
    <div className="mt-2 space-y-1.5 border-t border-gray-100 pt-2 text-xs">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-gray-700">
          {meta?.spendTracked === false ? <span className="text-gray-400">Spend not tracked yet</span> : <><span className="font-medium">{money(u.usd)}</span> <span className="text-gray-400">est. spent</span></>}
        </span>
        <span className="text-gray-400">{u.total} call{u.total === 1 ? '' : 's'} · {u.today}/{cap} today</span>
      </div>
      {limit != null && (
        <div className="h-1 overflow-hidden rounded-full bg-gray-100">
          <div className={`h-full rounded-full ${pct >= 90 ? 'bg-red-400' : pct >= 60 ? 'bg-amber-400' : 'bg-sky-400'}`} style={{ width: `${pct}%` }} />
        </div>
      )}
      <div className="flex items-center justify-between gap-2 text-gray-500">
        <span className="flex items-center gap-1">
          Limit
          <select disabled={busy} value={current ?? 0} onChange={e => onBudget(Number(e.target.value))} className="rounded border border-gray-200 bg-white px-1 py-0.5 text-xs text-gray-700">
            {options.map(b => <option key={b} value={b}>€{b}</option>)}
            <option value={0}>none</option>
          </select>
          {limit != null && <span className="text-gray-400">· {money(Math.max(0, limit - u.usd))} left</span>}
        </span>
        {features.length > 0 && (
          <details className="text-right">
            <summary className="cursor-pointer text-gray-400">By feature</summary>
            <ul className="mt-1 space-y-0.5 text-gray-500">
              {features.map(([k, n]) => <li key={k}>{meta?.labels[k] || k}: {n}</li>)}
            </ul>
          </details>
        )}
      </div>
    </div>
  );
}
