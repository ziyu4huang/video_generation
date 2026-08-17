/**
 * character_native.ts — native Bun port of `run.py image character`'s
 * orchestration (`app/commands/image-character.py`, 324 lines).
 *
 * image-character.py's own header/comments say it plainly: this command is
 * "PURE ORCHESTRATION" composing two already-certified primitives —
 *   1. `image profile` multi-view (front/side/back) generation, and
 *   2. Step-1 `cutout` (SAM3 segment → feather → alpha-composited PNG) per
 *      view,
 * then writes a persistent `IdentitySpec.json` (schema `character-lock.v1`)
 * so a later `image storyboard --character <hero>` can reuse the same
 * identity. Zero new MLX/generation code — this module mirrors that shape in
 * Bun: it calls `runProfileNative` (already ported, profile_native.ts) for
 * Phase 1, then flux2's native `cutout` command (Swift-native SAM3.1 bridge +
 * MLX alpha compositing, `swift/flux2-image-director/Sources/
 * Flux2DirectorCLI/CutoutCommand.swift`) per view for Phase 2, then
 * assembles + writes the IdentitySpec.json.
 *
 * PHASE 2 HISTORY: until 2026-08-01, this module called flux2's `segment`
 * command instead, which only produces an intermediate grayscale MASK PNG
 * (no alpha compositing — this package had no image-codec/pixel-buffer
 * library to do the PIL-equivalent compositing Python's `alpha_cutout` does).
 * `views[].cutout` was therefore hardcoded `null` forever, with the mask
 * riding under an undocumented extension field, `views[].mask`. The
 * 2026-07-31 `cutout` Swift-native port
 * (.planning/specs/2026-07-31-cutout-swift-native-port-design.md)
 * closed that gap by shipping `flux2 cutout` (SAM3 bridge unchanged, new
 * `ImageSave.savePNGRGBA` MLX-tensor compositing); this module was updated
 * (.planning/specs/2026-08-01-character-native-cutout-wiring-design.md)
 * to call it instead. `views[].mask` is gone — `views[].cutout` now carries
 * the real alpha-composited path, or `null` when SAM3 found no detection for
 * that view (or the bridge itself failed).
 *
 * Other DEFERRED items (documented, not silently dropped):
 *   - `_fill_holes` (interior-hole filling before feathering) — Python always
 *     applies this for character sheets ("A character turnaround silhouette
 *     MUST be solid"); the SAM3 bridge `cutout` calls through has a fixed
 *     feather-only behavior with no hole-filling option (unchanged by the
 *     2026-07-31 port).
 *   - `--self-test` (hero synthesis via ZImagePipeline T2I) — needs the MLX
 *     Python pipeline; out of scope for a Bun-only port. Callers wanting a
 *     self-test must supply their own hero image via `input`.
 *   - Everything profile_native.ts itself defers (prompt-style "detailed",
 *     --chain-ref, --ref-strength, VLM angle/identity verification, the HTML
 *     viewer, the horizontal strip PNG) — inherited unchanged, since Phase 1
 *     delegates straight to `runProfileNative`.
 */
import { runFlux2 } from "@repo/pi-agent-ext-flux2";
import { basename, dirname, extname, join } from "node:path";
import {
  runProfileNative,
  type ProfileView,
  type RatioPreset,
  type ProfileViewResult,
} from "./profile_native.ts";

const _SCHEMA = "character-lock.v1";

// SAM3 text segmentation prefers CONCISE prompts (mirrors Python's
// _DEFAULT_CUTOUT_SUBJECT comment: "person" reliably scores ~0.94, comma
// lists return 0 detections).
export const DEFAULT_CUTOUT_SUBJECT = "person";
export const DEFAULT_SAM_THRESHOLD = 0.3;

// ── Phase 2: per-view cutout (SAM3 segmentation + alpha compositing) ───────

