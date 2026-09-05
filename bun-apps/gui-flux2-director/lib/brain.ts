/**
 * brain.ts — the story-writing step of auto-story mode: one idea in, a
 * storyboard JSON out, from the LOCAL LM Studio server.
 *
 * Deliberately a thin standalone client (modeled on s2-agent-ext-movie-
 * director's lmstudio.ts contract — loaded-model resolution, JSON call with
 * one bounded retry) rather than importing that package: lmstudio.ts pulls
 * @repo/s2-agent-core-runtime's full index (agent dispatch, registry, rate
 * limiter) into what is otherwise a light GUI server. LOCAL ONLY — LM Studio
 * always resolves to localhost, never a cloud API.
 */
import { storySecondsToNarrationWords } from "./narration";

const DEFAULT_API_URL = "http://localhost:1234/v1";
const PREFERRED_MODEL = "prism-ml/bonsai-27b";

export interface BrainStoryboard {
  title: string;
  scenes: Array<{ visual: string; narration: string }>;
  model: string;
}

export interface BrainOptions {
  apiUrl?: string;
  model?: string;
  /** Cancel the chat call (job cancel). */
  signal?: AbortSignal;
  /** Optional phase logger — surfaces model-load waits in the job log. */
  onLog?: (line: string) => void;
  /** Test seam: inject a canned fetch so unit tests need no real server. */
  _fetchImpl?: typeof fetch;
}

function nativeBase(apiUrl: string): string {
  return `${apiUrl.replace(/\/+$/, "").replace(/\/v1$/, "")}/api/v1`;
}

/** Model keys currently LOADED in LM Studio, or null when unreachable. */
export async function loadedModelKeys(
  apiUrl = DEFAULT_API_URL,
  fetchImpl: typeof fetch = fetch,
): Promise<string[] | null> {
  try {
    const res = await fetchImpl(`${nativeBase(apiUrl)}/models`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const data = (await res.json()) as { models?: Array<{ type?: string; key?: string; loaded_instances?: unknown[] }> };
    return (data.models ?? [])
      .filter((m) => m.type === "llm" && m.loaded_instances && m.loaded_instances.length > 0 && m.key)
      .map((m) => m.key!);
  } catch {
    return null;
  }
}

/** Best-effort JIT load (LM Studio keeps the model warm afterwards). */
async function ensureModelLoaded(apiUrl: string, model: string, fetchImpl: typeof fetch, onLog?: (line: string) => void): Promise<void> {
  try {
    onLog?.(`[brain] ensuring ${model} is loaded (LTX renders can evict it — reload takes ~minutes)…`);
    await fetchImpl(`${nativeBase(apiUrl)}/models/load`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(180000),
    });
  } catch {
    /* best-effort — the chat call below surfaces a real failure */
  }
}

/** Pick the brain: env override → a loaded model (bonsai preferred) → the default key. */
export async function resolveBrainModel(
  apiUrl = DEFAULT_API_URL,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (process.env.LMSTUDIO_MODEL) return process.env.LMSTUDIO_MODEL;
  const loaded = (await loadedModelKeys(apiUrl, fetchImpl)) ?? [];
  const bonsai = loaded.find((k) => k.includes("bonsai"));
  if (bonsai) return bonsai;
  if (loaded.length > 0) return loaded[0]!;
  return PREFERRED_MODEL;
}

/** Tolerant JSON extraction: strips ``` fences and any prose around the object. */
export function extractJsonObject(raw: string): unknown {
  const unfenced = raw.replace(/```(?:json)?/gi, "");
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("no JSON object in reply");
  return JSON.parse(unfenced.slice(start, end + 1));
}

/**
 * Validate a brain reply into exactly `sceneCount` scenes. Wrong counts are
 * salvaged by trimming (a 5-scene reply for a 3-scene ask) — only an empty
 * or unparseable scene list rejects.
 */
export function coerceStoryboard(raw: unknown, sceneCount: number): { title: string; scenes: Array<{ visual: string; narration: string }> } {
  if (typeof raw !== "object" || raw === null) throw new Error("reply is not an object");
  const obj = raw as { title?: unknown; scenes?: unknown };
  const title = typeof obj.title === "string" && obj.title.trim() ? obj.title.trim().slice(0, 80) : "Untitled";
  if (!Array.isArray(obj.scenes) || obj.scenes.length === 0) throw new Error("reply has no scenes array");
  const scenes: Array<{ visual: string; narration: string }> = [];
  for (const s of obj.scenes) {
    if (typeof s !== "object" || s === null) continue;
    const { visual, narration } = s as { visual?: unknown; narration?: unknown };
    if (typeof visual !== "string" || !visual.trim()) continue;
    scenes.push({
      visual: visual.trim(),
      narration: typeof narration === "string" ? narration.trim().replace(/^["“](.*)["”]$/, "$1") : "",
    });
  }
  if (scenes.length === 0) throw new Error("no scene with a non-empty visual");
  return { title, scenes: scenes.slice(0, sceneCount) };
}

/** The writing prompt — scene count, narration budget, and the continuity rule. */
export function buildStoryPrompt(idea: string, sceneCount: number, seconds: number): string {
  const maxWords = storySecondsToNarrationWords(seconds);
  return [
    `Write a ${sceneCount}-scene micro-story for an AI video studio.`,
    ``,
    `IDEA: "${idea}"`,
    ``,
    `Rules:`,
    `- EVERY scene MUST have a non-empty "narration" — it is spoken aloud as the film's voice-over.`,
    `- Write EVERYTHING in the SAME LANGUAGE as the idea (the title too) — never mix English words into a non-English story.`,
    `- "visual": one concrete cinematic shot per scene, max 45 words. Repeat the protagonist's full appearance (species, colors, distinctive features) in EVERY scene — keyframes are generated independently, so the description is the only continuity anchor. Include 1-2 ambient sound cues (rain, wind, footsteps, distant traffic) for the video model's audio branch.`,
    `- "narration": the spoken voice-over line for that scene, max ${maxWords} words (the clip is only ${seconds} seconds). Plain spoken prose — no quotes, emoji, or stage directions.`,
    `- Shape a tiny arc across the scenes (setup, development, turn, resolution — adapt to the count).`,
    ``,
    `Reply with exactly this JSON shape and nothing else:`,
    `{"title": "...", "scenes": [{"visual": "...", "narration": "..."}]}`,
  ].join("\n");
}

