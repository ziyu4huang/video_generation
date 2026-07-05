//
//  Flux2StyleTransferPipeline.swift
//  Flux2Director
//
//  Training-free K/V-injection style transfer for Flux2 Klein. VAE-encodes the
//  style reference → refClean; each denoise step runs a 2-B batch [target ;
//  ref_noisy_σ] through the transformer with a Flux2StyleConfig active on the
//  single blocks in `activeBlocks`, slices the target velocity, steps.
//
//  RF mode: `linear` (ref_noisy = (1-σ)·refClean + σ·noise) — the simplest
//  integrator (no model-call cache loop), sufficient to demonstrate the palette
//  shift. The richer flowturbo_pc / rf_gamma caches port straightforwardly later.
//
//  GATE: strength=0 is byte-identical to vanilla t2i at the same seed, held by
//  construction (see Flux2KVStyleTransfer.swift header): the styleBuilder returns
//  mix=0 configs, so every single block routes to the ORIGINAL SDPA path; and the
//  2-B batch sliced to [:1] == a 1-B vanilla forward because the transformer is
//  batch-invariant (SDPA/LayerNorm/RoPE/linear are per-batch-element).
//

import Foundation
import MLX
import MLXRandom

public struct Flux2StyleTransferPipeline {
    public let transformer: Flux2Transformer
    public let textEncoder: Flux2TextEncoder
    public let tokenizer: Flux2Tokenizer
    public let vaeEncoder: Flux2VAEEncoder
    public let vaeDecoder: Flux2VAEDecoder
    public let bn: Flux2BatchNormStats

    public init(transformer: Flux2Transformer, textEncoder: Flux2TextEncoder,
                tokenizer: Flux2Tokenizer, vaeEncoder: Flux2VAEEncoder,
                vaeDecoder: Flux2VAEDecoder, bn: Flux2BatchNormStats) {
        self.transformer = transformer; self.textEncoder = textEncoder
        self.tokenizer = tokenizer; self.vaeEncoder = vaeEncoder
        self.vaeDecoder = vaeDecoder; self.bn = bn
    }

    /// Generate a style-transferred image. `strength` ∈ 0..1 is the style blend
    /// (0 → byte-identical to vanilla t2i at `seed`; 1 → full recommended preset).
    public func generate(prompt: String, styleImage: URL, strength: Float,
                         width: Int, height: Int, steps: Int, seed: UInt64,
                         guidance: Float = 0.0,
                         knobs: Flux2StyleDefaults = Flux2StyleDefaults())
        -> (MLXArray, Double)
    {
        let start = DispatchTime.now()
        let d = knobs

        // 1. Text encode, then duplicate to B=2 ([target ; ref] share the prompt).
        var tok = tokenizer
        let (ids, mask) = tok.tokenize(prompt, maxLength: 512)
        let promptEmbeds1 = textEncoder.getPromptEmbeds(
            MLXArray(ids.map { Int32($0) }).reshaped([1, -1]),
            attentionMask: MLXArray(mask.map { Int32($0) }).reshaped([1, -1]),
            hiddenStateLayers: [9, 18, 27]).asType(.bfloat16)
        let promptEmbeds = MLX.repeated(promptEmbeds1, count: 2, axis: 0)
        let textIds = Flux2LatentCreator.prepareTextIds(seqLen: promptEmbeds1.dim(1), batchSize: 1)

        // 2. Target noise latents (B=1; kept single-batch — only the transformer
        //    call batches). refClean = VAE-encoded style image.
        let (latents, latentIds, latentH, latentW) = Flux2LatentCreator.preparePackedLatents(
            seed: seed, height: height, width: width, batchSize: 1)
        let imgLen = latents.dim(1)
        let refClean = Flux2LatentCreator.encodeInitLatent(
            imagePath: styleImage, vaeEncoder: vaeEncoder, bn: bn,
            height: height, width: width).asType(latents.dtype)

        // Fixed noise for the linear-RF ref trajectory (deterministic per seed).
        MLXRandom.seed(seed &+ 0x9e37)
        let refNoise = MLXRandom.normal(refClean.shape).asType(latents.dtype)

        // 3. Scheduler.
        let scheduler = Flux2Scheduler(
            imageSeqLen: (height / 16) * (width / 16), numInferenceSteps: steps)
        var current: MLXArray = latents

        let mix = max(0, min(1, strength))
        let effAdain = max(0, min(d.adainStrength * min(strength, 1.25), 1.0))
        let (effHigh, effLow) = Flux2ScaleEndpoints.effective(
            highStart: d.highScaleStart, lowEnd: d.lowScaleEnd, strength: strength)
        let active = Set(d.activeBlocks)

        // 4. Denoise: 2-B batch [target ; ref_noisy_σ]; styled single blocks.
        for t in 0..<steps {
            let sigmaT = scheduler.sigmas[t].item(Float.self)
            // Linear-RF ref_noisy: (1-σ)·refClean + σ·noise.
            let refNoisy = ((1.0 - sigmaT) * refClean + sigmaT * refNoise).asType(.bfloat16)
            let hidden2 = MLX.concatenated([current, refNoisy], axis: 0) // (2, imgLen, dim)
            let ts = MLX.full([2], values: scheduler.timesteps[t]).asType(.bfloat16)

            let progress = Float(t) / Float(max(steps - 1, 1))
            // styleBuilder: per-single-block config (nil for inactive blocks).
            // imgS/imgE are image-relative (0..<imgLen); the transformer offsets
            // by txtLen for the absolute [text;image] positions.
            let builder: (Int) -> Flux2StyleConfig? = { blockIdx in
                guard active.contains(blockIdx) else { return nil }
                let scaleVec = flux2StyleScaleVec(progress: progress, beta: d.beta,
                                                  highStart: effHigh, highEnd: d.highScaleEnd,
                                                  lowStart: d.lowScaleStart, lowEnd: effLow,
                                                  headDim: self.transformer.config.attentionHeadDim)
                return Flux2StyleConfig(targetB: 1, imgS: 0, imgE: imgLen,
                                        scaleVec: scaleVec, refKStrength: d.refKStrength,
                                        valueAdainStrength: d.valueAdainStrength,
                                        refValueMix: d.refValueMix,
                                        adainStrength: effAdain, mix: mix)
            }

            var velocity = transformer(
                hiddenStates: hidden2, encoderHiddenStates: promptEmbeds,
                timestep: ts, imgIds: latentIds, txtIds: textIds,
                regionMask: nil, styleBuilder: builder)
            velocity = velocity[0..<1] // slice target
            current = scheduler.step(noise: velocity, timestep: t, latents: current)
            MLX.eval(current)
        }

        // 5. VAE decode the target.
        let unpacked = current.reshaped([1, latentH, latentW, current.dim(2)])
            .transposed(0, 3, 1, 2)
        let pixels = (vaeDecoder.decodePackedLatents(unpacked, bn: bn) * 0.5 + 0.5)
            .asType(.float32)
        MLX.eval(pixels)
        let elapsed = Double(DispatchTime.now().uptimeNanoseconds - start.uptimeNanoseconds) / 1e9
        return (pixels, elapsed)
    }
}
