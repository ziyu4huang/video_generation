/**
 * caption_native.ts — native Bun replacement for `run.py caption`'s 4 simplest
 * styles: `default`, `t2i`, `score`, `review`.
 *
 * `app/commands/caption.py`'s `_call_vlm` is a bare `requests.post` to a local
 * LM Studio server — no MLX compute happens in that Python for the VLM call
 * itself, same finding that drove `story_native.ts` (see its header). This
 * module ports the 4 styles' prompt templates 1:1 (verbatim from
 * `caption.py::_STYLE_PROMPTS`, including the shared `_DEFECT_BLOCK` anti-
 * over-praise guardrail) and calls `lmstudio.ts`'s `lmStudioVisionCall`
 * instead of shelling out to `run.py`. The output `<image>.caption.json` is
 * byte-for-byte the same shape caption.py writes (image/style/model/
 * elapsed_sec/caption/updated_style/styles_run/styles), read back through
 * `caption.ts`'s existing `readCaption` so downstream consumers
 * (image-review.py, image-profile.py, and any Bun caller) see identical
 * fields regardless of which path produced the file.
 *
 * NOT ported (stay on the run.py bridge, see caption.ts / bridge.ts):
 * - `--review-html` / `--ab-manifest` (batch HTML report generation)
 * - `--samples N` multi-sample median scoring
 * - the LM-Studio KV-cache-quant auto-fix (`_disable_kv_cache_quant`)
 * - video captioning (ffmpeg keyframe extraction)
 * - every OTHER style (photography/profile/style/video_score/video_analysis/
 *   compare/playwright/lora_quality/ltx_i2v/pose_dsg) — richer parsing/
 *   multi-image logic not worth re-deriving in this pass.
 *
 * KNOWN SIMPLIFICATION: caption.py downsizes the image to <=1024px and
 * re-encodes as JPEG (quality 85) via PIL before base64-encoding it. Bun has
 * no built-in image codec, so this module base64-encodes the ORIGINAL file
 * bytes verbatim (mime type inferred from the extension). For the movie-
 * director pipeline's typical output sizes this is a non-issue; a much
 * larger/unusual source image would send a bigger payload to LM Studio than
 * the Python path would. Revisit if that ever proves to matter in practice.
 *
 * LOCAL ONLY: LM Studio always resolves to localhost — never a cloud VLM.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { lmStudioVisionCall, resolveDefaultModel, type LmStudioChatOptions, type VisionImage } from "./lmstudio.ts";
import { captionPathFor, readCaption, type CaptionDetails, type CaptionOptions, type CaptionOutput } from "./caption.ts";

// Shared defect-hunting + hard-cap block (verbatim from caption.py's
// `_DEFECT_BLOCK`) — used by BOTH `score` and `review` so they cannot drift
// apart (a prior over-praise regression on `review` alone is documented there).
const _DEFECT_BLOCK =
  "DEFECT CHECK (do this first; be ruthless — hunt for each of these):\n" +
  "- PLASTICKY / WAXY / OVERSMOOTHED SKIN: skin with no visible pores that " +
  "looks like a mannequin, wax doll, or airbrushed plastic. This is the most " +
  "common AI defect — check forehead, cheeks, shoulders, hands, and arms.\n" +
  "- HANDS & FINGERS: wrong finger count, fused/merged fingers, extra or " +
  "missing fingers, malformed hands, or extra/missing/fused limbs.\n" +
  "- FACE: asymmetric eyes or ears, mismatched pupils, deformed teeth, " +
  "melting or drifting features.\n" +
  "- STRUCTURE & SYMMETRY: warped body proportions, fused clothing, " +
  "floating or duplicated objects.\n" +
  "- BACKGROUND: chaotic/melting background, nonsensical objects, seams, " +
  "or ghosting.\n\n" +
  "HARD RULES (override any holistic impression):\n" +
  "- If skin looks plasticky/waxy/oversmoothed (no visible pores): artifacts <= 5, detail <= 6, AND overall <= 7.\n" +
  "- If ANY hand has a wrong finger count or fused fingers: artifacts <= 4 AND overall <= 6.\n" +
  "- If there are extra limbs or fused body parts: artifacts <= 3 AND overall <= 4.\n" +
  "- Give artifacts 9-10 ONLY if you genuinely cannot find ANY defect above.\n\n";

/** The 4 style prompt templates this module ports, verbatim from caption.py's `_STYLE_PROMPTS`. */
export const STYLE_PROMPTS: Record<string, string> = {
  default: "Describe this image in detail.",
  t2i:
    "Write a detailed text-to-image generation prompt for this image. " +
    "Describe subject, appearance, clothing, pose, background, lighting, style, and atmosphere. " +
    "Output only the prompt, no preamble.",
  score:
    "You are a STRICT, ADVERSARIAL image quality evaluator. AI-generated " +
    "images almost always carry subtle flaws — your job is to FIND them, not " +
    "to praise. Do not be lenient; a polished-looking image can still fail on " +
    "skin texture or hands.\n\n" +
    _DEFECT_BLOCK +
    "Then score on a 1-10 scale (respect the HARD RULES caps on overall/artifacts):\n" +
    "1. overall — overall image quality and aesthetic appeal\n" +
    "2. detail — level of fine detail (textures, fabric, skin pores, hair)\n" +
    "3. sharpness — image sharpness and clarity across the frame\n" +
    "4. composition — framing, rule of thirds, visual balance\n" +
    "5. prompt_adherence — how well the image matches a typical text-to-image prompt intent\n" +
    "6. artifacts — absence of rendering artifacts (INVERTED: 10 = no artifacts, 1 = severe)\n\n" +
    "Respond with ONLY a JSON object (no markdown fences, no explanation):\n" +
    '{"overall": N, "detail": N, "sharpness": N, "composition": N, ' +
    '"prompt_adherence": N, "artifacts": N, ' +
    '"issues": ["..."], "strengths": ["..."], "summary": "one sentence"}\n' +
    "Each score is an integer 1-10. List EVERY defect you found in issues[].",
  review:
    "You are a STRICT image quality evaluator reviewing a TEXT-TO-IMAGE output.\n\n" +
    "ORIGINAL PROMPT given to the generator:\n" +
    "---\n" +
    "{prompt}\n" +
    "---\n\n" +
    "STEP 1 — ELEMENT CHECK (do this first; be literal and strict):\n" +
    "Split the prompt into its key elements: subject, clothing, pose, setting/background, " +
    "STYLE or MEDIUM (oil painting, watercolor, anime, 3D render, photograph, etc.), lighting, " +
    "color palette. For each element mark PRESENT or ABSENT in the image. " +
    "STYLE/MEDIUM is CRITICAL: if the prompt names a style/medium and the image is NOT in that " +
    "style (e.g. prompt 'oil painting' but image is a clean studio photo), mark it ABSENT.\n\n" +
    "STEP 2 — prompt_adherence is a DETERMINISTIC function of the element check, NOT a holistic " +
    "guess: adherence = round(10 x present_count / total_count), then if ANY style/medium " +
    "element is ABSENT, CAP adherence at 5. A matching subject/pose does NOT redeem a wrong " +
    "style — never score 8-10 when a named style/medium is absent.\n\n" +
    _DEFECT_BLOCK +
    "STEP 3 — general quality dimensions (1-10, respect the HARD RULES caps above):\n" +
    "1. overall — overall image quality and aesthetic appeal\n" +
    "2. detail — level of fine detail (textures, fabric, skin pores, hair)\n" +
    "3. sharpness — image sharpness and clarity across the frame\n" +
    "4. composition — framing, rule of thirds, visual balance\n" +
    "5. artifacts — absence of rendering artifacts (INVERTED: 10 = no artifacts)\n\n" +
    "List captured[] (PRESENT elements) and missed[] (ABSENT/wrong elements).\n\n" +
    "Respond with ONLY a JSON object (no markdown fences):\n" +
    '{"overall": N, "detail": N, "sharpness": N, "composition": N, ' +
    '"prompt_adherence": N, "artifacts": N, ' +
    '"captured": ["..."], "missed": ["..."], ' +
    '"issues": ["..."], "strengths": ["..."], "summary": "one sentence"}\n' +
    "Each score is an integer 1-10.",
};

