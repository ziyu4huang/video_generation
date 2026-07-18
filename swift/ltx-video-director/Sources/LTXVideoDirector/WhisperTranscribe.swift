//
//  WhisperTranscribe.swift
//  LTXVideoDirector
//
//  Segment-level native transcription on top of the real-checkpoint-verified
//  WhisperModel encoder/decoder + WhisperDecoding's temperature-fallback loop.
//  This closes the FIRST half of replacing mlx_whisper at runtime: a full
//  seek-loop transcription with segment boundaries derived from the timestamp
//  tokens the decoder already emits (WhisperDecoding.decodeOnce decodes from
//  sotSequenceWithTimestamps + applies ApplyTimestampRules, so the generated
//  token stream genuinely alternates <|t|> timestamp tokens around text runs).
//
//  The algorithm is a line-for-line port of mlx_whisper.transcribe.transcribe's
//  seek loop + timestamp-token slice parsing (transcribe.py lines ~247-412),
//  MINUS the pieces that belong to the cross-attention DTW word-alignment
//  path (word_timestamps / add_word_timestamps) — that is a separate, harder
//  port tracked as P2b. Everything needed for segment-level timestamps + the
//  full transcript text is here.
//
//  Constants mirror mlx_whisper.audio: N_FRAMES=3000 mel frames per 30s
//  window, n_audio_ctx=1500 encoder positions (conv2 stride-2 halves the
//  frame count), input_stride=2, time_precision=0.02s per timestamp token,
//  HOP_LENGTH=160, SAMPLE_RATE=16000.
//

import Foundation
import MLX

/// One transcribed segment: an absolute [start, end) time range (seconds)
/// plus the decoded text. Mirrors the per-segment slice of mlx_whisper's
/// WhisperResult that the Bun `whisperAdapter` parses.
public struct WhisperSegment {
    public let start: Double
    public let end: Double
    public let text: String

