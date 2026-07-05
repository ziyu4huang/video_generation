//
//  NativeT2IStage.swift
//  LTXVideoDirector
//
//  Replaces the T2I HALF of run.py's `video t2i2v` wrapper with a direct,
//  in-process call into ZImageDirector's T2IPipeline — which is ALREADY
//  100% native Swift/MLX end-to-end (its own Qwen3-4B text encoder, its
//  own transformer, its own VAE decoder; see z-image-director/Sources/
//  ZImageDirector/TextEncoder.swift's header: "Removes the Python
//  embedding-exchange dependency for true E2E text→image"). This was a
//  genuine discovery, not assumed: the LTX video-side Gemma bridge is the
//  ONE unported text encoder in this whole project — ZImage's Qwen3 text
//  encoder for the T2I stage was already fully ported by a sibling
//  package before this session started.
//
//  Mirrors the load-and-generate sequence in
//  z-image-director/Sources/ZImageDirectorCLI/T2ICommand.swift's
//  `loadPipeline`/`encodePrompt`/`generateWithCritique`, trimmed to the
//  no-LoRA, no-CFG-negative-prompt default path (cfgScale=1.0 is
//  ZImageDirector's own T2ICommand default — CFG is opt-in there, not
//  required for a good result).
//

import CommonImageDirector
import Foundation
import MLX
import ZImageDirector

public struct NativeT2IStage {
    public enum StageError: Error, CustomStringConvertible {
        case tokenizerLoadFailed(URL)
        public var description: String {
            switch self {
            case .tokenizerLoadFailed(let url): return "failed to load BPE tokenizer at \(url.path)"
            }
        }
    }

    public let transformer: String
    public let width: Int
    public let height: Int
    public let steps: Int?
    public let cfgScale: Float
    public let seed: UInt64
    public let vae: String
    public let encoder: String
    public let tokenizerDir: String
    public let profileSubsteps: Bool

    public init(
        transformer: String = "moody-pro-mix", width: Int = 640, height: Int = 960,
        steps: Int? = nil, cfgScale: Float = 1.0, seed: UInt64 = 99,
        vae: String = "zimage-ae", encoder: String = "qwen3-4b",
        tokenizerDir: String = "qwen3", profileSubsteps: Bool = false
    ) {
        self.transformer = transformer
        self.width = width
        self.height = height
        self.steps = steps
        self.cfgScale = cfgScale
        self.seed = seed
        self.vae = vae
        self.encoder = encoder
        self.tokenizerDir = tokenizerDir
        self.profileSubsteps = profileSubsteps
    }

    /// Generates an image natively (no run.py) and saves it as a PNG.
    /// Returns the saved image's pixel array too, in case a caller wants
    /// to feed it directly into the next stage without a disk round-trip.
    @discardableResult
    public func generate(prompt: String, outputURL: URL) throws -> MLXArray {
        let loaded = try WeightStore.load(variant: transformer)
        let resolvedSteps = steps ?? TransformerDefaultsRegistry.resolve(forTransformer: transformer).steps ?? 9

        let vaeURL = RepoPaths.mlxModelsRoot.appendingPathComponent("vae/\(vae)")
        let vaeWeights = try loadArrays(url: vaeURL.appendingPathComponent("model.safetensors"))

        let encoderURL = RepoPaths.mlxModelsRoot.appendingPathComponent("text_encoder/\(encoder)")
        let encWeights = try TextEncoderWeights.load(dir: encoderURL)
        let textEncoder = Qwen3TextEncoder.build(weights: encWeights)

        let tokURL = RepoPaths.mlxModelsRoot.appendingPathComponent("tokenizer/\(tokenizerDir)/tokenizer.json")
        guard var tokenizer = BPETokenizer(jsonURL: tokURL) else {
            throw StageError.tokenizerLoadFailed(tokURL)
        }

        let ids = tokenizer.encodePrompt(prompt, maxLength: 512).map { Double($0) }
        let idArray = MLXArray(converting: ids, [1, 512])
        let capFeats = textEncoder(idArray.asType(.int32)).asType(.bfloat16)

        let cfgActive = cfgScale != 1.0
        var uncondFeats: MLXArray?
        if cfgActive {
            let emptyIds = tokenizer.encodePrompt("", maxLength: 512).map { Double($0) }
            let emptyArray = MLXArray(converting: emptyIds, [1, 512])
            uncondFeats = textEncoder(emptyArray.asType(.int32)).asType(.bfloat16)
        }

        let pipeline = T2IPipeline(
            transformerWeights: loaded.arrays, vaeWeights: vaeWeights,
            config: loaded.config, groupSize: loaded.config.quantGroupSize, bits: loaded.config.quantBits)

        let image = pipeline.generate(
            capFeats: capFeats, uncondFeats: uncondFeats,
            seed: seed, width: width, height: height, steps: resolvedSteps, cfgScale: cfgScale,
            profileSubsteps: profileSubsteps)

        try ImageSave.savePNG(image, to: outputURL)
        return image
    }
}
