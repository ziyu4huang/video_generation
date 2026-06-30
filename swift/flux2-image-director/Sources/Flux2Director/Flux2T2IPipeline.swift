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
        // VAE decode outputs [-1,1] (diffusers convention, symmetric with encoder);
        // convert to [0,1] for the image contract (matches loadArray/composite).
        let pixels = (vaeDecoder.decodePackedLatents(unpacked, bn: bn) * 0.5 + 0.5)
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

/// Flux2 Klein Edit pipeline: reference image conditioning (i2i / multi-ref).
/// Same transformer + scheduler, but reference image tokens are concatenated to
/// the noisy latents and the output is sliced to the noise tokens only.
public struct Flux2EditPipeline {
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

    /// Generate via reference conditioning. imagePaths provide the conditioning
    /// reference(s) (identity). When `initImagePath` is set with
    /// `denoiseStrength < 1.0`, that image becomes the **denoise canvas**
    /// (SDEdit-style partial denoise): its VAE-encoded latent is forward-mixed
    /// with the flow-match noise at sigma(steps*(1-strength)) and the loop runs
    /// only the last `steps*strength` steps — so the background's layout/POV is
    /// inherited as the actual canvas while identities still come from refs.
    /// Returns (pixels, elapsed seconds).
    public func generate(prompt: String, imagePaths: [URL], seed: UInt64,
                         height: Int, width: Int, steps: Int, guidance: Float,
                         initImagePath: URL? = nil, denoiseStrength: Float = 1.0,
                         refStrengths: [Float]? = nil, refGateSteps: Float = 1.0)
        -> (MLXArray, Double)
    {
        let start = DispatchTime.now()

        // 1. Text encode.
        var tok = tokenizer
        let (ids, mask) = tok.tokenize(prompt, maxLength: 512)
        let promptEmbeds = textEncoder.getPromptEmbeds(
            MLXArray(ids.map { Int32($0) }).reshaped([1, -1]),
            attentionMask: MLXArray(mask.map { Int32($0) }).reshaped([1, -1]),
            hiddenStateLayers: [9, 18, 27]).asType(.bfloat16)
        let textIds = Flux2LatentCreator.prepareTextIds(seqLen: promptEmbeds.dim(1), batchSize: 1)

        // 2. Noise latents + ids.
        let (latents, latentIds, latentH, latentW) = Flux2LatentCreator.preparePackedLatents(
            seed: seed, height: height, width: width, batchSize: 1)
        let noiseLen = latents.dim(1)

        // 3. Reference image conditioning (identity tokens, concatenated each step).
        //    refStrengths scales each ref's tokens (WS3); refGateSteps caps the
        //    fraction of early steps that inject refs (applied in the loop below).
        let (imageLatents, imageLatentIds) = Flux2ReferenceConditioning.prepare(
            imagePaths: imagePaths, vaeEncoder: vaeEncoder, bn: bn,
            height: height, width: width, batchSize: 1, strengths: refStrengths)
        let gateStepIdx = refGateSteps >= 1.0
            ? steps
            : max(0, Int((Float(steps) * refGateSteps).rounded(.toNearestOrEven)))
        if refGateSteps < 1.0 {
            print("   ref gate: refs injected on steps 1..\(gateStepIdx)/\(steps) (gate=\(refGateSteps))")
        }

        // 4. Scheduler.
        let scheduler = Flux2Scheduler(
            imageSeqLen: (height / 16) * (width / 16), numInferenceSteps: steps)

        // 4b. SDEdit init canvas (background-as-canvas). Encode the init image
        // into the same BN-normalized denoise space as the noise, then flow-mix:
        //   x_{t0} = (1 - sigma[startStep]) * init + sigma[startStep] * noise
        // and denoise only the last `stepsToRun` steps (mirrors z-image's
        // cleanLatent/denoiseStrength: pipeline.py:595-604). strength 0.3=light
        // refine, 0.5=restyle keeping layout, 0.7=loose redraw. No init image
        // (or strength >= 1.0) falls back to the v1 pure-noise path.
        var startStep = 0
        var current: MLXArray
        if let bgPath = initImagePath, denoiseStrength < 1.0 {
            let stepsToRun = max(1, Int((Float(steps) * denoiseStrength).rounded(.toNearestOrEven)))
            startStep = max(0, steps - stepsToRun)
            let sigmaMix = scheduler.sigmas[startStep]
            let initPacked = Flux2LatentCreator.encodeInitLatent(
                imagePath: bgPath, vaeEncoder: vaeEncoder, bn: bn,
                height: height, width: width).asType(latents.dtype)
            current = ((1.0 - sigmaMix) * initPacked + sigmaMix * latents).asType(.bfloat16)
            print("   canvas: init=\(bgPath.lastPathComponent), \(stepsToRun)/\(steps) steps from step \(startStep + 1) (strength=\(denoiseStrength), sigma_mix=\(String(format: "%.3f", sigmaMix.item(Float.self))))")
        } else {
            current = latents
        }

        // 5. Denoise: concat [working, ref] tokens, slice output to working tokens.
        for t in startStep..<steps {
            let ts = scheduler.timesteps[t].asType(.bfloat16).reshaped([1])
            // Timestep gating (WS3): only inject ref tokens in the early
            // fraction of steps (t < gateStepIdx). After the gate, refs are
            // dropped so the model finishes the scene without their pull.
            let injectRefs = t < gateStepIdx
            let (hiddenStates, imgIds): (MLXArray, MLXArray)
            if injectRefs, let imgLat = imageLatents, let imgIds2 = imageLatentIds {
                hiddenStates = MLX.concatenated([current, imgLat], axis: 1)
                imgIds = MLX.concatenated([latentIds, imgIds2], axis: 1)
            } else {
                hiddenStates = current
                imgIds = latentIds
            }
            var noise = transformer(
                hiddenStates: hiddenStates, encoderHiddenStates: promptEmbeds,
                timestep: ts, imgIds: imgIds, txtIds: textIds)
            // Keep only the noise for the actual latents (discard ref-token output).
            noise = noise[0..., 0..<noiseLen, 0...]
            current = scheduler.step(noise: noise, timestep: t, latents: current)
            MLX.eval(current)
        }

        // 6. VAE decode. VAE outputs [-1,1]; convert to [0,1] (see T2IPipeline).
        let unpacked = current.reshaped([1, latentH, latentW, current.dim(2)])
            .transposed(0, 3, 1, 2)
        let pixels = (vaeDecoder.decodePackedLatents(unpacked, bn: bn) * 0.5 + 0.5)
            .asType(.float32)
        MLX.eval(pixels)
        let elapsed = Double(DispatchTime.now().uptimeNanoseconds - start.uptimeNanoseconds) / 1e9
        return (pixels, elapsed)
    }

