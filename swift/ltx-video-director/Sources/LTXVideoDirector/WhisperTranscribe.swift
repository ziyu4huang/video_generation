//
//  WhisperTranscribe.swift
//  LTXVideoDirector
//
//  Native transcription on top of the real-checkpoint-verified WhisperModel
//  encoder/decoder + WhisperDecoding's temperature-fallback loop. Closes the
//  full replacement of mlx_whisper at runtime: a seek-loop transcription with
//  segment boundaries derived from the timestamp tokens the decoder emits
//  (WhisperDecoding.decodeOnce decodes from sotSequenceWithTimestamps +
//  applies ApplyTimestampRules, so the generated token stream alternates
//  <|t|> timestamp tokens around text runs), AND per-word start/end/probability
//  via cross-attention DTW (WhisperAlignment).
//
//  The segment algorithm is a line-for-line port of
//  mlx_whisper.transcribe.transcribe's seek loop + timestamp-token slice
//  parsing (transcribe.py ~247-412). The word algorithm is a line-for-line
//  port of mlx_whisper.timing.add_word_timestamps (find_alignment + DTW +
//  median filter + punctuation merge).
//
//  Constants mirror mlx_whisper.audio: N_FRAMES=3000 mel frames per 30s
//  window, n_audio_ctx=1500 encoder positions (conv2 stride-2 halves the
//  frame count), input_stride=2, time_precision=0.02s per timestamp token,
//  HOP_LENGTH=160, SAMPLE_RATE=16000.
//

import Foundation
import MLX

/// One transcribed segment: an absolute [start, end) time range (seconds),
/// the decoded text, and (when word alignment is on) per-word timings. Mirrors
/// the per-segment slice of mlx_whisper's WhisperResult that the Bun
/// `whisperAdapter` parses.
public struct WhisperSegment {
    public let start: Double
    public let end: Double
    public let text: String
    public let words: [WhisperWord]

    public init(start: Double, end: Double, text: String, words: [WhisperWord] = []) {
        self.start = start; self.end = end; self.text = text; self.words = words
    }
}

/// Full native transcription result: detected/forced language, the
/// concatenated transcript text, and the per-segment breakdown.
public struct WhisperTranscription {
    public let language: String
    public let text: String
    public let segments: [WhisperSegment]

    public init(language: String, text: String, segments: [WhisperSegment]) {
        self.language = language; self.text = text; self.segments = segments
    }
}

/// A segment under construction within a 30s window — its absolute start/end,
/// decoded text, and the raw text tokens (timestamp tokens already stripped).
/// Used so the window's segments can be aligned together (one DTW over the
/// concatenated text tokens) then have words distributed back per-segment.
private struct WindowSegment {
    let start: Double
    let end: Double
    let text: String
    let textTokens: [Int]
}

extension WhisperModel {
    /// mlx_whisper.audio constants framing the seek loop.
    public static let nAudioCtx = 1500
    public static let melFramesPerWindow = 3000   // N_FRAMES — 30s of log-mel

