/**
 * caption_native.ts — native Bun replacement for `run.py caption` (ALL 14 styles).
 *
 * `app/commands/caption.py`'s VLM helpers (`_call_vlm` / `_call_vlm_multi`) are bare
 * `requests.post` calls to a local LM Studio server — no MLX tensor math happens in
 * that Python for the VLM call itself. This module ports the full caption surface —
 * every style prompt (verbatim from `caption.py::_STYLE_PROMPTS`, including the shared
 * `_DEFECT_BLOCK` anti-over-praise guardrail), `--samples N` median denoising
 * (`median_score_caption`), `pose_dsg` Python-recomputed aggregates (`parse_pose_dsg`),
 * and video keyframe captioning (ffmpeg extraction → multi-image VLM call) — onto
 * `lmstudio.ts`'s `lmStudioVisionCall`, with zero runtime Python.
 *
 * The output `<image>.caption.json` is the same shape caption.py writes (image|video /
 * style / model / elapsed_sec / caption / updated_style / styles_run / styles), read
 * back through `caption.ts`'s existing `readCaption` so downstream consumers see
 * identical fields regardless of which path produced the file.
 *
 * OUT OF SCOPE (still require run.py if ever needed — not on the movie-director
 * runtime path): `--review-html` / `--ab-manifest` (batch HTML report generation),
 * the `--view` profile-view-elements block (niche multi-view fair comparison), and the
 * LM-Studio KV-cache-quant auto-fix.
 *
 * KNOWN SIMPLIFICATION: caption.py downsizes images to <=1024px and re-encodes as
 * JPEG (quality 85) via PIL before base64-encoding; video keyframes are resized to
 * <=768px. Bun has no built-in image codec, so this module base64-encodes the ORIGINAL
 * bytes (images) / full-resolution ffmpeg-extracted frames (video). For the pipeline's
 * typical output sizes this is a non-issue; a much larger source would send a bigger
 * LM Studio payload than Python would.
 *
 * LOCAL ONLY: LM Studio always resolves to localhost — never a cloud VLM.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { lmStudioVisionCall, resolveDefaultModel, type LmStudioChatOptions, type VisionImage } from "./lmstudio.ts";
import { captionPathFor, readCaption, type CaptionDetails, type CaptionOptions, type CaptionOutput } from "./caption.ts";

// Shared defect-hunting + hard-cap block (verbatim from caption.py's `_DEFECT_BLOCK`) —
// used by `score`, `review`, `lora_quality`, and `pose_dsg` so they cannot drift apart.
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

/**
 * The 14 style prompt templates, verbatim from caption.py's `_STYLE_PROMPTS` (rendered
 * form — single braces in the JSON examples, since caption.py's `.format()`-based styles
 * double them in source). Placeholder tokens ({prompt}, {action}, {lora_name},
 * {lora_description}, {scale}, {atoms_block}) are substituted by buildCaptionPrompt.
 */