    /// Outpaint / image expansion (擴圖) via latent-mask re-injection. The original
    /// is centered on a larger canvas (edge-replicated fill); its VAE-encoded
    /// latent is re-injected into the kept region every step (mask 0) so the
    /// original survives bit-for-bit, while the padded margins (mask 1) denoise
    /// from the prompt. A final pixel composite makes the kept region exact.
    /// `inputPixels` is the loaded source (1,3,iH,iW) [0,1]; canvas size is derived
    /// from `expand`/`pixels`. Returns (pixels (1,3,cH,cW) [0,1], elapsed seconds).
    public func outpaint(prompt: String, inputPixels: MLXArray,
                         inputWidth: Int, inputHeight: Int,
                         expand: String, pixels: Int, feather: Int,
                         seed: UInt64, steps: Int, guidance: Float)
        -> (MLXArray, Double)
    {
        let start = DispatchTime.now()

        // 1. Plan + padded canvas + latent/pixel masks.
        let plan = Flux2Outpaint.plan(expand: expand, pixels: pixels,
                                      inputWidth: inputWidth, inputHeight: inputHeight)
        let padded = Flux2Outpaint.buildPaddedCanvas(input: inputPixels, plan: plan)
        let (latentMask, pixelMask) = Flux2Outpaint.buildMasks(plan: plan, feather: feather)
        let height = plan.canvasHeight, width = plan.canvasWidth
        print("   canvas: \(inputWidth)×\(inputHeight) → \(width)×\(height)  "
              + "(L\(plan.left) R\(plan.right) T\(plan.top) B\(plan.bottom), feather=\(feather))")

        // 2. Text encode.
        var tok = tokenizer
        let (ids, mask) = tok.tokenize(prompt, maxLength: 512)
        let promptEmbeds = textEncoder.getPromptEmbeds(
            MLXArray(ids.map { Int32($0) }).reshaped([1, -1]),
            attentionMask: MLXArray(mask.map { Int32($0) }).reshaped([1, -1]),
            hiddenStateLayers: [9, 18, 27]).asType(.bfloat16)
        let textIds = Flux2LatentCreator.prepareTextIds(seqLen: promptEmbeds.dim(1), batchSize: 1)

        // 3. Noise latents + init latent (BN-normalized packed — same denoise space).
        let (latents, latentIds, latentH, latentW) = Flux2LatentCreator.preparePackedLatents(
            seed: seed, height: height, width: width, batchSize: 1)
        let noiseLen = latents.dim(1)
        let initLatent = Flux2LatentCreator.encodeInitLatent(
            pixels: padded, vaeEncoder: vaeEncoder, bn: bn,
            height: height, width: width).asType(latents.dtype)

        // 4. Reference conditioning on the padded canvas (content coherence for the
        //    generated margins). Write the in-memory canvas to a temp PNG (prepare
        //    reads paths); cleaned up after.
        let tmpURL = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("flux2_outpaint_\(seed)_canvas.png")
        try? Flux2T2IPipeline.saveImage(padded, to: tmpURL)
        defer { try? FileManager.default.removeItem(at: tmpURL) }
        let (imageLatents, imageLatentIds) = Flux2ReferenceConditioning.prepare(
            imagePaths: [tmpURL], vaeEncoder: vaeEncoder, bn: bn,
            height: height, width: width, batchSize: 1)

        // 5. Scheduler.
        let scheduler = Flux2Scheduler(
            imageSeqLen: (height / 16) * (width / 16), numInferenceSteps: steps)

        // 6. Denoise with per-step mask re-injection:
        //    margins (mask 1) take the denoised step; kept region (mask 0) is forced
        //    back to the encoded original latent.
        var current = latents
        for t in 0..<steps {
            let ts = scheduler.timesteps[t].asType(.bfloat16).reshaped([1])
            let hiddenStates = MLX.concatenated([current, imageLatents!], axis: 1)
            let imgIds = MLX.concatenated([latentIds, imageLatentIds!], axis: 1)
            var noise = transformer(
                hiddenStates: hiddenStates, encoderHiddenStates: promptEmbeds,
                timestep: ts, imgIds: imgIds, txtIds: textIds)
            noise = noise[0..., 0..<noiseLen, 0...]
            let stepped = scheduler.step(noise: noise, timestep: t, latents: current)
            current = (latentMask * stepped + (1.0 - latentMask) * initLatent).asType(.bfloat16)
            MLX.eval(current)
        }

        // 7. Decode → generated, then composite the true original back (bit-perfect).
        let unpacked = current.reshaped([1, latentH, latentW, current.dim(2)]).transposed(0, 3, 1, 2)
        let generated = (vaeDecoder.decodePackedLatents(unpacked, bn: bn) * 0.5 + 0.5).asType(.float32)
        let final = Flux2Outpaint.composite(generated: generated, padded: padded, pixelMask: pixelMask)
        MLX.eval(final)
        let elapsed = Double(DispatchTime.now().uptimeNanoseconds - start.uptimeNanoseconds) / 1e9
        return (final, elapsed)
    }

