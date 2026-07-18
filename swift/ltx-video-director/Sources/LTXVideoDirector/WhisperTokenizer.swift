//
//  WhisperTokenizer.swift
//  LTXVideoDirector
//
//  Fourth real piece of the native Swift/MLX Whisper port (after
//  WhisperMel/WhisperEncoder/WhisperDecoder) — DECODE-only port of
//  mlx_whisper's tiktoken-based multilingual tokenizer
//  (mlx_whisper/tokenizer.py's get_encoding("multilingual")).
//
//  Deliberately decode-only: this ASR gate only ever needs token ids ->
//  text (the decode loop below produces ids; nothing here needs to encode
//  arbitrary text back into ids, which is what tiktoken's regex
//  pre-tokenizer + greedy-merge BPE algorithm is actually for). Decoding a
//  tiktoken vocabulary needs none of that — each of the 50257 mergeable
//  ranks already maps directly to its full byte string (that's what makes
//  it a byte-PAIR-encoding vocab: entries are progressively-merged byte
//  sequences, not a rules list to replay) — decode is just id -> bytes ->
//  concat -> UTF-8. Special token ids (>= 50257: <|startoftranscript|>,
//  per-language, <|transcribe|>, <|notimestamps|>, timestamp tokens, ...)
//  are derived from the SAME closed-form language-index arithmetic
//  mlx_whisper.tokenizer.get_encoding uses, not hardcoded per-language.
//
//  Still open (PLAN.md Phase 3 / docs/TODO.md): the autoregressive decode
//  loop itself (greedy/beam search + KV cache) that would call this on the
//  logits WhisperDecoder produces. ASRGate.swift keeps bridging to
//  mlx_whisper for actual transcription until that lands.
//

import Foundation

public enum WhisperTokenizer {
    /// ISO 639-1 codes in mlx_whisper.tokenizer.LANGUAGES' exact dict order —
    /// special-token ids are `sotBase + 1 + index`, so both the order AND
    /// this exact count (100) are load bearing, not just documentation.
    ///
    /// IMPORTANT correction (found while porting temperature-fallback
    /// decoding — see WhisperDecoding.swift): this list previously
    /// TRUNCATED to 99 entries, dropping the 100th ("yue"), based on
    /// `mlx_whisper.tokenizer.get_encoding`'s bare default
    /// `num_languages=99`. That default is WRONG for the actual
    /// large-v3-mlx checkpoint this port targets: `Whisper.num_languages`
    /// (derived from the checkpoint's real `n_vocab=51866`) is **100**, one
    /// more than the bare-default tokenizer call. Every trailing special
    /// token computed from `languageCodesInOrder.count` below (`translate`,
    /// `transcribe`, `startOfLM`, `startOfPrev`, `noSpeech`,
    /// `noTimestamps`, `timestampBegin`) was therefore off by one against
    /// the real checkpoint — confirmed by comparing this port's decode
    /// against the REAL `mlx_whisper.decoding.DecodingTask` (which
    /// correctly threads `model.num_languages=100` through
    /// `get_tokenizer`): `no_timestamps`=50364 / `timestamp_begin`=50365 on
    /// the real checkpoint, not 50363/50364. Per-language token ids for
    /// languages BEFORE "yue" (e.g. "zh"@1, "ja"@7) are unaffected — only
    /// the trailing specials, which come after all 100 language slots,
    /// shifted by one.
    public static let languageCodesInOrder: [String] = [
        "en", "zh", "de", "es", "ru", "ko", "fr", "ja", "pt", "tr", "pl", "ca", "nl", "ar", "sv",
        "it", "id", "hi", "fi", "vi", "he", "uk", "el", "ms", "cs", "ro", "da", "hu", "ta", "no",
        "th", "ur", "hr", "bg", "lt", "la", "mi", "ml", "cy", "sk", "te", "fa", "lv", "bn", "sr",
        "az", "sl", "kn", "et", "mk", "br", "eu", "is", "hy", "ne", "mn", "bs", "kk", "sq", "sw",
        "gl", "mr", "pa", "si", "km", "sn", "yo", "so", "af", "oc", "ka", "be", "tg", "sd", "gu",
        "am", "yi", "lo", "uz", "fo", "ht", "ps", "tk", "nn", "mt", "sa", "lb", "my", "bo", "tl",
        "mg", "as", "tt", "haw", "ln", "ha", "ba", "jw", "su", "yue",
    ]

    /// Number of real (non-special) mergeable-BPE ranks — mlx_whisper's
    /// `n_vocab` before appending special tokens.
    public static let numBaseTokens = 50257

