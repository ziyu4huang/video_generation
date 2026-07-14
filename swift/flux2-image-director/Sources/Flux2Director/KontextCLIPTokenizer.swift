//
//  KontextCLIPTokenizer.swift
//  Flux2Director
//
//  Part of the `kontext` (FLUX.1-Kontext-dev) native-port epic, phase 5
//  prerequisite — see output/next-goal-20260714_223500.md. Ports OpenAI
//  CLIP's `SimpleTokenizer` (the algorithm HF's `CLIPTokenizer` slow path
//  wraps) directly from `vocab.json` + `merges.txt` (the raw HF
//  `tokenizer/` files — no fast `tokenizer.json` exists for CLIP in this
//  checkpoint, only the legacy vocab+merges format).
//
//  Algorithm (byte-level BPE, `</w>` end-of-word suffix convention — NOT the
//  GPT-2/Qwen3 "Ġ"-space-prefix convention `Flux2Tokenizer.swift` implements
//  for a genuinely different tokenizer, so this is a separate implementation
//  despite superficial BPE-merge-loop similarity):
//    1. Lowercase (do_lower_case=true), NFC-normalize, collapse whitespace runs.
//    2. Pre-tokenize via OpenAI CLIP's regex (contractions, letter runs,
//       digit runs, punctuation runs — NOT Qwen3's GPT-4-style pattern).
//    3. Byte-encode each pretoken (GPT-2's `bytes_to_unicode`, shared with
//       `Flux2Tokenizer` via `KontextTokenizerUtils.bytesToUnicode()`), then
//       BPE-merge with the LAST byte-unit of the token suffixed `</w>`
//       (marks word boundary — this is what makes CLIP's BPE distinct from
//       GPT-2's).
//    4. Wrap: [bos] + content (truncated to maxLength-2) + [eos], padded
//       with eos (CLIP's pad_token == eos_token) to maxLength (verified
//       against real `CLIPTokenizer` output: a 100-word prompt at
//       maxLength=77 produces exactly 75 content tokens + bos + eos, zero
//       trailing pad).
//
//  Numerically verified via `flux2 verify-kontext-clip-tokenizer` — exact
//  token-id match (not just length) against real HF `CLIPTokenizer` output
//  for a fixed prompt set (ASCII, punctuation, contractions, multi-space,
//  accented Latin, CJK, empty string).
//

import Foundation

public struct KontextCLIPTokenizer {
    let vocab: [String: Int]
    let mergeRanks: [String: Int]
    let byteEncoder: [UInt8: Character]
    let bosId: Int
    let eosId: Int
    var cache: [String: [String]] = [:]

    public static let maxLength = 77

    // MARK: - Loading (vocab.json + merges.txt — legacy HF format, no fast tokenizer.json)

    public init?(vocabURL: URL, mergesURL: URL) {
        guard let vocabData = try? Data(contentsOf: vocabURL),
              let vocabDict = try? JSONSerialization.jsonObject(with: vocabData) as? [String: Int]
        else { return nil }
        self.vocab = vocabDict

        guard let mergesText = try? String(contentsOf: mergesURL, encoding: .utf8) else { return nil }
        var ranks: [String: Int] = [:]
        var rank = 0
        for line in mergesText.split(separator: "\n", omittingEmptySubsequences: true) {
            if line.hasPrefix("#version") { continue }
            ranks[String(line)] = rank
            rank += 1
        }
        self.mergeRanks = ranks

        self.byteEncoder = KontextTokenizerUtils.bytesToUnicode()
        self.bosId = vocabDict["<|startoftext|>"] ?? 49406
        self.eosId = vocabDict["<|endoftext|>"] ?? 49407
    }

    // MARK: - Pre-tokenizer regex (OpenAI CLIP's SimpleTokenizer pattern)

    private static let pattern = try! NSRegularExpression(
        pattern: #"<\|startoftext\|>|<\|endoftext\|>|'s|'t|'re|'ve|'m|'ll|'d|\p{L}+|\p{N}|[^\s\p{L}\p{N}]+"#,
        options: [.caseInsensitive]
    )