export const STYLE_PROMPTS: Record<string, string> = {
  default: "Describe this image in detail.",
  photography:
    "Describe this photo as a photography prompt. " +
    "Include: subject, pose, clothing, lighting, camera angle, composition, mood, and setting.",
  t2i:
    "Write a detailed text-to-image generation prompt for this image. " +
    "Describe subject, appearance, clothing, pose, background, lighting, style, and atmosphere. " +
    "Output only the prompt, no preamble.",
  profile:
    "仔细描述这个人物的服装和外貌。" +
    "包括：上衣、下装、鞋子、配饰、发型、发色、肤色。" +
    "只输出服装和外貌描述，不要描述背景、姿势或构图。" +
    "用简体中文回答，使用简洁的逗号分隔列表格式。",
  style:
    "Describe the ART STYLE and RENDERING TECHNIQUE of this image. " +
    "Include: medium (digital painting, anime cel-shading, watercolor, oil, 3D render, etc.), " +
    "color palette (vibrant/muted, warm/cool, dominant hues), " +
    "lighting style (soft/dramatic/flat, ambient/directional), " +
    "line work (thick/thin, present/absent, ink/pencil), " +
    "texture/shading technique (smooth/grainy, flat/cross-hatch, gradient), " +
    "overall aesthetic (realistic/semi-realistic/stylized/cartoon/anime). " +
    "Output ONLY the style description as a comma-separated list. " +
    "Answer in English.",
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
  video_score:
    "You are a professional video quality evaluator. " +
    "The images below are EVENLY-SPACED KEYFRAMES from a single generated video. " +
    "Analyze them together to assess the video's overall quality.\n\n" +
    "Evaluate these dimensions on a scale of 1-10:\n" +
    "1. overall — overall video quality and aesthetic appeal\n" +
    "2. sharpness — image sharpness and clarity across frames\n" +
    "3. detail_preservation — level of fine detail (textures, faces, objects)\n" +
    "4. color_lighting — color accuracy, lighting quality, exposure consistency\n" +
    "5. temporal_coherence — how consistent objects/subjects appear across frames " +
    "(do shapes, faces, and positions change smoothly or flicker/jump)\n" +
    "6. artifacts — absence of rendering artifacts like blur, noise, blockiness, " +
    "or seams (INVERTED: 10 = no artifacts, 1 = severe)\n\n" +
    "Respond with ONLY a JSON object (no markdown fences, no explanation):\n" +
    '{"overall": N, "sharpness": N, "detail_preservation": N, ' +
    '"color_lighting": N, "temporal_coherence": N, "artifacts": N, ' +
    '"issues": "...", "strengths": "...", "summary": "one-sentence assessment"}\n' +
    "Each score is an integer 1-10.",
  video_analysis:
    "The images below are EVENLY-SPACED KEYFRAMES from a single generated video.\n\n" +
    "Analyze the video's content and production quality. Report:\n" +
    "1. scene_description — what is happening in the video (subject, action, setting)\n" +
    "2. camera_movement — is the camera static, panning, zooming, tracking?\n" +
    "3. motion_quality — does motion appear smooth and natural, or jittery/stuttering?\n" +
    "4. subject_consistency — does the main subject change appearance between frames?\n" +
    "5. overall_quality — one-sentence quality summary\n\n" +
    "Respond with ONLY a JSON object (no markdown fences):\n" +
    '{"scene_description": "...", "camera_movement": "...", ' +
    '"motion_quality": "...", "subject_consistency": "...", ' +
    '"overall_quality": "..."}',
  compare:
    "Describe this image in ONE short sentence (max 25 words). " +
    "Focus on: subject appearance (hair color, clothing), style (realistic/anime/3D), " +
    "and overall quality. Output only the sentence, nothing else.",
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
  playwright:
    "You are analyzing a SCREENSHOT of a web application's graphical user interface to help " +
    "guide browser automation (Playwright). Describe the page so an automation agent can " +
    "understand and interact with it WITHOUT seeing the screen.\n\n" +
    "Report:\n" +
    "1. LAYOUT — the major page regions/panels (e.g. left sidebar nav, top bar, main content, " +
    "right output panel) and what each is for.\n" +
    "2. INTERACTIVE ELEMENTS — list every control by its VISIBLE LABEL or placeholder text, " +
    "with its type: button, text input (give placeholder), dropdown/select (list the options " +
    "and which is selected), checkbox (checked?), slider (current value), radio, link, tab. " +
    "Quote the exact on-screen text.\n" +
    "3. STATE — currently selected values, filled-in field values, disabled/greyed-out " +
    "controls, badges or counts (e.g. '12 failed'), error/warning/status messages, loading " +
    "spinners, empty states.\n" +
    "4. PRIMARY ACTION — the main submit/action button: its label, and whether it looks " +
    "enabled or disabled.\n\n" +
    "Be precise and exhaustive about labels and current values — those are what an " +
    "automation agent keys on to locate elements. Answer in English.",
  lora_quality:
    "You are a STRICT LoRA adapter quality evaluator. Determine whether the LoRA effect\n" +
    "is VISIBLE at the given scale, and whether the scale causes over-activation.\n\n" +
    "LoRA: {lora_name}\n" +
    "Description: {lora_description}\n" +
    "Scale applied: {scale}\n\n" +
    "═══ STEP 1 — IS THE LoRA EFFECT VISIBLE? ═══\n" +
    "Decide before scoring anything: does this image show ANY influence from this LoRA?\n" +
    "Mentally compare to what the base model would produce WITHOUT this LoRA.\n" +
    "- If you CANNOT tell that any LoRA style was applied → activation_level = 'under'\n" +
    "- If LoRA style is clearly present and appropriate → activation_level = 'correct'\n" +
    "- If LoRA has warped, filtered, or distorted the image → activation_level = 'over'\n\n" +
    "SPECIAL CASE — BASELINE IMAGE (scale=0, scale=null, or scale='none'):\n" +
    "No LoRA was applied. Unconditionally set:\n" +
    "  lora_activation=1, activation_level='under', gate='fail'.\n" +
    "Score overall/detail/artifacts for the base image quality only.\n\n" +
    "═══ STEP 2 — OVER-ACTIVATION SYMPTOMS (hunt for ALL) ═══\n" +
    "ONE symptom = activation_level must be 'over':\n" +
    "- Watercolor wash or paint filter replacing photorealism\n" +
    "- Extreme skin smoothing / plastic / airbrushed look — no visible pores\n" +
    "- Color shift toward stylized palette (over-saturated, art-filter, too warm)\n" +
    "- Style bleeding: anime or cartoon features imposed on a photo-realist subject\n" +
    "- Loss of fine texture — detail replaced by flat or smeared shading\n" +
    "- Any REGRESSION in image quality vs. what the base model alone would produce\n\n" +
    "═══ STEP 3 — UNDER-ACTIVATION SYMPTOMS ═══\n" +
    "If ANY apply, activation_level must be 'under':\n" +
    "- No visible LoRA style influence — image indistinguishable from base-model output\n" +
    "- Subject characteristics expected from this LoRA are absent\n" +
    "- Trigger content for this LoRA is missing despite correct prompt\n\n" +
    _DEFECT_BLOCK +
    "═══ SCORING RULES ═══\n" +
    "MANDATORY CONSISTENCY — enforce before writing JSON:\n" +
    "  activation_level='under'   → lora_activation MUST be 1-4\n" +
    "  activation_level='correct' → lora_activation MUST be 6-10\n" +
    "  activation_level='over'    → lora_activation MUST be 1-3 (artifacts tank the score)\n\n" +
    "Score each dimension 1-10 (respect HARD RULES caps from the defect check above):\n" +
    "1. overall — overall image quality and aesthetic appeal\n" +
    "2. detail — level of fine detail (pores, hair, fabric texture)\n" +
    "3. artifacts — absence of LoRA-induced artifacts (INVERTED: 10 = zero artifacts)\n" +
    "4. lora_activation — how PRESENT and CORRECT the LoRA style effect is at this scale:\n" +
    "   10 = LoRA style CLEARLY VISIBLE + appropriate + no artifacts (BOTH required)\n" +
    "   5  = marginal — faint or barely distinguishable from base-model output\n" +
    "   1  = completely absent (baseline/invisible) OR severely over-activated\n" +
    "   WARNING: 'no artifacts' alone does NOT justify a high score.\n" +
    "   A clean baseline scores lora_activation=1 because the LoRA effect is ABSENT.\n\n" +
    "GATE VERDICT — choose exactly one:\n" +
    '- "pass": LoRA effect CLEARLY VISIBLE AND appropriate (activation_level MUST be "correct")\n' +
    '- "marginal": faint activation but usable, or very minor artifacts\n' +
    '- "fail": LoRA invisible (under) OR over-activation artifacts (over)\n' +
    "  RULE: activation_level='under' → gate is 'fail' or 'marginal' ONLY. Never 'pass'.\n" +
    "  RULE: activation_level='over'  → gate is ALWAYS 'fail'.\n\n" +
    "Respond with ONLY a JSON object (no markdown fences, no prose):\n" +
    '{"overall": N, "detail": N, "artifacts": N, "lora_activation": N,\n' +
    ' "activation_level": "under|correct|over",\n' +
    ' "gate": "pass|marginal|fail",\n' +
    ' "over_symptoms": ["list any over-activation symptoms found, empty if none"],\n' +
    ' "under_symptoms": ["list any under-activation symptoms found, empty if none"],\n' +
    ' "issues": ["all quality defects found"], "strengths": ["notable strengths"],\n' +
    ' "summary": "one sentence verdict"}\n' +
    "Each score is an integer 1-10.",
  ltx_i2v:
    "You are an expert LTX-2.3 video generation prompt engineer.\n\n" +
    "Analyze this image carefully: note the character's appearance (hair color/style, face, " +
    "clothing, body type, art style — realistic/anime/3D), the setting, and lighting.\n\n" +
    "The user wants the following action:\n" +
    "---\n" +
    "{action}\n" +
    "---\n\n" +
    "Generate an optimized LTX I2V (image-to-video) prompt in English that includes ALL of:\n" +
    "1. CHARACTER ANCHOR — 1-2 sentences describing the character's appearance as seen in " +
    "the image (hair color/style, clothing, body features). This anchors the video to the " +
    "input frame.\n" +
    "2. MOTION — detailed, physics-aware motion description matching the action intent. " +
    "Describe body movement, limb positions, speed, facial expressions, hair/clothing " +
    "movement from motion.\n" +
    "3. VOICE LINES — the character's spoken words or vocal sounds in Traditional Chinese " +
    "(zh-TW) by default, rendered as she says them (e.g., 她輕喘著說「嗯...啊...」). " +
    "Include vocal quality (husky / high-pitched / breathless / soft). " +
    "If the action contains no speaking, add natural breathing sounds instead.\n" +
    "4. AMBIENT AUDIO — background or impact sounds that fit the scene.\n\n" +
    "Output ONLY a JSON object (no markdown fences, no extra text):\n" +
    '{"prompt": "the full LTX I2V prompt as one English paragraph", ' +
    '"voice_lang": "zh_TW", ' +
    '"motion_summary": "one-sentence motion summary in English", ' +
    '"estimated_seconds": <integer seconds>}',
  pose_dsg:
    "You are a STRICT pose-faithfulness evaluator for a text-to-image output. AI models " +
    "routinely produce a pleasing image that DOES NOT match the requested pose — your job " +
    "is to verify ATOM-BY-ATOM, not to give a holistic impression.\n\n" +
    "ORIGINAL POSE PROMPT:\n" +
    "---\n" +
    "{prompt}\n" +
    "---\n\n" +
    _DEFECT_BLOCK +
    "STEP 1 — ATOMIC DECOMPOSITION (DSG-style).\n" +
    "{atoms_block}\n" +
    "STEP 2 — ATOM VERIFICATION. For EACH atom, look at the image and decide whether it is " +
    "TRUE (present=true) or FALSE (present=false), plus your confidence 0.0-1.0. Be literal: " +
    "an atom is true only if you can see it in the image.\n\n" +
    "STEP 3 — ANATOMY GATE (independent of atoms; hard pass/fail). These are NOT about the " +
    "prompt — they are structural correctness any human image must satisfy:\n" +
    "- limb_count: exactly 2 arms and 2 legs, no extra/fused/duplicated limbs\n" +
    "- hands: every visible hand has <= 5 fingers, none fused/malformed/extra\n" +
    "- face: IF the face is visible — features symmetric, two eyes, no melting/drift; " +
    "use the string \"n/a\" when the face is not visible in the frame\n" +
    "- pose_plausible: every joint within a plausible human range of motion, no twisted/" +
    "broken/unnatural limb orientation\n\n" +
    "Respond with ONLY a JSON object (no markdown fences, no prose, no comments):\n" +
    '{"atoms":[{"id":"a1","q":"the atom statement","present":true,"confidence":0.9}],\n' +
    ' "faithfulness": 0.0,\n' +
    ' "anatomy":{"limb_count":true,"hands":true,"face":true,"pose_plausible":true},\n' +
    ' "anatomy_pass": true,\n' +
    ' "issues":["every defect and every failed atom"],\n' +
    ' "summary":"one sentence"}\n' +
    "Rules:\n" +
    "- Each atom present is boolean true/false. confidence is a number 0.0-1.0.\n" +
    "- faithfulness = (number of atoms with present=true) / (total atoms). Recompute it;\n" +
    "  do not paste a round number.\n" +
    "- face may be true, false, or \"n/a\". anatomy_pass is false if limb_count, hands, or\n" +
    "  pose_plausible is false, OR if face is false (a visible-but-distorted face fails).\n" +
    "  face \"n/a\" never fails the gate.",
};

