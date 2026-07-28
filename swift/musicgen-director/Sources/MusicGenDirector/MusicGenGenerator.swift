//
//  MusicGenGenerator.swift
//  MusicGenDirector
//
//  The autoregressive generation loop: classifier-free guidance (real +
//  null text conditioning, two separate batch-1 forward calls per step —
//  MusicGenDecoder's cross-attention only supports a batch-1
//  encoderHiddenStates, see MusicGenDecoder.swift's MGDecoderAttention:
//  `shapeKV` reshapes the key/value input using the QUERY's batch dim, so a
//  real batch-2 forward isn't possible without changing that file; two
//  batch-1 calls is the only working approach for v1, not just a
//  simplification), top-k sampling, delay-pattern bookkeeping (Task 4),
//  EnCodec decode (Task 5).
//
//  v1 has NO KV cache (see MusicGenDecoder's header) — every step recomputes
//  the full prefix's attention. This is O(maxLength^3)-ish and genuinely
//  slow for long durations; callers should default to short durations for
//  quick self-tests and expect multi-minute runs at 30s (this tradeoff was
//  confirmed acceptable for v1 — see this plan's Task 8 preamble / the
//  KV-cache-deferred decision made before writing this plan).
//
//  Text conditioning attention mask: MusicGenT5Encoder.callAsFunction
//  REQUIRES a real attentionMask (see that file's header: cos=0.33 unmasked
//  vs 1.00000 masked on padded prompts). KontextT5Tokenizer.tokenize(_:
//  maxLength:) always right-pads with token id 0 (`<pad>`, confirmed by
//  reading KontextT5Tokenizer.swift: `padId = 0`, appended after content+eos
//  up to maxLength) — so a real attention mask is derived here as
//  `id != 0 ? 1 : 0` per position, matching the HF tokenizer convention
//  VerifyT5Command.swift's reference data uses.
//
//  Null (unconditional) text conditioning: encode the empty string ""
//  through the same real T5 (tokenizes to [eos, pad, pad, ...], with a real
//  attention mask that only attends to the eos position), then zero the
//  result. This matches audiocraft's T5Conditioner null-embedding path
//  (forward a real empty prompt to preserve shape/dtype/masking semantics,
//  then zero the values) rather than substituting an arbitrary zero array.
//

import Foundation
import MLX
import Flux2Director   // KontextT5Tokenizer reuse — see Package.swift header

public struct MusicGenGenerationConfig {
    public var duration: Float = 30.0
    public var cfgCoef: Float = 3.0
    public var topK: Int = 250
    public var temperature: Float = 1.0
    public var seed: UInt64? = nil

    public init(duration: Float = 30.0, cfgCoef: Float = 3.0, topK: Int = 250,
                temperature: Float = 1.0, seed: UInt64? = nil) {
        self.duration = duration; self.cfgCoef = cfgCoef; self.topK = topK
        self.temperature = temperature; self.seed = seed
    }
}

public final class MusicGenGenerator {
    let tokenizer: KontextT5Tokenizer
    let t5: MusicGenT5Encoder
    let decoder: MusicGenDecoder
    let encodec: MusicGenEncodecAdapter
    static let t5MaxLength = 64   // matches gen_musicgen_t5_ref.py's fixed prompt length
    /// Real HF T5 tokenizer pad-token id (`<pad>`, vocab index 0) — mirrors
    /// KontextT5Tokenizer.padId, which isn't `public` (internal to
    /// Flux2Director), so this module re-derives the attention mask from the
    /// well-known convention instead of reaching into that private constant.
    static let t5PadTokenId = 0

    public init(tokenizer: KontextT5Tokenizer, t5: MusicGenT5Encoder, decoder: MusicGenDecoder, encodec: MusicGenEncodecAdapter) {
        self.tokenizer = tokenizer
        self.t5 = t5
        self.decoder = decoder
        self.encodec = encodec
    }