export interface CutoutParams {
  image: string;
  prompt: string;
  threshold: number;
  outputDir?: string;
}
export interface CutoutResult {
  /**
   * True alpha-composited cutout PNG path. `null` covers both "no SAM3
   * detection for this view" and an actual bridge/subprocess failure —
   * `flux2 cutout` exits non-zero for both and leaves no metadata sidecar
   * to distinguish them (unlike `flux2 segment`'s always-0-exit + sidecar
   * JSON), so v1 doesn't try to distinguish either; the view is simply
   * skipped either way, mirroring the prior segment-based behavior of
   * silently continuing without a cutout for that view.
   */
  cutoutPath: string | null;
}
export type CutoutFn = (params: CutoutParams) => Promise<CutoutResult>;

/** Build the cutout output path for one view image (mirrors Python's `{stem}_cutout.png` naming — see module doc). */
export function cutoutPathFor(imagePath: string): string {
  const dir = dirname(imagePath);
  const stem = basename(imagePath, extname(imagePath));
  return join(dir, `${stem}_cutout.png`);
}

/** Default cutout call: native flux2 `cutout` command (SAM3.1 bridge + MLX alpha compositing). No `--trim` (character-sheet views must stay at the profile phase's fixed canvas size) and no `--save-mask` (nothing consumes the debug mask/overlay PNGs it would produce). */
export const defaultCutout: CutoutFn = async (p) => {
  const outputPath = cutoutPathFor(p.image);
  const out = await runFlux2({
    command: "cutout",
    options: {
      input: p.image,
      subject: p.prompt,
      samThreshold: p.threshold,
      output: outputPath,
    },
    outputDir: p.outputDir,
  });
  if (!out.details.ok) {
    return { cutoutPath: null };
  }
  return { cutoutPath: outputPath };
};

// ── Phase 3: IdentitySpec.json builder (pure — mirrors build_identity_spec) ─

export interface CharacterLock {
  pipeline: string;
  seed: number;
  refCount: number;
  refStrength: number;
  styleAnchor: string;
  loraPath?: string;
  loraScale?: number;
  cfgScale?: number;
}

export interface ViewMeta {
  view: ProfileView;
  image: string | null;
  /** True alpha-composited cutout PNG path (null = no SAM3 detection for this view, or a bridge failure). */
  cutout: string | null;
}

export interface IdentitySpec {
  schema: string;
  hero: string;
  lock: CharacterLock;
  shots: unknown[];
  views: ViewMeta[];
}

export interface BuildIdentitySpecOptions {
  pipeline?: string;
  refCount?: number;
  refStrength?: number;
  styleAnchor?: string;
  loraPath?: string;
  loraScale?: number;
  cfgScale?: number;
}

/**
 * Build the `character-lock.v1` IdentitySpec dict (mirrors Python's
 * `build_identity_spec`, a pure builder with no generation/model calls).
 */
export function buildIdentitySpec(
  hero: string,
  seed: number,
  opts: BuildIdentitySpecOptions,
  views: ViewMeta[],
): IdentitySpec {
  let pipeline = opts.pipeline ?? "flux2-klein";
  if (pipeline === "auto") pipeline = "flux2-klein";
  const lock: CharacterLock = {
    pipeline,
    seed: Math.trunc(seed),
    refCount: Math.trunc(opts.refCount ?? 3) || 3,
    refStrength: opts.refStrength ?? 0.8,
    styleAnchor: (opts.styleAnchor ?? "").trim(),
  };
  if (opts.loraPath) {
    lock.loraPath = opts.loraPath;
    lock.loraScale = opts.loraScale ?? 1.0;
  }
  if (opts.cfgScale != null) {
    lock.cfgScale = opts.cfgScale;
  }
  return { schema: _SCHEMA, hero, lock, shots: [], views };
}

// ── The main orchestration ──────────────────────────────────────────────

export interface CharacterOptions {
  /** Hero reference image. REQUIRED (mirrors Python's `--input`/hero requirement). */
  input: string;
  views?: ProfileView[];
  ratio?: RatioPreset;
  width?: number;
  height?: number;
  steps?: number;
  seed?: number;
  refCount?: number;
  refStrength?: number;
  styleAnchor?: string;
  loraPath?: string;
  loraScale?: number;
  cfgScale?: number;
  pipeline?: string;
  cutoutSubject?: string;
  samThreshold?: number;
  outputDir?: string;
  /** Test seam: inject a canned profile-phase runner so unit tests don't need flux2's `angle`. */
  _runProfile?: typeof runProfileNative;
  /** Test seam: inject a canned cutout call so unit tests don't need flux2's `cutout`. */
  _cutoutImpl?: CutoutFn;
}