/** Styles that need a large token budget (complex JSON). Mirrors caption.py's `_JSON_OUTPUT_STYLES`. */
const JSON_OUTPUT_STYLES = new Set(["ltx_i2v"]);

export const NATIVE_CAPTION_STYLES: ReadonlySet<string> = new Set(Object.keys(STYLE_PROMPTS));

/** Verbatim from caption.py's `_LANG_INSTRUCTIONS`. */
const LANG_INSTRUCTIONS: Record<string, string> = {
  zh_TW: "請用繁體中文回答。",
  zh_CN: "请用简体中文回答。",
  en: "Answer in English.",
  ja: "日本語で答えてください。",
};

/** Video input detection (mirrors caption.py's video_exts). */
const VIDEO_EXTS = new Set([".mp4", ".mov", ".avi", ".webm", ".mkv", ".gif"]);
export function isVideoInput(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return false;
  return VIDEO_EXTS.has(path.slice(dot).toLowerCase());
}

// ─── score-style --samples median (port of median_score_caption / _parse_score_dict) ─

const SCORE_NUMERIC_DIMS = ["overall", "detail", "sharpness", "composition", "prompt_adherence", "artifacts"];
const SCORE_ARRAY_DIMS = ["captured", "missed", "issues", "strengths"];

/** Pull the first {...} block (after stripping ```json fences) and JSON-parse it. */
export function extractCaptionJson(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw !== "string") return {};
  let s = raw.trim();
  if (s.startsWith("```")) {
    s = s.replace(/^```[a-zA-Z]*\s*/, "").replace(/```\s*$/, "").trim();
  }
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end <= start) return {};
  try {
    const parsed = JSON.parse(s.slice(start, end + 1));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Parse a VLM score response into a dict (tolerating fences/prose); null on failure. */
function parseScoreDict(text: string): Record<string, unknown> | null {
  if (!text) return null;
  let s = text.trim();
  if (s.startsWith("```")) {
    s = s.replace(/^```[a-zA-Z]*\n?/, "").replace(/\n?```$/, "").trim();
  }
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(s.slice(start, end + 1));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function medianNum(values: unknown[]): number {
  const nums = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v)).sort((a, b) => a - b);
  if (nums.length === 0) return 0;
  const m = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[m]! : Math.round((nums[m - 1]! + nums[m]!) / 2);
}

