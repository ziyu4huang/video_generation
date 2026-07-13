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
 *      So the RE-DENOISE half is portable (same native I2I as base-gen), but
 *      the DETECTION half is not: no mediapipe/Vision-framework-backed face
 *      detector exists anywhere in swift/ (grepped for face/detail/landmark
 *      across all 6 swift packages — zero hits outside unrelated Whisper/
 *      ModelRegistry/Verify files). Apple's Vision framework COULD replace
 *      mediapipe (VNDetectFaceRectanglesRequest), but that is a genuinely NEW
 *      native port (a face-detection primitive this repo has never shipped),
 *      not orchestration of an already-native primitive — out of scope here.
 *      NOT PORTABLE in this session's orchestration-only scope.
 *
 *   3. POST-PROCESSING (`app/postprocess.py`, 442 lines) — `FilmGrain`,
 *      `Sharpening` (CAS + unsharp), `NoiseCleaner` (cv2 bilateral),
 *      `LUTGrading` (.cube trilinear interpolation), `SkinContrast` (cv2
 *      HSV mask + CLAHE). Confirmed PURE numpy/PIL/cv2 pixel math — no model
 *      inference (module docstring line 3 says so and the code matches: no
 *      `import mlx`/torch/model anywhere in the file). But "pure pixel math"
 *      does NOT mean "portable to Bun for free": every filter needs a decoded
 *      RGB pixel buffer, and this package has NO image-codec dependency
 *      (confirmed absent from package.json; the exact same gap
 *      profile_native.ts/character_native.ts/twosubject_native.ts already
 *      document for their own deferred alpha-compositing/pixel-tiebreak
 *      features). No Swift-native equivalent exists either (grepped
 *      grain/sharpen/LUT/clahe/skin-contrast across swift/ — zero real hits).
 *      Implementing this would mean building a NEW native filter chain (Bun
 *      + a codec lib, or a new Swift command), not calling an already-native
 *      primitive — out of scope here, same reasoning as stage 2.
 *      NOT PORTABLE in this session's orchestration-only scope.
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
 * chained with ESRGAN upscale (stage 4) — exactly the two stages that were
 * ALREADY independently native before this module existed. Face-detail
 * (stage 2) and post-processing (stage 3), plus `--upscale-method seedvr2`,
 * are NOT silently dropped: `isNativeWorkflowRequest` (bridge.ts) refuses the
 * native path and falls back to run.py's `image workflow` (realRunPyImage)
 * whenever any of those is requested — the same style-forked routing
 * discipline `isNativeControlNetRequest` established for `controlnet`.
 */
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
  /** Run stage 4 (ESRGAN only — see module doc; `seedvr2` must never reach here). */
  upscale?: boolean;
  /** ESRGAN model name under models/upscale/ (flux2 `upscale --model`). */
  upscaleModel?: string;
  outputDir?: string;
  /** Test seam: inject a canned base-generation call (t2i/i2i). */
  _runBase?: BaseGenFn;
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
  /** The last-produced image path (upscaled if stage 4 ran, else base). */
  finalImage: string;
  baseImage: string;
  upscaledImage: string | null;
  seed: number | null;
  width: number | null;
  height: number | null;
  /** Stages that actually ran, in order — mirrors Python's `stage_images.keys()` (a subset of base/face_detail/postprocess/upscale; this port only ever produces base and/or upscale). */
  stages: ("base" | "upscale")[];
}

/**
 * Run the portable workflow subset: base generation (T2I/I2I) optionally
 * chained with ESRGAN upscale. Throws if neither `prompt` nor `input` is
 * given (mirrors Python's `ValueError("No prompt provided...")`,
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

  const stages: ("base" | "upscale")[] = ["base"];
  let finalImage = base.path;
  let upscaledImage: string | null = null;
  let width = base.width;
  let height = base.height;

  if (opts.upscale) {
    const runUpscale = opts._runUpscale ?? defaultRunUpscale;
    const up = await runUpscale(base.path, opts);
    finalImage = up.path;
    upscaledImage = up.path;
    stages.push("upscale");
    width = up.width ?? width;
    height = up.height ?? height;
  }

  return {
    finalImage,
    baseImage: base.path,
    upscaledImage,
    seed: base.seed,
    width,
    height,
    stages,
  };
}
