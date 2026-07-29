//
//  KontextPipeline.swift
//  Flux2Director
//
//  End-to-end Kontext (FLUX.1-Kontext-dev) in-context generation. Wires the
//  already-verified KontextTransformer/KontextCLIPEncoder/KontextT5Encoder +
//  reused ZImageVAEEncoder/ZImageVAEDecoder into a real denoise loop, ported
//  line-for-line from ../mflux's Flux1Kontext.generate_image /
//  KontextUtil.create_image_conditioning_latents / Transformer.__call__ /
//  LinearScheduler (dev-kontext: requires_sigma_shift=true, num_train_steps=
//  1000, sigma_base_shift=0.5, sigma_max_shift=1.15, sigma_base_seq_len=256,
//  sigma_max_seq_len=4096, no sigma_shift_terminal). See the design plan's
//  "Design decisions carried from research" section for citations.
//
//  Distinct from Flux2EditPipeline: no CFG (guidance is a distilled embedding,
//  one transformer call per step), no img2img partial-denoise (Kontext's
//  image_strength is never set — always full noise-to-image), single hero
//  image only (no multi-ref).
//

import CommonImageDirector
import Foundation
import MLX
import MLXRandom
import ZImageDirector

public struct KontextPipeline {
    public let transformer: KontextTransformer
    public let clipEncoder: KontextCLIPEncoder
    public let t5Encoder: KontextT5Encoder
    public let vaeEncoder: ZImageVAEEncoder
    public let vaeDecoder: ZImageVAEDecoder
    public var clipTokenizer: KontextCLIPTokenizer
    public let t5Tokenizer: KontextT5Tokenizer

    public init(transformer: KontextTransformer, clipEncoder: KontextCLIPEncoder,
                t5Encoder: KontextT5Encoder, vaeEncoder: ZImageVAEEncoder,
                vaeDecoder: ZImageVAEDecoder, clipTokenizer: KontextCLIPTokenizer,
                t5Tokenizer: KontextT5Tokenizer) {
        self.transformer = transformer
        self.clipEncoder = clipEncoder
        self.t5Encoder = t5Encoder
        self.vaeEncoder = vaeEncoder
        self.vaeDecoder = vaeDecoder
        self.clipTokenizer = clipTokenizer
        self.t5Tokenizer = t5Tokenizer
    }

