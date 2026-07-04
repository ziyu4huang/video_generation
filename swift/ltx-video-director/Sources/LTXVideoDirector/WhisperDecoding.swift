//
//  WhisperDecoding.swift
//  LTXVideoDirector
//
//  Ports mlx_whisper.decoding's temperature-fallback retry loop
//  (`transcribe.py`'s `decode_with_fallback`, backed by
//  `DecodingTask.run`/`_main_loop`) — the ONE piece separating
//  WhisperModel's naive greedy decode (WhisperModel.transcribe) from real
//  mlx_whisper.transcribe()'s actual quality. Two closely-related gaps
//  closed together, because empirically neither alone reproduces
//  mlx_whisper's output (verified against the real large-v3-mlx checkpoint
//  on ASRGate.swift's reference clip — see WhisperModelRealCheckpointTests):
//
//  1. Temperature-fallback retries: on failure (compression_ratio too high,
//     avg_logprob too low), retry at a higher temperature with categorical
//     sampling instead of argmax.
//  2. The FULL real logit-filter stack `DecodingTask` always applies
//     (`SuppressBlank` + `SuppressTokens` + `ApplyTimestampRules`), decoding
//     from `sotSequenceWithTimestamps` rather than the notimestamps-forced
//     sequence `WhisperModel.transcribe` uses. Forcing `<|notimestamps|>`
//     directly (skipping `ApplyTimestampRules` entirely) measurably
//     degrades large-v3's output on short/ambiguous clips — confirmed by
//     A/B decoding the reference clip both ways against the real
//     checkpoint: notimestamps-forced greedy produced garbage ("Hi, Ni
//     Hao"/", Hi, how are you?") on the same audio where
//     `mlx_whisper.transcribe()`'s real path (timestamps + full filter
//     stack, T=0, no fallback even needed) produced the correct "嗨你好".
//

import Foundation
import MLX

public struct WhisperDecodingResult {
    public let text: String
    public let tokens: [Int]
    public let temperature: Double
    public let avgLogprob: Double
    public let noSpeechProb: Double
    public let compressionRatio: Double
}

extension WhisperModel {
    /// mlx_whisper's `SuppressTokens` mask set: `non_speech_tokens` plus the
    /// always-suppressed special tokens (`transcribe`/`translate`/`sot`/
    /// `sot_prev`/`sot_lm`/`no_speech` — `no_speech_prob` is measured
    /// separately, see below, so the token itself is never a valid output).
    private static let suppressTokenSet: Set<Int> = {
        var s = Set(WhisperTokenizer.nonSpeechTokens)
        s.formUnion([
            WhisperTokenizer.transcribe, WhisperTokenizer.translate,
            WhisperTokenizer.startOfTranscript, WhisperTokenizer.startOfPrev,
            WhisperTokenizer.startOfLM, WhisperTokenizer.noSpeech,
        ])
        return s
    }()