/** Median N raw VLM score responses into one score dict serialized as JSON (port of median_score_caption). */
export function medianScoreCaption(raws: string[]): string {
  const parsed = raws.map(parseScoreDict).filter((d): d is Record<string, unknown> => d != null);
  if (parsed.length === 0) return raws[0] ?? "{}";
  if (parsed.length === 1) {
    const out = { ...parsed[0]!, scoreSamples: 1 };
    return JSON.stringify(out);
  }
  const med: Record<string, unknown> = {};
  for (const d of SCORE_NUMERIC_DIMS) med[d] = medianNum(parsed.map((p) => p[d]));
  for (const d of SCORE_ARRAY_DIMS) {
    const seen = new Set<string>();
    const union: string[] = [];
    for (const p of parsed) {
      for (const x of (p[d] as unknown[] | undefined) ?? []) {
        const t = String(x);
        if (!seen.has(t)) {
          seen.add(t);
          union.push(t);
        }
      }
    }
    med[d] = union;
  }
  const target = med["overall"];
  let carrier = parsed[0]!;
  let best = Infinity;
  for (const p of parsed) {
    const diff = Math.abs(((p["overall"] as number) ?? 0) - (target as number));
    if (diff < best) {
      best = diff;
      carrier = p;
    }
  }
  med["summary"] = carrier["summary"] ?? "";
  med["scoreSamples"] = parsed.length;
  return JSON.stringify(med);
}