    /// Generate an in-context render. `heroImagePath` is the identity anchor
    /// (single reference image — NOT multi-ref). Returns (pixels (1,3,H,W)
    /// float32 in [0,1], elapsed seconds).
    public func generate(prompt: String, heroImagePath: URL, seed: UInt64,
                         width: Int, height: Int, steps: Int, guidance: Float)
        -> (MLXArray, Double)
    {
        let start = DispatchTime.now()

        // 1. Text encode (T5 prompt_embeds + CLIP pooled_prompt_embeds).
        //    max_sequence_length=512 for T5 (dev-kontext's ModelConfig), 77 for
        //    CLIP (KontextCLIPTokenizer.maxLength, fixed).
        let t5Ids = t5Tokenizer.tokenize(prompt, maxLength: 512)
        let promptEmbeds = t5Encoder(MLXArray(t5Ids.map { Int32($0) }).reshaped([1, -1]))
            .asType(.bfloat16)
        var clipTok = clipTokenizer
        let clipIds = clipTok.tokenize(prompt)
        let pooledPromptEmbeds = clipEncoder(MLXArray(clipIds.map { Int32($0) }).reshaped([1, -1]))
            .asType(.bfloat16)

        // 2. Hero image conditioning: resize to (width,height) [stretch, matches
        //    ImageUtil.scale_to_dimensions], normalize [-1,1], VAE-encode, pack.
        let heroPixels = try! Flux2ImageLoad.loadArray(from: heroImagePath, targetSize: (width: width, height: height))
        let heroNormalized = Flux2ImageLoad.normalizeForVAE(heroPixels).asType(.bfloat16)
        let heroLatent = vaeEncoder(heroNormalized).asType(.float32)
        let referenceLatents = KontextLatentCreator.packLatents(heroLatent, height: height, width: width)
            .asType(.bfloat16)
        let referenceIds = KontextUtil.createImageIds(height: height, width: width)
        let generationIds = KontextUtil.createGenerationImageIds(height: height, width: width)
        let imageIds = MLX.concatenated([generationIds, referenceIds], axis: 1)

        // 3. Noise latents. Matches Flux2LatentCreator.preparePackedLatents's
        //    MLXRandom.key(seed) convention for reproducibility.
        let imgSeqLen = (height / 16) * (width / 16)
        let key = MLXRandom.key(seed)
        var current = MLXRandom.normal([1, imgSeqLen, 64], dtype: .float32, key: key).asType(.bfloat16)

        // 4. Sigma schedule (linear + sigma-shift, dev-kontext constants).
        let sigmas = KontextPipeline.sigmaSchedule(steps: steps, width: width, height: height)
        MLX.eval(sigmas)

        // 5. Denoise loop. No CFG (single transformer call/step, guidance is a
        //    distilled embedding), no img2img blend (Kontext always starts
        //    from pure noise — init_time_step is always 0 in the Python ref).
        for t in 0..<steps {
            let sigmaT = sigmas[t].item(Float.self)
            let timeStep = MLXArray([sigmaT * 1000]).asType(.bfloat16)
            let guidanceVal = MLXArray([guidance * 1000]).asType(.bfloat16)

            let hiddenStates = MLX.concatenated([current, referenceLatents], axis: 1)
            var noise = transformer(
                timeStep: timeStep, guidance: guidanceVal, hiddenStates: hiddenStates,
                promptEmbeds: promptEmbeds, pooledPromptEmbeds: pooledPromptEmbeds,
                imageIds: imageIds)
            noise = noise[0..., 0..<imgSeqLen, 0...]

            let dt = (sigmas[t + 1] - sigmas[t]).asType(current.dtype)
            current = (current + noise.asType(current.dtype) * dt).asType(.bfloat16)
            MLX.eval(current)
        }

        // 6. Unpack (16ch, NOT Klein's 128ch) + VAE decode + denormalize.
        let unpacked = KontextLatentCreator.unpackLatents(current, height: height, width: width)
        let decoded = vaeDecoder(unpacked).asType(.float32)
        let pixels = MLX.clip(decoded * 0.5 + 0.5, min: 0.0, max: 1.0)
        MLX.eval(pixels)

        let elapsed = Double(DispatchTime.now().uptimeNanoseconds - start.uptimeNanoseconds) / 1e9
        return (pixels, elapsed)
    }

    /// Linear scheduler sigma schedule with dev-kontext's sigma-shift applied.
    /// Matches ../mflux's LinearScheduler._get_sigmas exactly (requires_sigma_shift
    /// =true, sigma_base_shift=0.5, sigma_max_shift=1.15, sigma_base_seq_len=256,
    /// sigma_max_seq_len=4096, sigma_shift_terminal unset for dev-kontext).
    static func sigmaSchedule(steps: Int, width: Int, height: Int) -> MLXArray {
        // sigmas = linspace(1.0, 1.0/N, N), float32 (reuses Flux2Scheduler.swift's
        // `linspace` free function — MLX-Swift doesn't expose linspace directly).
        let base = linspace(1.0, 1.0 / Double(steps), count: steps)

        let sigmaBaseShift: Float = 0.5
        let sigmaMaxShift: Float = 1.15
        let sigmaBaseSeqLen: Float = 256
        let sigmaMaxSeqLen: Float = 4096
        let m = (sigmaMaxShift - sigmaBaseShift) / (sigmaMaxSeqLen - sigmaBaseSeqLen)
        let b = sigmaBaseShift - m * sigmaBaseSeqLen
        let mu = m * Float(width) * Float(height) / 256 + b

        // exp(mu) / (exp(mu) + (1/sigma - 1)) — sigma_power=1 (LinearScheduler,
        // unlike Flux2Scheduler's exponential variant).
        let expMu = MLX.exp(MLXArray(mu))
        let shifted = expMu / (expMu + (1.0 / base - 1.0))
        return MLX.concatenated([shifted, MLX.zeros([1])], axis: 0)
    }

    /// Clamp pixels to [0,1] and save as PNG (mirrors Flux2T2IPipeline.saveImage).
    public static func saveImage(_ pixels: MLXArray, to url: URL) throws {
        let clamped = MLX.clip(pixels, min: 0.0, max: 1.0)
        try ImageSave.savePNG(clamped, to: url)
    }
}
