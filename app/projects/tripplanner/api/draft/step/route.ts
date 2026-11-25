import { NextRequest, NextResponse } from 'next/server';
import { converse } from '@/lib/trip/bedrock';
import { buildPrompt, loadTripContext, parseOptions, DRAFT_STEPS, type DraftStep } from '@/lib/trip/draft';
import { LAB_MODELS, LAB_MODEL_IDS } from '@/lib/trip/labModels';
import { requirePaid } from '@/lib/trip/access';

export const maxDuration = 60;

// One menu step for one model. Guardrails: model and step from allowlists, prompt built
// server-side from the trip's data, picked ids must be the trip's own places, output capped.
export async function POST(req: NextRequest) {
  let body: { tripId?: string; step?: string; model?: string; pickedIds?: unknown; usedIds?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }
  return run(body);
}

// Same thing as a GET, for checking from a browser: ?tripId=...&step=vibe&model=...
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  return run({
    tripId: q.get('tripId') ?? undefined, step: q.get('step') ?? undefined, model: q.get('model') ?? undefined,
    pickedIds: q.get('picked')?.split(',').filter(Boolean),
    usedIds: q.get('used')?.split(',').filter(Boolean),
  });
}

async function run(body: { tripId?: string; step?: string; model?: string; pickedIds?: unknown; usedIds?: unknown }) {
  const { tripId, step, model } = body;
  if (!tripId || typeof tripId !== 'string') return NextResponse.json({ error: 'tripId required' }, { status: 400 });
  if (!step || !DRAFT_STEPS.includes(step as DraftStep)) return NextResponse.json({ error: 'Unknown step' }, { status: 400 });
  if (!model || !LAB_MODEL_IDS.has(model)) return NextResponse.json({ error: 'Model not allowed' }, { status: 400 });
  const denied = await requirePaid('draft', tripId);
  if (denied) return denied;

  try {
    const ctx = await loadTripContext(tripId);
    const own = new Set(ctx.places.map(p => p.id));
    const ownIds = (v: unknown) => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && own.has(x)).slice(0, 30) : [];
    const pickedIds = ownIds(body.pickedIds);
    const usedIds = ownIds(body.usedIds);
    const { system, prompt, candidates } = buildPrompt(step as DraftStep, ctx, pickedIds, usedIds);
    const info = LAB_MODELS.find(m => m.id === model);
    const r = await converse(model, prompt, {
      system,
      maxTokens: info?.reasoning ? 4000 : 1500,
      temperature: 0.5,
      timeoutMs: 55_000,
    });
    const parsed = parseOptions(r.text, ctx);
    return NextResponse.json({
      model,
      latencyMs: r.latencyMs,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      error: r.error ?? null,
      candidates,
      ...parsed,
      raw: parsed.validJson ? null : (r.text ?? '').slice(0, 1500),
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'failed' }, { status: 500 });
  }
}