/**
 * The full writing step: resolve the model, ask, parse, coerce. Throws a
 * user-readable error (the job layer shows it as job.error).
 */
export async function writeStoryboard(
  idea: string,
  sceneCount: number,
  seconds: number,
  opts: BrainOptions = {},
): Promise<BrainStoryboard> {
  const apiUrl = opts.apiUrl ?? process.env.LMSTUDIO_API_URL ?? DEFAULT_API_URL;
  const fetchImpl = opts._fetchImpl ?? fetch;
  const model = opts.model ?? (await resolveBrainModel(apiUrl, fetchImpl));
  const t0 = Date.now();
  await ensureModelLoaded(apiUrl, model, fetchImpl, opts.onLog);

  const prompt = buildStoryPrompt(idea, sceneCount, seconds);
  // Fast path asks the model NOT to reason first (bonsai's default reasoning
  // mode can wander for minutes before emitting the JSON — measured 2026-09-05,
  // a 3-scene ask timed out at 180s with reasoning on). The safety retry drops
  // the knob and widens the budget in case the model needs to think.
  const attempts: Array<{ maxTokens: number; temperature: number; reasoningEffort: string | null; timeoutMs: number }> = [
    { maxTokens: 2048, temperature: 0.7, reasoningEffort: "none", timeoutMs: 300_000 },
    { maxTokens: 8192, temperature: 0.4, reasoningEffort: null, timeoutMs: 600_000 },
  ];
  let lastErr: Error | null = null;
  for (let i = 0; i < attempts.length; i++) {
    const attempt = attempts[i]!;
    let content: string;
    // Always bound the wait: a passed cancel signal alone would let a wedged
    // connection hang the writing stage forever.
    const timeout = AbortSignal.timeout(attempt.timeoutMs);
    const signal =
      opts.signal && typeof AbortSignal.any === "function" ? AbortSignal.any([opts.signal, timeout]) : timeout;
    opts.onLog?.(`[brain] asking ${model}${i > 0 ? " (retry)" : ""}…`);
    try {
      const payload: Record<string, unknown> = {
        model,
        messages: [
          { role: "system", content: "You are a storyboard writer for a local AI film studio. Reply with ONE JSON object and nothing else — no markdown fences, no commentary." },
          { role: "user", content: prompt },
        ],
        max_tokens: attempt.maxTokens,
        temperature: attempt.temperature,
        stream: false,
      };
      if (attempt.reasoningEffort !== null) payload.reasoning_effort = attempt.reasoningEffort;
      const res = await fetchImpl(`${apiUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal,
      });
      if (!res.ok) throw new Error(`brain HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      content = data.choices?.[0]?.message?.content ?? "";
    } catch (e) {
      if (opts.signal?.aborted) throw new Error("cancelled");
      // Unreachable server is the common failure — make it actionable.
      const msg = e instanceof Error ? e.message : String(e);
      const cause = e instanceof Error && e.cause ? ` (cause: ${String((e.cause as Error)?.message ?? e.cause)})` : "";
      console.error(`[brain] chat failed: ${msg}${cause}`);
      throw new Error(`local brain (LM Studio at ${apiUrl}) unreachable — start LM Studio and retry: ${msg}${cause}`);
    }
    try {
      const { title, scenes } = coerceStoryboard(extractJsonObject(content), sceneCount);
      const last = i === attempts.length - 1;
      if (scenes.length < sceneCount) {
        // Wrong scene count breaks the requested arc (and the render budget)
        // — retry for compliance, soft-land with fewer scenes on the last try.
        lastErr = new Error(`brain wrote ${scenes.length}/${sceneCount} scenes`);
        if (!last) continue;
      }
      if (!scenes.some((s) => s.narration)) {
        // Narration is the point of auto mode — retry once for it, but on the
        // last attempt soft-land with visuals only (the caller warns + the
        // story still renders; a silent film beats no film).
        lastErr = new Error("no scene carried a narration line");
        if (!last) continue;
      }
      return { title, scenes, model };
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
    }
  }
  throw new Error(`brain reply unparseable after retry (${((Date.now() - t0) / 1000).toFixed(0)}s): ${lastErr?.message ?? "unknown"}`);
}
