/**
 * profile_native.ts — native Bun port of `run.py image profile`'s CORE
 * multi-view (front/back/side) character-sheet generation path.
 *
 * `app/commands/image-profile.py`'s own header comment says it plainly: the
 * flux2-klein view prompts (`VIEW_PROMPTS_FLUX2`) deliberately mirror
 * `image-angle.py`'s short-prompt style ("The angle command uses short
 * prompts and achieves excellent style matching ... Profile adopts the same
 * approach"). `angle` is ALREADY fully ported to Swift
 * (`swift/flux2-image-director`'s `Flux2Angle.swift` — see its `buildPrompt`,
 * which emits the exact same "保持人物外貌、服裝、髮型完全一致，<angle text>,
 * photorealistic, maintain character identity and appearance consistency"
 * template Python's VIEW_PROMPTS_FLUX2 front/back entries hardcode). So this
 * module is NOT a new pipeline — it is pure orchestration calling the
 * already-native `angle` command 1-3 times (once per requested view) via
 * `runFlux2({command:"angle", ...})`, the same call shape twosubject_native.ts
 * uses for krea2's `t2i`.
 *
 * View → `angle` preset mapping:
 *   front → "front"   (azimuth 0)   — exact match, unambiguous.
 *   back  → "back"    (azimuth 180) — exact match, unambiguous.
 *   side  → "right"   (azimuth 90)  — a DELIBERATE, DOCUMENTED CHOICE, not a
 *     faithful 1:1 port: image-profile.py's own VIEW_PROMPTS_FLUX2["side"]
 *     text ("side profile view (90°) ... one shoulder and one side of the
 *     outfit visible") never names a lateral direction — the Python source
 *     is ITSELF ambiguous between left and right for this view; nothing in
 *     the Python enforces one over the other, and both are equally valid
 *     ways to satisfy that prompt. We pick "right" as the single deterministic
 *     mapping (matching `angle`'s own "right" preset text, "right side
 *     profile view") so `views: ["side"]` is reproducible. There is no
 *     "left" option in v1 — see DEFERRED below.
 *
 * Scope (v1 CORE — mirrors how caption_native.ts / twosubject_native.ts were
 * scoped in prior sessions of this migration):
 *
 *   PORTED: `--views` subset of front/back/side (any combination, generated
 *   in canonical VIEW_ORDER front→side→back — mirrors run_profile's own
 *   `[v for v in VIEW_ORDER if v in args.views]`), `--ratio` presets,
 *   explicit `--width`/`--height` override, `--steps`, `--seed` (single seed
 *   shared across all views — Python's VIEW_SEED_OFFSETS are all 0 today, so
 *   this is not a simplification, it is byte-identical behavior), `--ref-count`
 *   (clamped 1-3, mirrors Python's over-conditioning guard).
 *
 *   DEFERRED (documented, not silently dropped):
 *     - The `--pipeline zimage` / no-input-image path. image-profile.py only
 *       reaches the angle mechanism when `use_flux2` is true (flux2-klein
 *       pipeline AND an --input reference image). Without a reference image
 *       Python falls back to a completely different pipeline
 *       (`ZImagePipeline.generate` text-to-image, VIEW_PROMPTS not
 *       VIEW_PROMPTS_FLUX2) that has nothing to do with `angle` and is out of
 *       this port's scope. v1 REQUIRES `input` and always uses the flux2-klein
 *       reference-conditioned path (the recommended, default-when-input-given
 *       path in Python too).
 *     - `--prompt-style detailed` (VIEW_PROMPTS_FLUX2_DETAILED) and
 *       `--base-prompt` / `--vlm` auto-captioned clothing text. Both only
 *       affect the "detailed" prompt style in the Python — the DEFAULT
 *       "angle" style (which this module always uses, and which the Python's
 *       own comment calls out as achieving "excellent style matching") never
 *       consults base_prompt at all (`_build_view_prompt` returns
 *       `VIEW_PROMPTS_FLUX2[view]` verbatim for style="angle"). So porting
 *       only the default style loses nothing base_prompt would have added.
 *     - `--chain-ref` (cascade: side/back reference the previously generated
 *       view, not just the original). Swift's `angle` command's `input` field
 *       takes exactly ONE image path (repeated `refCount` times); it has no
 *       way to additionally reference a second, just-generated image, so
 *       chain-ref cannot be expressed through the `angle` mechanism at all.
 *       Python defaults `--chain-ref` to False anyway, so this only diverges
 *       from a non-default Python invocation.
 *     - `--ref-strength`. Python's own footgun guard IGNORES this for
 *       flux2-klein unconditionally (image_strength=None always, with a
 *       WARNING) — the angle command has no ref-strength-equivalent flag
 *       either, so there is nothing to wire even if we wanted to.
 *     - `_vlm_verify_profile_view` / `_vlm_verify_identity` (VLM angle-
 *       correctness + identity-preservation checks) — real candidates for a
 *       v2 (could reuse `lmstudio.ts`'s `lmStudioVisionCall`, the same
 *       primitive caption_native.ts/twosubject_native.ts already use), but
 *       out of scope for v1: the priority is a solid, tested CORE generation
 *       path first.
 *     - `_write_html_viewer` (self-contained profile-sheet HTML) and
 *       `_stitch_horizontal` (horizontal strip PNG) — both need real image
 *       decode/compose (PIL in Python); no image-codec dependency exists in
 *       this Bun package (twosubject_native.ts's module doc notes the same
 *       gap for its dropped `_bg_edge_split` tiebreak). Deferred, not
 *       silently dropped.
 *     - `--no-strip` / `--strip-gap` (flags for the deferred strip feature).
 *     - The shared `output/profile_<stamp>/` folder + `run.json`/`manifest.json`
 *       sidecars image-profile.py writes. Each view's own output path/seed/
 *       dims are still returned from `runProfileNative` (so a caller CAN write
 *       its own sidecar), but no folder or JSON file is created by this module
 *       — `angle`'s own outputDir/manifest handling is reused as-is per view.
 */
