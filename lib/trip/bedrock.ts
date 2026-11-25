// Server-only Amazon Bedrock helper for TripPlanner. Uses the site's own AWS user
// (BEDROCK_ACCESS_KEY_ID / BEDROCK_SECRET_ACCESS_KEY / BEDROCK_REGION, same as the chatbot)
// and the Converse API, which has the same request shape for almost every model on Bedrock.
import "server-only";
import { BedrockRuntimeClient, ConverseCommand, type ConverseCommandInput } from "@aws-sdk/client-bedrock-runtime";

export interface ConverseResult {
  modelId: string;
  text: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number;
  error?: string;
}

let client: BedrockRuntimeClient | null = null;
function bedrock() {
  if (client) return client;
  const accessKeyId = process.env.BEDROCK_ACCESS_KEY_ID;
  const secretAccessKey = process.env.BEDROCK_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) throw new Error("Bedrock credentials not set");
  client = new BedrockRuntimeClient({
    region: process.env.BEDROCK_REGION || "ap-southeast-2",
    credentials: { accessKeyId, secretAccessKey },
  });
  return client;
}

type Opts = { system?: string; maxTokens?: number; temperature?: number; timeoutMs?: number };

// Some models refuse a separate system prompt; retry with it folded into the user message.
export async function converse(modelId: string, prompt: string, opts: Opts = {}): Promise<ConverseResult> {
  const first = await converseOnce(modelId, prompt, opts);
  if (first.error && opts.system && /system/i.test(first.error)) {
    const retry = await converseOnce(modelId, `${opts.system}\n\n${prompt}`, { ...opts, system: undefined });
    return { ...retry, latencyMs: first.latencyMs + retry.latencyMs };
  }
  return first;
}

async function converseOnce(modelId: string, prompt: string, opts: Opts = {}): Promise<ConverseResult> {
  const started = Date.now();
  const input: ConverseCommandInput = {
    modelId,
    messages: [{ role: "user", content: [{ text: prompt }] }],
    inferenceConfig: { maxTokens: opts.maxTokens ?? 1024, temperature: opts.temperature ?? 0.4 },
  };
  if (opts.system) input.system = [{ text: opts.system }];
  try {
    const out = await bedrock().send(new ConverseCommand(input), {
      abortSignal: AbortSignal.timeout(opts.timeoutMs ?? 50_000),
    });
    const parts = out.output?.message?.content ?? [];
    return {
      modelId,
      text: parts.map((p) => ("text" in p && p.text) || "").join("").trim() || null,
      inputTokens: out.usage?.inputTokens ?? null,
      outputTokens: out.usage?.outputTokens ?? null,
      latencyMs: Date.now() - started,
    };
  } catch (e) {
    return {
      modelId, text: null, inputTokens: null, outputTokens: null, latencyMs: Date.now() - started,
      error: e instanceof Error ? e.message : "request failed",
    };
  }
}
