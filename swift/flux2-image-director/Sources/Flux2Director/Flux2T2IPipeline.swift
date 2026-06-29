//
//  Flux2T2IPipeline.swift
//  Flux2Director
//
//  Phase 2.4: End-to-end Flux2 Klein T2I generation. Wires tokenizer → text
//  encoder → latent creator → scheduler → transformer denoise loop → VAE decode.
//

import CommonImageDirector
import Foundation
import MLX
import MLXRandom

public struct Flux2T2IPipeline {
    public let transformer: Flux2Transformer
    public let textEncoder: Flux2TextEncoder
    public let tokenizer: Flux2Tokenizer
    public let vaeDecoder: Flux2VAEDecoder
    public let bn: Flux2BatchNormStats

    public init(transformer: Flux2Transformer, textEncoder: Flux2TextEncoder,
                tokenizer: Flux2Tokenizer, vaeDecoder: Flux2VAEDecoder,
                bn: Flux2BatchNormStats) {
        self.transformer = transformer
        self.textEncoder = textEncoder
        self.tokenizer = tokenizer
        self.vaeDecoder = vaeDecoder
        self.bn = bn
    }

    /// Generate an image. Returns (pixels (1,3,H,W) float32, generation time in seconds).
    public func generate(prompt: String, negativePrompt: String = " ",
                         seed: UInt64, height: Int, width: Int,
                         steps: Int, guidance: Float)
        -> (MLXArray, Double)
    {
        let start = DispatchTime.now()

        // 1. Tokenize + encode prompt.
        var tok = tokenizer
        let (posIds, posMask) = tok.tokenize(prompt, maxLength: 512)
        let promptEmbeds = textEncoder.getPromptEmbeds(
            MLXArray(posIds.map { Int32($0) }).reshaped([1, -1]),
            attentionMask: MLXArray(posMask.map { Int32($0) }).reshaped([1, -1]),
            hiddenStateLayers: [9, 18, 27]
        ).asType(.bfloat16)
        let textIds = Flux2LatentCreator.prepareTextIds(seqLen: promptEmbeds.dim(1), batchSize: 1)

        // Negative prompt embeddings (only if CFG).
        var negEmbeds: MLXArray? = nil
        if guidance > 1.0 {
            let (nIds, nMask) = tok.tokenize(negativePrompt, maxLength: 512)
            negEmbeds = textEncoder.getPromptEmbeds(
                MLXArray(nIds.map { Int32($0) }).reshaped([1, -1]),
                attentionMask: MLXArray(nMask.map { Int32($0) }).reshaped([1, -1]),
                hiddenStateLayers: [9, 18, 27]
            ).asType(.bfloat16)
        }

        // 2. Prepare packed latents + grid ids.
        let (latents, latentIds, latentH, latentW) = Flux2LatentCreator.preparePackedLatents(
            seed: seed, height: height, width: width, batchSize: 1)

        // 3. Build scheduler (image_seq_len = (H//16)*(W//16)).
        let imageSeqLen = (height / 16) * (width / 16)
        let scheduler = Flux2Scheduler(imageSeqLen: imageSeqLen, numInferenceSteps: steps)
        let timesteps = scheduler.timesteps
        let sigmas = scheduler.sigmas
        MLX.eval(timesteps, sigmas)

        // 4. Denoise loop.
        var current = latents
        for t in 0..<steps {
            let ts = timesteps[t].asType(.bfloat16).reshaped([1])
            var noise = transformer(
                hiddenStates: current, encoderHiddenStates: promptEmbeds,
                timestep: ts, imgIds: latentIds, txtIds: textIds)
            if let neg = negEmbeds {
                let negNoise = transformer(
                    hiddenStates: current, encoderHiddenStates: neg,
                    timestep: ts, imgIds: latentIds, txtIds: textIds)
                noise = negNoise + guidance * (noise - negNoise)
            }
            current = scheduler.step(noise: noise, timestep: t, latents: current)
            MLX.eval(current)
        }

        // 5. Unpack + VAE decode.
        // packed latents (1, lh*lw, 128) → (1, 128, lh, lw) via unpack then transpose.
        let unpacked = current.reshaped([1, latentH, latentW, current.dim(2)])
            .transposed(0, 3, 1, 2)   // (1, 128, lh, lw)
        let pixels = vaeDecoder.decodePackedLatents(unpacked, bn: bn)
            .asType(.float32)
        MLX.eval(pixels)

        let elapsed = Double(DispatchTime.now().uptimeNanoseconds - start.uptimeNanoseconds) / 1e9
        return (pixels, elapsed)
    }

    /// Clamp pixels to [0,1] and save as PNG.
    public static func saveImage(_ pixels: MLXArray, to url: URL) throws {
        let clamped = MLX.clip(pixels, min: 0.0, max: 1.0)
        try ImageSave.savePNG(clamped, to: url)
    }
}
