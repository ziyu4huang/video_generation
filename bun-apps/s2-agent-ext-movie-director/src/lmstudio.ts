/**
 * lmstudio.ts — direct Bun `fetch` client for LM Studio's OpenAI-compatible API.
 *
 * `run.py story angles/propose` (app/commands/story.py's `_gemma_json_call`) and
 * `run.py caption` are both, underneath, plain HTTP clients against a LOCAL LM
 * Studio server (`requests.post(f"{api_url}/chat/completions", ...)`) — no MLX
 * tensor math happens in that Python at all. That means porting them off Python
 * is NOT a Swift/MLX porting job; it's "delete the Python middleman, call the
 * same HTTP endpoint from Bun" (2026-07-13 migration, see
 * output/next-goal-20260713_*.md). This module is that direct client, mirroring
 * story.py's `_gemma_json_call` fast-path/safety-retry contract 1:1.
 *
 * LOCAL ONLY: LM Studio always resolves to localhost — never a cloud LLM API.
 */

const DEFAULT_API_URL = "http://localhost:1234/v1";
const FAST_MAX_TOKENS = 2048;
const SAFETY_MAX_TOKENS = 14000;

export interface LmStudioChatOptions {
  apiUrl?: string;
  model?: string;
  timeoutMs?: number;
  /** Test seam: inject a canned fetch so unit tests don't need a real LM Studio server. */
  _fetchImpl?: typeof fetch;
}

interface ChatChoiceMessage {
  content?: string;
  reasoning_content?: string;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: ChatChoiceMessage }>;
}

/** /api/v1/models — one entry per model LM Studio knows about (loaded or not). */
interface LmStudioModelEntry {
  key?: string;
  loaded_instances?: unknown[];
}

function lmstudioNativeBase(apiUrl: string): string {
  return `${apiUrl.replace(/\/+$/, "").replace(/\/v1$/, "")}/api/v1`;
}

/** Model keys currently LOADED in LM Studio, or null if the server is unreachable. */
export async function loadedModelKeys(apiUrl: string, fetchImpl: typeof fetch = fetch): Promise<Set<string> | null> {
  try {
    const res = await fetchImpl(`${lmstudioNativeBase(apiUrl)}/models`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const data = (await res.json()) as { models?: LmStudioModelEntry[] };
    return new Set((data.models ?? []).filter((m) => m.loaded_instances && m.loaded_instances.length > 0).map((m) => m.key ?? "").filter(Boolean));
  } catch {
    return null;
  }
}

/** ALL downloaded (indexed) model keys regardless of load state, or null if unreachable. */
export async function catalogModelKeys(apiUrl: string, fetchImpl: typeof fetch = fetch): Promise<Set<string> | null> {
  try {
    const res = await fetchImpl(`${lmstudioNativeBase(apiUrl)}/models`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const data = (await res.json()) as { models?: LmStudioModelEntry[] };
    return new Set((data.models ?? []).map((m) => m.key ?? "").filter(Boolean));
  } catch {
    return null;
  }
}

/**
 * The gemma brain resolver (mirrors caption.py's `resolve_default_model` /
 * `_resolve_model` with no explicit `--model`): prefer an already-loaded
 * google/gemma-4-12b, then any already-loaded model, then the auto-load
 * default if it's downloaded. The local model convention across
 * s2-agent-ext-* is a single model (google/gemma-4-12b), so there is no
 * separate lightweight fallback anymore.
 */
const PREFERRED_MODELS = ["google/gemma-4-12b"];
const DEFAULT_MODEL = "google/gemma-4-12b";
const FALLBACK_MODELS: string[] = [];

export async function resolveDefaultModel(apiUrl: string = DEFAULT_API_URL, fetchImpl: typeof fetch = fetch): Promise<string> {
  const loaded = (await loadedModelKeys(apiUrl, fetchImpl)) ?? new Set<string>();
  for (const candidate of PREFERRED_MODELS) {
    if (loaded.has(candidate)) return candidate;
  }
  if (loaded.size > 0) {
    if (loaded.has(DEFAULT_MODEL)) return DEFAULT_MODEL;
    return [...loaded][0]!;
  }
  const catalog = (await catalogModelKeys(apiUrl, fetchImpl)) ?? new Set<string>();
  if (catalog.has(DEFAULT_MODEL)) return DEFAULT_MODEL;
  for (const fb of FALLBACK_MODELS) {
    if (catalog.has(fb)) return fb;
  }
  return DEFAULT_MODEL;
}

/** Best-effort: POST /api/v1/models/load. Never throws — a failed ensure just proceeds anyway (mirrors story.py). */
export async function ensureModelLoaded(apiUrl: string, modelId: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  try {
    await fetchImpl(`${lmstudioNativeBase(apiUrl)}/models/load`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: modelId }),
      signal: AbortSignal.timeout(180000),
    });
  } catch {
    /* best-effort — the chat call below surfaces a real failure if the model truly isn't available */
  }
}

