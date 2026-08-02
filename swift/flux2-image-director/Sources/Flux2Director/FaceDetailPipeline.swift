//
//  FaceDetailPipeline.swift
//  Flux2Director
//
//  Per-face crop → low-denoise SDEdit regenerate → feathered composite
//  loop. Direct port of face_detailer.py's `detail_faces()` (minus
//  detection, which FaceDetector.swift owns, and minus LoRA support —
//  deferred, see design spec's Scope section). Takes an ALREADY-LOADED
//  Flux2EditPipeline so callers (FaceDetailCommand) control model
//  lifetime and this stays independently testable without ArgumentParser
//  or a running CLI process.
//

import CommonImageDirector
import Foundation
import MLX

public enum FaceDetailPipeline {
    /// `faces` are RAW (un-expanded) detection boxes from
    /// `FaceDetector.detectFaces`. Returns `image` unchanged if `faces` is
    /// empty (mirrors Python's "no faces detected — skipping", not an
    /// error) — `pipeline` is optional and never touched on that path, so
    /// callers with zero detected faces don't need a loaded model at all.
    /// Processes faces sequentially, each composited onto the accumulating
    /// `result` before the next face is cropped from the ORIGINAL `image`
    /// (matches Python's `image.crop(...)` reading from the untouched
    /// source while `result.paste(...)` accumulates).
    public static func detailFaces(
        image: MLXArray, faces: [FaceBoundingBox], prompt: String,
        pipeline: Flux2EditPipeline?, seed: UInt64, steps: Int,
        denoiseStrength: Float, padding: Float, feather: Int
    ) throws -> MLXArray {
        guard !faces.isEmpty, let pipeline else { return image }

        let h = image.dim(2), w = image.dim(3)
        var result = image

        for (idx, face) in faces.enumerated() {
            let expanded = FaceDetector.expandBBox(face, padding: padding, imgW: w, imgH: h)
            let cropW = expanded.x2 - expanded.x1
            let cropH = expanded.y2 - expanded.y1
            guard cropW > 0, cropH > 0 else { continue }
            print("  [face-detail] face \(idx + 1)/\(faces.count): (\(expanded.x1),\(expanded.y1))-(\(expanded.x2),\(expanded.y2)) [\(cropW)x\(cropH)]")

            let crop = image[0..., 0..., expanded.y1..<expanded.y2, expanded.x1..<expanded.x2]
            let tempCrop = URL(fileURLWithPath: NSTemporaryDirectory())
                .appendingPathComponent("flux2-face-detail-\(UUID().uuidString).png")
            defer { try? FileManager.default.removeItem(at: tempCrop) }
            try ImageSave.savePNG(crop, to: tempCrop)

            let (detailedCrop, _) = pipeline.generate(
                prompt: prompt, imagePaths: [], seed: seed,
                height: cropH, width: cropW, steps: steps, guidance: 1.0,
                initImagePath: tempCrop, denoiseStrength: denoiseStrength)

            // Full-canvas mask: 1.0 inside the expanded box, 0.0 elsewhere.
            // Flux2Composite resizes `reference` to fit the mask's bbox
            // (here a no-op — detailedCrop is already cropW×cropH) and
            // handles feathering itself.
            var mask = MLX.zeros([1, 1, h, w])
            mask[0..., 0..., expanded.y1..<expanded.y2, expanded.x1..<expanded.x2] =
                MLX.ones([1, 1, cropH, cropW])

            result = Flux2Composite.composite(
                source: result, reference: detailedCrop, mask: mask, featherRadius: feather)
        }

        return result
    }
}
