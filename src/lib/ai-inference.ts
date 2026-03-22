/**
 * Unified AI inference layer — single function for all LLM calls in open-browser.
 * Cerebras by default (fastest), Anthropic as fallback.
 */

export interface InferOptions {
  provider?: "cerebras" | "anthropic";
  model?: string;
  maxTokens?: number;
  temperature?: number;
}

const ALIASES: Record<string, { provider: "cerebras" | "anthropic"; model: string }> = {
  fast:     { provider: "cerebras",  model: "llama-4-scout-17b-16e-instruct" },
  scout:    { provider: "cerebras",  model: "llama-4-scout-17b-16e-instruct" },
  maverick: { provider: "cerebras",  model: "llama-4-maverick-17b-128e-instruct" },
  haiku:    { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
  sonnet:   { provider: "anthropic", model: "claude-sonnet-4-5-20250929" },
  opus:     { provider: "anthropic", model: "claude-opus-4-6" },
};

function resolve(opts?: InferOptions): { provider: "cerebras" | "anthropic"; model: string } {
  if (opts?.model && ALIASES[opts.model]) return ALIASES[opts.model];
  if (opts?.provider && opts?.model) return { provider: opts.provider, model: opts.model };
  if (opts?.provider === "anthropic") return ALIASES.haiku;
  return ALIASES.fast;
}

/**
 * Send a prompt to an LLM and get a text response.
 * Default: Cerebras llama-4-scout (fastest inference available).
 */
export async function infer(prompt: string, opts?: InferOptions): Promise<string> {
  const { provider, model } = resolve(opts);
  const maxTokens = opts?.maxTokens ?? 1024;

  if (provider === "anthropic") {
    const apiKey = process.env["ANTHROPIC_API_KEY"];
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] }),
    });
    if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json() as any;
    return data.content?.[0]?.text ?? "";
  }

  // Cerebras (OpenAI-compatible)
  const apiKey = process.env["CEREBRAS_API_KEY"];
  if (!apiKey) throw new Error("CEREBRAS_API_KEY not set");

  const res = await fetch("https://api.cerebras.ai/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body: JSON.stringify({ model, max_tokens: maxTokens, temperature: opts?.temperature ?? 0, messages: [{ role: "user", content: prompt }] }),
  });
  if (!res.ok) throw new Error(`Cerebras API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json() as any;
  return data.choices?.[0]?.message?.content ?? "";
}

/**
 * Send a prompt and parse the response as JSON.
 * Strips markdown code fences before parsing.
 */
export async function inferJSON<T = unknown>(prompt: string, opts?: InferOptions): Promise<T> {
  const text = await infer(prompt, opts);
  const cleaned = text.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
  return JSON.parse(cleaned);
}
