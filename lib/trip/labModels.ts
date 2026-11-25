// Models the Model lab and the planner are allowed to call (allowlist = guardrail).
// Prices: USD per 1M tokens, from aws.amazon.com/bedrock/pricing, checked 6 Oct 2026.
// priceNote says where the price is from when it isn't Sydney (ap-southeast-2).

export interface LabModel {
  id: string;            // Bedrock model id or inference profile id
  label: string;
  provider: string;
  price?: { input: number; output: number; note?: string };
  reasoning?: boolean;   // thinks before answering: needs a bigger output cap
  needsForm?: boolean;   // Anthropic: one-time use case form in the Bedrock console first
  defaultOn?: boolean;
}

export const LAB_MODELS: LabModel[] = [
  { id: 'amazon.nova-micro-v1:0', label: 'Nova Micro', provider: 'Amazon', price: { input: 0.032, output: 0.096, note: 'US East price' } },
  { id: 'amazon.nova-lite-v1:0', label: 'Nova Lite', provider: 'Amazon', price: { input: 0.067, output: 0.201, note: 'US East price' }, defaultOn: true },
  { id: 'amazon.nova-pro-v1:0', label: 'Nova Pro', provider: 'Amazon', price: { input: 0.8, output: 2.4, note: 'US East price' }, defaultOn: true },
  { id: 'global.amazon.nova-2-lite-v1:0', label: 'Nova 2 Lite', provider: 'Amazon' },
  { id: 'deepseek.v3.2', label: 'DeepSeek V3.2', provider: 'DeepSeek', price: { input: 0.6386, output: 1.9055 }, defaultOn: true },
  { id: 'openai.gpt-oss-120b-1:0', label: 'GPT-OSS 120B', provider: 'OpenAI', price: { input: 0.1545, output: 0.618 }, reasoning: true, defaultOn: true },
  { id: 'openai.gpt-oss-20b-1:0', label: 'GPT-OSS 20B', provider: 'OpenAI', price: { input: 0.0721, output: 0.309 }, reasoning: true },
  { id: 'qwen.qwen3-235b-a22b-2507-v1:0', label: 'Qwen3 235B', provider: 'Qwen', price: { input: 0.5459, output: 2.7398 }, defaultOn: true },
  { id: 'mistral.mistral-large-3-675b-instruct', label: 'Mistral Large 3', provider: 'Mistral', price: { input: 0.5, output: 1.5, note: 'US East price' }, defaultOn: true },
  { id: 'moonshotai.kimi-k2.5', label: 'Kimi K2.5', provider: 'Moonshot', price: { input: 0.618, output: 3.09 }, reasoning: true },
  { id: 'google.gemma-3-27b-it', label: 'Gemma 3 27B', provider: 'Google', price: { input: 0.2369, output: 0.3914 } },
  { id: 'zai.glm-4.7', label: 'GLM 4.7', provider: 'Z.ai', price: { input: 0.618, output: 2.266 }, reasoning: true },
  { id: 'minimax.minimax-m2.5', label: 'MiniMax M2.5', provider: 'MiniMax', price: { input: 0.31, output: 1.24 }, reasoning: true },
  { id: 'au.anthropic.claude-haiku-4-5-20251001-v1:0', label: 'Claude Haiku 4.5', provider: 'Anthropic', needsForm: true },
];

export const LAB_MODEL_IDS = new Set(LAB_MODELS.map(m => m.id));

export function costUsd(m: LabModel | undefined, inTok: number | null, outTok: number | null): number | null {
  if (!m?.price || inTok == null || outTok == null) return null;
  return (inTok * m.price.input + outTok * m.price.output) / 1_000_000;
}
