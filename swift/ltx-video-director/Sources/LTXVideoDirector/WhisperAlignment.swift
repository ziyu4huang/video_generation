//
//  WhisperAlignment.swift
//  LTXVideoDirector
//
//  P2b: per-word timestamp alignment via cross-attention DTW — a line-for-line
//  port of mlx_whisper.timing (find_alignment + add_word_timestamps +
//  merge_punctuations + dtw + median_filter). Closes the second half of the
//  native-Whisper replacement: segment-level timestamps (WhisperTranscribe)
//  PLUS per-word start/end/probability.
//
//  The cross-attention QK matrices come from WhisperDecoder.forwardWithCrossQk
//  (WhisperDecoder.swift) — the pre-softmax, SCALED (headDim**-0.25) scores
//  mlx_whisper's `forward_with_cross_qk` returns. find_alignment re-softmaxes
//  the alignment-head subset with its own qk_scale, z-scores across the token
//  axis, median-filters across frames, means over heads, and runs DTW on the
//  negated matrix to map each text-token position to an audio-frame position;
//  cumulative jump points become per-word boundaries. add_word_timestamps
//  folds in the duration/segment-boundary hacks + punctuation merging.
//
//  Default alignment heads = last-half decoder layers, all heads (the upstream
//  default when a checkpoint has no dumped head set) — matches what
//  mlx_whisper.whisper.Whisper sets in __init__.
//

import Foundation
import MLX

/// A single word's alignment: the decoded word text, its constituent token
/// ids, an absolute [start, end) range (seconds), and the mean per-token
/// softmax probability. Mirrors mlx_whisper.timing.WordTiming.
public struct WordTiming {
    public var word: String
    public var tokens: [Int]
    public var start: Double
    public var end: Double
    public var probability: Double

    public init(word: String, tokens: [Int], start: Double, end: Double, probability: Double) {
        self.word = word; self.tokens = tokens; self.start = start; self.end = end; self.probability = probability
    }
}

/// Per-word alignment for one 30s window. Mirrors mlx_whisper.timing.
public enum WhisperAlignment {
    /// TOKENS_PER_SECOND = SAMPLE_RATE / HOP_LENGTH / input_stride = 50.
    /// (Whisper's timestamp tokens advance at 50 Hz — 1500 audio-ctx positions
    /// per 30s window.) time_indices / 50.0 → seconds.
    public static let tokensPerSecond: Double = 50.0

    /// mlx_whisper.timing.median_filter: reflect-pad then a width-`width`
    /// median along the LAST axis of x (shape (heads, tokens, frames)). Odd
    /// width. `x` is indexed as [head][token][frame].
    static func medianFilter(_ x: [[[Float]]], width: Int) -> [[[Float]]] {
        let pad = width / 2
        var out = x
        for h in 0..<x.count {
            for t in 0..<x[h].count {
                let row = x[h][t]
                let n = row.count
                if n <= pad { continue }
                var padded = [Float](repeating: 0, count: n + 2 * pad)
                for i in 0..<pad { padded[pad - 1 - i] = row[1 + i] }            // reflect prefix
                for i in 0..<n { padded[pad + i] = row[i] }
                for i in 0..<pad { padded[pad + n + i] = row[n - pad - 1 + i] }  // reflect suffix
                var filtered = [Float](repeating: 0, count: n)
                var window = [Float](repeating: 0, count: width)
                for i in 0..<n {
                    for w in 0..<width { window[w] = padded[i + w] }
                    window.sort()
                    filtered[i] = window[pad]
                }
                out[h][t] = filtered
            }
        }
        return out
    }