// ─── pose_dsg — atoms + Python-recomputed aggregates (port of build_pose_dsg_prompt / parse_pose_dsg) ─

interface PoseAtom {
  id: string;
  q: string;
}

/** Load explicit atoms from a path or inline JSON ({atoms:[{id,q}]} or bare [{id,q}]). null → VLM self-decomposes. */
export function loadAtoms(spec: string | undefined): PoseAtom[] | null {
  if (!spec) return null;
  let text: string;
  if (existsSync(spec)) text = readFileSync(spec, "utf8");
  else text = spec;
  const data = JSON.parse(text) as { atoms?: PoseAtom[] } | PoseAtom[];
  const atoms = Array.isArray(data) ? data : data.atoms;
  if (!Array.isArray(atoms) || atoms.length === 0) {
    throw new Error("--atoms JSON must be a non-empty list of {id, q} objects");
  }
  return atoms.map((a, i) => {
    if (!a || !a.q) throw new Error(`--atoms[${i}] missing a 'q' statement`);
    return { id: String(a.id ?? `a${i + 1}`), q: String(a.q) };
  });
}

/** STEP-1 instruction for pose_dsg: use explicit atoms, or instruct self-decomposition. */
function buildAtomsBlock(atoms: PoseAtom[] | null): string {
  if (atoms && atoms.length > 0) {
    const lines = atoms.map((a) => `  - ${a.id}: ${a.q}`).join("\n");
    return `Use EXACTLY these atoms (do not add, merge, drop, or reword any):\n${lines}\n`;
  }
  return (
    "Derive 5-10 atoms yourself from the pose prompt above. Each atom is a single " +
    "yes/no proposition about ONE thing: an object (e.g. 'exactly one woman'), a body " +
    "attribute ('sitting cross-legged'), a spatial relation ('left hand on top of head'), " +
    "a viewpoint ('3/4 profile view'), or a count ('exactly 5 fingers per visible hand').\n"
  );
}