export const NATIVE_CAPTION_STYLES: ReadonlySet<string> = new Set(Object.keys(STYLE_PROMPTS));

/** Verbatim from caption.py's `_LANG_INSTRUCTIONS`. */
const LANG_INSTRUCTIONS: Record<string, string> = {
  zh_TW: "請用繁體中文回答。",
  zh_CN: "请用简体中文回答。",
  en: "Answer in English.",
  ja: "日本語で答えてください。",
};

/** `--style` defaults to `["t2i"]` when omitted (mirrors caption.py's argparse default). */
export function requestedStyles(options: CaptionOptions): string[] {
  if (Array.isArray(options.style) && options.style.length > 0) return options.style;
  if (typeof options.style === "string" && options.style) return [options.style];
  return ["t2i"];
}

/** True iff every requested style is one of the 4 natively-ported styles. */
export function isNativeCaptionRequest(options: CaptionOptions): boolean {
  return requestedStyles(options).every((s) => NATIVE_CAPTION_STYLES.has(s));
}

/** Build the VLM prompt for one style (mirrors caption.py's per-style prompt assembly). */
export function buildCaptionPrompt(style: string, lang: string, opts: { prompt?: string } = {}): string {
  const base = STYLE_PROMPTS[style];
  if (base == null) {
    throw new Error(`caption_native: unsupported style "${style}" (native path supports ${[...NATIVE_CAPTION_STYLES].join("/")})`);
  }
  let text = base;
  if (style === "review") {
    if (!opts.prompt) {
      throw new Error("caption_native: --prompt is required for 'review' style");
    }
    text = text.replace("{prompt}", opts.prompt);
  }
  const langLine = LANG_INSTRUCTIONS[lang] ?? LANG_INSTRUCTIONS.zh_TW!;
  return `${text}\n${langLine}`;
}

