import XCTest
import MLX
@testable import LTXVideoDirector

/// Real-checkpoint integration tests for First-Last-Frame (FFLF)
/// conditioning — see NativeI2VStage.Request.lastFrameImagePath's header
/// and docs/reference/comfyui_workflows/README.md for where this is ported
/// from. Reuses the same tiny/fast config as
/// NativeI2VStageRealCheckpointTests (textMaxLength=8, minimal frame count)
/// to keep this quick while still exercising the real 48-block transformer.
final class NativeI2VStageFFLFTests: XCTestCase {
    private func checkpointsAvailable() -> Bool {
        let fm = FileManager.default
        let transformerURL = RepoPaths.mlxModelsRoot.appendingPathComponent("transformer/ltx-2.3-distilled-q8/transformer-distilled-1.1.safetensors")
        let vaeEncoderURL = RepoPaths.mlxModelsRoot.appendingPathComponent("vae/ltx-2.3-vae/vae_encoder.safetensors")
        return fm.fileExists(atPath: transformerURL.path) && fm.fileExists(atPath: vaeEncoderURL.path)
    }

    /// A flat mid-grey PNG at exactly `width`x`height` — deliberately
    /// featureless so a pixel-diff against the decoded last frame is a
    /// clean signal (no risk of the T2I-generated frame 0 "coincidentally"
    /// resembling a photographic last-frame image).
    private func makeSolidColorPNG(width: Int, height: Int, gray: UInt8, to url: URL) {
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        let bitmapInfo = CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue)
        let ctx = CGContext(
            data: nil, width: width, height: height, bitsPerComponent: 8,
            bytesPerRow: width * 4, space: colorSpace, bitmapInfo: bitmapInfo)!
        ctx.setFillColor(CGColor(red: Double(gray) / 255.0, green: Double(gray) / 255.0, blue: Double(gray) / 255.0, alpha: 1.0))
        ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
        let image = ctx.makeImage()!
        FrameLoad.savePNG(image, to: url)
    }

    func testLastFrameImageIsPreservedThroughGeneration() throws {
        guard checkpointsAvailable() else {
            throw XCTSkip("real checkpoints not found — skipping FFLF integration test")
        }

        // Resolve the actual generation size ourselves (ResolutionResolver
        // scales small requests up to the validated area) so the synthetic
        // last-frame image is created at the EXACT size generate() expects.
        let resolved = ResolutionResolver.optimize(width: 320, height: 320)

        let outputDir = FileManager.default.temporaryDirectory.appendingPathComponent("native_i2v_fflf_\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: outputDir) }
        try FileManager.default.createDirectory(at: outputDir, withIntermediateDirectories: true)

        let lastFrameURL = outputDir.appendingPathComponent("last_frame_input.png")
        makeSolidColorPNG(width: resolved.width, height: resolved.height, gray: 40, to: lastFrameURL)

        var request = NativeI2VStage.Request(
            prompt: "a woman smiles at the camera", seconds: 17.0 / 24.0,
            width: resolved.width, height: resolved.height, textMaxLength: 8)
        request.fps = 24.0
        request.lastFrameImagePath = lastFrameURL

        let result = try NativeI2VStage().generate(request, outputDir: outputDir)
        XCTAssertGreaterThan(result.frameCount, 1, "FFLF needs at least 2 output frames")

        let frameFiles = (try FileManager.default.contentsOfDirectory(atPath: result.frameDirectory.path)).sorted()
        let lastDecodedURL = result.frameDirectory.appendingPathComponent(frameFiles.last!)
        guard let lastDecodedImage = FrameLoad.loadCGImage(from: lastDecodedURL) else {
            return XCTFail("could not load decoded last frame at \(lastDecodedURL.path)")
        }
        let decodedArr = FrameLoad.toArray(lastDecodedImage)          // (1,3,H,W) [0,1]
        guard let pinnedImage = FrameLoad.loadCGImage(from: lastFrameURL) else {
            return XCTFail("could not reload the pinned input image")
        }
        let pinnedArr = FrameLoad.toArray(pinnedImage)

        let meanAbsDiff = MLX.mean(MLX.abs(decodedArr - pinnedArr)).item(Float.self)
        // VAE encode/decode round-trip + patchify/unpatchify introduces some
        // loss (same order of magnitude as frame-0's own I2V conditioning
        // round trip, documented elsewhere in this package) — a flat 0.04
        // tolerance in [0,1] pixel space confirms the LAST frame is the
        // pinned image, not model-generated noise (which would show a much
        // larger mean diff against a solid-color target).
        XCTAssertLessThan(meanAbsDiff, 0.04, "decoded last frame should closely match the pinned FFLF input (mean abs diff \(meanAbsDiff))")
    }

    func testLastFrameWrongSizeThrowsClearError() throws {
        guard checkpointsAvailable() else {
            throw XCTSkip("real checkpoints not found — skipping FFLF integration test")
        }
        let resolved = ResolutionResolver.optimize(width: 320, height: 320)

        let outputDir = FileManager.default.temporaryDirectory.appendingPathComponent("native_i2v_fflf_badsize_\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: outputDir) }
        try FileManager.default.createDirectory(at: outputDir, withIntermediateDirectories: true)

        let lastFrameURL = outputDir.appendingPathComponent("wrong_size.png")
        // Deliberately wrong size (half the resolved width/height).
        makeSolidColorPNG(width: max(32, resolved.width / 2), height: max(32, resolved.height / 2), gray: 40, to: lastFrameURL)

        var request = NativeI2VStage.Request(
            prompt: "a woman smiles at the camera", seconds: 9.0 / 24.0,
            width: resolved.width, height: resolved.height, textMaxLength: 8)
        request.fps = 24.0
        request.lastFrameImagePath = lastFrameURL

        XCTAssertThrowsError(try NativeI2VStage().generate(request, outputDir: outputDir)) { error in
            guard let stageError = error as? NativeI2VStage.StageError else {
                XCTFail("expected StageError, got \(error)"); return
            }
            if case .lastFrameImageWrongSize = stageError {} else {
                XCTFail("expected .lastFrameImageWrongSize, got \(stageError)")
            }
        }
    }
}