    public static let endOfText = numBaseTokens               // <|endoftext|>
    public static let startOfTranscript = numBaseTokens + 1   // <|startoftranscript|>
    // <|{lang}|> tokens occupy [startOfTranscript+1, startOfTranscript+languageCodesInOrder.count]
    public static var translate: Int { startOfTranscript + 1 + languageCodesInOrder.count }
    public static var transcribe: Int { translate + 1 }
    public static var startOfLM: Int { transcribe + 1 }
    public static var startOfPrev: Int { startOfLM + 1 }
    public static var noSpeech: Int { startOfPrev + 1 }
    public static var noTimestamps: Int { noSpeech + 1 }
    public static var timestampBegin: Int { noTimestamps + 1 }

    public static func languageToken(_ code: String) -> Int? {
        guard let idx = languageCodesInOrder.firstIndex(of: code) else { return nil }
        return startOfTranscript + 1 + idx
    }

    /// The exact SOT sequence mlx_whisper builds for (language, task) with
    /// no timestamps — matches `Tokenizer.sot_sequence_including_notimestamps`
    /// for `task == "transcribe"` (this ASR gate never needs "translate").
    public static func sotSequence(language: String) -> [Int] {
        var seq = [startOfTranscript]
        if let langTok = languageToken(language) { seq.append(langTok) }
        seq.append(transcribe)
        seq.append(noTimestamps)
        return seq
    }

    /// The SOT sequence WITH timestamps allowed — matches
    /// `Tokenizer.sot_sequence` (no trailing `<|notimestamps|>`). Real
    /// `mlx_whisper.transcribe()` uses this by default (it never sets
    /// `without_timestamps`), pairing it with `ApplyTimestampRules` logit
    /// filtering. `WhisperModel.transcribeWithFallback` uses this sequence
    /// to match `mlx_whisper.decoding.DecodingTask`'s actual decode path,
    /// as opposed to `sotSequence(language:)` above, which the simpler,
    /// documented-naive `WhisperModel.transcribe` uses.
    public static func sotSequenceWithTimestamps(language: String) -> [Int] {
        var seq = [startOfTranscript]
        if let langTok = languageToken(language) { seq.append(langTok) }
        seq.append(transcribe)
        return seq
    }

    /// `mlx_whisper.tokenizer.Tokenizer.non_speech_tokens` — a FIXED,
    /// checkpoint-independent token-id set (speaker tags / musical-note /
    /// bracket annotations, e.g. "♪♪♪", "[DAVID]") that `SuppressTokens`
    /// masks out during real decoding. Computing this from scratch needs
    /// tiktoken's BPE ENCODER (regex pre-tokenizer + greedy merges), which
    /// this decode-only tokenizer deliberately doesn't implement (see this
    /// file's header) — since the set is invariant for the multilingual
    /// vocab, it's precomputed once via
    /// `get_tokenizer(multilingual=True).non_speech_tokens` and embedded
    /// here as data, the same pattern `languageCodesInOrder` already uses.
    public static let nonSpeechTokens: [Int] = [
        1, 2, 7, 8, 9, 10, 14, 25, 26, 27, 28, 29, 31, 58, 59, 60, 61, 62, 63, 90, 91, 92, 93,
        359, 503, 522, 542, 873, 893, 902, 918, 922, 931, 1350, 1853, 1982, 2460, 2627, 3246,
        3253, 3268, 3536, 3846, 3961, 4183, 4667, 6585, 6647, 7273, 9061, 9383, 10428, 10929,
        11938, 12033, 12331, 12562, 13793, 14157, 14635, 15265, 15618, 16553, 16604, 18362,
        18956, 20075, 21675, 22520, 26130, 26161, 26435, 28279, 29464, 31650, 32302, 32470,
        36865, 42863, 47425, 49870, 50254,
    ]

    // rank -> raw bytes, loaded once from the bundled tiktoken vocab file.
    private static let rankToBytes: [[UInt8]] = {
        guard let url = Bundle.module.url(forResource: "whisper_multilingual", withExtension: "tiktoken") else {
            fatalError("whisper_multilingual.tiktoken missing from bundle resources")
        }
        guard let text = try? String(contentsOf: url, encoding: .utf8) else {
            fatalError("could not read whisper_multilingual.tiktoken")
        }
        var table = [[UInt8]](repeating: [], count: numBaseTokens)
        for line in text.split(separator: "\n") {
            let parts = line.split(separator: " ")
            guard parts.count == 2, let rank = Int(parts[1]),
                  let data = Data(base64Encoded: String(parts[0])) else { continue }
            if rank >= 0 && rank < numBaseTokens {
                table[rank] = [UInt8](data)
            }
        }
        return table
    }()

