'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Earth } from '@/app/projects/tripplanner/_components/GlobeLoader';
import { describeChange, type ChatCodes, type ChatProposal } from '@/lib/trip/chatContext';

// The schedule chat. A small 3D globe sits in the bottom-right corner: drag and throw it
// (gravity, bounces off the edges), tap it to open the chat. The chat reads the whole trip,
// can search the web, and proposes changes that are only applied when the user taps Apply.

interface Msg {
  role: 'user' | 'assistant';
  content: string;
  proposal?: ChatProposal | null;
  lines?: string[];                 // readable proposal lines
  state?: 'open' | 'applying' | 'applied' | 'dismissed';
  sources?: { url: string; title: string }[];
}

interface Props {
  tripId: string;
  buildContext: () => { text: string; codes: ChatCodes };
  apply: (proposal: ChatProposal, codes: ChatCodes) => Promise<string>;
}

const SIZE = 60;          // globe px
const MARGIN = 16;        // gap to the window edges
const GRAVITY = 2600;     // px/s²
const BOUNCE = 0.55;      // energy kept on each bounce
const STARTERS = [
  'What do you think of my schedule?',
  'Did I miss any of my must-gos?',
  'Am I missing anything the pros rate highly?',
];

// Floor sits above the mobile bottom bar.
function bounds() {
  const mobile = window.innerWidth < 768;
  return {
    minX: MARGIN,
    maxX: window.innerWidth - SIZE - MARGIN,
    minY: MARGIN + 56,
    maxY: window.innerHeight - SIZE - MARGIN - (mobile ? 64 : 0),
  };
}

function ThrowableGlobe({ onTap, thinking }: { onTap: () => void; thinking: boolean }) {
  const el = useRef<HTMLDivElement>(null);
  const pos = useRef({ x: 0, y: 0 });
  const vel = useRef({ x: 0, y: 0 });
  const drag = useRef<{ dx: number; dy: number; startX: number; startY: number; t: number; moved: boolean; trail: { x: number; y: number; t: number }[] } | null>(null);
  const frame = useRef(0);
  const extraSpin = useRef(0);

  const paint = useCallback(() => {
    if (el.current) el.current.style.transform = `translate3d(${pos.current.x}px, ${pos.current.y}px, 0)`;
  }, []);

  const step = useCallback(() => {
    cancelAnimationFrame(frame.current);
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min((now - last) / 1000, 1 / 30);
      last = now;
      if (!drag.current) {
        const b = bounds();
        const p = pos.current, v = vel.current;
        v.y += GRAVITY * dt;
        p.x += v.x * dt;
        p.y += v.y * dt;
        if (p.x < b.minX) { p.x = b.minX; v.x = -v.x * BOUNCE; }
        if (p.x > b.maxX) { p.x = b.maxX; v.x = -v.x * BOUNCE; }
        if (p.y < b.minY) { p.y = b.minY; v.y = -v.y * BOUNCE; }
        if (p.y > b.maxY) {
          p.y = b.maxY;
          v.y = Math.abs(v.y) > 120 ? -v.y * BOUNCE : 0;
          v.x *= Math.pow(0.08, dt);  // rolling friction on the floor
        }
        // Rolling: spin follows sideways speed.
        extraSpin.current = v.x / 9000;
        paint();
        const resting = p.y >= b.maxY && v.y === 0 && Math.abs(v.x) < 4;
        if (resting) { v.x = 0; extraSpin.current = 0; return; }
      }
      frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
  }, [paint]);

  useEffect(() => {
    const b = bounds();
    pos.current = { x: b.maxX, y: b.maxY };
    paint();
    const onResize = () => {
      const nb = bounds();
      pos.current.x = Math.min(Math.max(pos.current.x, nb.minX), nb.maxX);
      pos.current.y = Math.min(Math.max(pos.current.y, nb.minY), nb.maxY);
      paint();
      step();
    };
    window.addEventListener('resize', onResize);
    return () => { window.removeEventListener('resize', onResize); cancelAnimationFrame(frame.current); };
  }, [paint, step]);

  useEffect(() => {
    if (thinking) extraSpin.current = 0.006;
    else if (!drag.current) extraSpin.current = 0;
  }, [thinking]);

  function down(e: React.PointerEvent) {
    e.currentTarget.setPointerCapture(e.pointerId);
    cancelAnimationFrame(frame.current);
    const now = performance.now();
    drag.current = {
      dx: e.clientX - pos.current.x, dy: e.clientY - pos.current.y,
      startX: e.clientX, startY: e.clientY, t: now, moved: false,
      trail: [{ x: e.clientX, y: e.clientY, t: now }],
    };
    vel.current = { x: 0, y: 0 };
  }

  function move(e: React.PointerEvent) {
    const d = drag.current;
    if (!d) return;
    if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) > 6) d.moved = true;
    if (!d.moved) return;
    const b = bounds();
    pos.current = {
      x: Math.min(Math.max(e.clientX - d.dx, b.minX), b.maxX),
      y: Math.min(Math.max(e.clientY - d.dy, b.minY), b.maxY),
    };
    const now = performance.now();
    d.trail.push({ x: e.clientX, y: e.clientY, t: now });
    while (d.trail.length > 2 && now - d.trail[0].t > 90) d.trail.shift();
    paint();
  }

  function up() {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (!d.moved) { onTap(); step(); return; }
    // Throw speed from the last ~90 ms of the drag.
    const a = d.trail[0], z = d.trail[d.trail.length - 1];
    const dt = Math.max((z.t - a.t) / 1000, 0.016);
    const cap = 4000;
    vel.current = {
      x: Math.max(-cap, Math.min(cap, (z.x - a.x) / dt)),
      y: Math.max(-cap, Math.min(cap, (z.y - a.y) / dt)),
    };
    step();
  }

  return (
    <div
      ref={el}
      role="button"
      aria-label="Ask about your schedule"
      tabIndex={0}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onTap(); } }}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      className="trip-chat-globe fixed left-0 top-0 z-40 cursor-grab touch-none select-none rounded-full active:cursor-grabbing"
      style={{ width: SIZE, height: SIZE, filter: 'drop-shadow(0 6px 10px rgba(15, 23, 42, 0.25))' }}
    >
      <Earth size={SIZE} extraSpin={extraSpin} />
    </div>
  );
}