    /// Matches HF's `BasicTokenizer._is_chinese_char` (CJK Unified Ideograph
    /// ranges only — deliberately NOT Hiragana/Katakana/Hangul, which are
    /// handled like any other alphabetic script).
    private static func isCJKUnifiedIdeograph(_ scalar: Unicode.Scalar) -> Bool {
        let cp = scalar.value
        return (cp >= 0x4E00 && cp <= 0x9FFF) || (cp >= 0x3400 && cp <= 0x4DBF)
            || (cp >= 0x20000 && cp <= 0x2A6DF) || (cp >= 0x2A700 && cp <= 0x2B73F)
            || (cp >= 0x2B740 && cp <= 0x2B81F) || (cp >= 0x2B820 && cp <= 0x2CEAF)
            || (cp >= 0xF900 && cp <= 0xFAFF) || (cp >= 0x2F800 && cp <= 0x2FA1F)
    }

    /// Ports HF `CLIPTokenizer._tokenize`'s no-ftfy fallback path (this repo's
    /// venv has no `ftfy` installed, confirmed empirically — the real code
    /// path taken is `BasicTokenizer(strip_accents=False,
    /// do_split_on_punc=False)`, which wraps CJK Unified Ideographs in
    /// spaces so each becomes its own pretoken, then NFC-normalizes, then
    /// lowercases, then collapses whitespace — accents are NOT stripped
    /// despite `do_lower_case=True`, confirmed: "café résumé naïve" round-trips
    /// with accents intact).
    private static func basicCleanAndLower(_ text: String) -> String {
        var spaced = ""
        spaced.reserveCapacity(text.count)
        for scalar in text.unicodeScalars {
            if isCJKUnifiedIdeograph(scalar) {
                spaced.append(" "); spaced.unicodeScalars.append(scalar); spaced.append(" ")
            } else {
                spaced.unicodeScalars.append(scalar)
            }
        }
        let nfc = spaced.precomposedStringWithCanonicalMapping
        let collapsed = nfc.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
        return collapsed.trimmingCharacters(in: .whitespaces).lowercased()
    }

    private func preTokenize(_ text: String) -> [String] {
        let range = NSRange(text.startIndex..., in: text)
        var tokens: [String] = []
        Self.pattern.enumerateMatches(in: text, options: [], range: range) { m, _, _ in
            guard let m, let r = Range(m.range, in: text) else { return }
            tokens.append(String(text[r]))
        }
        return tokens
    }

    // MARK: - BPE (`</w>` suffix on the last byte-unit, per OpenAI CLIP)

    private static func getPairs(_ word: [String]) -> Set<[String]> {
        var pairs = Set<[String]>()
        for i in 0..<max(word.count - 1, 0) { pairs.insert([word[i], word[i + 1]]) }
        return pairs
    }

    private mutating func bpe(_ token: String) -> [String] {
        if let cached = cache[token] { return cached }
        var units = token.map { String($0) }
        guard units.count > 1 else {
            let r = [token + "</w>"]
            cache[token] = r
            return r
        }
        units[units.count - 1] = units[units.count - 1] + "</w>"
        var word = units
        while true {
            let pairs = Self.getPairs(word)
            var bestPair: [String]? = nil
            var bestRank = Int.max
            for pair in pairs {
                if let rank = mergeRanks["\(pair[0]) \(pair[1])"], rank < bestRank {
                    bestRank = rank; bestPair = pair
                }
            }
            guard let pair = bestPair else { break }
            var nw: [String] = []
            var i = 0
            while i < word.count {
                if i < word.count - 1 && word[i] == pair[0] && word[i + 1] == pair[1] {
                    nw.append(pair[0] + pair[1]); i += 2
                } else {
                    nw.append(word[i]); i += 1
                }
            }
            word = nw
            if word.count == 1 { break }
        }
        cache[token] = word
        return word
    }

    private mutating func encode(_ text: String) -> [Int] {
        let cleaned = Self.basicCleanAndLower(text)
        var ids: [Int] = []
        for pretoken in preTokenize(cleaned) {
            let utf8 = Array(pretoken.utf8)
            let byteEncoded = String(utf8.compactMap { byteEncoder[$0] })
            for piece in bpe(byteEncoded) {
                if let id = vocab[piece] { ids.append(id) }
            }
        }
        return ids
    }

    /// Full pipeline: prompt -> [bos] + content(truncated to maxLength-2) +
    /// [eos] + pad(eos) to maxLength. Returns flat input_ids, length maxLength.
    public mutating func tokenize(_ prompt: String, maxLength: Int = KontextCLIPTokenizer.maxLength) -> [Int] {
        var content = encode(prompt)
        if content.count > maxLength - 2 {
            content = Array(content.prefix(maxLength - 2))
        }
        var ids = [bosId] + content + [eosId]
        while ids.count < maxLength { ids.append(eosId) }
        return ids
    }
}
