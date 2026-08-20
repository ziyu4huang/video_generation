/**
 * twosubject_native.ts — native Bun port of `run.py image twosubject`.
 *
 * `app/commands/image-twosubject.py` composes two characters into ONE t2i
 * pass (not the latent-couple composite `image-multicouple.py` uses — that
 * one stays a genuine MLX/GPU compute path, unportable, permanently on
 * runpy_image.ts). twosubject is PURE CONTROL FLOW around two things this
 * repo already has native Bun access to:
 *
 *   1. the local VLM (Qwen3-VL / gemma via LM Studio) — bare HTTP, ported
 *      1:1 in lmstudio.ts's `lmStudioVisionCall` (mirrors caption.py's
 *      `_call_vlm` / `_call_vlm_multi`).
 *   2. the Z-Image t2i pass itself — `image-twosubject.py` defaults to the
 *      plain `ZImagePipeline()` (no --transformer override in the default
 *      path), i.e. the SAME model family krea2's native Swift `t2i` command
 *      already drives. This module calls `runKrea2({command:"t2i", ...})`
 *      instead of shelling out to run.py.
 *
 * The 4-phase loop (prompt-master compose → best-of-N seeds → VLM judge →
 * optional revise) is ported 1:1 in shape; see individual function docs for
 * the couple of deltas from the Python (documented, not silent):
 *
 *   - `_bg_edge_split` (the pixel-level background color-temperature
 *     tiebreak in `pick_best`) needs raw image decoding (numpy+PIL in
 *     Python); no image-decode lib is a dependency of this Bun package, so
 *     it is DROPPED here. `pickBest` ranks by overall → natural → distinct
 *     only. This only changes the outcome on an exact tie across all three,
 *     which the judge's continuous 0-10 scores make rare.
 *   - Reference-image captioning (`--ref-a`/`--ref-b`) uses a small inline
 *     vision prompt (`captionRefImage`) rather than the full 14-style
 *     `caption.py`/`caption.ts` port — twosubject only ever needs a single
 *     "describe this person's appearance" caption, not the full style menu.
 *   - krea2's native `t2i` command has no `--cfg-scale` knob (unlike run.py's
 *     ZImagePipeline.generate, which takes `cfg_scale`), so `_DEFAULT_CFG`
 *     (3.0, "the single biggest quality lever" per the Python's own comment)
 *     cannot be forwarded. This is a real quality delta versus the Python
 *     path until krea2 grows a cfg-scale flag — noted, not silently dropped.
 */
import { readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { runKrea2 } from "@repo/s2-agent-ext-krea2";
import { lmStudioVisionCall, type LmStudioChatOptions, type VisionImage } from "./lmstudio.ts";

// ── Defaults (mirrors image-twosubject.py's module constants) ──────────────
export const DEFAULT_CANDIDATES = 12;
export const DEFAULT_ROUNDS = 1;
export const DEFAULT_MIN_OVERALL = 8.0;
export const DEFAULT_BASE_SEED = 42;
export const DEFAULT_STYLE =
  "cinematic lighting, hyperdetailed, imaginative, soft ethereal glow, painterly fantasy atmosphere";
export const DEFAULT_CHAR_A =
  "a young 19-year-old girl, slim petite build, long straight raven-black hair, " +
  "delicate porcelain skin, large dark eyes, soft natural makeup, wearing a " +
  "flowing white summer dress with subtle silver embroidery, gentle shy smile";
export const DEFAULT_CHAR_B =
  "a 26-year-old woman, taller athletic curvy build, wavy auburn copper hair, " +
  "warm tan skin, green eyes, elegant bold makeup, wearing a deep emerald silk gown, " +
  "confident serene expression";

// ── VLM prompt templates (mirrors _PROMPT_MASTER_RULES / _PROMPT_MASTER_REVISE / _JUDGE) ──

const PROMPT_MASTER_RULES = (targetBlock: string): string => `You are a master prompt engineer for a text-to-image diffusion model (Z-Image DiT).
Goal: write ONE single text prompt that generates an image of TWO distinct people
in ONE coherent scene, with MINIMAL "token bleeding" (where one subject's hair color / eye color / outfit / skin contaminates the other subject).

${targetBlock}

Write ONE prompt that:
1. OPENS with the SHARED scene + lighting ("two women standing together in a dreamlike surreal fantasy scene, unified cinematic lighting from above, ..."). Both people MUST inherit the SAME light source and environment — this is what makes a two-person image read as one photo instead of a collage.
2. Describes person A in ONE contiguous clause anchored to a clear spatial side ("The woman on the FAR LEFT: <all of A's attributes — age, build, hair, skin, eyes, makeup, outfit, expression>"), then a comma, then person B in another contiguous clause anchored to the opposite side ("the woman on the FAR RIGHT: <all of B's attributes>").
3. Groups EACH person's attributes tightly together and far from the other person's, so the model binds hair/eyes/outfit to the correct subject. NEVER interleave the two people's attributes.
4. Has the two face each other / share the space so they read as one scene.
5. Do NOT append style tags — they are added automatically after your prompt.

Return ONLY the prompt text (the shared scene + the two people). No preamble, no quotes, no labels, no explanation, no trailing style tags.`;

const PROMPT_MASTER_REVISE = (bleeding: string, summary: string): string => `

The PREVIOUS attempt at this prompt produced token bleeding. Judge findings:
- bleeding (attributes that crossed over): ${bleeding}
- note: ${summary}
Rewrite the single two-subject prompt to FIX that specific bleeding (e.g. re-anchor the swapped attribute to its owner with an explicit side, or separate the two clauses more). Keep all the rules above. Return ONLY the prompt text.`;

const JUDGE = (descA: string, descB: string): string => `You are HARSHLY judging a text-to-image result for a TWO-PERSON prompt.

Target person A (should be on the LEFT): ${descA}
Target person B (should be on the RIGHT): ${descB}

Look at the image and answer as STRICT JSON only (no prose, no code fence):
{
  "both_present": <true|false>,
  "distinct": <true|false>,
  "bleeding": ["<each attribute that crossed between the two people, or empty list>"],
  "natural": <0-10, does it read as ONE coherent photo with shared lighting/scale/scene, not two photos pasted together?>,
  "overall": <0-10, overall quality for the two-distinct-people goal>,
  "summary": "<one short sentence>"
}

Rules:
- "distinct" is FALSE if the two people share hair color, eye color, outfit, or face when they should differ. Token bleeding MUST lower "distinct" and "overall".
- "natural" is LOW if the two halves have different lighting, scale, or look collaged.
- Be precise and critical; do not inflate scores.
Return ONLY the JSON object.`;

const CAPTION_REF_PROMPT =
  "Describe this person's physical appearance in one dense paragraph for a text-to-image " +
  "prompt: approximate age, build, hair (color/length/style), skin tone, eye color, makeup, " +
  "outfit, and expression. Return ONLY the description, no preamble.";

// ── Helpers ──────────────────────────────────────────────────────────────

/** Read an image file into a VisionImage (base64 + MIME by extension). No resize (unlike Python's PIL downsize — see module doc). */
export function imageToVisionImage(path: string): VisionImage {
  const buf = readFileSync(path);
  const ext = extname(path).toLowerCase();
  const mime = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
  return { b64: buf.toString("base64"), mime };
}

/** Tolerant JSON-object extraction (mirrors caption.py's `_parse_score_dict`): strips ```fences, finds the first `{ … }`. */
export function parseScoreDict(raw: string): Record<string, unknown> | null {
  if (!raw) return null;
  let s = raw.trim();
  if (s.startsWith("```")) {
    s = s.replace(/^```[a-zA-Z]*\n?/, "").replace(/\n?```$/, "").trim();
  }
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(s.slice(start, end + 1));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export interface JudgeScores {
  both_present: boolean | null;
  distinct: boolean | null;
  bleeding: string[];
  natural: number | null;
  overall: number | null;
  summary: string;
  unparsed?: boolean;
}

/** Coerce a parsed score dict into JudgeScores (mirrors judge_two_subject's numeric coercion). */
export function coerceJudgeScores(raw: string): JudgeScores {
  const parsed = parseScoreDict(raw);
  if (!parsed) {
    return { overall: null, natural: null, distinct: null, both_present: null, bleeding: [], summary: raw.slice(0, 200), unparsed: true };
  }
  const toNum = (v: unknown): number | null => {
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  return {
    both_present: typeof parsed.both_present === "boolean" ? parsed.both_present : null,
    distinct: typeof parsed.distinct === "boolean" ? parsed.distinct : null,
    bleeding: Array.isArray(parsed.bleeding) ? (parsed.bleeding as string[]) : [],
    natural: toNum(parsed.natural),
    overall: toNum(parsed.overall),
    summary: typeof parsed.summary === "string" ? parsed.summary : "",
  };
}

export interface ScoredCandidate extends JudgeScores {
  path: string;
  seed: number;
}

/** Select the best-scored candidate: overall → natural → distinct (True>False). No bg_edge_split tiebreak — see module doc. */
export function pickBest(scored: ScoredCandidate[]): ScoredCandidate | null {
  const valid = scored.filter((s) => s.overall != null);
  if (valid.length === 0) return null;
  return valid.reduce((best, cur) => {
    const key = (s: ScoredCandidate): [number, number, number] => [s.overall ?? 0, s.natural ?? 0, s.distinct ? 1 : 0];
    const [bo, bn, bd] = key(best);
    const [co, cn, cd] = key(cur);
    if (co !== bo) return co > bo ? cur : best;
    if (cn !== bn) return cn > bn ? cur : best;
    if (cd !== bd) return cd > bd ? cur : best;
    return best;
  });
}

/** Resolve (width, height, steps) from options — mirrors `_resolve_geometry`'s --detail preset. */
export function resolveGeometry(opts: { width?: number; height?: number; steps?: number; detail?: boolean }): {
  width: number;
  height: number;
  steps: number;
} {
  const detail = !!opts.detail;
  return {
    width: opts.width ?? (detail ? 768 : 640),
    height: opts.height ?? (detail ? 1152 : 960),
    steps: opts.steps ?? (detail ? 20 : 9),
  };
}

// ── VLM calls ────────────────────────────────────────────────────────────

/** Caption a reference image into an appearance description (a minimal single-purpose i2t call — see module doc). */
export async function captionRefImage(path: string, opts: LmStudioChatOptions = {}): Promise<string> {
  const img = imageToVisionImage(path);
  const raw = await lmStudioVisionCall(CAPTION_REF_PROMPT, [img], opts);
  return raw.replace(/<think[\s\S]*?<\/think\s*>/gi, "").trim();
}

/** The VLM prompt-master: compose ONE anti-bleeding two-subject prompt (mirrors `compose_two_subject_prompt`). */
export async function composeTwoSubjectPrompt(
  descA: string,
  descB: string,
  refImages: VisionImage[],
  failure: { bleeding?: string[]; summary?: string } | null,
  opts: LmStudioChatOptions = {},
): Promise<string> {
  const targetBlock = `Person A (place on the FAR LEFT): ${descA}\nPerson B (place on the FAR RIGHT): ${descB}`;
  let instruction = PROMPT_MASTER_RULES(targetBlock);
  if (failure) {
    instruction += PROMPT_MASTER_REVISE((failure.bleeding ?? []).join(", ") || "(none diagnosed)", (failure.summary ?? "").trim() || "(none)");
  }
  const raw = await lmStudioVisionCall(instruction, refImages, opts);
  return raw.replace(/<think[\s\S]*?<\/think\s*>/gi, "").trim();
}

/** Score one generated seed on the two-subject rubric (mirrors `judge_two_subject`). */
export async function judgeTwoSubject(imagePath: string, descA: string, descB: string, opts: LmStudioChatOptions = {}): Promise<JudgeScores> {
  const img = imageToVisionImage(imagePath);
  const raw = await lmStudioVisionCall(JUDGE(descA, descB), [img], opts);
  return coerceJudgeScores(raw);
}

// ── T2I seam (default: native krea2 Z-Image t2i) ────────────────────────

export interface T2iParams {
  prompt: string;
  width: number;
  height: number;
  steps: number;
  seed: number;
  outputDir?: string;
}
export interface T2iResult {
  path: string;
  seed: number;
}
export type T2iFn = (params: T2iParams) => Promise<T2iResult>;

/** Default t2i: native krea2 Z-Image (the same pipeline family `ZImagePipeline()` defaults to in the Python). No --cfg-scale forwarding — see module doc. */
export const defaultT2i: T2iFn = async (params) => {
  const out = await runKrea2({
    command: "t2i",
    options: { prompt: params.prompt, width: params.width, height: params.height, steps: params.steps, seed: params.seed },
    outputDir: params.outputDir,
  });
  if (!out.details.ok || !out.details.output) {
    throw new Error(`twosubject: krea2 t2i failed (seed=${params.seed}): ${out.summary}`);
  }
  return { path: out.details.output, seed: out.details.seed ?? params.seed };
};

// ── The main loop ────────────────────────────────────────────────────────

export interface TwosubjectOptions {
  charA?: string;
  charB?: string;
  refA?: string;
  refB?: string;
  candidates?: number;
  rounds?: number;
  minOverall?: number;
  style?: string;
  width?: number;
  height?: number;
  steps?: number;
  detail?: boolean;
  seed?: number;
  seedStart?: number;
  vlmApiUrl?: string;
  vlmModel?: string;
  outputDir?: string;
  /** Test seam: inject a canned t2i call so unit tests don't need the krea2 binary. */
  _t2iImpl?: T2iFn;
  /** Test seam: inject a canned fetch so unit tests don't need a real LM Studio server. */
  _fetchImpl?: typeof fetch;
}

export interface TwosubjectRoundHistory {
  round: number;
  prompt: string;
  bestSeed: number | null;
  bestOverall: number | null;
  candidates: ScoredCandidate[];
}

export interface TwosubjectResult {
  winnerPath: string;
  winnerSeed: number;
  winnerRound: number;
  winnerScores: JudgeScores;
  composedPrompt: string;
  threshold: number;
  candidatesPerRound: number;
  roundsRequested: number;
  roundsRun: number;
  history: TwosubjectRoundHistory[];
}

/**
 * Run the VLM-driven single-prompt two-subject loop (mirrors `run_twosubject`).
 * Phase 0 (ref-image captioning) → per round: Phase 1 (VLM composes prompt) →
 * Phase 2 (best-of-N native t2i, serial) → Phase 3 (VLM judges every seed) →
 * accept-or-revise. Throws if no candidate ever produces a parseable score
 * (mirrors the Python's `sys.exit(1)` on that condition).
 */
export async function runTwosubjectNative(opts: TwosubjectOptions): Promise<TwosubjectResult> {
  const { width, height, steps } = resolveGeometry(opts);
  const style = opts.style ?? DEFAULT_STYLE;
  let descA = opts.charA ?? DEFAULT_CHAR_A;
  let descB = opts.charB ?? DEFAULT_CHAR_B;
  const candidates = Math.max(1, opts.candidates ?? DEFAULT_CANDIDATES);
  const rounds = Math.max(1, Math.trunc(opts.rounds ?? DEFAULT_ROUNDS));
  const minOverall = opts.minOverall ?? DEFAULT_MIN_OVERALL;
  const baseSeed = opts.seedStart ?? opts.seed ?? DEFAULT_BASE_SEED;
  const t2i = opts._t2iImpl ?? defaultT2i;
  const lmOpts: LmStudioChatOptions = { apiUrl: opts.vlmApiUrl, model: opts.vlmModel, _fetchImpl: opts._fetchImpl };

  // Phase 0: refine descriptions from reference images (i2t caption).
  const refImages: VisionImage[] = [];
  if (opts.refA) {
    descA = await captionRefImage(opts.refA, lmOpts);
    refImages.push(imageToVisionImage(opts.refA));
  }
  if (opts.refB) {
    descB = await captionRefImage(opts.refB, lmOpts);
    refImages.push(imageToVisionImage(opts.refB));
  }

  let best: { path: string; seed: number; scores: ScoredCandidate; prompt: string; round: number } | null = null;
  const history: TwosubjectRoundHistory[] = [];
  let failure: { bleeding?: string[]; summary?: string } | null = null;

  for (let r = 0; r < rounds; r++) {
    // Phase 1: VLM composes ONE anti-bleeding two-subject prompt.
    const composed = await composeTwoSubjectPrompt(descA, descB, refImages, failure, lmOpts);
    const fullPrompt = style ? `${composed}, ${style}` : composed;

    // Phase 2: best-of-N (serial — Apple-Silicon-safe, mirrors the Python).
    const roundCandidates: ScoredCandidate[] = [];
    for (let i = 0; i < candidates; i++) {
      const seed = baseSeed + i;
      const gen = await t2i({ prompt: fullPrompt, width, height, steps, seed, outputDir: opts.outputDir });

      // Phase 3: VLM judges this seed.
      const scores = await judgeTwoSubject(gen.path, descA, descB, lmOpts);
      roundCandidates.push({ ...scores, path: gen.path, seed: gen.seed });
    }

    const roundBest = pickBest(roundCandidates);
    history.push({
      round: r + 1,
      prompt: fullPrompt,
      bestSeed: roundBest?.seed ?? null,
      bestOverall: roundBest?.overall ?? null,
      candidates: roundCandidates,
    });

    if (roundBest && (best === null || (roundBest.overall ?? 0) > (best.scores.overall ?? 0))) {
      best = { path: roundBest.path, seed: roundBest.seed, scores: roundBest, prompt: fullPrompt, round: r + 1 };
    }

    const bestOverall = best?.scores.overall ?? null;
    if (bestOverall != null && bestOverall >= minOverall) break;

    if (r + 1 < rounds) {
      const src = roundBest ?? best?.scores ?? null;
      failure = { bleeding: src?.bleeding ?? [], summary: src?.summary ?? "" };
    }
  }

  if (best === null) {
    throw new Error("twosubject: no candidate produced a parseable score.");
  }

  return {
    winnerPath: best.path,
    winnerSeed: best.seed,
    winnerRound: best.round,
    winnerScores: best.scores,
    composedPrompt: best.prompt,
    threshold: minOverall,
    candidatesPerRound: candidates,
    roundsRequested: rounds,
    roundsRun: history.length,
    history,
  };
}
