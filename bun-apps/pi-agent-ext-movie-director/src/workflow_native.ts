/**
 * workflow_native.ts — native Bun port of the PORTABLE SUBSET of
 * `run.py image workflow` (`app/commands/image-workflow.py` orchestrating
 * `app/workflow.py`'s `WorkflowOrchestrator`, 4 conceptual stages).
 *
 * Full investigation (2026-07-13/14, this session) of all 4 stages:
 *
 *   1. BASE GENERATION (`WorkflowOrchestrator._run_base_generation`,
 *      app/workflow.py:108-149) — plain `ZImagePipeline.generate()` (T2I or
 *      I2I depending on `input_image`), `upscale=False` forced (upscale is
 *      handled as its own stage 4). Zero extra logic. PORTABLE — this is
 *      exactly what `swift/krea2-image-director`'s native `t2i`/`i2i` already
 *      do (the `z_image` registry entry aliases krea2 for the zimage
 *      pipeline `run_workflow` hardcodes, app/commands/image-workflow.py:870).
 *
 *   2. FACE DETAILER (`app/face_detailer.py`, 246 lines) — `detect_faces()`
 *      (line 41) uses `mediapipe.tasks.python.vision.FaceDetector` (a
 *      TFLite-backed bbox detector, `blaze_face_short_range.tflite`) to find
 *      face boxes, then `detail_faces()` (line 138) crops+pads each box and
 *      re-denoises it via the SAME `ZImagePipeline.generate()` I2I path used
 *      by stage 1, feather-composited back with PIL `Image.paste(mask=...)`.
 *      NOW PORTABLE (2026-08-02): `swift/flux2-image-director`'s
 *      `FaceDetector.swift` (VNDetectFaceRectanglesRequest) replaces the
 *      mediapipe detection half, and `FaceDetailPipeline.swift` replicates
 *      the crop/regenerate/composite loop using the existing
 *      `Flux2EditPipeline` (SDEdit I2I) + `Flux2Composite` (feathered
 *      paste-back) primitives — see
 *      .planning/specs/2026-08-02-face-detail-swift-native-port-design.md.
 *      Exposed as `flux2 face-detail`, chained here between base-gen and
 *      upscale (see `runWorkflowNative`).
 *
 *   3. POST-PROCESSING (`app/postprocess.py`, 442 lines) — `FilmGrain`,
 *      `Sharpening` (CAS + unsharp), `NoiseCleaner` (cv2 bilateral),
 *      `LUTGrading` (.cube trilinear interpolation), `SkinContrast` (cv2
 *      HSV mask + CLAHE). Confirmed PURE numpy/PIL/cv2 pixel math — no model
 *      inference (module docstring line 3 says so and the code matches: no
 *      `import mlx`/torch/model anywhere in the file). Earlier (2026-07-13/
 *      14) this was judged NOT PORTABLE on the assumption that "pure pixel
 *      math" still needs a decoded RGB pixel buffer via an external
 *      image-codec dependency this package doesn't have. NOW PORTABLE
 *      (2026-08-03) for 4 of the 5 filters: that assumption was wrong for
 *      this specific pipeline — every filter here already operates on the
 *      SAME `(1,3,H,W)` float32 `[0,1]` `MLXArray` every other stage in this
 *      chain carries, no codec/decode step needed at all.
 *      `swift/flux2-image-director`'s `PostProcessFilters.swift`
 *      reimplements `FilmGrain`, `Sharpening` (CAS + unsharp),
 *      `NoiseCleaner` (windowed joint-bilateral filter replacing
 *      `cv2.bilateralFilter`), and `SkinContrast` (HSV skin mask + CLAHE via
 *      a D65 RGB↔LAB round-trip) as pure MLXArray algorithms — see
 *      `.planning/specs/2026-08-03-postprocess-swift-native-port-design.md`.
 *      Exposed as `flux2 postprocess`, chained here between face-detail and
 *      upscale (see `runWorkflowNative`). `LUTGrading` STAYS NOT PORTABLE:
 *      zero `.cube` assets exist anywhere in this repo and no caller has
 *      ever exercised the path — a theoretical GUI field
 *      (`bun-apps/gui-movie-director/schemas/workflow.ts`'s `lut`/
 *      `lut_strength`), not a real gap; deferred, not silently dropped (see
 *      `isNativeWorkflowRequest` in bridge.ts).
 *
 *   4. UPSCALE (`WorkflowOrchestrator._run_upscale`, app/workflow.py:192-224)
 *      — two methods: `upscale_method == "seedvr2"` uses
 *      `app.seedvr2.pipeline.SeedVR2Upscaler` (confirmed PyTorch/torch-MPS
 *      only — see memory project_pytorch_mps_versions/
 *      project_attention_backends_mps; NOT PORTABLE, no MLX/Swift port
 *      exists anywhere). Otherwise (`esrgan`, the default) it calls
 *      `ZImagePipeline.upscale_esrgan()` — and THIS already has a native
 *      Swift MLX replacement: `swift/flux2-image-director`'s `upscale`
 *      command (RealPLKSR/ESRGAN, `UpscaleCommand.swift`), already wired as
 *      the `upscale_flux2` registry entry for the standalone `enhancement`
 *      capability. PORTABLE for `esrgan` (the default); NOT PORTABLE for
 *      `seedvr2`.
 *
 * NET: the genuinely portable subset is base-generation (T2I/I2I, stage 1)
 * optionally chained with face-detail (stage 2), post-process filters minus
 * LUT (stage 3), and/or ESRGAN upscale (stage 4). LUT color-grading and
 * `--upscale-method seedvr2` are NOT silently dropped: `isNativeWorkflowRequest`
 * (bridge.ts) refuses the native path and falls back to run.py's `image
 * workflow` (realRunPyImage) whenever either is requested — the same
 * style-forked routing discipline `isNativeControlNetRequest` established
 * for `controlnet`.
 */