import { runFlux2 } from "@repo/s2-agent-ext-flux2";

// ── View / preset definitions (mirrors image-profile.py's module constants) ──

export const ALL_VIEWS = ["front", "back", "side"] as const;
export type ProfileView = (typeof ALL_VIEWS)[number];

/** Canonical generation order (mirrors Python's VIEW_ORDER: front → side → back). */
export const VIEW_ORDER: ProfileView[] = ["front", "side", "back"];

/**
 * view → flux2 `angle` preset name. "side" → "right" is a deliberate,
 * documented single choice for an ambiguous Python source — see module doc.
 */
export const VIEW_TO_ANGLE_PRESET: Record<ProfileView, string> = {
  front: "front",
  back: "back",
  side: "right",
};

/** Aspect-ratio presets (mirrors Python's RATIO_PRESETS: width × height, multiples of 16). */
export const RATIO_PRESETS = {
  portrait: [1024, 1360],
  standing: [1024, 1536],
  "full-body": [896, 1792],
  tall: [864, 2016],
  "9:16": [1088, 1920],
} as const satisfies Record<string, readonly [number, number]>;
export type RatioPreset = keyof typeof RATIO_PRESETS;
export const DEFAULT_RATIO: RatioPreset = "full-body";

// Profile-specific defaults (mirrors image-profile.py's _PROFILE_DEFAULT_SEED / _STEPS).
export const PROFILE_DEFAULT_SEED = 63515082432616;
export const PROFILE_DEFAULT_STEPS = 6;
export const DEFAULT_REF_COUNT = 3;

/** Resolve (width, height) from explicit overrides or a --ratio preset (mirrors run_profile's dimension resolution). */
export function resolveDimensions(opts: { ratio?: RatioPreset; width?: number; height?: number }): {
  width: number;
  height: number;
} {
  const preset = RATIO_PRESETS[opts.ratio ?? DEFAULT_RATIO];
  return { width: opts.width ?? preset[0], height: opts.height ?? preset[1] };
}

