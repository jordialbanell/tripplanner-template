// Server-only helpers for asking Claude for a JSON list.
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.TRIP_ANTHROPIC_API_KEY });

// Sonnet is much better with messy place names; Haiku is the fallback.
export const PRIMARY_MODEL = process.env.TRIP_ANTHROPIC_IMPORT_MODEL || 'claude-sonnet-5-5';
export const FALLBACK_MODEL = 'claude-haiku-4-5-20251001';

interface ListTool {
  name: string;
  description: string;
  itemSchema: Record<string, unknown>; // JSON schema for one item
}

// Asks for a list via a tool (tool_choice "auto": Sonnet 5.5 rejects a forced tool),
// reads the JSON array out of the text if the model answers in prose instead, and
// falls back to Haiku if Sonnet errors.
export async function askForList<T>(prompt: string, tool: ListTool, tag: string): Promise<T[]> {
  const toolDef = {
    name: tool.name,
    description: tool.description,
    input_schema: {
      type: 'object' as const,
      properties: { entries: { type: 'array', items: tool.itemSchema } },
      required: ['entries'],
    },
  };

  let lastError: unknown = null;
  for (const model of [PRIMARY_MODEL, FALLBACK_MODEL]) {
    try {
      const res = await client.messages.create({
        model,
        max_tokens: 4096,
        tools: [toolDef],
        tool_choice: { type: 'auto' },
        messages: [{
          role: 'user',
          content: `${prompt}\n\nCall the ${tool.name} tool once with all entries. If you cannot call tools, reply with ONLY the JSON array of entries.`,
        }],
      });
      const block = res.content.find(b => b.type === 'tool_use');
      if (block && block.type === 'tool_use') return ((block.input as { entries?: T[] }).entries) || [];
      const text = res.content.map(b => (b.type === 'text' ? b.text : '')).join('');
      return extractJsonArray(text) as T[];
    } catch (err) {
      lastError = err;
      console.error(`[${tag}] ${model} failed:`, err instanceof Error ? err.message : err);
    }
  }
  throw lastError instanceof Error ? lastError : new Error('All models failed');
}

// Pulls the first complete JSON array out of a reply, ignoring any prose around it.
export function extractJsonArray(text: string): unknown[] {
  const start = text.indexOf('[');
  if (start === -1) throw new Error('no JSON array in reply');
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '[') depth++;
    else if (ch === ']' && --depth === 0) return JSON.parse(text.slice(start, i + 1));
  }
  throw new Error('unterminated JSON array in reply');
}

export const DESCRIPTION_RULES = `"description": one or two short sentences (max 30 words) for a traveller: what the place is known for and, for food, what to order. Plain and specific, no hype words like "hidden gem" or "must-visit". Only write it if you are confident you know this specific place; otherwise use null. Never invent details.`;
