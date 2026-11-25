'use client';

// Model lab: the same "Draft my days" menu step sent to several Bedrock models side by
// side, to compare speed, cost and whether they stick to the trip's real places.
import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { supabase } from '@/lib/trip/supabase';
import { LAB_MODELS, costUsd } from '@/lib/trip/labModels';

type Step = 'vibe' | 'area' | 'see' | 'lunch' | 'snack' | 'dinner' | 'after';

const STEPS: { key: Step; label: string; skippable?: boolean }[] = [
  { key: 'vibe', label: 'Vibe' },
  { key: 'area', label: 'Area' },
  { key: 'see', label: 'What to see' },
  { key: 'lunch', label: 'Lunch' },
  { key: 'snack', label: 'Coffee / snack', skippable: true },
  { key: 'dinner', label: 'Dinner' },
  { key: 'after', label: 'After dinner', skippable: true },
];
const nextStep = (s: Step): Step | null => {
  const i = STEPS.findIndex(x => x.key === s);
  return i >= 0 && i < STEPS.length - 1 ? STEPS[i + 1].key : null;
};

interface Pick { title: string; placeIds: string[]; from: string }
interface Stop { id: string; step: Step; from: string }

interface Option { title: string; blurb: string; placeIds: string[]; km: number | null }
interface RunResult {
  status: 'running' | 'done' | 'failed';
  startedAt: number;
  latencyMs?: number;
  inputTokens?: number | null;
  outputTokens?: number | null;
  error?: string | null;
  options?: Option[];
  validJson?: boolean;
  unknownCodes?: string[];
  raw?: string | null;
}

const MAX_MODELS = 6;

