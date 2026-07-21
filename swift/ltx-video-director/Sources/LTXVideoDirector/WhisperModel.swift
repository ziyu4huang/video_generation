//
//  WhisperModel.swift
//  LTXVideoDirector
//
//  Fifth real piece of the native Swift/MLX Whisper port — a real-checkpoint
//  loader (WhisperModel.load) plus a greedy autoregressive decode loop
//  (WhisperModel.transcribe), closing the loop opened by WhisperMel.swift /
//  WhisperEncoder.swift / WhisperDecoder.swift / WhisperTokenizer.swift into
//  an actual end-to-end native transcription path.
//
//  Deliberately NO KV cache: mlx_whisper's decode loop caches per-layer
//  self-attn K/V (avoiding recomputation over the growing token prefix) and
//  cross-attn K/V (computed once, reused every step, since it never changes
//  after the first step — see ResidualAttentionBlock's `cross_kv` handling).
//  This port instead re-runs the full decoder over the ENTIRE token prefix
//  every step — O(steps) decoder forward passes instead of O(1) incremental
//  ones. Correct (WhisperDecoder.callAsFunction already IS the correct
//  from-scratch forward for any prefix — a KV cache is a performance
//  optimization, not a different computation) but slower; for the short
//  single-utterance zh clips this ASR gate actually verifies (a handful of
//  characters, well under WhisperTokenizer's n_text_ctx=448), this is a
//  deliberate, documented "make it correct first" tradeoff — same
//  "ship the real math now, optimize later" call this package already made
//  elsewhere (e.g. VideoTiling's early single-tile path before the
//  trapezoid-weighted tiling landed). Adding a real KV cache remains a
//  legitimate follow-up once this path proves out.
//

import Foundation
import MLX

public struct WhisperModel {
    public let encoder: WhisperEncoder
    public let decoder: WhisperDecoder
    /// Decoder layer / head counts — needed to compute the DTW alignment-head
    /// set (default: last-half layers, all heads) for word alignment.
    public let nDecoderLayer: Int
    public let nHead: Int

    public init(encoder: WhisperEncoder, decoder: WhisperDecoder, nDecoderLayer: Int = 0, nHead: Int = 0) {
        self.encoder = encoder
        self.decoder = decoder
        self.nDecoderLayer = nDecoderLayer
        self.nHead = nHead
    }

    public enum LoadError: Error, CustomStringConvertible {
        case checkpointNotFound(String)
        case missingWeight(String)

        public var description: String {
            switch self {
            case .checkpointNotFound(let p): return "Whisper checkpoint not found at \(p)"
            case .missingWeight(let k): return "checkpoint missing expected weight key \(k)"
            }
        }
    }

