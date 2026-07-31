/**
 * character_native.ts — native Bun port of `run.py image character`'s
 * orchestration (`app/commands/image-character.py`, 324 lines).
 *
 * image-character.py's own header/comments say it plainly: this command is
 * "PURE ORCHESTRATION" composing two already-certified primitives —
 *   1. `image profile` multi-view (front/side/back) generation, and
 *   2. Step-1 `cutout` (SAM3 segment → feather → alpha PNG) per view,
 * then writes a persistent `IdentitySpec.json` (schema `character-lock.v1`)
 * so a later `image storyboard --character <hero>` can reuse the same
 * identity. Zero new MLX/generation code — this module mirrors that shape in
 * Bun: it calls `runProfileNative` (already ported, profile_native.ts) for
 * Phase 1, then flux2's native `segment` command (Swift-native SAM3.1 bridge,
 * `swift/flux2-image-director/Sources/Flux2DirectorCLI/SegmentCommand.swift`)
 * per view for Phase 2, then assembles + writes the IdentitySpec.json.
 *
 * PHASE 2 SCOPE NOTE (a real, documented delta from the Python — read this
 * before trusting `views[].cutout`):
 *
 *   Python's `_cutout_view` produces a TRANSPARENT RGBA PNG: SAM3 segments →
 *   `feather_mask` → `alpha_cutout(source, alpha)` composites the feathered
 *   mask as source's alpha CHANNEL (PIL-backed pixel compositing). Swift's
 *   native `segment` command (flux2 CommandSpec `segment`, backed by
 *   `sam3_segment_bridge.py`) does the SAME SAM3.1 segmentation + feathering,
 *   but stops one step short: it writes a standalone MASK PNG (white=object,
 *   feathered edges, grayscale/L-mode) — it does NOT composite that mask onto
 *   the source image's alpha channel. That compositing step needs a real
 *   image-codec/pixel-buffer library (PIL in Python); this Bun package has
 *   none (the same gap profile_native.ts's module doc notes for the deferred
 *   HTML-viewer/strip-PNG features, and twosubject_native.ts's module doc
 *   notes for its dropped bg_edge_split tiebreak). So v1 produces the
 *   intermediate MASK PNG, not the final RGBA cutout PNG.
 *
 *   To keep `IdentitySpec.json` truthful rather than silently mislabeling a
 *   mask as a "transparent cutout", each `views[]` entry's `cutout` field is
 *   `null` when no true alpha-composited cutout exists (always, in v1) and
 *   the produced mask path instead rides under an EXTENSION field, `mask`
 *   (extra fields don't break the character-lock.v1 schema — the Python's own
 *   `views` field is itself already documented as "extension"). A future v2
 *   could either (a) add a tiny native Swift "apply-mask-as-alpha" command, or
 *   (b) shell out to the same Python `alpha_cutout`/`_fill_holes` primitives
 *   image-character.py already calls, mirroring how `segment` itself bridges
 *   through Python for SAM3.1. Neither is implemented here — v1 prioritizes a
 *   solid, tested Phase 1 + Phase 3 (IdentitySpec) path, same as
 *   profile_native.ts's own stated v1 priority.
 *
 * Other DEFERRED items (documented, not silently dropped):
 *   - `_fill_holes` (interior-hole filling before feathering) — Python always
 *     applies this for character sheets ("A character turnaround silhouette
 *     MUST be solid"); the native `segment` command has no such option and,
 *     per the note above, does no compositing at all yet, so hole-filling is
 *     moot until compositing exists.
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
import { readFile } from "node:fs/promises";
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

// ── Phase 2: per-view segmentation (the "cutout" step) ─────────────────────

export interface SegmentParams {
  image: string;
  prompt: string;
  threshold: number;
  outputDir?: string;
}
export interface SegmentResult {
  /** Mask PNG path (null if the flux2 invocation itself failed to run). */
  maskPath: string | null;
  /** Detection count read from the sidecar `<mask>.json` (0 = no detection, mirrors Python's `len(result.scores) == 0` check). */
  count: number;
  bestScore: number | null;
}
export type SegmentFn = (params: SegmentParams) => Promise<SegmentResult>;

/** Build the cutout output path for one view image (mirrors Python's `{stem}_cutout.png` naming — see module doc). */
export function cutoutPathFor(imagePath: string): string {
  const dir = dirname(imagePath);
  const stem = basename(imagePath, extname(imagePath));
  return join(dir, `${stem}_cutout.png`);
}

/** Default segment call: native flux2 `segment` command (SAM3.1 bridge). */
export const defaultSegment: SegmentFn = async (p) => {
  const out = await runFlux2({
    command: "segment",
    options: {
      image: p.image,
      prompt: p.prompt,
      threshold: p.threshold,
      output: cutoutPathFor(p.image),
    },
    outputDir: p.outputDir,
  });
  const maskPath = cutoutPathFor(p.image);
  if (!out.details.ok) {
    return { maskPath: null, count: 0, bestScore: null };
  }
  // Read the sidecar JSON the SAM3 bridge writes (`<mask>.json`, {count,
  // best_score,...}) to detect "no detections" the same way Python's
  // `len(result.scores) == 0` check does. Missing/unparsable sidecar is
  // treated as "no detection" (fail closed, mirrors returning None,None).
  try {
    const raw = await readFile(`${maskPath}.json`, "utf8");
    const meta = JSON.parse(raw) as { count?: number; best_score?: number };
    const count = meta.count ?? 0;
    if (count === 0) return { maskPath: null, count: 0, bestScore: null };
    return { maskPath, count, bestScore: meta.best_score ?? null };
  } catch {
    return { maskPath: null, count: 0, bestScore: null };
  }
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
  /** Transparent alpha-composited cutout. Always null in v1 — see module doc. */
  cutout: string | null;
  /** EXTENSION field (not in the Python schema): the intermediate SAM3 mask PNG, when produced. */
  mask?: string | null;
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
  /** Test seam: inject a canned segment call so unit tests don't need flux2's `segment`. */
  _segmentImpl?: SegmentFn;
}

export interface CharacterResult {
  identitySpecPath: string | null;
  identitySpec: IdentitySpec;
  outDir: string;
  cutouts: number;
}

/**
 * Run the character-sheet build: Phase 1 (multi-view profile via
 * `runProfileNative`) → Phase 2 (per-view SAM3 segment mask) → Phase 3
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
  const segmentFn = opts._segmentImpl ?? defaultSegment;

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

  // Phase 2: per-view SAM3 mask (the intermediate step for the deferred
  // full alpha-cutout — see module doc).
  const subject = opts.cutoutSubject ?? DEFAULT_CUTOUT_SUBJECT;
  const threshold = opts.samThreshold ?? DEFAULT_SAM_THRESHOLD;

  const viewsMeta: ViewMeta[] = [];
  let cutoutCount = 0;
  for (const vo of viewOutputs) {
    const entry: ViewMeta = { view: vo.view, image: vo.path, cutout: null };
    if (vo.path) {
      const seg = await segmentFn({ image: vo.path, prompt: subject, threshold, outputDir: opts.outputDir });
      if (seg.maskPath) {
        entry.mask = seg.maskPath;
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