import { basename, dirname, extname, join } from "node:path";
import { runKrea2, type Krea2Details } from "@repo/pi-agent-ext-krea2";
import { runFlux2, type Flux2Details } from "@repo/pi-agent-ext-flux2";

export interface WorkflowNativeOptions {
  /** Text prompt (T2I) — required unless `input` is given (I2I). */
  prompt?: string;
  /** Source image — presence selects I2I over T2I (mirrors Python's `input_image`). */
  input?: string;
  width?: number;
  height?: number;
  steps?: number;
  seed?: number;
  loraPath?: string;
  loraScale?: number;
  /** I2I denoise strength (mirrors Python's `denoise_strength`, krea2's `strength`). */
  denoiseStrength?: number;
  /** Run stage 2 (face-detail: Apple Vision detect + SDEdit regenerate + composite) — see module doc. */
  faceDetail?: boolean;
  /** Run stage 3 (post-process: film grain / CAS+unsharp sharpening / bilateral noise-clean / CLAHE skin-contrast — see module doc; LUT stays non-portable). */
  postProcess?: PostProcessOptions;
  /** Run stage 4 (ESRGAN only — see module doc; `seedvr2` must never reach here). */
  upscale?: boolean;
  /** ESRGAN model name under models/upscale/ (flux2 `upscale --model`). */
  upscaleModel?: string;
  outputDir?: string;
  /** Test seam: inject a canned base-generation call (t2i/i2i). */
  _runBase?: BaseGenFn;
  /** Test seam: inject a canned face-detail call. */
  _runFaceDetail?: FaceDetailFn;
  /** Test seam: inject a canned post-process call. */
  _runPostProcess?: PostProcessFn;
  /** Test seam: inject a canned upscale call. */
  _runUpscale?: UpscaleFn;
}

export interface BaseGenResult {
  path: string;
  seed: number | null;
  width: number | null;
  height: number | null;
}
export type BaseGenFn = (opts: WorkflowNativeOptions) => Promise<BaseGenResult>;

export interface FaceDetailResult {
  path: string;
  width: number | null;
  height: number | null;
}
export type FaceDetailFn = (input: string, opts: WorkflowNativeOptions) => Promise<FaceDetailResult>;