    /// Loads a full whisper-*-mlx checkpoint (a single `weights.npz`, the
    /// same format `mlx.core.load` reads — e.g. the file cached at
    /// `~/.cache/huggingface/hub/models--mlx-community--whisper-large-v3-mlx/
    /// snapshots/*/weights.npz`). `nLayer`/`nHead` must match the
    /// checkpoint's `config.json` (large-v3: 32/20 for both encoder+decoder).
    public static func load(checkpointPath: String, nEncoderLayer: Int, nDecoderLayer: Int, nHead: Int) throws -> WhisperModel {
        guard FileManager.default.fileExists(atPath: checkpointPath) else {
            throw LoadError.checkpointNotFound(checkpointPath)
        }
        let weights = try MLX.loadArrays(url: URL(fileURLWithPath: checkpointPath))
        func w(_ key: String) throws -> MLXArray {
            guard let v = weights[key] else { throw LoadError.missingWeight(key) }
            // float16 — NOT float32. mlx_whisper loads the whole model with
            // dtype=mx.float16 and runs the forward in float16. For DECODE this
            // is cosmetic (argmax is dtype-robust, so P2a text parity held even
            // when this port ran float32), but for DTW WORD ALIGNMENT it is
            // load-bearing: find_alignment consumes the cross-attention QK
            // (q@k over 1500 audio frames) → softmax → z-score → DTW, and that
            // pipeline is acutely sensitive to float16 vs float32 rounding.
            // A float32 forward produces a visibly different attention
            // distribution (the noTimestamps row peaks at a different frame),
            // which warps the DTW path and drifts per-word timestamps ~1.26×.
            // Matching mlx_whisper's float16 here is what makes the alignment
            // numerically match. See WhisperAlignment.swift.
            return v.asType(.float16)
        }

        var encoderBlocks: [WhisperEncoderBlock] = []
        for i in 0..<nEncoderLayer {
            let p = "encoder.blocks.\(i)."
            let attn = WhisperAttention(
                numHeads: nHead,
                queryWeight: try w(p + "attn.query.weight"), queryBias: try w(p + "attn.query.bias"),
                keyWeight: try w(p + "attn.key.weight"),
                valueWeight: try w(p + "attn.value.weight"), valueBias: try w(p + "attn.value.bias"),
                outWeight: try w(p + "attn.out.weight"), outBias: try w(p + "attn.out.bias")
            )
            encoderBlocks.append(WhisperEncoderBlock(
                attn: attn,
                attnLnWeight: try w(p + "attn_ln.weight"), attnLnBias: try w(p + "attn_ln.bias"),
                mlp1Weight: try w(p + "mlp1.weight"), mlp1Bias: try w(p + "mlp1.bias"),
                mlp2Weight: try w(p + "mlp2.weight"), mlp2Bias: try w(p + "mlp2.bias"),
                mlpLnWeight: try w(p + "mlp_ln.weight"), mlpLnBias: try w(p + "mlp_ln.bias")
            ))
        }
        let encoder = WhisperEncoder(
            conv1Weight: try w("encoder.conv1.weight"), conv1Bias: try w("encoder.conv1.bias"),
            conv2Weight: try w("encoder.conv2.weight"), conv2Bias: try w("encoder.conv2.bias"),
            blocks: encoderBlocks,
            lnPostWeight: try w("encoder.ln_post.weight"), lnPostBias: try w("encoder.ln_post.bias")
        )

        var decoderBlocks: [WhisperDecoderBlock] = []
        for i in 0..<nDecoderLayer {
            let p = "decoder.blocks.\(i)."
            let selfAttn = WhisperAttention(
                numHeads: nHead,
                queryWeight: try w(p + "attn.query.weight"), queryBias: try w(p + "attn.query.bias"),
                keyWeight: try w(p + "attn.key.weight"),
                valueWeight: try w(p + "attn.value.weight"), valueBias: try w(p + "attn.value.bias"),
                outWeight: try w(p + "attn.out.weight"), outBias: try w(p + "attn.out.bias")
            )
            let crossAttn = WhisperAttention(
                numHeads: nHead,
                queryWeight: try w(p + "cross_attn.query.weight"), queryBias: try w(p + "cross_attn.query.bias"),
                keyWeight: try w(p + "cross_attn.key.weight"),
                valueWeight: try w(p + "cross_attn.value.weight"), valueBias: try w(p + "cross_attn.value.bias"),
                outWeight: try w(p + "cross_attn.out.weight"), outBias: try w(p + "cross_attn.out.bias")
            )
            decoderBlocks.append(WhisperDecoderBlock(
                selfAttn: selfAttn, attnLnWeight: try w(p + "attn_ln.weight"), attnLnBias: try w(p + "attn_ln.bias"),
                crossAttn: crossAttn, crossAttnLnWeight: try w(p + "cross_attn_ln.weight"), crossAttnLnBias: try w(p + "cross_attn_ln.bias"),
                mlp1Weight: try w(p + "mlp1.weight"), mlp1Bias: try w(p + "mlp1.bias"),
                mlp2Weight: try w(p + "mlp2.weight"), mlp2Bias: try w(p + "mlp2.bias"),
                mlpLnWeight: try w(p + "mlp_ln.weight"), mlpLnBias: try w(p + "mlp_ln.bias")
            ))
        }
        let decoder = WhisperDecoder(
            tokenEmbeddingWeight: try w("decoder.token_embedding.weight"),
            positionalEmbedding: try w("decoder.positional_embedding"),
            blocks: decoderBlocks,
            lnWeight: try w("decoder.ln.weight"), lnBias: try w("decoder.ln.bias")
        )

        return WhisperModel(encoder: encoder, decoder: decoder, nDecoderLayer: nDecoderLayer, nHead: nHead)
    }

