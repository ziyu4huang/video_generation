//
//  T2IPipeline.swift
//  ZImageDirector
//
//  Phase 5: end-to-end text-to-image pipeline.
//  Transformer (Phase 2) + scheduler + patchify/unpack + VAE (Phase 4).
//  Text embeddings come from the embedding-exchange file (Phase 3 deferred).
//

import CommonImageDirector
import Foundation
import MLX
import MLXRandom

/// End-to-end Z-Image T2I pipeline (no ControlNet, optional CFG).
public final class T2IPipeline {

    public let transformer: ZImageTransformer
    public let vae: ZImageVAEDecoder?
    /// VAE encoder for i2i (image → latent). Built from the same weights as the
    /// decoder; nil when the pipeline was constructed with empty vaeWeights.
    public let vaeEncoder: ZImageVAEEncoder?
    public let config: TransformerConfig

    /// Last generate() performance breakdown (nil before first run). Read this
    /// after generate() returns to embed per-step it/s + memory into the manifest.
    public private(set) var lastPerf: GenerationPerf?

    public init(transformerWeights: [String: MLXArray], vaeWeights: [String: MLXArray],
                config: TransformerConfig, groupSize: Int = 64, bits: Int = 8) {
        self.config = config
        self.transformer = ZImageTransformer(
            weights: transformerWeights, config: config, groupSize: groupSize, bits: bits
        )
        if vaeWeights.isEmpty {
            self.vae = nil
            self.vaeEncoder = nil
        } else {
            self.vae = ZImageVAEDecoder(weights: vaeWeights)
            self.vaeEncoder = ZImageVAEEncoder(weights: vaeWeights)
        }
    }

