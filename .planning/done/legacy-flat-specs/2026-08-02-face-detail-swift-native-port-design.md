# Face-Detail Swift-Native Port — Design Spec

## Context

`run.py image workflow`'s 4-stage pipeline (`app/commands/image-workflow.py` →
`app/workflow.py`'s `WorkflowOrchestrator`) already has a genuinely portable
subset (stage 1 base-gen + stage 4 ESRGAN upscale) shipped natively as
`workflow_native.ts` / `swift/flux2-image-director`'s `upscale` command,
wired via `bridge.ts`'s style-forked `isNativeWorkflowRequest` (fires only
when the request needs none of face-detail/post-process/`seedvr2`; otherwise
falls back to `run.py image workflow`). Stage 2 (face-detailer,
`app/face_detailer.py`) was investigated and explicitly ruled out at the time
(`workflow_native.ts`'s own module doc, 2026-07-13/14): its detection half
(mediapipe `FaceDetector`) had no Swift/Vision-framework equivalent anywhere
in this repo, and building one was judged out of scope for an
orchestration-only session.

That has changed. Two Swift primitives shipped in the weeks since:

- `swift/ltx-video-director/Sources/LTXVideoDirector/LipsyncMetrics.swift`
  (2026-07-25) already does real Apple Vision-framework face detection —
  `VNDetectFaceLandmarksRequest` + `VNImageRequestHandler`, proven against
  real video frames.
- `swift/flux2-image-director/Sources/Flux2Director/Flux2Composite.swift`
  (Phase 4.2, for the `swap` command) already does feathered-mask
  alpha-blend compositing on `MLXArray` images — bounding-box detection from
  a mask, resize-to-fit, box-blur feathering, alpha blend. Exactly the
  paste-back mechanism `face_detailer.py`'s `detail_faces()` needs.

Combined with the low-denoise SDEdit-style I2I regeneration mechanism
already wired for `flux2 styletransfer`/`flux2 inpaint`
(`Flux2EditPipeline.generate(initImagePath:denoiseStrength:)`), every
primitive `face_detailer.py`'s algorithm needs now exists natively — this
port is CLI + orchestration wiring across three already-proven mechanisms,
not new model or new pixel-processing infrastructure.

## Scope

**In scope:**
- A new `flux2 face-detail` CLI command
  (`swift/flux2-image-director/Sources/Flux2DirectorCLI/FaceDetailCommand.swift`)
  implementing `face_detailer.py`'s algorithm 1:1: detect faces → expand
  bbox with padding → crop → low-denoise I2I regenerate the crop → feathered
  alpha-composite back onto the original.
- A new `FaceDetector` type
  (`swift/flux2-image-director/Sources/Flux2Director/FaceDetector.swift`)
  wrapping `VNDetectFaceRectanglesRequest` — bbox-only detection (no
  landmarks needed; `face_detailer.py` only ever uses bounding boxes).
- `workflow_native.ts`'s `isNativeWorkflowRequest` gate relaxed to allow a
  `face_detail: true` request through to the native path — chained as an
  extra step after base-gen, the same way ESRGAN upscale already chains
  after base-gen.
- Real, non-mocked test coverage: `FaceDetector` against a real image with a
  detectable face (or a fixture image confirmed to have one), and
  `FaceDetailCommand`'s end-to-end output (real face-crop regeneration +
  composite, not just "doesn't throw").

**Out of scope (deferred, documented, not silently dropped):**
- Stage 3 (post-processing: film grain/sharpen/LUT/skin-contrast) — still
  needs a genuinely new pixel-filter chain + image-codec dependency this
  package doesn't have; unrelated to this port's scope, unchanged from
  `workflow_native.ts`'s existing module doc.
- `--upscale-method seedvr2` — confirmed PyTorch/torch-MPS-only, no MLX/Swift
  path exists anywhere; unchanged.
- `mediapipe`'s TFLite confidence-score field — Vision's
  `VNFaceObservation.confidence` is a different model's calibration; this
  port exposes `--min-confidence` against Vision's own confidence score, not
  a numerically-identical port of mediapipe's threshold. Documented as a
  known behavioral delta, not a bug.
- LoRA support for the face-detail regeneration step (`face_detailer.py`'s
  `lora_path`/`lora_scale` params) — no caller in this repo's current
  workflow usage passes a face-detail LoRA; deferred until a real need
  appears (YAGNI), not silently unsupported forever — flagged in the CLI's
  `--help` and the module doc as a known gap.

## Design

### 1. `FaceDetector.swift` (new)

```swift
import Vision
import Foundation

public struct FaceBoundingBox {
    public let x1: Int, y1: Int, x2: Int, y2: Int
}

public enum FaceDetector {
    /// Detect face bounding boxes in an image file via Apple Vision
    /// (VNDetectFaceRectanglesRequest). Pixel-coordinate boxes, origin
    /// top-left (Vision's own boundingBox is normalized [0,1] with a
    /// BOTTOM-left origin — this function does the y-flip + denormalize).
    public static func detectFaces(
        at imageURL: URL, width: Int, height: Int, minConfidence: Float = 0.5
    ) throws -> [FaceBoundingBox] {
        let handler = VNImageRequestHandler(url: imageURL, options: [:])
        let request = VNDetectFaceRectanglesRequest()
        try handler.perform([request])
        let observations = (request.results ?? []).filter { $0.confidence >= minConfidence }
        return observations.map { obs in
            let bb = obs.boundingBox  // normalized, bottom-left origin
            let x1 = Int((bb.minX * CGFloat(width)).rounded(.down))
            let x2 = Int((bb.maxX * CGFloat(width)).rounded(.up))
            let yTop = 1.0 - bb.maxY  // flip to top-left origin
            let yBottom = 1.0 - bb.minY
            let y1 = Int((yTop * CGFloat(height)).rounded(.down))
            let y2 = Int((yBottom * CGFloat(height)).rounded(.up))
            return FaceBoundingBox(
                x1: max(0, x1), y1: max(0, y1),
                x2: min(width, x2), y2: min(height, y2))
        }
    }
}
```