    /// Ports `mlx_whisper.whisper.Whisper.forward_with_cross_qk`: encode mel,
    /// run the decoder over `tokens` once (no KV cache), return BOTH the
    /// vocab logits and the per-layer cross-attention pre-softmax QK matrices
    /// (each `(1, nHead, textLen, audioFrames)`). `find_alignment` (DTW word
    /// alignment) consumes the cross QKs from the alignment-head subset.
    public func forwardWithCrossQk(mel: MLXArray, tokens: MLXArray) -> (logits: MLXArray, crossQKs: [MLXArray]) {
        let encoderOutput = encoder(mel)
        return decoder.forwardWithCrossQk(tokens: tokens, encoderOutput: encoderOutput)
    }

    /// Greedy-decode a transcript for `mel` (a (1, n_frames, n_mels)
    /// log-mel spectrogram, e.g. from WhisperMel.logMelSpectrogram),
    /// starting from `language`'s SOT sequence. No KV cache (see header) —
    /// fine for the short single-utterance clips this ASR gate verifies;
    /// `maxNewTokens` bounds runaway generation.
    public func transcribe(mel: MLXArray, language: String, maxNewTokens: Int = 64) -> String {
        let encoderOutput = encoder(mel)
        let promptLength = WhisperTokenizer.sotSequence(language: language).count
        var ids = WhisperTokenizer.sotSequence(language: language)

        for _ in 0..<maxNewTokens {
            let tokensArray = MLXArray(ids.map { Int32($0) }, [1, ids.count])
            let logits = decoder(tokens: tokensArray, encoderOutput: encoderOutput)
            var lastLogits = logits[0, ids.count - 1]
            // mlx_whisper's SuppressBlank logit filter: at the FIRST
            // generation step only, mask out <|endoftext|> and the space
            // token (id 220, `tokenizer.encode(" ")`) so a real utterance
            // can't immediately terminate with an empty transcript —
            // without this, greedy decoding on real speech genuinely does
            // predict EOT as the top logit at step 0 (confirmed empirically
            // via WHISPER_DEBUG: max logit 23.2 landed exactly on EOT before
            // this fix, producing an empty transcript).
            if ids.count == promptLength {
                var maskValues = [Float](repeating: 0, count: lastLogits.dim(0))
                maskValues[WhisperTokenizer.endOfText] = -Float.infinity
                maskValues[220] = -Float.infinity
                lastLogits = lastLogits + MLXArray(maskValues)
            }
            MLX.eval(lastLogits)
            let nextId = MLX.argMax(lastLogits).item(Int.self)
            if nextId == WhisperTokenizer.endOfText { break }
            ids.append(nextId)
        }

        // Strip the SOT-sequence prefix before decoding — matches
        // mlx_whisper's own transcription path, which only decodes tokens
        // generated AFTER the special-token prompt.
        return WhisperTokenizer.decode(Array(ids.dropFirst(promptLength)))
    }

    /// Ports `mlx_whisper.decoding.detect_language` exactly: encode once,
    /// decode ONE step from `<|startoftranscript|>` alone (no language
    /// forced), mask every non-language-token logit to -inf, argmax over
    /// what's left. Returns the ISO 639-1 code (e.g. "zh") of the most
    /// probable language. This is a REAL auto-detect (unlike
    /// `transcribe(language:)`, which always force-decodes whatever
    /// language you pass) — closes the gap noted in ASRGate.swift's header:
    /// the native engine can now check "did this actually come out as
    /// Chinese" instead of trivially assuming whatever language was asked
    /// for.
    public func detectLanguage(mel: MLXArray) -> String {
        let encoderOutput = encoder(mel)
        let sotToken = MLXArray([Int32(WhisperTokenizer.startOfTranscript)], [1, 1])
        let logits = decoder(tokens: sotToken, encoderOutput: encoderOutput)
        var lastLogits = logits[0, 0]

        let vocabSize = lastLogits.dim(0)
        var mask = [Float](repeating: -Float.infinity, count: vocabSize)
        for (idx, _) in WhisperTokenizer.languageCodesInOrder.enumerated() {
            let tokenId = WhisperTokenizer.startOfTranscript + 1 + idx
            mask[tokenId] = 0
        }
        lastLogits = lastLogits + MLXArray(mask)
        MLX.eval(lastLogits)
        let bestTokenId = MLX.argMax(lastLogits).item(Int.self)
        let languageIndex = bestTokenId - (WhisperTokenizer.startOfTranscript + 1)
        guard languageIndex >= 0 && languageIndex < WhisperTokenizer.languageCodesInOrder.count else {
            return "unknown"
        }
        return WhisperTokenizer.languageCodesInOrder[languageIndex]
    }
}