    /// mlx_whisper's `ApplyTimestampRules`, ported for batch=1. `logits` is
    /// mutated in place; `tokensSoFar` is the FULL sequence generated up to
    /// (not including) the token about to be sampled. `sampleBegin` is the
    /// length of the initial SOT-sequence prompt. Faithfully reproduces the
    /// upstream "index used as if it were a timestamp value" quirk in the
    /// `last_timestamp` branch (confirmed present in both mlx_whisper and
    /// openai-whisper's decoding.py) rather than "fixing" it.
    private static func applyTimestampRules(
        logits: inout [Float], tokensSoFar: [Int], sampleBegin: Int, maxInitialTimestampIndex: Int?
    ) {
        let n = logits.count
        var mask = [Float](repeating: 0, count: n)
        mask[WhisperTokenizer.noTimestamps] = -Float.infinity

        let seq = Array(tokensSoFar[sampleBegin...])
        let lastWasTimestamp = seq.count >= 1 && seq.last! >= WhisperTokenizer.timestampBegin
        let penultimateWasTimestamp = seq.count < 2 || seq[seq.count - 2] >= WhisperTokenizer.timestampBegin

        if lastWasTimestamp {
            if penultimateWasTimestamp {
                for i in WhisperTokenizer.timestampBegin..<n { mask[i] = -Float.infinity }
            } else {
                for i in 0..<WhisperTokenizer.endOfText { mask[i] = -Float.infinity }
            }
        }

        let timestampIndices = seq.indices.filter { seq[$0] > WhisperTokenizer.timestampBegin }
        if let lastIdx = timestampIndices.last {
            var lastTimestamp = lastIdx
            if lastTimestamp == 0 || penultimateWasTimestamp { lastTimestamp += 1 }
            let upper = min(WhisperTokenizer.timestampBegin + lastTimestamp, n)
            if upper > WhisperTokenizer.timestampBegin {
                for i in WhisperTokenizer.timestampBegin..<upper { mask[i] = -Float.infinity }
            }
        }

        if seq.isEmpty {
            for i in 0..<WhisperTokenizer.timestampBegin { mask[i] = -Float.infinity }
            if let maxIdx = maxInitialTimestampIndex {
                let lastAllowed = WhisperTokenizer.timestampBegin + maxIdx
                if lastAllowed + 1 < n {
                    for i in (lastAllowed + 1)..<n { mask[i] = -Float.infinity }
                }
            }
        }

        // logsumexp / max over the ORIGINAL (pre-mask) logits, matching
        // mlx_whisper exactly — the comparison ignores the mask array above.
        let maxLogit = logits.max() ?? 0
        var sumExp: Float = 0
        for v in logits { sumExp += expf(v - maxLogit) }
        let logsumexpAll = maxLogit + logf(sumExp)

        var timestampSumExp: Float = 0
        for i in WhisperTokenizer.timestampBegin..<n { timestampSumExp += expf(logits[i] - maxLogit) }
        let timestampLogprob = (maxLogit + logf(timestampSumExp)) - logsumexpAll
        let maxTextLogit = logits[0..<WhisperTokenizer.timestampBegin].max() ?? -Float.infinity
        let maxTextLogprob = maxTextLogit - logsumexpAll

        if timestampLogprob > maxTextLogprob {
            for i in 0..<WhisperTokenizer.timestampBegin { mask[i] = -Float.infinity }
        }

        for i in 0..<n { logits[i] += mask[i] }
    }

    /// mlx_whisper's `compression_ratio(text)`: UTF-8 byte length divided by
    /// zlib-compressed length. Uses Apple's Compression framework (zlib
    /// algorithm) rather than a byte-identical zlib port — the resulting
    /// ratio is used only against a fixed threshold (2.4, "too repetitive"),
    /// not compared bit-for-bit against Python's zlib output.
    static func compressionRatio(_ text: String) -> Double {
        let bytes = Array(text.utf8)
        guard !bytes.isEmpty else { return 0 }
        guard let compressed = try? (Data(bytes) as NSData).compressed(using: .zlib) as Data,
              !compressed.isEmpty
        else { return Double(bytes.count) }
        return Double(bytes.count) / Double(compressed.count)
    }