    /// mlx_whisper.timing.dtw (+ dtw_cpu + backtrace): dynamic-time-warping
    /// alignment of `matrix` (shape N×M, typically the negated mean attention).
    /// Returns paired (textIndex-1, frameIndex-1) steps along the optimal path,
    /// in forward order. Ported from the numba reference verbatim.
    static func dtw(_ matrix: [[Float]]) -> (textIndices: [Int], timeIndices: [Int]) {
        let N = matrix.count
        guard N > 0 else { return ([], []) }
        let M = matrix[0].count
        guard M > 0 else { return ([], []) }
        let inf = Float.infinity
        var cost = [[Float]](repeating: [Float](repeating: inf, count: M + 1), count: N + 1)
        var trace = [[Float]](repeating: [Float](repeating: -1, count: M + 1), count: N + 1)
        cost[0][0] = 0

        for j in 1...M {
            for i in 1...N {
                let c0 = cost[i - 1][j - 1]
                let c1 = cost[i - 1][j]
                let c2 = cost[i][j - 1]
                let c: Float, t: Float
                if c0 < c1 && c0 < c2 { c = c0; t = 0 }
                else if c1 < c0 && c1 < c2 { c = c1; t = 1 }
                else { c = c2; t = 2 }
                cost[i][j] = matrix[i - 1][j - 1] + c
                trace[i][j] = t
            }
        }
        // backtrace boundary forcing: trace[0,:]=2, trace[:,0]=1
        for j in 0...M { trace[0][j] = 2 }
        for i in 0...N { trace[i][0] = 1 }

        var result: [(Int, Int)] = []
        var i = N, j = M
        while i > 0 || j > 0 {
            result.append((i - 1, j - 1))
            let t = trace[i][j]
            if t == 0 { i -= 1; j -= 1 }
            else if t == 1 { i -= 1 }
            else { j -= 1 }
        }
        result.reverse()
        return (result.map { $0.0 }, result.map { $0.1 })
    }