export interface CharacterResult {
  identitySpecPath: string | null;
  identitySpec: IdentitySpec;
  outDir: string;
  cutouts: number;
}

/**
 * Run the character-sheet build: Phase 1 (multi-view profile via
 * `runProfileNative`) → Phase 2 (per-view SAM3 cutout) → Phase 3
 * (IdentitySpec.json). Mirrors `run_character`'s control flow. Throws if
 * `input` is missing (mirrors Python's `sys.exit(1)` — no partial-success
 * mode for a missing hero) or if Phase 1 fails (runProfileNative already
 * throws in that case).
 *
 * NOTE: unlike the Python (which writes `IdentitySpec.json` to disk inside
 * `out_dir`), this function returns the built spec to the caller; writing it
 * to disk is the caller's responsibility (via `writeIdentitySpec` below) —
 * this keeps the core orchestration pure/testable, mirroring how
 * `runProfileNative` itself does not write any sidecar files.
 */
export async function runCharacterNative(opts: CharacterOptions): Promise<CharacterResult> {
  if (!opts.input) {
    throw new Error("character: --input (hero image) is required.");
  }

  const runProfile = opts._runProfile ?? runProfileNative;
  const cutoutFn = opts._cutoutImpl ?? defaultCutout;

  // Phase 1: multi-view profile generation (delegates to the certified,
  // already-ported profile_native.ts — same as Python delegating to
  // app/commands/image-profile.py's run_profile()).
  const profileResult = await runProfile({
    input: opts.input,
    views: opts.views,
    ratio: opts.ratio,
    width: opts.width,
    height: opts.height,
    steps: opts.steps,
    seed: opts.seed,
    refCount: opts.refCount,
    outputDir: opts.outputDir,
  });

  const seed = profileResult.seed;
  const viewOutputs: ProfileViewResult[] = profileResult.views;
  const outDir = opts.outputDir ?? (viewOutputs[0]?.path ? dirname(viewOutputs[0].path) : "");

  // Phase 2: per-view cutout (SAM3 segmentation + MLX alpha compositing,
  // via flux2's native `cutout` command).
  const subject = opts.cutoutSubject ?? DEFAULT_CUTOUT_SUBJECT;
  const threshold = opts.samThreshold ?? DEFAULT_SAM_THRESHOLD;

  const viewsMeta: ViewMeta[] = [];
  let cutoutCount = 0;
  for (const vo of viewOutputs) {
    const entry: ViewMeta = { view: vo.view, image: vo.path, cutout: null };
    if (vo.path) {
      const result = await cutoutFn({ image: vo.path, prompt: subject, threshold, outputDir: opts.outputDir });
      if (result.cutoutPath) {
        entry.cutout = result.cutoutPath;
        cutoutCount += 1;
      }
    }
    viewsMeta.push(entry);
  }

  // Phase 3: IdentitySpec.json (pure builder).
  const identitySpec = buildIdentitySpec(
    opts.input,
    seed,
    {
      pipeline: opts.pipeline,
      refCount: opts.refCount,
      refStrength: opts.refStrength,
      styleAnchor: opts.styleAnchor,
      loraPath: opts.loraPath,
      loraScale: opts.loraScale,
      cfgScale: opts.cfgScale,
    },
    viewsMeta,
  );

  return { identitySpecPath: null, identitySpec, outDir, cutouts: cutoutCount };
}

/** Write the IdentitySpec.json to `<outDir>/IdentitySpec.json` (mirrors Python's `json.dump(..., indent=2)` + trailing newline). Split out from the orchestration so the core stays pure/testable (mirrors runProfileNative not writing sidecars itself). */
export async function writeIdentitySpec(outDir: string, spec: IdentitySpec): Promise<string> {
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(outDir, { recursive: true });
  const path = join(outDir, "IdentitySpec.json");
  await writeFile(path, `${JSON.stringify(spec, null, 2)}\n`, "utf8");
  return path;
}