// Light formatting for replies: **bold** and "- " bullets. Everything else stays plain text.
function inline(text: string) {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith('**') && part.endsWith('**') ? <strong key={i} className="font-semibold">{part.slice(2, -2)}</strong> : part);
}

function Rich({ text }: { text: string }) {
  const blocks: React.ReactNode[] = [];
  let bullets: string[] = [];
  const flush = () => {
    if (!bullets.length) return;
    blocks.push(<ul key={`u${blocks.length}`} className="my-1 list-disc space-y-1 pl-4">{bullets.map((b, i) => <li key={i}>{inline(b)}</li>)}</ul>);
    bullets = [];
  };
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*[-*•]\s+(.*)$/);
    if (m) { bullets.push(m[1]); continue; }
    flush();
    if (line.trim()) blocks.push(<p key={`p${blocks.length}`} className="my-1">{inline(line.replace(/^#+\s*/, ''))}</p>);
  }
  flush();
  return <>{blocks}</>;
}

function Proposal({ msg, onApply, onDismiss }: { msg: Msg; onApply: () => void; onDismiss: () => void }) {
  if (!msg.lines?.length) return null;
  return (
    <div className="mt-2 rounded-xl border border-sky-100 bg-sky-50/60 p-3">
      <p className="text-[11px] font-semibold text-sky-700">Proposed changes</p>
      <ul className="mt-1.5 space-y-1">
        {msg.lines.map((l, i) => <li key={i} className="text-[13px] text-gray-700">{l}</li>)}
      </ul>
      {msg.state === 'open' && (
        <div className="mt-2.5 flex gap-2">
          <button onClick={onApply} className="rounded-lg bg-gray-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-gray-700">Apply</button>
          <button onClick={onDismiss} className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-500 hover:text-gray-700">No thanks</button>
        </div>
      )}
      {msg.state === 'applying' && <p className="mt-2 text-xs text-gray-500">Applying…</p>}
      {msg.state === 'applied' && <p className="mt-2 text-xs font-medium text-emerald-600">Applied</p>}
      {msg.state === 'dismissed' && <p className="mt-2 text-xs text-gray-400">Not applied</p>}
    </div>
  );
}

export function ScheduleChat({ tripId, buildContext, apply }: Props) {
  const [portalReady, setPortalReady] = useState(false);
  useEffect(() => { setPortalReady(true); }, []);
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const codesRef = useRef<ChatCodes | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' }); }, [msgs, busy]);
  useEffect(() => { if (open) inputRef.current?.focus(); }, [open]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  async function send(text: string) {
    const q = text.trim();
    if (!q || busy) return;
    setError(null);
    setInput('');
    const next: Msg[] = [...msgs, { role: 'user', content: q }];
    setMsgs(next);
    setBusy(true);
    try {
      // Fresh context every time, so the chat sees changes made since the last question.
      const { text: context, codes } = buildContext();
      codesRef.current = codes;
      const history = next.map(m => ({
        role: m.role,
        content: m.lines?.length
          ? `${m.content}\n(Proposed: ${m.lines.join('; ')}. ${m.state === 'applied' ? 'The user applied it.' : 'Not applied.'})`
          : m.content,
      }));
      const res = await fetch('/projects/tripplanner/api/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tripId, context, messages: history }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Something went wrong');
      const proposal: ChatProposal | null = data.proposal ?? null;
      const lines = proposal ? proposal.changes.map(c => describeChange(c, codes)).filter((l): l is string => !!l) : [];
      setMsgs([...next, {
        role: 'assistant', content: data.reply, sources: data.sources || [],
        proposal, lines, state: lines.length ? 'open' : undefined,
      }]);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
      setMsgs(msgs);
      setInput(q);
    }
    setBusy(false);
  }

  async function applyAt(i: number) {
    const m = msgs[i];
    if (!m.proposal || !codesRef.current) return;
    setMsgs(prev => prev.map((x, k) => (k === i ? { ...x, state: 'applying' } : x)));
    try {
      const result = await apply(m.proposal, codesRef.current);
      setMsgs(prev => [...prev.map((x, k) => (k === i ? { ...x, state: 'applied' as const } : x)), { role: 'assistant' as const, content: result }]);
    } catch (e) {
      setMsgs(prev => prev.map((x, k) => (k === i ? { ...x, state: 'open' } : x)));
      setError(e instanceof Error ? e.message : 'Could not apply the changes');
    }
  }

  // Rendered into <body> so it stays visible when the planner itself is hidden (Places tab, phone map view).
  if (!portalReady) return null;
  return createPortal(
    <>
      <ThrowableGlobe onTap={() => setOpen(o => !o)} thinking={busy} />
      {open && (
        <div className="trip-sheet fixed inset-x-0 bottom-0 z-50 flex max-h-[80vh] flex-col rounded-t-2xl border border-gray-200 bg-white shadow-2xl sm:inset-x-auto sm:bottom-6 sm:right-6 sm:h-[560px] sm:w-[380px] sm:rounded-2xl">
          <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
            <div>
              <p className="text-sm font-semibold text-gray-900">Trip assistant</p>
              <p className="text-[11px] text-gray-400">Reads your schedule. Changes only when you tap Apply.</p>
            </div>
            <button onClick={() => setOpen(false)} className="text-sm text-gray-400 hover:text-gray-600" aria-label="Close chat">Close</button>
          </div>

          <div ref={listRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
            {msgs.length === 0 && (
              <div className="space-y-2 pt-2">
                <p className="text-sm text-gray-500">Ask anything about your plan.</p>
                {STARTERS.map(s => (
                  <button key={s} onClick={() => send(s)} className="block w-full rounded-xl border border-gray-200 px-3 py-2 text-left text-sm text-gray-700 transition hover:border-sky-300 hover:bg-sky-50">{s}</button>
                ))}
              </div>
            )}
            {msgs.map((m, i) => (
              <div key={i} className={m.role === 'user' ? 'flex justify-end' : ''}>
                <div className={m.role === 'user'
                  ? 'max-w-[85%] rounded-2xl rounded-br-md bg-gray-900 px-3 py-2 text-sm text-white'
                  : 'max-w-[95%] text-sm leading-relaxed text-gray-800'}>
                  {m.role === 'user' ? <p className="whitespace-pre-wrap">{m.content}</p> : <Rich text={m.content} />}
                  {m.role === 'assistant' && (
                    <Proposal msg={m} onApply={() => applyAt(i)} onDismiss={() => setMsgs(prev => prev.map((x, k) => (k === i ? { ...x, state: 'dismissed' } : x)))} />
                  )}
                  {!!m.sources?.length && (
                    <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
                      {m.sources.map(s => (
                        <a key={s.url} href={s.url} target="_blank" rel="noreferrer" className="max-w-[160px] truncate text-[11px] text-sky-600 hover:underline">{s.title}</a>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
            {busy && <p className="text-xs text-gray-400">Thinking (searching can take a few seconds)…</p>}
            {error && <p className="text-xs text-red-500">{error}</p>}
          </div>

          <form onSubmit={e => { e.preventDefault(); send(input); }} className="flex items-end gap-2 border-t border-gray-100 p-3">
            <textarea
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input); } }}
              rows={1}
              maxLength={2000}
              placeholder="Ask about your schedule"
              className="max-h-28 min-h-[40px] flex-1 resize-none rounded-xl border border-gray-200 px-3 py-2 text-[16px] text-gray-900 outline-none focus:border-sky-400 sm:text-sm"
            />
            <button type="submit" disabled={!input.trim() || busy} className="h-10 rounded-xl bg-sky-500 px-3 text-sm font-medium text-white transition hover:bg-sky-600 disabled:opacity-40">Send</button>
          </form>
        </div>
      )}
    </>,
    document.body,
  );
}