    /// Ports mlx_whisper.timing.find_alignment. Returns one WordTiming per
    /// word in `textTokens` (+ the trailing eot word, which the distributor
    /// drops by token-count). `melWindow` is the (3000, n_mels) mel for this
    /// 30s window; `numFrames` is its real frame count (≤ 3000; the padded
    /// tail is ignored via num_frames//2).
    public static func findAlignment(
        model: WhisperModel, textTokens: [Int], melWindow: MLXArray, numFrames: Int,
        language: String, nDecoderLayer: Int, nHead: Int,
        medfiltWidth: Int = 7, qkScale: Float = 1.0
    ) -> [WordTiming] {
        if textTokens.isEmpty { return [] }

        let sot = WhisperTokenizer.sotSequenceWithTimestamps(language: language)  // [sot, lang, transcribe]
        let eot = WhisperTokenizer.endOfText
        var toks = sot
        toks.append(WhisperTokenizer.noTimestamps)
        toks.append(contentsOf: textTokens)
        toks.append(eot)
        let tokensArr = MLXArray(toks.map { Int32($0) }, [1, toks.count])
        let melBatched = melWindow.expandedDimensions(axis: 0)
        let (logits, crossQKs) = model.forwardWithCrossQk(mel: melBatched, tokens: tokensArr)

        // text_token_probs[i] = softmax(logits[0, sot.count + i])[textTokens[i]]
        let N = textTokens.count
        var textTokenProbs = [Float](repeating: 0, count: N)
        for i in 0..<N {
            let probs = MLX.softmax(logits[0, sot.count + i], axis: -1)
            textTokenProbs[i] = probs[textTokens[i]].item(Float.self)
        }

        // alignment heads: last-half decoder layers, all heads (upstream default).
        var heads: [(Int, Int)] = []
        for l in (nDecoderLayer / 2)..<nDecoderLayer {
            for h in 0..<nHead { heads.append((l, h)) }
        }
        guard !heads.isEmpty else { return [] }

        // weights: (heads, textLen, frames) — stack the per-head cross QK.
        var qkParts: [MLXArray] = []
        for (l, h) in heads { qkParts.append(crossQKs[l][0, h]) }
        var W = MLX.stacked(qkParts, axis: 0)
        let totalFrames = W.dim(2)
        let contentFrames = min(numFrames / 2, totalFrames)
        if contentFrames < totalFrames {
            W = W[0..<W.dim(0), 0..<W.dim(1), 0..<contentFrames]
        }
        W = MLX.softmax(W * qkScale, axis: -1, precise: true).asType(.float32)
        let mean = W.mean(axis: -2, keepDims: true)
        let diff = W - mean
        let std = MLX.sqrt(MLX.square(diff).mean(axis: -2, keepDims: true))
        W = diff / std
        MLX.eval(W)

        let nHeads = W.dim(0), nText = W.dim(1), nFrames = W.dim(2)
        let flat = W.asArray(Float.self)
        var weights = [[[Float]]](repeating: [[Float]](repeating: [Float](repeating: 0, count: nFrames), count: nText), count: nHeads)
        var idx = 0
        for h in 0..<nHeads { for t in 0..<nText { for f in 0..<nFrames { weights[h][t][f] = flat[idx]; idx += 1 } } }

        weights = medianFilter(weights, width: medfiltWidth)

        // matrix = mean over heads → (nText, nFrames); slice [sot.count ..< nText-1].
        var matrix = [[Float]](repeating: [Float](repeating: 0, count: nFrames), count: nText)
        for t in 0..<nText {
            for f in 0..<nFrames {
                var s: Float = 0
                for h in 0..<nHeads { s += weights[h][t][f] }
                matrix[t][f] = s / Float(nHeads)
            }
        }
        let lo = sot.count
        let hi = nText - 1
        var sliced = [[Float]]()
        sliced.reserveCapacity(max(0, hi - lo))
        for t in lo..<hi { sliced.append(matrix[t]) }
        guard !sliced.isEmpty, !sliced[0].isEmpty else { return [] }

        let (textIndices, timeIndices) = dtw(sliced.map { $0.map { -$0 } })

        // split_to_word_tokens on text_tokens + [eot].
        let (words, wordTokens) = WhisperTokenizer.splitToWordTokens(textTokens + [eot], language: language)
        if wordTokens.count <= 1 { return [] }
        // word_boundaries = pad(cumsum([len(t) for t in word_tokens[:-1]]), (1,0))
        // → [0, len0, len0+len1, ...]; index textTokens directly.
        var boundaries = [Int](repeating: 0, count: wordTokens.count)
        var acc = 0
        for i in 0..<(wordTokens.count - 1) {
            acc += wordTokens[i].count
            boundaries[i + 1] = acc
        }

        // jumps = pad(diff(text_indices), (1, 0), constant_values=1).astype(bool)
        var jumps = [Bool](repeating: false, count: textIndices.count)
        if !textIndices.isEmpty { jumps[0] = true }
        for i in 1..<textIndices.count { jumps[i] = textIndices[i] != textIndices[i - 1] }
        let jumpTimes: [Double] = (0..<timeIndices.count).filter { jumps[$0] }.map { Double(timeIndices[$0]) / tokensPerSecond }

        var alignment: [WordTiming] = []
        alignment.reserveCapacity(wordTokens.count - 1)
        for w in 0..<(wordTokens.count - 1) {
            let sIdx = boundaries[w]
            let eIdx = min(boundaries[w + 1], max(jumpTimes.count - 1, 0))
            let start = sIdx < jumpTimes.count ? jumpTimes[sIdx] : (jumpTimes.last ?? 0)
            let end = eIdx >= 0 && eIdx < jumpTimes.count ? jumpTimes[eIdx] : start
            // word probability = mean(text_token_probs over the word's text tokens)
            var ps: Float = 0
            var pc = 0
            for ti in sIdx..<min(boundaries[w + 1], N) { ps += textTokenProbs[ti]; pc += 1 }
            let prob = pc > 0 ? Double(ps / Float(pc)) : 0
            alignment.append(WordTiming(word: words[w], tokens: wordTokens[w], start: start, end: end, probability: prob))
        }
        return alignment
    }

    /// Ports mlx_whisper.timing.merge_punctuations: fold prepended punctuation
    /// into the following word, appended into the preceding word.
    static func mergePunctuations(_ alignment: inout [WordTiming], prepended: String, appended: String) {
        // merge prepended (right-to-left)
        var i = alignment.count - 2
        var j = alignment.count - 1
        while i >= 0 {
            let prevWord = alignment[i].word
            let follWord = alignment[j].word
            let stripped = prevWord.trimmingCharacters(in: .whitespaces)
            if prevWord.hasPrefix(" ") && stripped.count == 1 && prepended.contains(stripped) {
                alignment[j].word = prevWord + follWord
                alignment[j].tokens = alignment[i].tokens + alignment[j].tokens
                alignment[i].word = ""
                alignment[i].tokens = []
            } else {
                j = i
            }
            i -= 1
        }
        // merge appended (left-to-right)
        i = 0
        j = 1
        while j < alignment.count {
            let prevWord = alignment[i].word
            let follWord = alignment[j].word
            if !prevWord.hasSuffix(" ") && follWord.count <= 1 && appended.contains(follWord) {
                alignment[i].tokens = alignment[i].tokens + alignment[j].tokens
                alignment[i].word = prevWord + follWord
                alignment[j].word = ""
                alignment[j].tokens = []
            } else {
                i = j
            }
            j += 1
        }
    }

