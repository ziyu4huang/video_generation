//
//  T2IPipeline.swift
//  ZImageDirector
//
//  Phase 5: end-to-end text-to-image pipeline.
//  Transformer (Phase 2) + scheduler + patchify/unpack + VAE (Phase 4).
//  Text embeddings come from the embedding-exchange file (Phase 3 deferred).
//

import Foundation
import MLX
import MLXRandom

/// End-to-end Z-Image T2I pipeline (no ControlNet, optional CFG).
public final class T2IPipeline {

    public let transformer: ZImageTransformer
    public let vae: ZImageVAEDecoder?
    public let config: TransformerConfig

    public init(transformerWeights: [String: MLXArray], vaeWeights: [String: MLXArray],
                config: TransformerConfig, groupSize: Int = 64, bits: Int = 8) {
        self.config = config
        self.transformer = ZImageTransformer(
            weights: transformerWeights, config: config, groupSize: groupSize, bits: bits
        )
        self.vae = vaeWeights.isEmpty ? nil : ZImageVAEDecoder(weights: vaeWeights)
    }

    // MARK: - Phase 5: end-to-end latent (fixed noise)

    /// Run the denoise loop with a FIXED noise array (from Python) and return the
    /// final latent — for verifying the loop matches Python deterministically.
    public func generateLatentFixedNoise(
        noise: MLXArray, capFeats: MLXArray, uncondFeats: MLXArray? = nil,
        width: Int, height: Int, steps: Int, maxSteps: Int? = nil, cfgScale: Float = 1.0
    ) -> MLXArray {
        let runSteps = maxSteps ?? steps
        let cfgActive = uncondFeats != nil && cfgScale != 1.0
        let hLat = height / 8, wLat = width / 8
        let hTok = hLat / 2, wTok = wLat / 2
        let mu = FlowMatchEulerScheduler.calculateShift(imageSeqLen: hTok * wTok)
        let scheduler = FlowMatchEulerScheduler(shift: 3.0, useDynamicShifting: true)
        scheduler.setTimesteps(numSteps: steps, mu: mu)
        let totalLen = capFeats.dim(1)
        let imgPos = PositionGrid.create(size: (1, hTok, wTok), start: (totalLen + 1, 0, 0))
            .reshaped([1, -1, 3]).asType(.bfloat16)
        let capPos = PositionGrid.create(size: (totalLen, 1, 1), start: (1, 0, 0))
            .reshaped([1, -1, 3]).asType(.bfloat16)
        let unifiedPos = MLX.concatenated([imgPos, capPos], axis: 1)
        let (cos, sin) = transformer.prepareRope(positions: unifiedPos)
        let cosBf = cos.asType(.bfloat16), sinBf = sin.asType(.bfloat16)
        let stepInputs = StepInputs(xPos: imgPos, capPos: capPos, cos: cosBf, sin: sinBf, hTok: hTok, wTok: wTok)
        var latents = noise.asType(.bfloat16)
        for idx in 0..<runSteps {
            let tInput = (1.0 - scheduler.timesteps![idx]).expandedDimensions(axis: -1).asType(.bfloat16)
            let np: MLXArray
            if cfgActive, let uncond = uncondFeats {
                let cond = stepFn(latent: latents, timestep: tInput, capFeats: capFeats, inputs: stepInputs)
                let uncondPred = stepFn(latent: latents, timestep: tInput, capFeats: uncond, inputs: stepInputs)
                np = uncondPred + cfgScale * (cond - uncondPred)
            } else {
                np = stepFn(latent: latents, timestep: tInput, capFeats: capFeats, inputs: stepInputs)
            }
            latents = scheduler.step(modelOutput: np, timestepIdx: idx, sample: latents)
            MLX.eval(latents)
        }
        return latents
    }

    /// Cached positional inputs for the transformer step (avoid rebuilding each call).
    public struct StepInputs {
        public let xPos: MLXArray
        public let capPos: MLXArray
        public let cos: MLXArray
        public let sin: MLXArray
        public let hTok: Int
        public let wTok: Int
    }

    /// One transformer forward step: latent → noise prediction.
    /// Mirrors the Python step_fn (compiled closure).
    public func stepFn(latent: MLXArray, timestep: MLXArray, capFeats: MLXArray, inputs: StepInputs) -> MLXArray {
        let channels = config.inChannels  // 16
        let xTokens = LatentOps.patchify(latent, hTok: inputs.hTok, wTok: inputs.wTok)
        let out = transformer(
            x: xTokens, t: timestep, capFeats: capFeats,
            xPos: inputs.xPos, capPos: inputs.capPos, cos: inputs.cos, sin: inputs.sin, capMask: nil
        )
        return LatentOps.unpack(out, hTok: inputs.hTok, wTok: inputs.wTok, channels: channels)
    }