/** Clamp --ref-count to the validated 1-3 range (mirrors Python's over-conditioning footgun guard). */
export function clampRefCount(count: number): number {
  return Math.max(1, Math.min(3, Math.trunc(count)));
}

/** Order + de-duplicate a requested view subset into canonical VIEW_ORDER (mirrors `[v for v in VIEW_ORDER if v in args.views]`). */
export function orderViews(requested: ProfileView[] | undefined): ProfileView[] {
  const set = new Set(requested && requested.length ? requested : ALL_VIEWS);
  return VIEW_ORDER.filter((v) => set.has(v));
}

// ── The angle seam (default: native flux2 `angle` command) ─────────────────

export interface AngleParams {
  input: string;
  angle: string;
  refCount: number;
  width: number;
  height: number;
  steps: number;
  seed: number;
  outputDir?: string;
}
export interface AngleResult {
  path: string;
  seed: number | null;
  width: number | null;
  height: number | null;
}
export type AngleFn = (params: AngleParams) => Promise<AngleResult>;

/** Default angle call: native flux2 `angle` command (Flux2KleinEdit multi-ref, the same mechanism image-profile.py's own comments say it reuses). */
export const defaultAngle: AngleFn = async (p) => {
  const out = await runFlux2({
    command: "angle",
    options: {
      input: p.input,
      angle: p.angle,
      refCount: p.refCount,
      width: p.width,
      height: p.height,
      steps: p.steps,
      seed: p.seed,
    },
    outputDir: p.outputDir,
  });
  if (!out.details.ok || !out.details.output) {
    throw new Error(`profile: flux2 angle failed (angle=${p.angle}, seed=${p.seed}): ${out.summary}`);
  }
  return { path: out.details.output, seed: out.details.seed, width: out.details.width, height: out.details.height };
};

// ── The main orchestration ──────────────────────────────────────────────

export interface ProfileOptions {
  /** Identity reference image. REQUIRED in v1 — the angle mechanism is reference-conditioned; see module doc's DEFERRED zimage-text-only path. */
  input: string;
  /** Views to generate (default: all three). */
  views?: ProfileView[];
  ratio?: RatioPreset;
  width?: number;
  height?: number;
  steps?: number;
  seed?: number;
  refCount?: number;
  outputDir?: string;
  /** Test seam: inject a canned angle call so unit tests don't need the flux2 binary. */
  _angleImpl?: AngleFn;
}

export interface ProfileViewResult {
  view: ProfileView;
  angle: string;
  path: string;
  seed: number | null;
  width: number | null;
  height: number | null;
}

export interface ProfileResult {
  views: ProfileViewResult[];
  seed: number;
  width: number;
  height: number;
}

/**
 * Run the multi-view character-profile generation (mirrors run_profile's core
 * per-view loop). For each requested view (in canonical front→side→back
 * order), calls the native `angle` command once with the same reference image
 * and the mapped angle preset. Throws if `input` is missing or if any view's
 * `angle` call fails (mirrors the Python's `sys.exit(1)` on an unhandled
 * exception inside the generation loop — there is no partial-success mode).
 */
export async function runProfileNative(opts: ProfileOptions): Promise<ProfileResult> {
  if (!opts.input) {
    throw new Error("profile: --input is required (v1 only ports the flux2-klein reference-conditioned path — see module doc)");
  }
  const { width, height } = resolveDimensions(opts);
  const steps = opts.steps ?? PROFILE_DEFAULT_STEPS;
  const seed = opts.seed ?? PROFILE_DEFAULT_SEED;
  const refCount = clampRefCount(opts.refCount ?? DEFAULT_REF_COUNT);
  const views = orderViews(opts.views);
  const angleFn = opts._angleImpl ?? defaultAngle;

  const results: ProfileViewResult[] = [];
  for (const view of views) {
    const angle = VIEW_TO_ANGLE_PRESET[view];
    const out = await angleFn({ input: opts.input, angle, refCount, width, height, steps, seed, outputDir: opts.outputDir });
    results.push({ view, angle, path: out.path, seed: out.seed, width: out.width, height: out.height });
  }
  return { views: results, seed, width, height };
}