export interface PostProcessOptions {
  filmGrain?: number;
  sharpening?: number;
  skinContrast?: boolean;
  noiseClean?: boolean;
}

export interface PostProcessResult {
  path: string;
  width: number | null;
  height: number | null;
}
export type PostProcessFn = (input: string, opts: WorkflowNativeOptions) => Promise<PostProcessResult>;

export interface UpscaleResult {
  path: string;
  width: number | null;
  height: number | null;
}
export type UpscaleFn = (input: string, opts: WorkflowNativeOptions) => Promise<UpscaleResult>;

/** Default base-gen call: krea2 native `t2i` (no `input`) or `i2i` (`input` set). Mirrors `run_workflow`'s hardcoded `pipeline="zimage"` (app/commands/image-workflow.py:870) — the zimage family is krea2's native turf (registry.ts's `z_image` entry). */
export const defaultRunBase: BaseGenFn = async (opts) => {
  const isI2I = opts.input != null && opts.input !== "";
  const out = await runKrea2({
    command: isI2I ? "i2i" : "t2i",
    options: isI2I
      ? {
          input: opts.input,
          prompt: opts.prompt,
          strength: opts.denoiseStrength,
          width: opts.width,
          height: opts.height,
          steps: opts.steps,
          seed: opts.seed,
        }
      : {
          prompt: opts.prompt,
          width: opts.width,
          height: opts.height,
          steps: opts.steps,
          seed: opts.seed,
        },
    outputDir: opts.outputDir,
  });
  const d: Krea2Details = out.details;
  if (!d.ok || !d.output) {
    throw new Error(`workflow: base generation (${isI2I ? "i2i" : "t2i"}) failed: ${out.summary}\n${out.stderrTail}`.trim());
  }
  return { path: d.output, seed: d.seed, width: d.width, height: d.height };
};

/** Default face-detail call: flux2 native `face-detail` (Apple Vision detection + SDEdit regenerate + feathered composite). Reuses the SAME `prompt` as base-gen — face_detailer.py's own `detail_faces()` takes the workflow's single prompt, not a separate one. */
export const defaultRunFaceDetail: FaceDetailFn = async (input, opts) => {
  const out = await runFlux2({
    command: "face-detail",
    options: { input, prompt: opts.prompt, seed: opts.seed },
    outputDir: opts.outputDir,
  });
  const d: Flux2Details = out.details;
  if (!d.ok || !d.output) {
    throw new Error(`workflow: face-detail failed: ${out.summary}\n${out.stderrTail}`.trim());
  }
  return { path: d.output, width: d.width, height: d.height };
};

/** Build the postprocess output path for a source image (mirrors `character_native.ts`'s `cutoutPathFor` — `flux2 postprocess`, like `flux2 cutout`, has a plain required `--output` with no `--output-dir`/auto-naming, so the caller must construct the path itself). */
export function postProcessPathFor(imagePath: string): string {
  const dir = dirname(imagePath);
  const stem = basename(imagePath, extname(imagePath));
  return join(dir, `${stem}_postprocess.png`);
}

/**
 * Default post-process call: flux2 native `postprocess` (film grain / CAS+unsharp
 * sharpening / bilateral noise-clean / CLAHE skin-contrast).
 *
 * Unlike `defaultRunFaceDetail`/`defaultRunUpscale`, this does NOT trust
 * `d.output` — `flux2 postprocess`'s only path-bearing stdout line is
 * "✅ postprocess saved: <path>" (matches `cutout`'s stdout shape, not
 * `face-detail`'s standalone-path-line convention), so
 * `parseOutputPathFromStdout` (pi-agent-ext-flux2/src/result.ts) can never
 * match it and `d.output` is always null here — the SAME reason
 * `character_native.ts`'s `defaultCutout` uses its own known `outputPath`
 * instead of `d.output`. `d.ok` (exit code) is still the right success check.
 */