    /// Generate pixel image (1, 3, H, W) float32 in [0,1] from a prompt embedding.
    ///
    /// - Parameters:
    ///   - capFeats: (1, N_cap, 2560) prompt embedding (from embedding exchange).
    ///   - uncondFeats: optional (1, N_cap, 2560) for CFG; nil = no CFG.
    ///   - prompt: only for logging.
    public func generate(
        capFeats: MLXArray, uncondFeats: MLXArray? = nil,
        seed: UInt64, width: Int, height: Int, steps: Int, cfgScale: Float,
        fixedNoise: MLXArray? = nil
    ) -> MLXArray {
        let cfgActive = uncondFeats != nil

        // Latent spatial dims: /8 downsample, then H_tok = H_lat/2.
        let hLat = height / 8
        let wLat = width / 8
        let hTok = hLat / 2
        let wTok = wLat / 2

        // Noise: either the provided fixed array (for reproducible comparison
        // against Python) or freshly seeded MLX noise.
        let noise: MLXArray
        if let fixed = fixedNoise {
            noise = fixed.asType(.bfloat16)
        } else {
            MLXRandom.seed(seed)
            noise = MLXRandom.normal([1, config.inChannels, hLat, wLat]).asType(.bfloat16)
        }

        // Scheduler.
        let mu = FlowMatchEulerScheduler.calculateShift(imageSeqLen: hTok * wTok)
        let scheduler = FlowMatchEulerScheduler(shift: 3.0, useDynamicShifting: true)
        scheduler.setTimesteps(numSteps: steps, mu: mu)

        // Positions: img over (H_tok, W_tok) patchified tokens; cap over caption.
        let totalLen = capFeats.dim(1)
        let imgPos = PositionGrid.create(size: (1, hTok, wTok), start: (totalLen + 1, 0, 0))
            .reshaped([1, -1, 3]).asType(.bfloat16)
        let capPos = PositionGrid.create(size: (totalLen, 1, 1), start: (1, 0, 0))
            .reshaped([1, -1, 3]).asType(.bfloat16)
        let unifiedPos = MLX.concatenated([imgPos, capPos], axis: 1)
        let (cos, sin) = transformer.prepareRope(positions: unifiedPos)
        let cosBf = cos.asType(.bfloat16)
        let sinBf = sin.asType(.bfloat16)
        let stepInputs = StepInputs(xPos: imgPos, capPos: capPos, cos: cosBf, sin: sinBf, hTok: hTok, wTok: wTok)

        var latents = noise

        print("   denoising \(steps) steps (cfg=\(cfgScale), mu=\(String(format: "%.3f", mu)))...")
        var stepTimes: [Double] = []
        for idx in 0..<steps {
            let tCurr = scheduler.timesteps![idx]
            // t_input = (1.0 - t_curr)[None] as bfloat16
            let tInput = (1.0 - tCurr).expandedDimensions(axis: -1).asType(.bfloat16)

            let noisePred: MLXArray
            if cfgActive, let uncond = uncondFeats {
                let cond = stepFn(latent: latents, timestep: tInput, capFeats: capFeats, inputs: stepInputs)
                let uncondPred = stepFn(latent: latents, timestep: tInput, capFeats: uncond, inputs: stepInputs)
                noisePred = uncondPred + cfgScale * (cond - uncondPred)
            } else {
                noisePred = stepFn(latent: latents, timestep: tInput, capFeats: capFeats, inputs: stepInputs)
            }
            latents = scheduler.step(modelOutput: noisePred, timestepIdx: idx, sample: latents)
            let stepStart = Date()
            MLX.eval(latents)
            let stepMs = stepStart.distance(to: Date()) * 1000
            stepTimes.append(stepMs)
            let avgMs = stepTimes.reduce(0, +) / Double(stepTimes.count)
            let stepMsg = "      step \(idx + 1)/\(steps) done  " +
                "(\(String(format: "%.0f", stepMs)) ms, " +
                "avg \(String(format: "%.0f", avgMs)) ms)"
            print(stepMsg)
        }
        let totalMs = stepTimes.reduce(0, +)
        let totalSec = String(format: "%.2f", totalMs / 1000)
        let perStep = String(format: "%.2f", totalMs / 1000 / Double(steps))
        print("   denoise total: \(totalSec)s, avg \(perStep)s/it")

        // VAE decode → (1, 3, H, W) float32 [0,1].
        guard let vae = vae else {
            fatalError("generate() requires VAE weights; build pipeline with non-empty vaeWeights")
        }
        let decoded = vae(latents)
        let img = MLX.clip(decoded.asType(.float32) / 2.0 + 0.5, min: 0, max: 1)
        MLX.eval(img)
        // NaN guard (matches pipeline.py nan_to_num).
        let nanMask = MLX.isNaN(img)
        let clean = MLX.where(nanMask, zeros(like: img), img)
        return clean
    }
}