/** Strip Qwen3/Gemma-4 `<think>` reasoning blocks (mirrors caption.py's `_call_vlm`). */
function stripThinkBlocks(raw: string): string {
  const content = raw.replace(/<think[\s\S]*?<\/think\s*>/gi, "").trim();
  if (!content && /<think/i.test(raw)) {
    return raw.replace(/<\/?think\s*>/gi, "").trim();
  }
  return content;
}

function mimeFor(path: string): string {
  const ext = path.toLowerCase().split(".").pop() ?? "";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "webp") return "image/webp";
  if (ext === "gif") return "image/gif";
  return "image/png";
}

interface StyleEntry {
  model: string | null;
  elapsed_sec: number;
  caption: string;
}

/** Migrate a legacy flat single-style caption record to the `styles` map format (mirrors caption.py's `_normalize_caption_file`). */
function normalizeCaptionFile(data: Record<string, unknown>): { styles: Record<string, StyleEntry> } {
  if (data.styles && typeof data.styles === "object") {
    return { styles: data.styles as Record<string, StyleEntry> };
  }
  const style = (typeof data.style === "string" && data.style) || "default";
  return {
    styles: {
      [style]: {
        model: (data.model as string | null) ?? null,
        elapsed_sec: (data.elapsed_sec as number) ?? 0,
        caption: (data.caption as string) ?? "",
      },
    },
  };
}

function loadExistingStyles(outputPath: string): Record<string, StyleEntry> {
  if (!existsSync(outputPath)) return {};
  try {
    const data = JSON.parse(readFileSync(outputPath, "utf8"));
    return normalizeCaptionFile(data).styles;
  } catch {
    return {};
  }
}

export interface CaptionNativeInput {
  options: CaptionOptions;
  /** Test seam: inject a canned fetch so unit tests don't need a real LM Studio server. */
  _fetchImpl?: typeof fetch;
}

