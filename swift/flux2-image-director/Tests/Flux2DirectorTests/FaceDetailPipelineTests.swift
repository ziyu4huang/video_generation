import XCTest
import MLX
import CommonImageDirector
@testable import Flux2Director

final class FaceDetailPipelineTests: XCTestCase {

    private static func repoRootRelative(_ relPath: String) -> String {
        var dir = FileManager.default.currentDirectoryPath
        for _ in 0..<8 {
            let candidate = (dir as NSString).appendingPathComponent(relPath)
            if FileManager.default.fileExists(atPath: candidate) { return candidate }
            dir = (dir as NSString).deletingLastPathComponent
        }
        return (FileManager.default.currentDirectoryPath as NSString).appendingPathComponent(relPath)
    }

    /// Real end-to-end: real Vision detection + real Flux2 Klein model load +
    /// real SDEdit regeneration + real composite. Slow (full model load +
    /// denoise) — skipped automatically when the models aren't present on
    /// disk (fresh checkout / CI), same XCTSkipUnless discipline as
    /// ZImageDirectorTests.testLoadMoodyProMixWeights.
    func testDetailFacesRegeneratesFaceRegionAndLeavesRestNearUnchanged() throws {
        let fixture = URL(fileURLWithPath: Self.repoRootRelative(
            "scripts/fixtures/faces/real_face_portrait.png"))
        try XCTSkipUnless(FileManager.default.fileExists(atPath: fixture.path), "fixture image not found")

        let transformerDir = ModelPaths.transformerRoot.appendingPathComponent(Flux2ModelRegistry.defaultTransformer)
        try XCTSkipUnless(FileManager.default.fileExists(atPath: transformerDir.path),
                           "flux2 klein-9b transformer weights not found at \(transformerDir.path) — skipping real E2E test")

        let faces = try FaceDetector.detectFaces(at: fixture, width: 832, height: 1024)
        try XCTSkipIf(faces.isEmpty, "no face detected in fixture — cannot exercise the regenerate/composite path")

        print("  loading flux2 models for real E2E face-detail test...")
        let tfW = try Flux2TransformerWeights.load(dir: transformerDir)
        let tf = Flux2Transformer.build(weights: tfW)
        let teW = try Flux2TextEncoderWeights.load(
            dir: ModelPaths.textEncoderRoot.appendingPathComponent(Flux2ModelRegistry.defaultTextEncoder))
        let te = Flux2TextEncoder.build(weights: teW)
        let tok = Flux2Tokenizer(jsonURL: ModelPaths.tokenizerRoot
            .appendingPathComponent(Flux2ModelRegistry.defaultTokenizer).appendingPathComponent("tokenizer.json"))!
        let vaeURL = ModelPaths.vaeRoot.appendingPathComponent(Flux2ModelRegistry.defaultVAE)
        var vaeWeights: [String: MLXArray] = [:]
        let files = (try FileManager.default.contentsOfDirectory(at: vaeURL, includingPropertiesForKeys: nil))
            .filter { $0.pathExtension == "safetensors" && !$0.lastPathComponent.hasPrefix("._") }
        for f in files { vaeWeights.merge(try loadArrays(url: f)) { _, new in new } }
        let bn = Flux2BatchNormStats(
            runningMean: vaeWeights["bn.running_mean"]!, runningVar: vaeWeights["bn.running_var"]!)
        let pipeline = Flux2EditPipeline(
            transformer: tf, textEncoder: te, tokenizer: tok,
            vaeEncoder: Flux2VAEEncoder(weights: vaeWeights),
            vaeDecoder: Flux2VAEDecoder(weights: vaeWeights), bn: bn)

        let image = try Flux2ImageLoad.loadArray(from: fixture, targetSize: (832, 1024))
        let result = try FaceDetailPipeline.detailFaces(
            image: image, faces: faces, prompt: "a woman's face, natural skin detail, photorealistic",
            pipeline: pipeline, seed: 42, steps: 9, denoiseStrength: 0.15, padding: 1.8, feather: 20)

        XCTAssertEqual(result.dim(2), image.dim(2))
        XCTAssertEqual(result.dim(3), image.dim(3))

        // Coarse localization check: the composite should differ MORE inside
        // the (expanded) face region than in a corner patch far from any
        // face — proves detailFaces localized the edit rather than
        // regenerating/blending the whole frame.
        let expanded = FaceDetector.expandBBox(faces[0], padding: 1.8, imgW: 832, imgH: 1024)
        let diff = MLX.abs(result - image)
        MLX.eval(diff)
        let insideDiff = MLX.mean(diff[0..., 0..., expanded.y1..<expanded.y2, expanded.x1..<expanded.x2]).item(Float.self)
        let cornerDiff = MLX.mean(diff[0..., 0..., 0..<50, 0..<50]).item(Float.self)
        XCTAssertGreaterThan(insideDiff, cornerDiff,
            "face-region diff (\(insideDiff)) should exceed a far corner patch's diff (\(cornerDiff))")
    }

    func testDetailFacesReturnsImageUnchangedWhenNoFacesGiven() throws {
        let image = MLX.zeros([1, 3, 64, 64])
        MLX.eval(image)
        // No real pipeline needed — detailFaces must short-circuit before
        // touching `pipeline` when `faces` is empty (`pipeline: nil` is only
        // legal because the empty-faces guard runs first). Compare via
        // .asArray since MLXArray itself isn't Equatable.
        let result = try FaceDetailPipeline.detailFaces(
            image: image, faces: [], prompt: "", pipeline: nil,
            seed: 42, steps: 9, denoiseStrength: 0.15, padding: 1.8, feather: 20)
        MLX.eval(result)
        XCTAssertEqual(result.asArray(Float.self), image.asArray(Float.self))
    }
}