/**
 * Send `prompt` to the local gemma brain, parse the reply with `parseFn`.
 * Fast path first (reasoning_effort:"none", small token budget — ~9s on
 * gemma-4-12b); a safety-net retry at a large budget without the knob if the
 * fast path yields nothing `parseFn` can extract. Mirrors story.py's
 * `_gemma_json_call` exactly (including the reasoning_content retry).
 */
export async function lmStudioJsonCall<T>(
  prompt: string,
  parseFn: (raw: string) => T,
  opts: LmStudioChatOptions = {},
): Promise<T> {
  const apiUrl = opts.apiUrl ?? DEFAULT_API_URL;
  const fetchImpl = opts._fetchImpl ?? fetch;
  const resolved = opts.model ?? (await resolveDefaultModel(apiUrl, fetchImpl));
  await ensureModelLoaded(apiUrl, resolved, fetchImpl);

  const attempts: Array<{ maxTokens: number; reasoningEffort: string | null }> = [
    { maxTokens: FAST_MAX_TOKENS, reasoningEffort: "none" },
    { maxTokens: SAFETY_MAX_TOKENS, reasoningEffort: null },
  ];

  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < attempts.length; attempt++) {
    const { maxTokens, reasoningEffort } = attempts[attempt]!;
    const payload: Record<string, unknown> = {
      model: resolved,
      messages: [{ role: "user", content: prompt }],
      max_tokens: maxTokens,
      temperature: 0.3,
      stream: false,
    };
    if (reasoningEffort != null) payload.reasoning_effort = reasoningEffort;

    const res = await fetchImpl(`${apiUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 600000),
    });
    if (!res.ok) {
      lastErr = new Error(`lmstudio chat/completions HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      continue;
    }
    const data = (await res.json()) as ChatCompletionResponse;
    const message = data.choices?.[0]?.message;
    if (!message) {
      lastErr = new Error(`gemma call: response missing OpenAI chat shape; raw excerpt: ${JSON.stringify(data).slice(0, 300)}`);
      continue;
    }
    const content = message.content ?? "";
    try {
      return parseFn(content);
    } catch {
      const reasoning = message.reasoning_content;
      if (reasoning && attempt < attempts.length - 1) {
        try {
          return parseFn(reasoning);
        } catch {
          /* fall through to retry */
        }
      }
      lastErr = new Error(`no parseable content at budget ${maxTokens}; retrying`);
      continue;
    }
  }
  throw lastErr ?? new Error("gemma call produced no parseable content");
}

/** One image attachment for lmStudioVisionCall — base64 payload + its MIME type. */
export interface VisionImage {
  b64: string;
  mime: string;
}

/**
 * Send `prompt` + zero or more images to the local VLM, return the raw text
 * content (mirrors caption.py's `_call_vlm` / `_call_vlm_multi`: an
 * OpenAI-compatible vision chat call with an `image_url` entry per image
 * followed by one `text` entry, single-shot — no fast/safety dual-attempt
 * like `lmStudioJsonCall`, since caption.py's VLM helpers aren't JSON-schema
 * callers themselves; callers that need tolerant JSON parsing do that on the
 * returned string). Zero images degrades to a text-only vision-shaped call
 * (still content-array form), used for text-only prompt composition.
 */
export async function lmStudioVisionCall(
  prompt: string,
  images: VisionImage[],
  opts: LmStudioChatOptions & { maxTokens?: number } = {},
): Promise<string> {
  const apiUrl = opts.apiUrl ?? DEFAULT_API_URL;
  const fetchImpl = opts._fetchImpl ?? fetch;
  const resolved = opts.model ?? (await resolveDefaultModel(apiUrl, fetchImpl));
  await ensureModelLoaded(apiUrl, resolved, fetchImpl);

  const content: unknown[] = images.map((img) => ({
    type: "image_url",
    image_url: { url: `data:${img.mime};base64,${img.b64}` },
  }));
  content.push({ type: "text", text: prompt });

  const payload = {
    model: resolved,
    messages: [{ role: "user", content }],
    max_tokens: opts.maxTokens ?? 2048,
    temperature: 0.3,
    stream: false,
  };

  const res = await fetchImpl(`${apiUrl.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 300000),
  });
  if (!res.ok) {
    throw new Error(`lmstudio vision chat/completions HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const data = (await res.json()) as ChatCompletionResponse;
  const message = data.choices?.[0]?.message;
  if (!message) {
    throw new Error(`lmstudio vision call: response missing OpenAI chat shape; raw excerpt: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return message.content ?? "";
}

export { DEFAULT_API_URL as LMSTUDIO_DEFAULT_API_URL };