function failDetails(summary: string, model: string | null = null): CaptionOutput {
  const details: CaptionDetails = {
    ok: false,
    command: "caption",
    exitCode: 1,
    aborted: false,
    captionPath: null,
    model,
    styles: [],
    text: null,
    stdout: "",
  };
  return { details, summary, stderrTail: summary };
}

/** Run the 4 natively-ported caption styles directly against LM Studio (no run.py). */
export async function runCaptionNative(input: CaptionNativeInput): Promise<CaptionOutput> {
  const { options } = input;
  const styles = requestedStyles(options);
  const unsupported = styles.filter((s) => !NATIVE_CAPTION_STYLES.has(s));
  if (unsupported.length > 0) {
    return failDetails(
      `caption_native: unsupported style(s) ${unsupported.join(", ")} (native path supports ${[...NATIVE_CAPTION_STYLES].join("/")})`,
    );
  }
  if (!options.image || !existsSync(options.image)) {
    return failDetails(`caption_native: image not found: ${options.image}`);
  }

  let imageBytes: Buffer;
  try {
    imageBytes = readFileSync(options.image);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return failDetails(`caption_native: cannot read image: ${msg}`);
  }
  const image: VisionImage = { b64: imageBytes.toString("base64"), mime: mimeFor(options.image) };
  const lang = options.lang ?? "zh_TW";
  const outputPath = captionPathFor(options.image);
  const lmOpts: LmStudioChatOptions = { model: options.model, _fetchImpl: input._fetchImpl };

  let resolvedModel: string;
  try {
    resolvedModel = options.model ?? (await resolveDefaultModel(undefined, input._fetchImpl ?? fetch));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return failDetails(`caption_native: model resolution failed: ${msg}`);
  }

  const newEntries: Record<string, StyleEntry> = {};
  try {
    for (const style of styles) {
      const promptText = buildCaptionPrompt(style, lang, { prompt: options.prompt });
      const t0 = Date.now();
      // lmStudioVisionCall (shared with twosubject_native.ts) doesn't strip
      // <think> blocks itself — caption.py's _call_vlm does, so replicate that
      // here to keep the written caption text clean of reasoning-model noise.
      const raw = await lmStudioVisionCall(promptText, [image], { ...lmOpts, model: resolvedModel, maxTokens: 2048 });
      const caption = stripThinkBlocks(raw);
      const elapsedSec = Math.round(((Date.now() - t0) / 1000) * 100) / 100;
      newEntries[style] = { model: resolvedModel, elapsed_sec: elapsedSec, caption };
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return failDetails(`caption_native FAILED: ${msg}`, resolvedModel);
  }

  const lastStyle = styles[styles.length - 1]!;
  const mergedStyles = { ...loadExistingStyles(outputPath), ...newEntries };
  const lastEntry = newEntries[lastStyle]!;
  const merged = {
    image: options.image,
    style: lastStyle,
    ...lastEntry,
    updated_style: lastStyle,
    styles_run: Object.keys(newEntries),
    styles: mergedStyles,
  };

  try {
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, JSON.stringify(merged, null, 2));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return failDetails(`caption_native: failed to write ${outputPath}: ${msg}`, resolvedModel);
  }

  // Read back through caption.ts's own parser so downstream consumers see the
  // exact same {model, styles, text} shape regardless of which path wrote it.
  const parsed = readCaption(outputPath);
  const details: CaptionDetails = {
    ok: parsed != null,
    command: "caption",
    exitCode: 0,
    aborted: false,
    captionPath: parsed ? outputPath : null,
    model: parsed?.model ?? resolvedModel,
    styles: parsed?.styles ?? Object.keys(mergedStyles),
    text: parsed?.text ?? null,
    stdout: `Saved: ${outputPath} (${styles.length} style(s): ${styles.join(", ")})`,
  };
  const summary = details.ok
    ? `caption ✓ ${styles.join(",")} → ${outputPath} [${resolvedModel}]`
    : `caption FAILED (native, no json parsed)`;
  return { details, summary, stderrTail: "" };
}
