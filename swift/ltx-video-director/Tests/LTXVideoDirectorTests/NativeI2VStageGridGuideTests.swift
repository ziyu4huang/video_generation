import XCTest
import MLX
@testable import LTXVideoDirector

/// Real-checkpoint integration tests for grid-guide conditioning — a single
/// NxN storyboard-panel image split in-memory into N independent keyframe
/// guides (see NativeI2VStage.Request.gridImagePath's header). Ported
/// conceptually from the reference ComfyUI custom node
/// `TD_LTXVAddGuideFromGrid` (`ComfyUI-TDNodes`, MIT). Reuses the same
/// tiny/fast config as NativeI2VStageFFLFTests to keep this quick while
/// still exercising the real 48-block transformer.
final class NativeI2VStageGridGuideTests: XCTestCase {
    private func checkpointsAvailable() -> Bool {
        let fm = FileManager.default
        let transformerURL = RepoPaths.mlxModelsRoot.appendingPathComponent("transformer/ltx-2.3-distilled-q8/transformer-distilled-1.1.safetensors")
        let vaeEncoderURL = RepoPaths.mlxModelsRoot.appendingPathComponent("vae/ltx-2.3-vae/vae_encoder.safetensors")
        return fm.fileExists(atPath: transformerURL.path) && fm.fileExists(atPath: vaeEncoderURL.path)
    }