`VNImageRequestHandler(url:)` reads the file directly — no need to first
load the image into an `MLXArray`/`CGImage` ourselves for detection (unlike
`LipsyncMetrics.swift`, which detects on already-decoded video frames and so
needs the `cgImage:` initializer instead).

### 2. `FaceDetailCommand.swift` (new)

CLI surface (mirrors `StyleTransferCommand`'s flag/model-loading shape):

```
flux2 face-detail --input <path> --output <path> --prompt <text>
  [--padding 1.8] [--feather 20] [--denoise-strength 0.15] [--steps 9]
  [--min-confidence 0.5] [--seed 42]
  [model-loading flags: --transformer/--vae/--encoder/--tokenizer-dir, same defaults as StyleTransfer]
```

Algorithm (per face, matching `face_detailer.py`'s `expand_bbox`/
`detail_faces` 1:1):
1. `FaceDetector.detectFaces(at: input, width:, height:, minConfidence:)`. Zero
   faces → copy input to output unchanged, exit 0 (matches Python's "no
   faces detected — skipping" — NOT an error).
2. For each box: expand by `padding` around its center, clamp to
   even-numbered dimensions (VAE constraint) and image bounds — direct port
   of `expand_bbox`.
3. Crop the ORIGINAL loaded `MLXArray` (`rgb[0..., 0..., y1..<y2, x1..<x2]`,
   same slicing style `Flux2Composite`/`CutoutCommand.trimToAlpha` already
   use) and write it to a temp PNG (`ImageSave.savePNG`) — `initImagePath`
   takes a `URL`, not an in-memory array.
4. Load the SAME `Flux2EditPipeline` used by `StyleTransferCommand` once
   (not per-face — matches Python's single-pipeline-instance reuse across
   all faces) and call `pipeline.generate(prompt:, imagePaths: [], seed:,
   height: cropH, width: cropW, steps:, guidance: 1.0, initImagePath:
   <tempCropURL>, denoiseStrength:)`.
5. Composite the regenerated crop back via
   `Flux2Composite.composite(source:, reference:, mask:, featherRadius:)` —
   the mask is a full-canvas array that's 1.0 inside the expanded box and
   0.0 elsewhere (built once per face, matching Python's per-face
   `create_feathered_mask` + `Image.paste(mask=...)`; `Flux2Composite`
   handles the feathering itself via `featherMask`, so no separate feather
   step is needed before calling it).
6. After all faces are processed, `ImageSave.savePNG` the final composited
   result to `--output`.

Temp crop PNGs are written under `NSTemporaryDirectory()` and removed via
`defer`, matching `CutoutCommand`'s temp-file discipline.

### 3. `workflow_native.ts` gate relaxation

`isNativeWorkflowRequest` currently returns `false` whenever
`options.face_detail` (or equivalent flag) is truthy. This changes to: allow
`face_detail` through (still refusing post-process knobs and
`upscale_method === "seedvr2"`, unchanged). `workflow_native.ts`'s
orchestration, after base-gen (and before/instead-of upscale — matching
Python's stage ORDER: base-gen → face-detail → post-process → upscale, so
face-detail chains between base-gen and upscale), spawns `flux2 face-detail`
on the base-gen output the same way it already spawns `flux2 upscale`.

### 4. Testing

- `FaceDetector`: a real Vision detection test against
  `scripts/fixtures/faces/real_face_portrait.png` (832×1024, git-tracked —
  a photorealistic AI-generated portrait reused from an earlier face-restore
  self-test, `video_generation__output/output_20260709_121649_facerestore.png`;
  corrected during planning after discovering the originally-cited SAM3
  fixture, `scripts/output_sam3_test/output_20260609_192145_womans_face_extracted.png`,
  is an anime/illustrated character — `VNDetectFaceRectanglesRequest` is
  trained on real human faces and correctly returns zero detections on it,
  confirmed via a standalone script bypassing all FaceDetector code) —
  assert at least one box returned, with plausible bounds (inside image
  dimensions, non-degenerate w/h).
- `FaceDetailCommand`: real end-to-end run — real model load, real
  detection, real regeneration, real composite — asserting the output PNG
  exists, has the same dimensions as the input, and differs from the input
  in the face region while remaining unchanged (or near-unchanged) outside
  it (a coarse pixel-diff check: mean abs diff inside the expanded bbox
  clearly higher than mean abs diff outside it — proves the composite
  actually localized the edit rather than regenerating/blending the whole
  frame).
- `workflow_native.ts`: `isNativeWorkflowRequest` unit tests for the
  relaxed gate (face_detail:true still native; post-process knobs / seedvr2
  still fall back), plus an orchestration test confirming the chained
  `flux2 face-detail` call happens after base-gen when requested.