export default function ModelLab() {
  const { id: tripId } = useParams<{ id: string }>();
  const [tripName, setTripName] = useState('');
  const [names, setNames] = useState<Map<string, { name: string; mustGo: boolean }>>(new Map());
  const [step, setStep] = useState<Step>('vibe');
  const [vibe, setVibe] = useState<Pick | null>(null);
  const [area, setArea] = useState<Pick | null>(null);
  const [stops, setStops] = useState<Stop[]>([]);
  const [done, setDone] = useState(false);
  const [selected, setSelected] = useState<string[]>(LAB_MODELS.filter(m => m.defaultOn).map(m => m.id));
  const [results, setResults] = useState<Record<string, RunResult>>({});
  const [, tick] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    supabase.from('trips').select('name').eq('id', tripId).single().then(({ data }) => setTripName(data?.name ?? ''));
    supabase.from('places').select('id, name, must_go').then(({ data }) => {
      setNames(new Map((data ?? []).map((p: { id: string; name: string; must_go: boolean }) => [p.id, { name: p.name, mustGo: !!p.must_go }] as const)));
    });
  }, [tripId]);

  const running = Object.values(results).some(r => r.status === 'running');
  useEffect(() => {
    if (running && !timer.current) timer.current = setInterval(() => tick(t => t + 1), 250);
    if (!running && timer.current) { clearInterval(timer.current); timer.current = null; }
  }, [running]);

  function toggle(id: string) {
    setSelected(prev => prev.includes(id) ? prev.filter(x => x !== id) : prev.length >= MAX_MODELS ? prev : [...prev, id]);
  }

  async function run() {
    const now = Date.now();
    setResults(Object.fromEntries(selected.map(m => [m, { status: 'running', startedAt: now } as RunResult])));
    await Promise.all(selected.map(async model => {
      try {
        const res = await fetch('/projects/tripplanner/api/draft/step', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tripId, step, model,
            // What the menu is built around: the vibe for "area", the area for "see", the day's stops after that.
            pickedIds: step === 'area' ? vibe?.placeIds ?? []
              : step === 'see' || stops.length === 0 ? area?.placeIds ?? []
              : stops.map(x => x.id),
            usedIds: stops.map(x => x.id),
          }),
        });
        const data = await res.json();
        setResults(prev => ({ ...prev, [model]: {
          ...prev[model],
          status: res.ok && !data.error ? 'done' : 'failed',
          ...data,
          error: data.error ?? (res.ok ? null : `HTTP ${res.status}`),
        } }));
      } catch (e) {
        setResults(prev => ({ ...prev, [model]: { ...prev[model], status: 'failed', error: e instanceof Error ? e.message : 'failed' } }));
      }
    }));
  }

  function goTo(s: Step | null) {
    setResults({});
    if (s) { setStep(s); setDone(false); } else setDone(true);
  }
  function choose(o: Option, from: string) {
    if (step === 'vibe') { setVibe({ title: o.title, placeIds: o.placeIds, from }); setArea(null); setStops([]); goTo('area'); return; }
    if (step === 'area') { setArea({ title: o.title, placeIds: o.placeIds, from }); setStops([]); goTo('see'); return; }
    const id = o.placeIds[0];
    if (!id) return;
    if (step === 'see') {
      setStops(prev => prev.some(x => x.id === id) ? prev.filter(x => x.id !== id) : [...prev, { id, step, from }]);
      return;
    }
    setStops(prev => [...prev.filter(x => x.step !== step), { id, step, from }]);
    goTo(nextStep(step));
  }
  const unlocked = (s: Step) => s === 'vibe' || (s === 'area' ? !!vibe : !!area);
  const stepInfo = STEPS.find(x => x.key === step)!;

  const ordered = useMemo(() => selected.filter(id => results[id]), [selected, results]);
  const totalCost = ordered.reduce((sum, id) => {
    const r = results[id];
    const c = costUsd(LAB_MODELS.find(m => m.id === id), r?.inputTokens ?? null, r?.outputTokens ?? null);
    return sum + (c ?? 0);
  }, 0);

  return (
    <main className="min-h-full bg-gray-50">
      <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-gray-200 bg-white/95 px-4 py-3 backdrop-blur-sm sm:px-6">
        <Link href={`/projects/tripplanner/trip/${tripId}#schedule`} className="text-sm text-gray-500 hover:text-gray-900">← {tripName || 'Trip'}</Link>
        <h1 className="text-base font-semibold text-gray-900">Model lab</h1>
        <span className="hidden text-xs text-gray-400 sm:inline">Same question, several AI models, side by side</span>
      </header>

      <div className="mx-auto max-w-6xl space-y-5 px-4 py-5 sm:px-6">
        {/* Step */}
        <section className="rounded-xl border border-gray-200 bg-white p-4">
          <p className="mb-2 text-[11px] font-medium text-gray-400">Question</p>
          <div className="flex flex-wrap items-center gap-1.5">
            {STEPS.map((x, i) => (
              <button key={x.key} onClick={() => unlocked(x.key) && goTo(x.key)} disabled={!unlocked(x.key)}
                className={`rounded-full px-3 py-1.5 text-sm font-medium transition disabled:opacity-35 ${
                  step === x.key && !done ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
                {i + 1} · {x.label}
              </button>
            ))}
          </div>
          {(step === 'see' || stepInfo.skippable) && !done && (
            <div className="mt-2 flex gap-2">
              {step === 'see' && (
                <button onClick={() => goTo('lunch')} className="rounded-lg bg-sky-500 px-3 py-1 text-xs font-medium text-white hover:bg-sky-600">
                  Next: lunch →
                </button>
              )}
              {stepInfo.skippable && (
                <button onClick={() => goTo(nextStep(step))} className="rounded-lg bg-gray-100 px-3 py-1 text-xs font-medium text-gray-600 hover:bg-gray-200">
                  Skip this →
                </button>
              )}
            </div>
          )}

          {/* Day so far */}
          {(vibe || area || stops.length > 0) && (
            <div className="mt-3 border-t border-gray-100 pt-3">
              <p className="mb-1.5 text-[11px] font-medium text-gray-400">Day so far</p>
              <div className="flex flex-wrap items-center gap-1.5 text-xs">
                {vibe && <span className="rounded-full bg-violet-50 px-2 py-0.5 text-violet-700">Vibe: {vibe.title} <span className="text-violet-400">({vibe.from})</span></span>}
                {area && <span className="rounded-full bg-sky-50 px-2 py-0.5 text-sky-700">Area: {area.title} <span className="text-sky-400">({area.from})</span></span>}
                {stops.map(x => (
                  <span key={x.id} className="flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-gray-700">
                    <span className="text-gray-400">{STEPS.find(s2 => s2.key === x.step)?.label}:</span> {names.get(x.id)?.name ?? '…'}
                    <button onClick={() => setStops(prev => prev.filter(y => y.id !== x.id))} className="text-gray-400 hover:text-gray-700" aria-label="Remove">×</button>
                  </span>
                ))}
              </div>
              {done && <p className="mt-2 text-xs font-medium text-emerald-700">Day complete. In the real planner this becomes the day&apos;s stops.</p>}
            </div>
          )}
        </section>

        {/* Models */}
        <section className="rounded-xl border border-gray-200 bg-white p-4">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-[11px] font-medium text-gray-400">Models · {selected.length}/{MAX_MODELS}</p>
            <button onClick={run} disabled={!selected.length || running || done}
              className="rounded-lg bg-sky-500 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-sky-600 disabled:opacity-40">
              {running ? 'Running…' : `Run on ${selected.length} model${selected.length === 1 ? '' : 's'}`}
            </button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {LAB_MODELS.map(m => {
              const on = selected.includes(m.id);
              return (
                <button key={m.id} onClick={() => toggle(m.id)}
                  title={[m.provider, m.price ? `$${m.price.input} / $${m.price.output} per 1M tokens${m.price.note ? ` (${m.price.note})` : ''}` : 'price not checked', m.reasoning ? 'thinks first' : '', m.needsForm ? 'needs the Anthropic form in the Bedrock console' : ''].filter(Boolean).join(' · ')}
                  className={`rounded-full border px-2.5 py-1 text-xs font-medium transition ${on ? 'border-gray-900 bg-gray-900 text-white' : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300'}`}>
                  {m.label}
                  <span className={`ml-1 ${on ? 'text-gray-400' : 'text-gray-400'}`}>{m.provider}</span>
                  {m.reasoning && <span className="ml-1" title="Thinks before answering">💭</span>}
                  {m.needsForm && <span className="ml-1" title="Needs the Anthropic form first">⚠︎</span>}
                </button>
              );
            })}
          </div>
          <p className="mt-2 text-[11px] text-gray-400">💭 thinks before answering (slower). ⚠︎ Claude needs the one-time Anthropic form in the Bedrock console first.</p>
        </section>

        {/* Results */}
        {ordered.length > 0 && (
          <section>
            <div className="mb-2 flex items-baseline justify-between">
              <p className="text-[11px] font-medium text-gray-400">Answers</p>
              <p className="text-[11px] text-gray-400">This run: ${totalCost.toFixed(4)} (priced models only)</p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {ordered.map(id => {
                const m = LAB_MODELS.find(x => x.id === id)!;
                const r = results[id];
                const secs = ((r.latencyMs ?? (Date.now() - r.startedAt)) / 1000).toFixed(1);
                const cost = costUsd(m, r.inputTokens ?? null, r.outputTokens ?? null);
                const invented = r.unknownCodes?.length ?? 0;
                return (
                  <article key={id} className="flex flex-col rounded-xl border border-gray-200 bg-white p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="text-sm font-semibold text-gray-900">{m.label}</p>
                        <p className="text-[11px] text-gray-400">{m.provider}</p>
                      </div>
                      <span className={`text-sm font-semibold tabular-nums ${r.status === 'running' ? 'text-sky-600' : 'text-gray-700'}`}>{secs}s</span>
                    </div>

                    {r.status === 'running' && <div className="mt-3 h-1 overflow-hidden rounded-sm bg-sky-100"><div className="h-full w-1/3 animate-pulse rounded-sm bg-sky-400" /></div>}

                    {r.status !== 'running' && (
                      <div className="mt-2 flex flex-wrap gap-1 text-[11px]">
                        {r.inputTokens != null && <span className="rounded-sm bg-gray-100 px-1.5 py-0.5 text-gray-600">{r.inputTokens} in · {r.outputTokens} out</span>}
                        {cost != null && <span className="rounded-sm bg-gray-100 px-1.5 py-0.5 text-gray-600">${cost.toFixed(4)}{m.price?.note ? '*' : ''}</span>}
                        {r.status === 'done' && (r.validJson
                          ? <span className="rounded-sm bg-emerald-50 px-1.5 py-0.5 text-emerald-700">✓ valid answer</span>
                          : <span className="rounded-sm bg-red-50 px-1.5 py-0.5 text-red-600">✗ unreadable answer</span>)}
                        {r.validJson && (invented
                          ? <span className="rounded-sm bg-amber-50 px-1.5 py-0.5 text-amber-700" title={r.unknownCodes?.join(', ')}>✗ made up {invented} place{invented === 1 ? '' : 's'}</span>
                          : <span className="rounded-sm bg-emerald-50 px-1.5 py-0.5 text-emerald-700">✓ only your places</span>)}
                      </div>
                    )}

                    {r.error && <p className="mt-2 text-xs text-red-600">{r.error}</p>}
                    {r.raw && <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-sm bg-gray-50 p-2 text-[10px] text-gray-500">{r.raw}</pre>}

                    {r.options && r.options.length > 0 && (
                      <ol className="mt-3 space-y-2">
                        {r.options.map((o, i) => (
                          <li key={i} className="rounded-lg border border-gray-100 p-2">
                            <div className="flex items-start justify-between gap-2">
                              <p className="text-sm font-medium text-gray-900">{o.title}</p>
                              {o.km != null && <span className="shrink-0 text-[11px] text-gray-400">{o.km} km from hotel</span>}
                            </div>
                            {o.blurb && <p className="text-xs text-gray-500">{o.blurb}</p>}
                            <p className="mt-1 text-[11px] leading-relaxed text-gray-600">
                              {o.placeIds.map(pid => names.get(pid)).filter(Boolean).map((p, j) => (
                                <span key={j}>{j > 0 && ' · '}{p!.name}{p!.mustGo && <span className="text-amber-500">★</span>}</span>
                              ))}
                            </p>
                            {(() => {
                              const pickedHere = step === 'see' && stops.some(x => x.id === o.placeIds[0]);
                              const label = step === 'vibe' ? 'Use this vibe →' : step === 'area' ? 'Use this area →'
                                : step === 'see' ? (pickedHere ? '✓ Added (tap to remove)' : '+ Add to the day') : 'Pick this →';
                              return (
                                <button onClick={() => choose(o, m.label)}
                                  className={`mt-1.5 text-[11px] font-medium ${pickedHere ? 'text-emerald-600' : 'text-sky-600 hover:text-sky-700'}`}>
                                  {label}
                                </button>
                              );
                            })()}
                          </li>
                        ))}
                      </ol>
                    )}
                  </article>
                );
              })}
            </div>
            <p className="mt-2 text-[11px] text-gray-400">* US East list price; Sydney may differ slightly. Costs in USD, taken from your AWS credit.</p>
          </section>
        )}
      </div>
    </main>
  );
}