    /// Encode a pixel image (1, 3, H, W) normalized to [-1, 1] into a latent
    /// (1, 16, H/8, W/8) for the img2img path. Fatal if no encoder was loaded.
    public func encodeImage(_ pixels: MLXArray) -> MLXArray {
        guard let encoder = vaeEncoder else {
            fatalError("encodeImage() requires VAE weights; build pipeline with non-empty vaeWeights")
        }
        let latent = encoder(pixels.asType(.bfloat16))
        MLX.eval(latent)
        return latent
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
    public func stepFn(
        latent: MLXArray, timestep: MLXArray, capFeats: MLXArray, inputs: StepInputs,
        onBlockTimings: ((BlockTimings) -> Void)? = nil,
        onLayerAttnMlpTimings: ((AttnMlpTimings) -> Void)? = nil
    ) -> MLXArray {
        let channels = config.inChannels  // 16
        let xTokens = LatentOps.patchify(latent, hTok: inputs.hTok, wTok: inputs.wTok)
        let out = transformer(
            x: xTokens, t: timestep, capFeats: capFeats,
            xPos: inputs.xPos, capPos: inputs.capPos, cos: inputs.cos, sin: inputs.sin, capMask: nil,
            onBlockTimings: onBlockTimings,
            onLayerAttnMlpTimings: onLayerAttnMlpTimings
        )
        return LatentOps.unpack(out, hTok: inputs.hTok, wTok: inputs.wTok, channels: channels)
    }

    /// One transformer forward step WITH ControlNet injection. The controlnet
    /// context is pre-computed once from the 33-channel control image and reused
    /// every step (it doesn't depend on the timestep or current latent).
    public func stepFnControlnet(
        latent: MLXArray, timestep: MLXArray, capFeats: MLXArray, inputs: StepInputs,
        controlnet: ZImageControlNet, controlContext: MLXArray, strength: Float,
        onBlockTimings: ((BlockTimings) -> Void)? = nil
    ) -> MLXArray {
        let channels = config.inChannels
        let xTokens = LatentOps.patchify(latent, hTok: inputs.hTok, wTok: inputs.wTok)
        let out = transformer(
            x: xTokens, t: timestep, capFeats: capFeats,
            xPos: inputs.xPos, capPos: inputs.capPos, cos: inputs.cos, sin: inputs.sin,
            capMask: nil,
            controlnet: controlnet, controlnetContext: controlContext,
            controlnetStrength: strength,
            onBlockTimings: onBlockTimings
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
        fixedNoise: MLXArray? = nil,
        cleanLatent: MLXArray? = nil, denoiseStrength: Float = 1.0,
        mask: MLXArray? = nil,
        controlnet: ZImageControlNet? = nil, controlImage33ch: MLXArray? = nil,
        controlnetStrength: Float = 1.0,
        // Opt-in per-step forward/scheduler breakdown (default off: forces an
        // extra MLX.eval sync point per step to split the timing, which adds
        // real overhead absent in the default path — same "opt-in, bounded"
        // pattern as DenoiseLoop's cachedBlockCount). When false, timing and
        // stepTimesMs are byte-identical to before this flag existed.
        profileSubsteps: Bool = false,
        // Opt-in per-block breakdown of the forward pass itself (noiseRefiner /
        // contextRefiner / main layers), now that profileSubsteps has already
        // shown forward ≈ 100% of step time. Same "opt-in, bounded" cost
        // pattern: byte-identical to before this flag existed when false.
        // When CFG is active, timings from the cond and uncond forward calls
        // are summed (both run every step; splitting them further isn't
        // useful since they share the same block structure).
        profileBlocks: Bool = false,
        // Opt-in measurement of adjacent-timestep redundancy in the final
        // noise prediction (L1 + cosine similarity vs the previous step's
        // noisePred). Answers, empirically, whether TeaCache-style step
        // caching is even plausible for this model's 9-step distilled
        // schedule — see project_teacache_style_caching_research memory:
        // every published caching method (TeaCache/FasterCache/BWCache) was
        // validated only on ≥30-step schedules, none report results for
        // few-step distilled models, so the "adjacent steps are similar"
        // assumption is unverified here. This is measurement only — it does
        // NOT cache or reuse anything. Forces two extra scalar reads
        // (`.item()`) per step after the first; zero cost when false.
        profileSimilarity: Bool = false,
        // Opt-in attention-vs-MLP breakdown of the main `layers` stage — the
        // next granularity down now that BlockTimings (PR #315) confirmed
        // `layers` dominates at ~90%+ of forward time. Summed across all 30
        // layer blocks (and cond+uncond under CFG). No-op under ControlNet
        // (stepFnControlnet doesn't wire this through — out of scope for the
        // T2I timing investigation this belongs to). Same zero-cost-when-off
        // pattern as the other profile* flags.
        profileAttnMlp: Bool = false
        // NOTE on MLX compile: this pipeline does NOT use MLX.compile for the
        // denoise step, despite Python's @mx.compile step_fn. Measured verdict
        // (4-run interleaved benchmark, 2026-06-29): compile gave ZERO speed
        // benefit (32.93s vs 32.51s, diff < σ=2.8s thermal noise) while tripling
        // peak memory (17.4GB vs 5.7GB, σ=0). MLX-Swift's compile retains the
        // full compiled graph cache without Python's graph-fusion payoff — a
        // pure cost with no upside. The denoise loop runs eagerly. Do NOT
        // re-add compile without re-proving a speed win on a fresh interleaved
        // benchmark; the historical evidence is uniformly negative.
    ) -> MLXArray {
        let cfgActive = uncondFeats != nil
        let img2img = cleanLatent != nil && denoiseStrength < 1.0
        let useCnet = controlnet != nil && controlImage33ch != nil
        // Inpainting (Repaint): mask is a soft [0,1] latent-space array.
        //   1 = LOCK to init latent (keep original), 0 = free to re-denoise.
        //   Requires cleanLatent (the init). When active, after each scheduler
        //   step the locked region is re-injected from the forward-noised init
        //   latent so the free region can denoise hard with zero drift in the
        //   locked region. Port of pipeline.py:683-693.

        // Latent spatial dims: /8 downsample, then H_tok = H_lat/2.
        let hLat = height / 8
        let wLat = width / 8
        let hTok = hLat / 2
        let wTok = wLat / 2

        // Noise: either the provided fixed array (for reproducible comparison
        // against Python) or freshly seeded MLX noise. For img2img the noise
        // must match the clean-latent shape (already H/8 × W/8).
        let noise: MLXArray
        if let fixed = fixedNoise {
            noise = fixed.asType(.bfloat16)
        } else {
            MLXRandom.seed(seed)
            let noiseShape = cleanLatent?.shape ?? [1, config.inChannels, hLat, wLat]
            noise = MLXRandom.normal(noiseShape).asType(.bfloat16)
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
        let inpaintActive = mask != nil && cleanLatent != nil

        // img2img (SDEdit): mix clean latent with noise at t_mix, then denoise
        // only the last `stepsToRun` steps. Matches pipeline.py:595-604.
        // NOTE: when inpainting (mask present), we denoise from FULL noise so the
        // free region (mask=0) regenerates completely; the locked region is
        // pinned each step by the Repaint logic above.
        var startStep = 0
        if img2img, let clean = cleanLatent {
            // Match Python's round() (banker's rounding, round-half-to-even):
            // round(9*0.5)=4, not 5. Swift's .rounded() defaults to half-up,
            // so use .toNearestOrEven to align with pipeline.py:598.
            let stepsToRun = max(1, Int((Float(steps) * denoiseStrength).rounded(.toNearestOrEven)))
            startStep = steps - stepsToRun
            let tMix = scheduler.timesteps![startStep]
            latents = ((1.0 - tMix) * clean + tMix * noise).asType(.bfloat16)
            let tMixVal = tMix.item(Float.self)
            print("   img2img: \(stepsToRun) steps from step \(startStep + 1)/\(steps) (t_mix=\(String(format: "%.3f", tMixVal)))")
        }

        // Pre-compute the ControlNet context once (independent of timestep/latent).
        var cnetContext: MLXArray? = nil
        if useCnet, let cnet = controlnet, let ctrl33 = controlImage33ch {
            cnetContext = cnet.embedControl(ctrl33)
            print("   controlnet: context \(cnetContext!.shape), strength=\(controlnetStrength)")
        }

        print("   denoising \(img2img ? (steps - startStep) : steps) steps (cfg=\(cfgScale), mu=\(String(format: "%.3f", mu)))\(inpaintActive ? ", inpaint=on" : "")\(useCnet ? ", controlnet=on" : "")...")

        var stepTimes: [Double] = []
        var previousNoisePred: MLXArray? = nil
        for idx in startStep..<steps {
            let iterStart = Date()
            let tCurr = scheduler.timesteps![idx]
            // t_input = (1.0 - t_curr)[None] as bfloat16
            let tInput = (1.0 - tCurr).expandedDimensions(axis: -1).asType(.bfloat16)

            var blockTimings = BlockTimings()
            let onBlocks: ((BlockTimings) -> Void)? = profileBlocks ? { t in
                blockTimings.noiseRefinerMs += t.noiseRefinerMs
                blockTimings.contextRefinerMs += t.contextRefinerMs
                blockTimings.layersMs += t.layersMs
            } : nil

            var attnMlpTimings = AttnMlpTimings()
            let onAttnMlp: ((AttnMlpTimings) -> Void)? = profileAttnMlp ? { t in
                attnMlpTimings.attnMs += t.attnMs
                attnMlpTimings.mlpMs += t.mlpMs
            } : nil

            let noisePred: MLXArray
            if useCnet, let cnet = controlnet, let ctx = cnetContext {
                if cfgActive, let uncond = uncondFeats {
                    let cond = stepFnControlnet(latent: latents, timestep: tInput, capFeats: capFeats, inputs: stepInputs, controlnet: cnet, controlContext: ctx, strength: controlnetStrength, onBlockTimings: onBlocks)
                    let uncondPred = stepFnControlnet(latent: latents, timestep: tInput, capFeats: uncond, inputs: stepInputs, controlnet: cnet, controlContext: ctx, strength: controlnetStrength, onBlockTimings: onBlocks)
                    noisePred = uncondPred + cfgScale * (cond - uncondPred)
                } else {
                    noisePred = stepFnControlnet(latent: latents, timestep: tInput, capFeats: capFeats, inputs: stepInputs, controlnet: cnet, controlContext: ctx, strength: controlnetStrength, onBlockTimings: onBlocks)
                }
            } else if cfgActive, let uncond = uncondFeats {
                let cond = stepFn(latent: latents, timestep: tInput, capFeats: capFeats, inputs: stepInputs, onBlockTimings: onBlocks, onLayerAttnMlpTimings: onAttnMlp)
                let uncondPred = stepFn(latent: latents, timestep: tInput, capFeats: uncond, inputs: stepInputs, onBlockTimings: onBlocks, onLayerAttnMlpTimings: onAttnMlp)
                noisePred = uncondPred + cfgScale * (cond - uncondPred)
            } else {
                noisePred = stepFn(latent: latents, timestep: tInput, capFeats: capFeats, inputs: stepInputs, onBlockTimings: onBlocks, onLayerAttnMlpTimings: onAttnMlp)
            }

            // When profiling, force the forward pass to materialize now so its
            // cost is separated from the scheduler step below. This eval is an
            // EXTRA sync point that does not exist on the default path (see
            // comment on the profileSubsteps parameter).
            var forwardMs: Double = 0
            if profileSubsteps {
                MLX.eval(noisePred)
                forwardMs = iterStart.distance(to: Date()) * 1000
            }

            let schedStart = Date()
            latents = scheduler.step(modelOutput: noisePred, timestepIdx: idx, sample: latents)

            // Repaint (latent inpainting): re-inject the LOCKED region (mask=1,
            // e.g. a subject) from the forward-noised init latent at the NEXT
            // timestep, so only the background (mask=0) is free to re-denoise.
            // Flow-match interpolant is linear: x_t = (1-t)*clean + t*noise.
            // Matches pipeline.py:690-693.
            if let inpaintMask = mask, let clean = cleanLatent {
                // t_next is the NEXT timestep (the one we just stepped INTO).
                // On the final step there is no next — lock at t=0 (full clean).
                let tNext: MLXArray
                if idx + 1 < scheduler.timesteps!.shape[0] {
                    tNext = scheduler.timesteps![idx + 1]
                } else {
                    tNext = MLXArray(0.0)
                }
                let locked = ((1.0 - tNext) * clean + tNext * noise).asType(latents.dtype)
                latents = inpaintMask * locked + (1.0 - inpaintMask) * latents
            }

            MLX.eval(latents)
            let schedMs = schedStart.distance(to: Date()) * 1000
            // When not profiling, schedStart was set right after building the
            // (still-unevaluated) noisePred graph, so schedMs already captures
            // the whole step (forward + scheduler + repaint + eval) — identical
            // to the original single-timer measurement. When profiling,
            // forwardMs covers the piece schedStart no longer includes.
            let stepMs = forwardMs + schedMs
            stepTimes.append(stepMs)
            let avgMs = stepTimes.reduce(0, +) / Double(stepTimes.count)
            let stepMsg: String
            if profileSubsteps {
                stepMsg = "      step \(idx + 1)/\(steps) done  " +
                    "(forward \(String(format: "%.0f", forwardMs)) ms, " +
                    "sched \(String(format: "%.0f", schedMs)) ms, " +
                    "total \(String(format: "%.0f", stepMs)) ms, " +
                    "avg \(String(format: "%.0f", avgMs)) ms)"
            } else {
                stepMsg = "      step \(idx + 1)/\(steps) done  " +
                    "(\(String(format: "%.0f", stepMs)) ms, " +
                    "avg \(String(format: "%.0f", avgMs)) ms)"
            }
            print(stepMsg)
            if profileBlocks {
                print("         blocks: noiseRefiner \(String(format: "%.0f", blockTimings.noiseRefinerMs)) ms, " +
                    "contextRefiner \(String(format: "%.0f", blockTimings.contextRefinerMs)) ms, " +
                    "layers \(String(format: "%.0f", blockTimings.layersMs)) ms")
            }
            if profileAttnMlp {
                print("         layers attn/mlp: attn \(String(format: "%.0f", attnMlpTimings.attnMs)) ms, " +
                    "mlp \(String(format: "%.0f", attnMlpTimings.mlpMs)) ms")
            }
            if profileSimilarity {
                let curr = noisePred.asType(.float32)
                if let prev = previousNoisePred {
                    let l1 = MLX.abs(curr - prev).mean().item(Float.self)
                    let dot = (curr * prev).sum().item(Float.self)
                    let normCurr = MLX.sqrt((curr * curr).sum()).item(Float.self)
                    let normPrev = MLX.sqrt((prev * prev).sum()).item(Float.self)
                    let cosine = dot / (normCurr * normPrev + 1e-8)
                    print("         similarity vs prev step: L1=\(String(format: "%.5f", l1)), cosine=\(String(format: "%.5f", cosine))")
                }
                previousNoisePred = curr
            }
        }
        let runSteps = steps - startStep
        let totalMs = stepTimes.reduce(0, +)
        let totalSec = totalMs / 1000
        let perStep = String(format: "%.2f", totalSec / Double(runSteps))
        print("   denoise total: \(String(format: "%.2f", totalSec))s, avg \(perStep)s/it")

        // Capture per-step perf for the manifest (it/s, memory, total).
        lastPerf = GenerationPerf(
            steps: runSteps,
            startStep: startStep,
            stepTimesMs: stepTimes,
            totalSeconds: totalSec,
            peakMemoryMB: peakRSSMB(),
            width: width,
            height: height
        )

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
