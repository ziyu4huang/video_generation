//
//  FaceDetector.swift
//  Flux2Director
//
//  Native (Vision framework) face bounding-box detection — replaces
//  face_detailer.py's mediapipe `vision.FaceDetector` (blaze_face_short_range
//  TFLite model). VNDetectFaceRectanglesRequest gives bbox-only detection
//  (no landmarks needed; face_detailer.py only ever uses bounding boxes).
//  Vision's confidence calibration differs from mediapipe's — this is a
//  fresh implementation of the same CONCEPT, not a numeric port, matching
//  the precedent set by LipsyncMetrics.swift's VNDetectFaceLandmarksRequest
//  port of lipsync_metrics.py. See
//  docs/superpowers/specs/2026-08-02-face-detail-swift-native-port-design.md.
//

import Vision
import Foundation

/// Axis-aligned bounding box in pixel coordinates, origin top-left.
public struct FaceBoundingBox: Equatable {
    public let x1: Int, y1: Int, x2: Int, y2: Int

    public init(x1: Int, y1: Int, x2: Int, y2: Int) {
        self.x1 = x1; self.y1 = y1; self.x2 = x2; self.y2 = y2
    }
}

public enum FaceDetector {
    /// Detect face bounding boxes in an image file via Apple Vision
    /// (VNDetectFaceRectanglesRequest). Pixel-coordinate boxes, origin
    /// top-left (Vision's own boundingBox is normalized [0,1] with a
    /// BOTTOM-left origin — this function does the y-flip + denormalize).
    /// `VNImageRequestHandler(url:)` reads the file directly — no need to
    /// first decode into an MLXArray/CGImage ourselves (unlike
    /// LipsyncMetrics.swift, which detects on already-decoded video frames
    /// and so needs the `cgImage:` initializer instead).
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

    /// Expand a bounding box by `padding` around its center, clamped to even
    /// dimensions (VAE constraint — same `& ~1` truncation as Python's
    /// `int(w) & ~1`) and image bounds. Direct port of face_detailer.py's
    /// `expand_bbox`. Pure function — no I/O, no MLX — independently
    /// testable, and reused by both FaceDetailCommand (crop sizing) and
    /// FaceDetailPipeline (the same expansion, so both agree exactly).
    public static func expandBBox(_ box: FaceBoundingBox, padding: Float, imgW: Int, imgH: Int) -> FaceBoundingBox {
        let cx = Float(box.x1 + box.x2) / 2
        let cy = Float(box.y1 + box.y2) / 2
        let wi = Int(Float(box.x2 - box.x1) * padding) & ~1
        let hi = Int(Float(box.y2 - box.y1) * padding) & ~1
        let x1 = max(0, Int(cx - Float(wi) / 2))
        let y1 = max(0, Int(cy - Float(hi) / 2))
        let x2 = min(imgW, Int(cx + Float(wi) / 2))
        let y2 = min(imgH, Int(cy + Float(hi) / 2))
        return FaceBoundingBox(x1: x1, y1: y1, x2: x2, y2: y2)
    }
}