    /// One temperature's worth of `DecodingTask.run` for a single 30s
    /// window: real SOT sequence (timestamps allowed), the full
    /// SuppressBlank + SuppressTokens + ApplyTimestampRules filter stack,
    /// greedy (T=0) or categorical-sampled (T>0) next-token selection,
    /// accumulating `sum_logprobs` exactly as `GreedyDecoder.update` does.
    private func decodeOnce(
        encoderOutput: MLXArray, language: String, temperature: Double, sampleLen: Int
    ) -> WhisperDecodingResult {
        let initialTokens = WhisperTokenizer.sotSequenceWithTimestamps(language: language)
        let sampleBegin = initialTokens.count
        // precision = CHUNK_LENGTH(30) / n_audio_ctx(1500) = 0.02s/token;
        // max_initial_timestamp defaults to 1.0s -> index 50.
        let maxInitialTimestampIndex = 50

        var ids = initialTokens
        var sumLogprob: Float = 0
        var noSpeechProb: Double = .nan

        for step in 0..<sampleLen {
            let tokensArray = MLXArray(ids.map { Int32($0) }, [1, ids.count])
            let fullLogits = decoder(tokens: tokensArray, encoderOutput: encoderOutput)
            MLX.eval(fullLogits)

            if step == 0 {
                // no_speech_prob: softmax of the RAW (pre-filter) logits
                // predicting the token right after <|startoftranscript|>
                // (index 0 in our sequence, since there's no `prompt`).
                let sotLogits = fullLogits[0, 0]
                let probsAtSot = MLX.softmax(sotLogits, axis: -1)
                MLX.eval(probsAtSot)
                noSpeechProb = Double(probsAtSot[WhisperTokenizer.noSpeech].item(Float.self))
            }

            var lastLogits: [Float] = (fullLogits[0, ids.count - 1]).asArray(Float.self)

            // SuppressBlank — first step only.
            if ids.count == sampleBegin {
                lastLogits[WhisperTokenizer.endOfText] = -Float.infinity
                lastLogits[220] = -Float.infinity
            }
            // SuppressTokens — every step.
            for t in Self.suppressTokenSet where t < lastLogits.count {
                lastLogits[t] = -Float.infinity
            }
            // ApplyTimestampRules — every step.
            Self.applyTimestampRules(
                logits: &lastLogits, tokensSoFar: ids, sampleBegin: sampleBegin,
                maxInitialTimestampIndex: maxInitialTimestampIndex
            )

            let logitsArray = MLXArray(lastLogits)
            let nextId: Int
            if temperature == 0 {
                nextId = MLX.argMax(logitsArray).item(Int.self)
            } else {
                let sampled = MLXRandom.categorical(logitsArray / Float(temperature))
                MLX.eval(sampled)
                nextId = sampled.item(Int.self)
            }

            // sum_logprobs from the FINAL (post-filter) logits, matching
            // GreedyDecoder.update.
            let maxLogit = lastLogits.max() ?? 0
            var sumExp: Float = 0
            for v in lastLogits { sumExp += expf(v - maxLogit) }
            let logsumexpAll = maxLogit + logf(sumExp)
            sumLogprob += (lastLogits[nextId] - logsumexpAll)

            if nextId == WhisperTokenizer.endOfText { break }
            ids.append(nextId)
        }

        let generated = Array(ids.dropFirst(sampleBegin))
        let textTokens = generated.filter { $0 < WhisperTokenizer.endOfText }
        let text = WhisperTokenizer.decode(textTokens)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let avgLogprob = Double(sumLogprob) / Double(generated.count + 1)

        return WhisperDecodingResult(
            text: text, tokens: generated, temperature: temperature,
            avgLogprob: avgLogprob, noSpeechProb: noSpeechProb,
            compressionRatio: Self.compressionRatio(text)
        )
    }

    /// Ports `mlx_whisper.transcribe.transcribe`'s `decode_with_fallback`
    /// for a single 30s window (this ASR gate's clips are always <=30s —
    /// no segment-splitting/seek loop needed): try `temperatures` in order,
    /// stopping at the first one that doesn't need a fallback. A result
    /// "needs fallback" exactly when `decode_with_fallback` does:
    /// compression_ratio too high (repetitive) or avg_logprob too low
    /// (unconfident) — `no_speech_prob` never forces a retry (silence is a
    /// legitimate, not-a-failure outcome).
    public func transcribeWithFallback(
        mel: MLXArray, language: String,
        temperatures: [Double] = [0.0, 0.2, 0.4, 0.6, 0.8, 1.0],
        compressionRatioThreshold: Double = 2.4,
        logprobThreshold: Double = -1.0,
        noSpeechThreshold: Double = 0.6,
        sampleLen: Int = 224
    ) -> WhisperDecodingResult {
        let encoderOutput = encoder(mel)
        var result = decodeOnce(encoderOutput: encoderOutput, language: language, temperature: 0, sampleLen: sampleLen)

        for temperature in temperatures {
            result = decodeOnce(encoderOutput: encoderOutput, language: language, temperature: temperature, sampleLen: sampleLen)
            var needsFallback = false
            if result.compressionRatio > compressionRatioThreshold { needsFallback = true }
            if result.avgLogprob < logprobThreshold { needsFallback = true }
            if result.noSpeechProb > noSpeechThreshold { needsFallback = false }
            if !needsFallback { break }
        }
        return result
    }
}