function asBool(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return ["true", "yes", "1", "pass"].includes(v.trim().toLowerCase());
  return false;
}

/** Face field: true | false | 'n/a' → true | false | null. */
function faceValue(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  if (typeof v === "string" && ["n/a", "na", "none", "not visible"].includes(v.trim().toLowerCase())) return null;
  return asBool(v);
}

function clampConf(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, Math.round(n * 100) / 100));
}

/** Parse a pose_dsg VLM response and RECOMPUTE faithfulness + anatomy_pass (never trust model aggregates). */
export function parsePoseDsg(textOrDict: unknown): Record<string, unknown> {
  const raw = extractCaptionJson(textOrDict);
  const srcAtoms = Array.isArray(raw["atoms"]) ? (raw["atoms"] as unknown[]) : [];
  const atoms = srcAtoms
    .filter((a): a is Record<string, unknown> => !!a && typeof a === "object")
    .map((a, i) => ({
      id: String(a["id"] ?? `a${i + 1}`),
      q: String(a["q"] ?? a["question"] ?? ""),
      present: Boolean(a["present"]),
      confidence: clampConf(a["confidence"]),
    }));
  const present = atoms.filter((a) => a.present).length;
  const faithfulness = atoms.length > 0 ? Math.round((present / atoms.length) * 1000) / 1000 : 0;
  const anIn = (raw["anatomy"] && typeof raw["anatomy"] === "object" ? raw["anatomy"] : {}) as Record<string, unknown>;
  const face = faceValue(anIn["face"]);
  const anatomy = {
    limb_count: asBool(anIn["limb_count"]),
    hands: asBool(anIn["hands"]),
    face,
    pose_plausible: asBool(anIn["pose_plausible"]),
  };
  const anatomyPass = Boolean(
    anatomy.limb_count && anatomy.hands && anatomy.pose_plausible && face !== false,
  );
  const issuesIn = raw["issues"];
  const issues = Array.isArray(issuesIn) ? issuesIn.map((x) => String(x)) : issuesIn != null ? [String(issuesIn)] : [];
  return {
    atoms,
    faithfulness,
    anatomy,
    anatomy_pass: anatomyPass,
    issues,
    summary: String(raw["summary"] ?? ""),
  };
}