    /// Transcribe a full log-mel spectrogram (shape (n_frames, n_mels), e.g.
    /// from `WhisperMel.logMelSpectrogram`) into segment + per-word timestamps
    /// + text, windowing >30s audio in 30s chunks exactly as mlx_whisper does.
    ///
    /// - Parameters:
    ///   - mel: full log-mel, shape (n_frames, n_mels). Variable n_frames;
    ///     each 3000-frame window is one decode pass.
    ///   - forcedLanguage: ISO 639-1 code to force-decode (e.g. "en", "zh").
    ///     nil → auto-detect once on the first 30s head via `detectLanguage`
    ///     and reuse for every window (mirrors mlx_whisper's single detect
    ///     at the start of the first clip).
    ///   - wordTimestamps: run cross-attention DTW per window to fill each
    ///     segment's `words` array ( mlx_whisper's `word_timestamps=True`).
    ///   - sampleLen: per-window generation cap (WhisperDecoding default 224).
    /// - Returns: language + concatenated text + per-segment start/end/text/words.
    public func transcribeSegments(
        mel fullMel: MLXArray,
        forcedLanguage: String? = nil,
        wordTimestamps: Bool = true,
        sampleLen: Int = 224
    ) -> WhisperTranscription {
        let hop = WhisperMel.hopLength            // 160
        let sr = WhisperMel.sampleRate            // 16000
        let nFrames = fullMel.shape[0]
        let windowFrames = Self.melFramesPerWindow  // 3000
        let inputStride = windowFrames / Self.nAudioCtx  // 2 (mel frames per audio-ctx token)
        let timePrecision = Double(inputStride * hop) / Double(sr)
        let tsBegin = WhisperTokenizer.timestampBegin
        let eot = WhisperTokenizer.endOfText

        // Language: detect once on the first 30s head unless forced.
        var language = forcedLanguage ?? ""
        if forcedLanguage == nil {
            language = detectLanguage(mel: padOrTrimTo(fullMel[0..<min(windowFrames, nFrames)], windowFrames).expandedDimensions(axis: 0))
        }

        var seek = 0
        var segments: [WhisperSegment] = []

        while seek < nFrames {
            let timeOffset = Double(seek) * Double(hop) / Double(sr)
            let segmentSize = min(windowFrames, nFrames - seek)
            let melWindow = padOrTrimTo(fullMel[seek..<(seek + segmentSize)], windowFrames)
            let melBatched = melWindow.expandedDimensions(axis: 0)

            let result = transcribeWithFallback(mel: melBatched, language: language, sampleLen: sampleLen)
            let tokens = result.tokens

            if tokens.isEmpty {
                seek += segmentSize
                continue
            }

            if result.noSpeechProb.isFinite && result.noSpeechProb > 0.6 && !(result.avgLogprob > -1.0) {
                seek += segmentSize
                continue
            }

            // ── timestamp-token slice parsing (transcribe.py:346-412) ──────
            let windowSegs = parseTimestampSlices(
                tokens: tokens, tsBegin: tsBegin, eot: eot, timeOffset: timeOffset,
                timePrecision: timePrecision, windowDuration: Double(segmentSize) * Double(hop) / Double(sr)
            )

            // ── per-word alignment for this window's segments ──────────────
            var perSegWords: [[WhisperWord]] = Array(repeating: [], count: windowSegs.count)
            if wordTimestamps && !windowSegs.isEmpty {
                let windowForAlign = melWindow   // the SAME 30s mel window (content-cropped via numFrames)
                perSegWords = WhisperAlignment.addWordTimestamps(
                    windowSegments: windowSegs.map { (start: $0.start, end: $0.end, textTokens: $0.textTokens) },
                    model: self, melWindow: windowForAlign, numFrames: segmentSize,
                    language: language, nDecoderLayer: nDecoderLayer, nHead: nHead, timeOffset: timeOffset
                )
            }

            for (i, ws) in windowSegs.enumerated() {
                segments.append(WhisperSegment(start: ws.start, end: ws.end, text: ws.text, words: perSegWords.indices.contains(i) ? perSegWords[i] : []))
            }

            // ── advance seek per the timestamp structure ───────────────────
            let n = tokens.count
            let isTimestamp = tokens.map { $0 >= tsBegin }
            let singleTimestampEnding = n >= 2 && !isTimestamp[n - 2] && isTimestamp[n - 1]
            var hasConsecutive = false
            for i in 0..<(n - 1) where isTimestamp[i] && isTimestamp[i + 1] { hasConsecutive = true; break }

            if hasConsecutive {
                if singleTimestampEnding {
                    seek += segmentSize
                } else {
                    // seek to the last consecutive boundary's timestamp position.
                    var lastBoundary = 0
                    for i in 0..<(n - 1) where isTimestamp[i] && isTimestamp[i + 1] { lastBoundary = i + 1 }
                    let lastTsPos = tokens[lastBoundary - 1] - tsBegin
                    seek += lastTsPos * inputStride
                }
            } else {
                seek += segmentSize
            }
        }

        let fullText = segments.map { $0.text }.joined(separator: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return WhisperTranscription(language: language, text: fullText, segments: segments)
    }

    /// Parse one window's generated token stream (post-sotSequenceWithTimestamps,
    /// including timestamp tokens) into segments, faithfully porting
    /// transcribe.py's consecutive-timestamp slice logic + the
    /// no-consecutive-timestamp fallback. Each segment carries its absolute
    /// [start, end) and the inner text tokens (timestamp tokens stripped).
    private func parseTimestampSlices(
        tokens: [Int], tsBegin: Int, eot: Int, timeOffset: Double, timePrecision: Double, windowDuration: Double
    ) -> [WindowSegment] {
        let n = tokens.count
        let isTimestamp = tokens.map { $0 >= tsBegin }
        let singleTimestampEnding = n >= 2 && !isTimestamp[n - 2] && isTimestamp[n - 1]

        var consecutive: [Int] = []
        for i in 0..<(n - 1) {
            if isTimestamp[i] && isTimestamp[i + 1] { consecutive.append(i + 1) }
        }

        var out: [WindowSegment] = []
        if !consecutive.isEmpty {
            var slices = consecutive
            if singleTimestampEnding { slices.append(n) }
            var lastSlice = 0
            for currentSlice in slices {
                let sliced = Array(tokens[lastSlice..<currentSlice])
                if let firstTok = sliced.first, let lastTok = sliced.last {
                    let startPos = firstTok - tsBegin
                    let endPos = lastTok - tsBegin
                    let segStart = timeOffset + Double(startPos) * timePrecision
                    let segEnd = timeOffset + Double(endPos) * timePrecision
                    let textTokens = sliced.filter { $0 < eot }
                    let text = WhisperTokenizer.decode(textTokens).trimmingCharacters(in: .whitespacesAndNewlines)
                    out.append(WindowSegment(start: segStart, end: segEnd, text: text, textTokens: textTokens))
                }
                lastSlice = currentSlice
            }
        } else {
            var duration = windowDuration
            let timestampTokens = tokens.filter { $0 >= tsBegin }
            if let last = timestampTokens.last, last != tsBegin {
                duration = Double(last - tsBegin) * timePrecision
            }
            let textTokens = tokens.filter { $0 < eot }
            let text = WhisperTokenizer.decode(textTokens).trimmingCharacters(in: .whitespacesAndNewlines)
            out.append(WindowSegment(start: timeOffset, end: timeOffset + duration, text: text, textTokens: textTokens))
        }
        return out
    }

    /// mlx_whisper.audio.pad_or_trim along axis 0: zero-pad short arrays up
    /// to `length`, or trim long ones.
    private func padOrTrimTo(_ x: MLXArray, _ length: Int) -> MLXArray {
        let cur = x.shape[0]
        if cur == length { return x }
        if cur > length { return x[0..<length] }
        let cols = x.shape[1]
        let padCount = length - cur
        let pad = MLXArray([Float](repeating: 0, count: padCount * cols), [padCount, cols])
        return concatenated([x, pad], axis: 0)
    }
}