    /// Full text-to-music generation. Returns the decoded waveform,
    /// shape (samples,), at `encodec.sampleRate`.
    public func generate(prompt: String, config: MusicGenGenerationConfig) -> MLXArray {
        if let seed = config.seed { MLXRandom.seed(seed) }

        // Real conditioning.
        let realIds = tokenizer.tokenize(prompt, maxLength: Self.t5MaxLength)
        let realIdsArr = MLXArray(realIds.map { Int32($0) }, [1, Self.t5MaxLength])
        let realMask = Self.attentionMask(forIds: realIds)
        let condHidden = t5(realIdsArr, attentionMask: realMask)   // (1, t5MaxLength, 768)

        // Null conditioning: encode "" through the same real T5 (with its own
        // real attention mask), then zero — see file header for why this is
        // the real audiocraft-matching approach, not an approximation.
        let nullIds = tokenizer.tokenize("", maxLength: Self.t5MaxLength)
        let nullIdsArr = MLXArray(nullIds.map { Int32($0) }, [1, Self.t5MaxLength])
        let nullMask = Self.attentionMask(forIds: nullIds)
        let uncondHidden = t5(nullIdsArr, attentionMask: nullMask) * MLXArray(Float(0))

        let totalGenLen = Int((config.duration * Float(encodec.frameRate)).rounded())
        let maxLength = totalGenLen + MusicGenDecoder.numCodebooks
        let patternMask = DelayPattern.buildMask(numCodebooks: MusicGenDecoder.numCodebooks, maxLength: maxLength)

        // raw[codebook][t] — a single shared token history: both the cond
        // and uncond decoder branches see the SAME generated tokens once
        // CFG-blended (matches audiocraft's shared decoder_input_ids).
        var raw = [[Int32]](repeating: [Int32](repeating: DelayPattern.padTokenId, count: maxLength),
                            count: MusicGenDecoder.numCodebooks)
        DelayPattern.apply(&raw, mask: patternMask)   // forces t=0 (and any other bos/eos-region cell) per codebook

        for t in 1..<maxLength {
            let prefixLen = t
            let prefixArr = MLXArray(raw.flatMap { Array($0[0..<prefixLen]) }, [MusicGenDecoder.numCodebooks, prefixLen])

            let condLogits = decoder(inputIds: prefixArr, encoderHiddenStates: condHidden)
            let uncondLogits = decoder(inputIds: prefixArr, encoderHiddenStates: uncondHidden)

            let condLast = condLogits[0..., prefixLen - 1, 0...]     // (numCodebooks, vocab)
            let uncondLast = uncondLogits[0..., prefixLen - 1, 0...]
            let blended = uncondLast + config.cfgCoef * (condLast - uncondLast)

            let sampled = Self.topKSample(logits: blended, topK: config.topK, temperature: config.temperature)
            let sampledInts: [Int32] = sampled.asArray(Int32.self)
            for c in 0..<MusicGenDecoder.numCodebooks { raw[c][t] = sampledInts[c] }
            DelayPattern.apply(&raw, mask: patternMask)   // re-force any bos/eos-region cell at this new t
        }

        let clean = DelayPattern.deinterleave(raw, frameCount: totalGenLen)
        let cleanArr = MLXArray(clean.flatMap { $0 }, [MusicGenDecoder.numCodebooks, totalGenLen])
        let waveform = encodec.decode(codes: cleanArr)   // (batch=1, samples, channels=1)
        return waveform.reshaped([-1])
    }

    /// HF tokenizer-convention attention mask: 1 at real-token positions
    /// (content + eos), 0 at trailing pad positions (id == t5PadTokenId).
    static func attentionMask(forIds ids: [Int]) -> MLXArray {
        let maskInts: [Int32] = ids.map { $0 == t5PadTokenId ? 0 : 1 }
        return MLXArray(maskInts, [1, ids.count])
    }

    /// Top-k + temperature categorical sampling, per codebook row.
    /// `logits`: (numCodebooks, vocab). Returns (numCodebooks,) int32 token ids.
    static func topKSample(logits: MLXArray, topK: Int, temperature: Float) -> MLXArray {
        let k = min(topK, logits.dim(-1))
        // MLX.top returns the k largest VALUES per row, NOT necessarily in
        // sorted order (confirmed from mlx-swift's Ops.swift doc comment:
        // "will not necessarily be in sorted order") — so the top-k
        // threshold must be the row-wise MIN of that unordered set, not
        // element [0].
        let topValues = MLX.top(logits, k: k, axis: -1)               // (numCodebooks, k)
        let threshold = MLX.min(topValues, axis: -1, keepDims: true)  // (numCodebooks, 1)
        let masked = MLX.where(logits .>= threshold, logits, MLXArray(-Float.infinity))
        let scaled = temperature == 1.0 ? masked : masked / temperature
        let sampled = MLX.categorical(scaled, axis: -1)   // UInt32, (numCodebooks,)
        return sampled.asType(.int32)
    }
}