export const defaultRunPostProcess: PostProcessFn = async (input, opts) => {
  const pp = opts.postProcess ?? {};
  const outputPath = postProcessPathFor(input);
  const out = await runFlux2({
    command: "postprocess",
    options: {
      input,
      output: outputPath,
      filmGrain: pp.filmGrain,
      sharpening: pp.sharpening,
      skinContrast: pp.skinContrast,
      noiseClean: pp.noiseClean,
      seed: opts.seed,
    },
    outputDir: opts.outputDir,
  });
  const d: Flux2Details = out.details;
  if (!d.ok) {
    throw new Error(`workflow: postprocess failed: ${out.summary}\n${out.stderrTail}`.trim());
  }
  return { path: outputPath, width: d.width, height: d.height };
};

/** Default upscale call: flux2 native `upscale` (RealPLKSR/ESRGAN). Only ever called for the esrgan path — see module doc; the caller (`runWorkflowNative`) never routes seedvr2 requests here (that request never reaches the native path at all, gated by `isNativeWorkflowRequest`). */
export const defaultRunUpscale: UpscaleFn = async (input, opts) => {
  const out = await runFlux2({
    command: "upscale",
    options: { input, model: opts.upscaleModel },
    outputDir: opts.outputDir,
  });
  const d: Flux2Details = out.details;
  if (!d.ok || !d.output) {
    throw new Error(`workflow: upscale failed: ${out.summary}\n${out.stderrTail}`.trim());
  }
  return { path: d.output, width: d.width, height: d.height };
};

export interface WorkflowNativeResult {
  /** The last-produced image path (post-upscale if it ran, else post-face-detail if it ran, else base). */
  finalImage: string;
  baseImage: string;
  faceDetailImage: string | null;
  postProcessImage: string | null;
  upscaledImage: string | null;
  seed: number | null;
  width: number | null;
  height: number | null;
  /** Stages that actually ran, in order — mirrors Python's `stage_images.keys()` (a subset of base/face_detail/postprocess/upscale). */
  stages: ("base" | "face_detail" | "postprocess" | "upscale")[];
}

/**
 * Run the portable workflow subset: base generation (T2I/I2I) optionally
 * chained with face-detail and/or ESRGAN upscale, in that order. Throws if
 * neither `prompt` nor `input` is given (mirrors Python's
 * `ValueError("No prompt provided...")`,
 * app/workflow.py:53) or if a stage's director call fails (no
 * partial-success mode, mirroring the Python's `sys.exit(1)` on an
 * unhandled workflow exception).
 */
export async function runWorkflowNative(opts: WorkflowNativeOptions): Promise<WorkflowNativeResult> {
  if (!opts.prompt && !opts.input) {
    throw new Error("workflow: no prompt provided. Set --prompt or --input (I2I).");
  }

  const runBase = opts._runBase ?? defaultRunBase;
  const base = await runBase(opts);

  const stages: ("base" | "face_detail" | "postprocess" | "upscale")[] = ["base"];
  let finalImage = base.path;
  let faceDetailImage: string | null = null;
  let postProcessImage: string | null = null;
  let upscaledImage: string | null = null;
  let width = base.width;
  let height = base.height;

  if (opts.faceDetail) {
    const runFaceDetail = opts._runFaceDetail ?? defaultRunFaceDetail;
    const fd = await runFaceDetail(finalImage, opts);
    finalImage = fd.path;
    faceDetailImage = fd.path;
    stages.push("face_detail");
    width = fd.width ?? width;
    height = fd.height ?? height;
  }

  if (opts.postProcess) {
    const runPostProcess = opts._runPostProcess ?? defaultRunPostProcess;
    const pp = await runPostProcess(finalImage, opts);
    finalImage = pp.path;
    postProcessImage = pp.path;
    stages.push("postprocess");
    width = pp.width ?? width;
    height = pp.height ?? height;
  }

  if (opts.upscale) {
    const runUpscale = opts._runUpscale ?? defaultRunUpscale;
    const up = await runUpscale(finalImage, opts);
    finalImage = up.path;
    upscaledImage = up.path;
    stages.push("upscale");
    width = up.width ?? width;
    height = up.height ?? height;
  }

  return {
    finalImage,
    baseImage: base.path,
    faceDetailImage,
    postProcessImage,
    upscaledImage,
    seed: base.seed,
    width,
    height,
    stages,
  };
}
