import XCTest
import MLX
@testable import LTXVideoDirector

/// Real-checkpoint integration tests for multi-anchor I2V conditioning —
/// pinning a standalone image at an arbitrary latent frame index (see
/// NativeI2VStage.Request.anchorImages's header). Temporal-keyframing
/// generalization of NativeI2VStageFFLFTests' single last-frame case;
/// reuses the same tiny/fast config to keep this quick while still
/// exercising the real 48-block transformer.
final class NativeI2VStageAnchorImageTests: XCTestCase {
    private func checkpointsAvailable() -> Bool {
        let fm = FileManager.default
        let transformerURL = RepoPaths.mlxModelsRoot.appendingPathComponent("transformer/ltx-2.3-distilled-q8/transformer-distilled-1.1.safetensors")
        let vaeEncoderURL = RepoPaths.mlxModelsRoot.appendingPathComponent("vae/ltx-2.3-vae/vae_encoder.safetensors")
        return fm.fileExists(atPath: transformerURL.path) && fm.fileExists(atPath: vaeEncoderURL.path)
    }

    private func makeSolidPNG(width: Int, height: Int, gray: UInt8, to url: URL) {
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        let bitmapInfo = CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue)
        let ctx = CGContext(
            data: nil, width: width, height: height, bitsPerComponent: 8,
            bytesPerRow: width * 4, space: colorSpace, bitmapInfo: bitmapInfo)!
        let g = Double(gray) / 255.0
        ctx.setFillColor(CGColor(red: g, green: g, blue: g, alpha: 1.0))
        ctx.fill(CGRect(x: 0, y: 0, width: CGFloat(width), height: CGFloat(height)))
        let image = ctx.makeImage()!
        FrameLoad.savePNG(image, to: url)
    }

    /// Only frame 0 and the LAST latent frame have a verified 1:1 mapping to
    /// the first/last decoded PNG (see NativeI2VStageFFLFTests/
    /// NativeI2VStageGridGuideTests — a causal VAE's temporal upsampling
    /// does not map interior latent indices to output frames 1:1), so this
    /// pins the anchor at the last latent frame to get a verifiable
    /// boundary-decode assertion, distinct from frame 0's own T2I content.
    func testAnchorImageIsPreservedAtItsPinnedFrameIndex() throws {
        guard checkpointsAvailable() else {
            throw XCTSkip("real checkpoints not found — skipping multi-anchor integration test")
        }
        let resolved = ResolutionResolver.optimize(width: 320, height: 320)
        let seconds = 17.0 / 24.0
        let fps = 24.0

        let (fLat, _, _) = VideoLatentShape.compute(
            numFrames: NativeI2VStage.Request(prompt: "", seconds: seconds, fps: fps, width: resolved.width, height: resolved.height).frames,
            height: resolved.height, width: resolved.width)
        XCTAssertGreaterThanOrEqual(fLat, 2, "test needs at least 2 latent frames to exercise a non-trivial anchor")

        let outputDir = FileManager.default.temporaryDirectory.appendingPathComponent("native_i2v_anchor_\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: outputDir) }
        try FileManager.default.createDirectory(at: outputDir, withIntermediateDirectories: true)

        let anchorURL = outputDir.appendingPathComponent("anchor_input.png")
        makeSolidPNG(width: resolved.width, height: resolved.height, gray: 200, to: anchorURL)

        var request = NativeI2VStage.Request(
            prompt: "a woman smiles at the camera", seconds: seconds, fps: fps,
            width: resolved.width, height: resolved.height, textMaxLength: 8)
        request.anchorImages = [(path: anchorURL, frameIndex: fLat - 1, strength: 1.0)]

        let result = try NativeI2VStage().generate(request, outputDir: outputDir)
        XCTAssertGreaterThan(result.frameCount, 1, "multi-anchor needs at least 2 output frames")

        let frameFiles = (try FileManager.default.contentsOfDirectory(atPath: result.frameDirectory.path)).sorted()
        let lastDecodedURL = result.frameDirectory.appendingPathComponent(frameFiles.last!)
        let lastDecodedArr = FrameLoad.toArray(FrameLoad.loadCGImage(from: lastDecodedURL)!)
        let targetGray = MLXArray(Float(200) / 255.0)
        let diff = MLX.mean(MLX.abs(lastDecodedArr - targetGray)).item(Float.self)
        // 0.08, not GridGuideTests' 0.04 — this anchor's higher brightness
        // (200/255 vs. that test's 40-160/255 grays) sits closer to the VAE
        // decode's reconstruction-error ceiling; observed diff 0.0575 on a
        // real-checkpoint run, comfortably inside 0.08 while still tight
        // enough to catch "anchor not applied at all" (which would show the
        // T2I-generated frame-0 content instead, a much larger diff).
        XCTAssertLessThan(diff, 0.08, "decoded last frame should match the pinned anchor image (mean abs diff \(diff))")
    }

    func testAnchorImageOutOfRangeFrameIndexThrowsClearError() throws {
        let resolved = ResolutionResolver.optimize(width: 320, height: 320)
        let outputDir = FileManager.default.temporaryDirectory.appendingPathComponent("native_i2v_anchor_oob_\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: outputDir) }
        try FileManager.default.createDirectory(at: outputDir, withIntermediateDirectories: true)

        let anchorURL = outputDir.appendingPathComponent("anchor_input.png")
        makeSolidPNG(width: resolved.width, height: resolved.height, gray: 200, to: anchorURL)

        var request = NativeI2VStage.Request(
            prompt: "a woman smiles at the camera", seconds: 9.0 / 24.0,
            width: resolved.width, height: resolved.height, textMaxLength: 8)
        request.fps = 24.0
        // Deliberately absurd: no clip has 999 latent frames at this duration.
        request.anchorImages = [(path: anchorURL, frameIndex: 999, strength: 1.0)]

        XCTAssertThrowsError(try NativeI2VStage().generate(request, outputDir: outputDir)) { error in
            guard let stageError = error as? NativeI2VStage.StageError else {
                XCTFail("expected StageError, got \(error)"); return
            }
            if case .anchorConfigMismatch = stageError {} else {
                XCTFail("expected .anchorConfigMismatch, got \(stageError)")
            }
        }
    }

    func testAnchorImageWrongSizeThrowsClearError() throws {
        let resolved = ResolutionResolver.optimize(width: 320, height: 320)
        let outputDir = FileManager.default.temporaryDirectory.appendingPathComponent("native_i2v_anchor_size_\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: outputDir) }
        try FileManager.default.createDirectory(at: outputDir, withIntermediateDirectories: true)

        let anchorURL = outputDir.appendingPathComponent("anchor_input.png")
        makeSolidPNG(width: resolved.width / 2, height: resolved.height / 2, gray: 200, to: anchorURL)

        var request = NativeI2VStage.Request(
            prompt: "a woman smiles at the camera", seconds: 9.0 / 24.0,
            width: resolved.width, height: resolved.height, textMaxLength: 8)
        request.fps = 24.0
        request.anchorImages = [(path: anchorURL, frameIndex: 0, strength: 1.0)]

        XCTAssertThrowsError(try NativeI2VStage().generate(request, outputDir: outputDir)) { error in
            guard let stageError = error as? NativeI2VStage.StageError else {
                XCTFail("expected StageError, got \(error)"); return
            }
            if case .anchorImageWrongSize = stageError {} else {
                XCTFail("expected .anchorImageWrongSize, got \(stageError)")
            }
        }
    }
}