    /// Ports mlx_whisper.timing.add_word_timestamps for ONE window's segments.
    /// `windowSegments` carries each segment's absolute start/end + its text
    /// tokens (< eot); `timeOffset` is the window's absolute seek offset. The
    /// window's segments are aligned TOGETHER (one find_alignment over the
    /// concatenated text tokens), then words distributed back per-segment by
    /// token-count consumption (the mlx_whisper loop). Returns one `[WhisperWord]`
    /// per input segment (empty list for a segment that got no words).
    public static func addWordTimestamps(
        windowSegments: [(start: Double, end: Double, textTokens: [Int])],
        model: WhisperModel, melWindow: MLXArray, numFrames: Int,
        language: String, nDecoderLayer: Int, nHead: Int, timeOffset: Double
    ) -> [[WhisperWord]] {
        let nSeg = windowSegments.count
        if nSeg == 0 { return [] }
        var textTokensAll: [Int] = []
        for seg in windowSegments { textTokensAll.append(contentsOf: seg.textTokens.filter { $0 < WhisperTokenizer.endOfText }) }

        var alignment = findAlignment(
            model: model, textTokens: textTokensAll, melWindow: melWindow, numFrames: numFrames,
            language: language, nDecoderLayer: nDecoderLayer, nHead: nHead
        )

        // duration truncation + punctuation merge (the mlx_whisper hacks).
        if !alignment.isEmpty {
            let wordDurations = alignment.map { $0.end - $0.start }.filter { $0 > 0 }
            var medianDuration: Double = 0
            if !wordDurations.isEmpty {
                let sorted = wordDurations.sorted()
                medianDuration = sorted[sorted.count / 2]
            }
            medianDuration = min(0.7, medianDuration)
            let maxDuration = medianDuration * 2
            let sentenceEndMarks: Set<Character> = [".", "。", "!", "！", "?", "？"]
            if !wordDurations.isEmpty {
                for i in 1..<alignment.count {
                    if alignment[i].end - alignment[i].start > maxDuration {
                        if alignment[i].word.count == 1 && sentenceEndMarks.contains(Character(alignment[i].word)) {
                            alignment[i].end = alignment[i].start + maxDuration
                        } else if alignment[i - 1].word.count == 1 && sentenceEndMarks.contains(Character(alignment[i - 1].word)) {
                            alignment[i].start = alignment[i].end - maxDuration
                        }
                    }
                }
            }
            mergePunctuations(&alignment,
                              prepended: "\"'“¿([{-",
                              appended: "\"'.。,，!！?？:：”)]}、")
        }

        // Distribute words back to segments by token-count consumption.
        var perSegWords: [[WhisperWord]] = Array(repeating: [], count: nSeg)
        if alignment.isEmpty { return perSegWords }
        var wordIndex = 0
        for s in 0..<nSeg {
            let segTokenCount = windowSegments[s].textTokens.filter { $0 < WhisperTokenizer.endOfText }.count
            var savedTokens = 0
            var words: [WhisperWord] = []
            while wordIndex < alignment.count && savedTokens < segTokenCount {
                let timing = alignment[wordIndex]
                if !timing.word.isEmpty {
                    words.append(WhisperWord(
                        word: timing.word,
                        start: (timeOffset + timing.start).roundedTo(2),
                        end: (timeOffset + timing.end).roundedTo(2),
                        probability: timing.probability
                    ))
                }
                savedTokens += timing.tokens.count
                wordIndex += 1
            }
            perSegWords[s] = words
        }
        return perSegWords
    }
}

/// A per-word timestamp entry in a WhisperSegment (the Bun `words[]` field).
public struct WhisperWord {
    public let word: String
    public let start: Double
    public let end: Double
    public let probability: Double
    public init(word: String, start: Double, end: Double, probability: Double) {
        self.word = word; self.start = start; self.end = end; self.probability = probability
    }
}

internal extension Double {
    func roundedTo(_ places: Int) -> Double {
        let f = Foundation.pow(10.0, Double(places))
        return (self * f).rounded() / f
    }
}