// ─── prompt assembly + I/O ─────────────────────────────────────────────────────

/** `--style` defaults to `["t2i"]` when omitted (mirrors caption.py's argparse default). */
export function requestedStyles(options: CaptionOptions): string[] {
  if (Array.isArray(options.style) && options.style.length > 0) return options.style;
  if (typeof options.style === "string" && options.style) return [options.style];
  return ["t2i"];
}

/** True iff every requested style is natively ported (all 14 are, so this is always true
 *  for valid styles; kept for bridge.ts compatibility + invalid-style rejection). */
export function isNativeCaptionRequest(options: CaptionOptions): boolean {
  return requestedStyles(options).every((s) => NATIVE_CAPTION_STYLES.has(s));
}

/** Build the VLM prompt for one style (mirrors caption.py's per-style prompt assembly). */
export function buildCaptionPrompt(style: string, lang: string, opts: CaptionOptions): string {
  const base = STYLE_PROMPTS[style];
  if (base == null) {
    throw new Error(`caption_native: unsupported style "${style}" (native path supports ${[...NATIVE_CAPTION_STYLES].join("/")})`);
  }
  let text = base;
  if (style === "review") {
    if (!opts.prompt) throw new Error("caption_native: --prompt is required for 'review' style");
    text = text.replace("{prompt}", opts.prompt);
  } else if (style === "pose_dsg") {
    if (!opts.prompt) throw new Error("caption_native: --prompt is required for 'pose_dsg' style");
    text = text.replace("{prompt}", opts.prompt).replace("{atoms_block}", buildAtomsBlock(loadAtoms(opts.atoms)));
  } else if (style === "ltx_i2v") {
    if (!opts.action) throw new Error("caption_native: --action is required for 'ltx_i2v' style");
    text = text.replace("{action}", opts.action);
  } else if (style === "lora_quality") {
    text = text
      .replace("{lora_name}", opts.loraName ?? "unknown")
      .replace("{lora_description}", opts.loraDescription ?? "no description")
      .replace("{scale}", opts.loraScale != null ? String(opts.loraScale) : "unknown");
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
  caption: unknown;
  /** Video-only: number of keyframes extracted. */
  frames?: number;
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
        caption: data.caption ?? "",
      },
    },
  };
}

function loadExistingStyles(outputPath: string): Record<string, StyleEntry> {
  if (!existsSync(outputPath)) return {};
  try {
    const data = JSON.parse(readFileSync(outputPath, "utf8")) as Record<string, unknown>;
    return normalizeCaptionFile(data).styles;
  } catch {
    return {};
  }
}

// ─── video keyframe extraction (ffmpeg; mirrors app/video_utils.extract_keyframes) ─

/** Sample `nFrames` evenly-spaced frames from `video` into a temp dir as JPEGs. */
async function extractKeyframes(video: string, nFrames: number): Promise<string[]> {
  const outDir = mkdtempSync(join(tmpdir(), "md-caption-keyframes-"));
  // Probe duration synchronously via spawnSync for accurate even spacing.
  let dur = 0;
  try {
    const { spawnSync } = await import("node:child_process");
    const r = spawnSync("ffprobe", [
      "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", video,
    ], { encoding: "utf8" });
    dur = Number.parseFloat((r.stdout ?? "").trim()) || 0;
  } catch {
    dur = 0;
  }
  const frames: string[] = [];
  for (let i = 0; i < nFrames; i++) {
    const ts = dur > 0 ? (dur * (i + 0.5)) / nFrames : i;
    const outPath = join(outDir, `frame_${String(i).padStart(3, "0")}.jpg`);
    const code = await runSpawn("ffmpeg", [
      "-y", "-loglevel", "error", "-ss", ts.toFixed(3), "-i", video, "-frames:v", "1", outPath,
    ]);
    if (code === 0 && existsSync(outPath)) frames.push(outPath);
  }
  return frames;
}

