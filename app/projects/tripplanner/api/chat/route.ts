import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { requirePaid } from '@/lib/trip/access';

// Schedule chat: "what do you think of my plan?", "did I miss a must-go?", "best waterfalls?".
// The browser sends the trip as text (places as p1.., stops as s1..); the model answers, may search
// the web, and may propose changes as codes. Nothing is changed here: the browser shows the
// proposal and applies it only when the user taps Apply.
export const maxDuration = 60;

const client = new Anthropic({ apiKey: process.env.TRIP_ANTHROPIC_API_KEY });
const MODELS = [process.env.TRIP_CHAT_MODEL || 'claude-haiku-5-5', 'claude-haiku-4-5-20251001'];
const MAX_CONTEXT = 40_000;   // characters of trip text
const MAX_HISTORY = 12;       // earlier messages kept
const MAX_MESSAGE = 2_000;    // characters per message

interface ChatMessage { role: 'user' | 'assistant'; content: string }

const PROPOSE_TOOL = {
  name: 'propose_changes',
  description: 'Propose concrete edits to the schedule. The user sees them and decides whether to apply. Only call this when the user asks for changes or clearly agrees to a suggestion.',
  input_schema: {
    type: 'object' as const,
    properties: {
      summary: { type: 'string', description: 'One short sentence describing the changes.' },
      changes: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['add', 'remove', 'move'] },
            place: { type: 'string', description: 'add: code of a saved place, e.g. p12' },
            new_place: { type: 'string', description: 'add: name of a place NOT in the saved list (it will be looked up on Google and saved)' },
            category: { type: 'string', enum: ['Restaurant', 'Snacks', 'Café', 'Bar', 'Shopping', 'Museum', 'Attraction', 'Nature', 'Area', 'Photobooth'], description: 'add + new_place: its category' },
            stop: { type: 'string', description: 'remove / move: stop code, e.g. s3' },
            date: { type: 'string', description: 'add / move: day as YYYY-MM-DD' },
            position: { type: 'integer', description: 'add / move: 1-based position in that day. Omit to put it at the end.' },
          },
          required: ['action'],
        },
      },
    },
    required: ['summary', 'changes'],
  },
};

function systemPrompt(context: string): string {
  return `You are the trip assistant inside TripPlanner, talking to the person who made this trip.
You can see their schedule and their saved places below. Help them judge and improve the plan.

How to answer:
- Short and specific. Plain sentences, a few bullets at most. No em dashes. No filler.
- Refer to places by name, never by code.
- Must-go places are marked MUST GO. If asked what's missing, check every must-go against the schedule.
- Watch the timings: opening hours you're sure of, travel between far-apart stops, overloaded days, meals.
- For "what do others recommend", "best X", opening hours or anything current, use web search and say where it comes from (e.g. "travel bloggers and Google reviews rate..."). If you're not sure, say so. Never invent facts.
- Suggesting a place they haven't saved is fine. Say it's new.
- When they ask you to change the plan, or agree to a suggestion ("yes", "do it", "swap them"), call propose_changes with the edits and say in one line what you proposed. They apply it with a button, so don't claim it's done.
- Use saved place codes (p..) whenever the place is in the list; use new_place only for places that aren't.

THE TRIP
${context}`;
}

export async function POST(req: NextRequest) {
  let tripId = '', context = '', messages: ChatMessage[] = [];
  try {
    const body = await req.json();
    tripId = String(body?.tripId || '');
    context = String(body?.context || '').slice(0, MAX_CONTEXT);
    messages = (Array.isArray(body?.messages) ? body.messages : [])
      .filter((m: ChatMessage) => (m?.role === 'user' || m?.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
      .slice(-MAX_HISTORY)
      .map((m: ChatMessage) => ({ role: m.role, content: m.content.slice(0, MAX_MESSAGE) }));
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
  if (!tripId || !context || !messages.length || messages[messages.length - 1].role !== 'user') {
    return NextResponse.json({ error: 'Missing trip or question' }, { status: 400 });
  }
  // The model needs alternating turns starting with the user.
  while (messages.length && messages[0].role !== 'user') messages.shift();

  const denied = await requirePaid('chat', tripId);
  if (denied) return denied;

  let lastError = '';
  for (const model of MODELS) {
      try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const convo: any[] = messages.map(m => ({ role: m.role, content: m.content }));
      const textParts: string[] = [];
      const sources = new Map<string, string>();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let proposal: any = null;
      let searches = 0;
      let usage = { in: 0, out: 0 };

      // Server tools (web search) can pause a long turn; continue up to twice.
      for (let turn = 0; turn < 3; turn++) {
        const res = await client.messages.create({
          model,
          max_tokens: 1500,
          system: systemPrompt(context),
          tools: [
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            { type: 'web_search_20250305', name: 'web_search', max_uses: 3 } as any,
            PROPOSE_TOOL,
          ],
          tool_choice: { type: 'auto' },
          messages: convo,
        });
        usage = { in: usage.in + res.usage.input_tokens, out: usage.out + res.usage.output_tokens };
        for (const block of res.content) {
          if (block.type === 'text') {
            textParts.push(block.text);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            for (const c of ((block as any).citations || [])) {
              if (c?.url && !sources.has(c.url)) sources.set(c.url, c.title || c.url);
            }
          } else if (block.type === 'tool_use' && block.name === 'propose_changes') {
            proposal = block.input;
          } else if (block.type === 'server_tool_use') {
            searches++;
          }
        }
        if (res.stop_reason !== 'pause_turn') break;
        convo.push({ role: 'assistant', content: res.content });
      }

      console.log(`[trip-chat] ${model} in=${usage.in} out=${usage.out} searches=${searches} proposal=${proposal ? proposal.changes?.length ?? 0 : 0}`);
      const reply = textParts.join('').trim()
        || (proposal ? proposal.summary || 'Here are the changes I suggest.' : 'Sorry, I had nothing to say to that. Try asking another way.');
      return NextResponse.json({
        reply,
        proposal: proposal && Array.isArray(proposal.changes) && proposal.changes.length ? proposal : null,
        sources: Array.from(sources, ([url, title]) => ({ url, title })).slice(0, 6),
      });
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      console.error(`[trip-chat] ${model} failed:`, lastError);
    }
  }
  return NextResponse.json({ error: 'The assistant is unavailable right now. Try again in a minute.' }, { status: 502 });
}
