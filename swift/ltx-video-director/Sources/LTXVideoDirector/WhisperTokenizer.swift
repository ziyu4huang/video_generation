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
    /// ISO 639-1 codes in mlx_whisper.tokenizer.LANGUAGES' exact dict order,
    /// TRUNCATED to the first 99 — special-token ids are `sotBase + 1 +
    /// index`, so both the order AND this exact count are load bearing, not
    /// just documentation. mlx_whisper.tokenizer.get_encoding's default
    /// `num_languages=99` slices `LANGUAGES.keys()[:99]`, which DROPS the
    /// 100th ("yue") from the reserved language-token range — confirmed via
    /// a live `mlx_whisper.get_tokenizer(multilingual=True, language="ja")`
    /// call returning language-token id 50266 (index 7), which only lines
    /// up if this list has exactly 99 entries, not the full 100-key dict.
    public static let languageCodesInOrder: [String] = [
        "en", "zh", "de", "es", "ru", "ko", "fr", "ja", "pt", "tr", "pl", "ca", "nl", "ar", "sv",
        "it", "id", "hi", "fi", "vi", "he", "uk", "el", "ms", "cs", "ro", "da", "hu", "ta", "no",
        "th", "ur", "hr", "bg", "lt", "la", "mi", "ml", "cy", "sk", "te", "fa", "lv", "bn", "sr",
        "az", "sl", "kn", "et", "mk", "br", "eu", "is", "hy", "ne", "mn", "bs", "kk", "sq", "sw",
        "gl", "mr", "pa", "si", "km", "sn", "yo", "so", "af", "oc", "ka", "be", "tg", "sd", "gu",
        "am", "yi", "lo", "uz", "fo", "ht", "ps", "tk", "nn", "mt", "sa", "lb", "my", "bo", "tl",
        "mg", "as", "tt", "haw", "ln", "ha", "ba", "jw", "su",
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
}