    public init(start: Double, end: Double, text: String) {
        self.start = start; self.end = end; self.text = text
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

extension WhisperModel {
    /// mlx_whisper.audio constants framing the seek loop.
    public static let nAudioCtx = 1500
    public static let melFramesPerWindow = 3000   // N_FRAMES — 30s of log-mel

    /// Transcribe a full log-mel spectrogram (shape (n_frames, n_mels), e.g.
    /// from `WhisperMel.logMelSpectrogram`) into segment-level timestamps +
    /// text, windowing >30s audio in 30s chunks exactly as mlx_whisper does.
    ///
    /// - Parameters:
    ///   - mel: full log-mel, shape (n_frames, n_mels). Variable n_frames;
    ///     each 3000-frame window is one decode pass.
    ///   - forcedLanguage: ISO 639-1 code to force-decode (e.g. "en", "zh").
    ///     nil → auto-detect once on the first 30s head via `detectLanguage`
    ///     and reuse for every window (mirrors mlx_whisper's single detect
    ///     at the start of the first clip).
    ///   - sampleLen: per-window generation cap (WhisperDecoding default 224).
    /// - Returns: language + concatenated text + per-segment start/end/text.
    public func transcribeSegments(
        mel fullMel: MLXArray,
        forcedLanguage: String? = nil,
        sampleLen: Int = 224
    ) -> WhisperTranscription {
        let hop = WhisperMel.hopLength            // 160
        let sr = WhisperMel.sampleRate            // 16000
        let nFrames = fullMel.shape[0]
        let windowFrames = Self.melFramesPerWindow  // 3000
        let inputStride = windowFrames / Self.nAudioCtx  // 2 (mel frames per audio-ctx token)
        // time per timestamp token = input_stride * HOP / SR = 2 * 160 / 16000 = 0.02s
        let timePrecision = Double(inputStride * hop) / Double(sr)
        let tsBegin = WhisperTokenizer.timestampBegin
        let eot = WhisperTokenizer.endOfText

        // Language: detect once on the first 30s head unless forced. Matches
        // mlx_whisper, which runs detect_language once on the first segment.
        var language = forcedLanguage ?? ""
        if forcedLanguage == nil {
            language = detectLanguage(mel: padOrTrimTo(fullMel[0..<min(windowFrames, nFrames)], windowFrames).expandedDimensions(axis: 0))
        }

        var seek = 0
        var segments: [WhisperSegment] = []

        while seek < nFrames {
            // time_offset = seek * HOP / SR (seconds) — absolute window start.
            let timeOffset = Double(seek) * Double(hop) / Double(sr)
            let segmentSize = min(windowFrames, nFrames - seek)
            let melWindow = padOrTrimTo(fullMel[seek..<(seek + segmentSize)], windowFrames)
            let melBatched = melWindow.expandedDimensions(axis: 0)  // (1, 3000, n_mels)

            let result = transcribeWithFallback(mel: melBatched, language: language, sampleLen: sampleLen)
            let tokens = result.tokens

            if tokens.isEmpty {
                seek += segmentSize
                continue
            }

            // mlx_whisper's voice-activity skip: a window classified as
            // no-speech (no_speech_prob > 0.6) is fast-forwarded UNLESS the
            // logprob is high enough (avg_logprob > -1.0) to rescue it.
            if result.noSpeechProb.isFinite && result.noSpeechProb > 0.6 && !(result.avgLogprob > -1.0) {
                seek += segmentSize
                continue
            }

            // ── timestamp-token slice parsing (transcribe.py:346-412) ──────
            let n = tokens.count
            let isTimestamp = tokens.map { $0 >= tsBegin }
            // single_timestamp_ending: the last two tokens are [text, timestamp]
            // — a trailing timestamp with no following text (silence after it).
            let singleTimestampEnding = n >= 2 && !isTimestamp[n - 2] && isTimestamp[n - 1]

            // consecutive = indices where two timestamp tokens are adjacent,
            // then +1 (the boundary between a segment's end-ts and the next
            // segment's start-ts).
            var consecutive: [Int] = []
            for i in 0..<(n - 1) {
                if isTimestamp[i] && isTimestamp[i + 1] { consecutive.append(i + 1) }
            }

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
                        let text = WhisperTokenizer.decode(textTokens)
                            .trimmingCharacters(in: .whitespacesAndNewlines)
                        segments.append(WhisperSegment(start: segStart, end: segEnd, text: text))
                    }
                    lastSlice = currentSlice
                }

                if singleTimestampEnding {
                    // trailing timestamp → no speech after it; advance a full window.
                    seek += segmentSize
                } else {
                    // unfinished tail segment: drop it and seek to the last
                    // timestamp so the next window re-decodes the tail.
                    let lastTimestampPos = tokens[lastSlice - 1] - tsBegin
                    seek += lastTimestampPos * inputStride
                }
            } else {
                // No consecutive timestamps — the whole window is one segment.
                // Use the last timestamp token as the end if present (and it
                // isn't the bare <|0.00|> marker), else the full window duration.
                var duration = Double(segmentSize) * Double(hop) / Double(sr)
                let timestampTokens = tokens.filter { $0 >= tsBegin }
                if let last = timestampTokens.last, last != tsBegin {
                    duration = Double(last - tsBegin) * timePrecision
                }
                let textTokens = tokens.filter { $0 < eot }
                let text = WhisperTokenizer.decode(textTokens)
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                segments.append(WhisperSegment(start: timeOffset, end: timeOffset + duration, text: text))
                seek += segmentSize
            }
        }

        // mlx_whisper: text = " ".join(segment texts).strip(). Each decoded
        // segment carries a leading space from GPT-2 BPE; joining on " " then
        // trimming reproduces the canonical full transcript.
        let fullText = segments.map { $0.text }.joined(separator: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return WhisperTranscription(language: language, text: fullText, segments: segments)
    }

    /// mlx_whisper.audio.pad_or_trim along axis 0: zero-pad short arrays up
    /// to `length`, or trim long ones. Used to fixed-size each 30s mel window
    /// before the encoder (positional embedding covers exactly n_audio_ctx*2
    /// = 3000 frames).
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