    /// A 2x2 grid image where each quadrant is a distinct flat gray value —
    /// deliberately featureless per-panel so a pixel-diff against the
    /// decoded frame at that panel's pinned index is a clean signal.
    private func makeSolidQuadrantGridPNG(panelWidth: Int, panelHeight: Int, grays: [UInt8], to url: URL) {
        let width = panelWidth * 2, height = panelHeight * 2
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        let bitmapInfo = CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue)
        let ctx = CGContext(
            data: nil, width: width, height: height, bitsPerComponent: 8,
            bytesPerRow: width * 4, space: colorSpace, bitmapInfo: bitmapInfo)!
        let quadrantOrigins = [
            CGPoint(x: 0, y: 0), CGPoint(x: panelWidth, y: 0),
            CGPoint(x: 0, y: panelHeight), CGPoint(x: panelWidth, y: panelHeight),
        ]
        for (i, origin) in quadrantOrigins.enumerated() {
            let gray = Double(grays[i]) / 255.0
            ctx.setFillColor(CGColor(red: gray, green: gray, blue: gray, alpha: 1.0))
            ctx.fill(CGRect(x: origin.x, y: origin.y, width: CGFloat(panelWidth), height: CGFloat(panelHeight)))
        }
        let image = ctx.makeImage()!
        FrameLoad.savePNG(image, to: url)
    }

    func testGridPanelIsPreservedAtItsPinnedFrameIndex() throws {
        guard checkpointsAvailable() else {
            throw XCTSkip("real checkpoints not found — skipping grid-guide integration test")
        }
        let resolved = ResolutionResolver.optimize(width: 320, height: 320)
        let seconds = 17.0 / 24.0
        let fps = 24.0

        // Only frame 0 and the LAST latent frame have a verified 1:1 mapping
        // to the first/last decoded PNG (see NativeI2VStageFFLFTests, which
        // relies on the same boundary mapping for its own last-frame
        // assertion) — a causal VAE's temporal upsampling does not map
        // interior latent indices to output frames 1:1, so this test
        // deliberately avoids asserting against any interior index.
        let (fLat, _, _) = VideoLatentShape.compute(
            numFrames: NativeI2VStage.Request(prompt: "", seconds: seconds, fps: fps, width: resolved.width, height: resolved.height).frames,
            height: resolved.height, width: resolved.width)
        XCTAssertGreaterThanOrEqual(fLat, 2, "test needs at least 2 latent frames to exercise a non-trivial grid")

        let outputDir = FileManager.default.temporaryDirectory.appendingPathComponent("native_i2v_grid_\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: outputDir) }
        try FileManager.default.createDirectory(at: outputDir, withIntermediateDirectories: true)

        let gridURL = outputDir.appendingPathComponent("grid_input.png")
        let grays: [UInt8] = [40, 80, 120, 160]
        makeSolidQuadrantGridPNG(panelWidth: resolved.width, panelHeight: resolved.height, grays: grays, to: gridURL)

        // Read back each panel's ACTUAL content via the same splitGrid the
        // stage itself calls, rather than assuming a visual quadrant layout
        // (CGContext fill uses a bottom-up coordinate space while CGImage
        // cropping/pixel data is top-down, so "row 0" in the drawn image
        // isn't necessarily "row 0" as splitGrid crops it) — this keeps the
        // assertions correct regardless of that coordinate convention.
        let gridCGImage = FrameLoad.loadCGImage(from: gridURL)!
        let panels = FrameLoad.splitGrid(gridCGImage, columns: 2, rows: 2)
        let panelGrays = panels.map { MLX.mean(FrameLoad.toArray($0)).item(Float.self) }

        var request = NativeI2VStage.Request(
            prompt: "a woman smiles at the camera", seconds: seconds, fps: fps,
            width: resolved.width, height: resolved.height, textMaxLength: 8)
        request.gridImagePath = gridURL
        request.gridColumns = 2
        request.gridRows = 2
        // Panel 0 pinned at frame 0; panel 3 pinned at the LAST latent
        // frame, applied after panel 2 (also pinned there) to exercise
        // last-writer-wins — both indices have the verified boundary decode
        // mapping above.
        request.gridFrameIndices = [0, fLat - 1, fLat - 1, fLat - 1]
        request.gridStrengths = [1.0, 1.0, 1.0, 1.0]

        let result = try NativeI2VStage().generate(request, outputDir: outputDir)
        XCTAssertGreaterThan(result.frameCount, 1, "grid guide needs at least 2 output frames")

        let frameFiles = (try FileManager.default.contentsOfDirectory(atPath: result.frameDirectory.path)).sorted()

        let firstDecodedURL = result.frameDirectory.appendingPathComponent(frameFiles.first!)
        let firstDecodedArr = FrameLoad.toArray(FrameLoad.loadCGImage(from: firstDecodedURL)!)
        let firstTargetGray = MLXArray(panelGrays[0])
        let firstDiff = MLX.mean(MLX.abs(firstDecodedArr - firstTargetGray)).item(Float.self)
        XCTAssertLessThan(firstDiff, 0.04, "decoded first frame should match panel 0 (mean abs diff \(firstDiff))")

        let lastDecodedURL = result.frameDirectory.appendingPathComponent(frameFiles.last!)
        let lastDecodedArr = FrameLoad.toArray(FrameLoad.loadCGImage(from: lastDecodedURL)!)
        // Panel 3 was applied last, overwriting panel 2's slot — the
        // decoded last frame should reflect the last-writer-wins panel.
        let lastTargetGray = MLXArray(panelGrays[3])
        let lastDiff = MLX.mean(MLX.abs(lastDecodedArr - lastTargetGray)).item(Float.self)
        XCTAssertLessThan(lastDiff, 0.04, "decoded last frame should match the last-writer-wins panel 3, not panel 2 (mean abs diff \(lastDiff))")
        XCTAssertGreaterThan(abs(panelGrays[2] - panelGrays[3]), 0.01, "test grays must be distinct to prove last-writer-wins, not coincidence")
    }

    func testGridConfigMismatchThrowsClearError() throws {
        let resolved = ResolutionResolver.optimize(width: 320, height: 320)
        let outputDir = FileManager.default.temporaryDirectory.appendingPathComponent("native_i2v_grid_mismatch_\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: outputDir) }
        try FileManager.default.createDirectory(at: outputDir, withIntermediateDirectories: true)

        let gridURL = outputDir.appendingPathComponent("grid_input.png")
        makeSolidQuadrantGridPNG(panelWidth: resolved.width, panelHeight: resolved.height, grays: [40, 80, 120, 160], to: gridURL)

        var request = NativeI2VStage.Request(
            prompt: "a woman smiles at the camera", seconds: 9.0 / 24.0,
            width: resolved.width, height: resolved.height, textMaxLength: 8)
        request.fps = 24.0
        request.gridImagePath = gridURL
        request.gridColumns = 2
        request.gridRows = 2
        // Deliberately wrong: only 3 indices for a 2x2 (4-panel) grid.
        request.gridFrameIndices = [0, 1, 2]

        XCTAssertThrowsError(try NativeI2VStage().generate(request, outputDir: outputDir)) { error in
            guard let stageError = error as? NativeI2VStage.StageError else {
                XCTFail("expected StageError, got \(error)"); return
            }
            if case .gridConfigMismatch = stageError {} else {
                XCTFail("expected .gridConfigMismatch, got \(stageError)")
            }
        }
    }
}