    /// Decode a sequence of token ids to text. Special tokens (id >=
    /// numBaseTokens) are skipped — matches mlx_whisper's own transcription
    /// path, which strips special tokens before returning `result["text"]`.
    public static func decode(_ ids: [Int]) -> String {
        var bytes: [UInt8] = []
        for id in ids {
            guard id >= 0 && id < numBaseTokens else { continue }
            bytes.append(contentsOf: rankToBytes[id])
        }
        return String(decoding: bytes, as: UTF8.self)
    }

    /// mlx_whisper's `decode_with_timestamps`: like `decode` but emits the
    /// textual form of special/timestamp tokens instead of dropping them
    /// (`<|endoftext|>`, `<|1.08|>`). Needed by `splitToWordTokens` — the
    /// unicode-boundary word-splitter runs on token lists that include the
    /// trailing `<|endoftext|>` sentinel (non-empty, U+FFFD-free, so the
    /// final partial-byte run always flushes). `String(decoding:as:UTF8.self)`
    /// replaces each maximal ill-formed byte subsequence with one U+FFFD,
    /// matching Python's `bytes.decode("utf-8", errors="replace")`.
    public static func decodeWithTimestamps(_ ids: [Int]) -> String {
        var bytes: [UInt8] = []
        for id in ids {
            if id >= 0 && id < numBaseTokens {
                bytes.append(contentsOf: rankToBytes[id])
            } else if id == endOfText {
                bytes.append(contentsOf: Array("<|endoftext|>".utf8))
            } else if id >= timestampBegin {
                let secs = Double(id - timestampBegin) * 0.02
                bytes.append(contentsOf: Array(String(format: "<|%.2f|>", secs).utf8))
            }
        }
        return String(decoding: bytes, as: UTF8.self)
    }

    /// Languages whose scripts don't use spaces → split at every unicode point
    /// rather than at spaces. Matches mlx_whisper.tokenizer.split_to_word_tokens.
    private static let noSpaceLanguages: Set<String> = ["zh", "ja", "th", "lo", "my", "yue"]

    /// mlx_whisper.tokenizer.Tokenizer.split_to_word_tokens.
    public static func splitToWordTokens(_ tokens: [Int], language: String) -> (words: [String], wordTokens: [[Int]]) {
        if noSpaceLanguages.contains(language) {
            return splitTokensOnUnicode(tokens)
        }
        return splitTokensOnSpaces(tokens)
    }

    /// mlx_whisper.tokenizer.split_tokens_on_unicode: decode the token stream
    /// incrementally; flush a word whenever the accumulated decode has NO
    /// replacement char, OR its replacement char aligns with a real one in the
    /// full decode (i.e. the bytes are genuinely invalid, not just awaiting a
    /// completing token). Works on Unicode scalar arrays so the offset
    /// arithmetic matches Python codepoint indexing.
    private static func splitTokensOnUnicode(_ tokens: [Int]) -> (words: [String], wordTokens: [[Int]]) {
        let fullScalars = Array(decodeWithTimestamps(tokens).unicodeScalars)
        let replacement = Unicode.Scalar(0xFFFD)!
        var words: [String] = []
        var wordTokens: [[Int]] = []
        var current: [Int] = []
        var offset = 0
        for token in tokens {
            current.append(token)
            let decoded = decodeWithTimestamps(current)
            let scalars = Array(decoded.unicodeScalars)
            let flush: Bool
            if let ridx = scalars.firstIndex(of: replacement) {
                let pos = offset + ridx
                flush = pos < fullScalars.count && fullScalars[pos] == replacement
            } else {
                flush = true
            }
            if flush {
                words.append(decoded)
                wordTokens.append(current)
                current = []
                offset += scalars.count
            }
        }
        return (words, wordTokens)
    }

    /// mlx_whisper.tokenizer.split_tokens_on_spaces: split on unicode, then
    /// merge subwords that are non-special, non-space-leading, and
    /// non-punctuation into the previous word.
    private static func splitTokensOnSpaces(_ tokens: [Int]) -> (words: [String], wordTokens: [[Int]]) {
        let punctuation: Set<Character> = Set("!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~")
        let (subwords, subwordTokens) = splitTokensOnUnicode(tokens)
        var words: [String] = []
        var wordTokens: [[Int]] = []
        for (subword, tk) in zip(subwords, subwordTokens) {
            let isSpecial = (tk.first ?? 0) >= endOfText
            let withSpace = subword.hasPrefix(" ")
            let stripped = subword.trimmingCharacters(in: .whitespaces)
            let isPunct = stripped.count == 1 && punctuation.contains(Character(stripped))
            if isSpecial || withSpace || isPunct || words.isEmpty {
                words.append(subword)
                wordTokens.append(tk)
            } else {
                words[words.count - 1] += subword
                wordTokens[wordTokens.count - 1].append(contentsOf: tk)
            }
        }
        return (words, wordTokens)
    }
}