function runSpawn(cmd: string, argv: string[]): Promise<number> {
  return new Promise((res) => {
    const p = spawn(cmd, argv, { stdio: ["ignore", "ignore", "ignore"] });
    p.on("exit", (c) => res(c ?? -1));
    p.on("error", () => res(-1));
  });
}

// ─── main entry ────────────────────────────────────────────────────────────────

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

/**
 * Run any of the 14 caption styles directly against LM Studio (no run.py). Handles
 * image + video inputs, `--samples N` median denoising (score family), pose_dsg's
 * Python-recomputed aggregates, and the templated styles (review/pose_dsg/ltx_i2v/lora_quality).
 */
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
    return failDetails(`caption_native: input not found: ${options.image}`);
  }

  const lang = options.lang ?? "zh_TW";
  const outputPath = captionPathFor(options.image);
  const lmOpts: LmStudioChatOptions = { model: options.model, _fetchImpl: input._fetchImpl };
  const video = isVideoInput(options.image);
  const nFrames = options.frames ?? 8;

  let resolvedModel: string;
  try {
    resolvedModel = options.model ?? (await resolveDefaultModel(undefined, input._fetchImpl ?? fetch));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return failDetails(`caption_native: model resolution failed: ${msg}`);
  }

  // Encode the single image once (image path); video path extracts per-style keyframes.
  let imageVision: VisionImage[] | null = null;
  if (!video) {
    try {
      const bytes = readFileSync(options.image);
      imageVision = [{ b64: bytes.toString("base64"), mime: mimeFor(options.image) }];
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return failDetails(`caption_native: cannot read image: ${msg}`);
    }
  }

  const newEntries: Record<string, StyleEntry> = {};
  try {
    for (const style of styles) {
      const promptText = buildCaptionPrompt(style, lang, options);
      const maxTokens = JSON_OUTPUT_STYLES.has(style) ? 40000 : 2048;
      const t0 = Date.now();

      let visionImages: VisionImage[];
      let framesCount: number | undefined;
      if (video) {
        const kf = await extractKeyframes(options.image, nFrames);
        if (kf.length === 0) {
          return failDetails(`caption_native: no keyframes extracted from ${options.image}`, resolvedModel);
        }
        framesCount = kf.length;
        visionImages = kf.map((p) => ({ b64: readFileSync(p).toString("base64"), mime: mimeFor(p) }));
      } else {
        visionImages = imageVision!;
      }

      const nSamples = Math.max(1, options.samples ?? 1);
      // --samples median applies to score-family styles only (pose_dsg ignores it; video
      // ignores it — caption.py samples on the single-image score path only).
      const useMedian = nSamples > 1 && !video && style !== "pose_dsg";
      let captionValue: unknown;
      if (useMedian) {
        const raws: string[] = [];
        for (let s = 0; s < nSamples; s++) {
          const raw = await lmStudioVisionCall(promptText, visionImages, { ...lmOpts, model: resolvedModel, maxTokens });
          raws.push(stripThinkBlocks(raw));
        }
        captionValue = medianScoreCaption(raws);
      } else {
        const raw = await lmStudioVisionCall(promptText, visionImages, { ...lmOpts, model: resolvedModel, maxTokens });
        captionValue = stripThinkBlocks(raw);
      }

      // pose_dsg: recompute faithfulness/anatomy_pass in JS (never trust model aggregates).
      if (style === "pose_dsg") {
        captionValue = parsePoseDsg(captionValue);
      }

      const elapsedSec = Math.round(((Date.now() - t0) / 1000) * 100) / 100;
      const entry: StyleEntry = { model: resolvedModel, elapsed_sec: elapsedSec, caption: captionValue };
      if (video) entry.frames = framesCount;
      newEntries[style] = entry;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return failDetails(`caption_native FAILED: ${msg}`, resolvedModel);
  }

  const lastStyle = styles[styles.length - 1]!;
  const mergedStyles = { ...loadExistingStyles(outputPath), ...newEntries };
  const lastEntry = newEntries[lastStyle]!;
  const flatRecord: Record<string, unknown> = video ? { video: options.image, frames: lastEntry.frames } : { image: options.image };
  const merged = {
    ...flatRecord,
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