    /// Seamless inpaint / swap (无痕换脸). Regenerates the masked region of the
    /// source (mask 1 = regenerate, e.g. a face/object) guided by `prompt` + an
    /// optional reference image (identity), while locking the rest of the source
    /// bit-for-bit via latent re-injection + a final pixel composite. This is the
    /// model-driven seamless path (vs SwapCommand's feathered paste): no hard seam.
    /// `sourcePixels` (1,3,H,W) [0,1], `sourceMask` (1,1,H,W) [0,1] (1=regenerate).
    public func inpaint(prompt: String, sourcePixels: MLXArray, sourceMask: MLXArray,
                        referencePath: URL?, seed: UInt64, steps: Int, guidance: Float,
                        width: Int, height: Int, feather: Int, denoiseStrength: Float = 1.0)
        -> (MLXArray, Double)
    {
        let start = DispatchTime.now()

        // 1. Text encode.
        var tok = tokenizer
        let (ids, mask) = tok.tokenize(prompt, maxLength: 512)
        let promptEmbeds = textEncoder.getPromptEmbeds(
            MLXArray(ids.map { Int32($0) }).reshaped([1, -1]),
            attentionMask: MLXArray(mask.map { Int32($0) }).reshaped([1, -1]),
            hiddenStateLayers: [9, 18, 27]).asType(.bfloat16)
        let textIds = Flux2LatentCreator.prepareTextIds(seqLen: promptEmbeds.dim(1), batchSize: 1)

        // 2. Noise latents + init latent (the SOURCE is the canvas; outside-mask kept).
        let (latents, latentIds, latentH, latentW) = Flux2LatentCreator.preparePackedLatents(
            seed: seed, height: height, width: width, batchSize: 1)
        let noiseLen = latents.dim(1)
        let initLatent = Flux2LatentCreator.encodeInitLatent(
            pixels: sourcePixels, vaeEncoder: vaeEncoder, bn: bn,
            height: height, width: width).asType(latents.dtype)

        // 3. Latent mask: 1 over the object (regenerate), 0 elsewhere (keep).
        let latentMask = Flux2Outpaint.downsampleMaskToLatent(
            sourceMask, latentH: latentH, latentW: latentW).asType(latents.dtype)

        // 4. Reference conditioning (identity for the regenerated content), optional.
        var imageLatents: MLXArray? = nil
        var imageLatentIds: MLXArray? = nil
        if let ref = referencePath {
            (imageLatents, imageLatentIds) = Flux2ReferenceConditioning.prepare(
                imagePaths: [ref], vaeEncoder: vaeEncoder, bn: bn,
                height: height, width: width, batchSize: 1)
        }

        // 5. Scheduler + denoise with re-injection (object denoised, rest locked).
        // denoiseStrength < 1.0 = SDEdit partial denoise on the masked region:
        // start from a lightly-noised copy of the existing scene (initLatent)
        // instead of pure noise, and run only the last `stepsToRun` steps. This
        // REFINES identity into the strip without fully re-rolling hands (the
        // failure mode that made `--regional` net-negative). Mirrors the
        // background-as-canvas SDEdit path above (generate, line ~184).
        let scheduler = Flux2Scheduler(
            imageSeqLen: (height / 16) * (width / 16), numInferenceSteps: steps)
        var startStep = 0
        var current: MLXArray
        if denoiseStrength < 1.0 {
            let stepsToRun = max(1, Int((Float(steps) * denoiseStrength).rounded(.toNearestOrEven)))
            startStep = max(0, steps - stepsToRun)
            let sigmaMix = scheduler.sigmas[startStep]
            current = ((1.0 - sigmaMix) * initLatent + sigmaMix * latents).asType(.bfloat16)
        } else {
            current = latents
        }
        for t in startStep..<steps {
            let ts = scheduler.timesteps[t].asType(.bfloat16).reshaped([1])
            let hiddenStates: MLXArray, imgIds: MLXArray
            if let imgLat = imageLatents, let imgIds2 = imageLatentIds {
                hiddenStates = MLX.concatenated([current, imgLat], axis: 1)
                imgIds = MLX.concatenated([latentIds, imgIds2], axis: 1)
            } else {
                hiddenStates = current; imgIds = latentIds
            }
            var noise = transformer(
                hiddenStates: hiddenStates, encoderHiddenStates: promptEmbeds,
                timestep: ts, imgIds: imgIds, txtIds: textIds)
            noise = noise[0..., 0..<noiseLen, 0...]
            let stepped = scheduler.step(noise: noise, timestep: t, latents: current)
            current = (latentMask * stepped + (1.0 - latentMask) * initLatent).asType(.bfloat16)
            MLX.eval(current)
        }

        // 6. Decode → generated; composite the true source back outside the mask.
        let unpacked = current.reshaped([1, latentH, latentW, current.dim(2)]).transposed(0, 3, 1, 2)
        let generated = (vaeDecoder.decodePackedLatents(unpacked, bn: bn) * 0.5 + 0.5).asType(.float32)
        let h = sourceMask.dim(2), w = sourceMask.dim(3)
        let seamMask = MLX.clip(
            Flux2Composite.featherMask(sourceMask.reshaped([h, w]).asType(.float32), radius: feather)
                .reshaped([1, 1, h, w]), min: 0.0, max: 1.0)
        let final = Flux2Outpaint.composite(generated: generated, padded: sourcePixels, pixelMask: seamMask)
        MLX.eval(final)
        let elapsed = Double(DispatchTime.now().uptimeNanoseconds - start.uptimeNanoseconds) / 1e9
        return (final, elapsed)
    }
}
