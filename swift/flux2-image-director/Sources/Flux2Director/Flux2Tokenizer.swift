//
//  Flux2Tokenizer.swift
//  Flux2Director
//
//  Phase 2.2: Qwen3 BPE tokenizer for Flux2 Klein. Reads tokenizer.json
//  (HuggingFace format), applies the Qwen3 chat template (enable_thinking=False),
//  and produces padded (input_ids, attention_mask) for the text encoder.
//
//  Chat template (enable_thinking=False, add_generation_prompt=True):
//    <|im_start|>user\n{prompt}<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n
//

import Foundation

// MARK: - Byte-level BPE tokenizer (Qwen3 / GPT-4 pre-tokenizer)

public struct Flux2Tokenizer {
    let vocab: [String: Int]
    let mergeRanks: [String: Int]
    let specialTokens: [String: Int]
    let byteEncoder: [UInt8: Character]
    let padTokenId: Int
    let patRegex: NSRegularExpression
    var cache: [String: [Int]] = [:]

    public var vocabCount: Int { vocab.count }

    // MARK: - Loading

    public init?(jsonURL: URL) {
        guard let data = try? Data(contentsOf: jsonURL),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let model = json["model"] as? [String: Any],
              let vocabDict = model["vocab"] as? [String: Int]
        else { return nil }
        self.vocab = vocabDict

        var ranks: [String: Int] = [:]
        if let merges = model["merges"] as? [String] {
            for (rank, line) in merges.enumerated() { ranks[line] = rank }
        } else if let merges = model["merges"] as? [[String]] {
            for (rank, pair) in merges.enumerated() where pair.count == 2 {
                ranks["\(pair[0]) \(pair[1])"] = rank
            }
        }
        self.mergeRanks = ranks

        var specials: [String: Int] = [:]
        if let added = json["added_tokens"] as? [[String: Any]] {
            for token in added {
                if let content = token["content"] as? String, let id = token["id"] as? Int {
                    specials[content] = id
                }
            }
        }
        self.specialTokens = specials
        self.padTokenId = specials["<|endoftext|>"] ?? 151643

        let (enc, _) = Flux2Tokenizer.bytesToUnicode()
        self.byteEncoder = enc

        let pattern = #"(?i:'s|'t|'re|'ve|'m|'ll|'d)|[^\r\n\p{L}\p{N}]?\p{L}+|\p{N}| ?[^\s\p{L}\p{N}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+"#
        self.patRegex = try! NSRegularExpression(pattern: pattern)
    }

    // MARK: - GPT-2 bytes_to_unicode

    private static func bytesToUnicode() -> ([UInt8: Character], [Character: UInt8]) {
        let directRanges: [Range<Int>] = [33..<127, 161..<173, 174..<256]
        var bs: Set<UInt8> = []
        for range in directRanges { for v in range { bs.insert(UInt8(v)) } }
        var encoder: [UInt8: Character] = [:]
        var decoder: [Character: UInt8] = [:]
        var other: UInt16 = 0
        for byte in 0..<256 {
            let v = UInt8(byte)
            if bs.contains(v) {
                let c = Character(UnicodeScalar(byte)!)
                encoder[v] = c; decoder[c] = v
            } else {
                let c = Character(UnicodeScalar(256 + Int(other))!)
                encoder[v] = c; decoder[c] = v; other += 1
            }
        }
        return (encoder, decoder)
    }

    // MARK: - BPE

    private static func getPairs(_ word: [String]) -> Set<[String]> {
        var pairs = Set<[String]>()
        for i in 0..<word.count - 1 { pairs.insert([word[i], word[i + 1]]) }
        return pairs
    }

    private mutating func bpe(_ token: String) -> [Int] {
        if let cached = cache[token] { return cached }
        var word = token.map { String($0) }
        if word.count <= 1 {
            let r = [vocab[token]].compactMap { $0 }; cache[token] = r; return r
        }
        while true {
            let pairs = Flux2Tokenizer.getPairs(word)
            var bestPair: [String]? = nil
            var bestRank = Int.max
            for pair in pairs {
                if let rank = mergeRanks["\(pair[0]) \(pair[1])"], rank < bestRank {
                    bestRank = rank; bestPair = pair
                }
            }
            guard let pair = bestPair else { break }
            var nw: [String] = []; var i = 0
            while i < word.count {
                if i < word.count - 1 && word[i] == pair[0] && word[i + 1] == pair[1] {
                    nw.append(pair[0] + pair[1]); i += 2
                } else { nw.append(word[i]); i += 1 }
            }
            word = nw
            if word.count == 1 { break }
        }
        let r = word.compactMap { vocab[$0] }; cache[token] = r; return r
    }

    private mutating func encodeOrdinary(_ text: String) -> [Int] {
        let normalized = text.precomposedStringWithCanonicalMapping
        let range = NSRange(normalized.startIndex..., in: normalized)
        var preTokens: [String] = []
        patRegex.enumerateMatches(in: normalized, options: [], range: range) { m, _, _ in
            guard let m = m, let r = Range(m.range, in: normalized) else { return }
            preTokens.append(String(normalized[r]))
        }
        var ids: [Int] = []
        for pt in preTokens {
            let utf8 = Array(pt.utf8)
            let encoded = String(utf8.compactMap { byteEncoder[$0] })
            ids.append(contentsOf: bpe(encoded))
        }
        return ids
    }

    public mutating func encode(_ text: String, allowedSpecial: Set<String>? = nil) -> [Int] {
        let specials = allowedSpecial ?? Set(specialTokens.keys)
        if specials.isEmpty { return encodeOrdinary(text) }
        let escaped = specials.map { NSRegularExpression.escapedPattern(for: $0) }.joined(separator: "|")
        guard let splitRegex = try? NSRegularExpression(pattern: escaped) else {
            return encodeOrdinary(text)
        }
        var ids: [Int] = []
        let range = NSRange(text.startIndex..., in: text)
        var lastEnd = text.startIndex
        splitRegex.enumerateMatches(in: text, options: [], range: range) { m, _, _ in
            guard let m = m, let mr = Range(m.range, in: text) else { return }
            if lastEnd < mr.lowerBound {
                ids.append(contentsOf: encodeOrdinary(String(text[lastEnd..<mr.lowerBound])))
            }
            let s = String(text[mr])
            if let id = specialTokens[s] { ids.append(id) }
            lastEnd = mr.upperBound
        }
        if lastEnd < text.endIndex {
            ids.append(contentsOf: encodeOrdinary(String(text[lastEnd..<text.endIndex])))
        }
        return ids
    }

    // MARK: - Flux2 Qwen3 chat template (enable_thinking=False)

    /// Qwen3 chat template with enable_thinking=False + add_generation_prompt.
    /// Produces: <|im_start|>user\n{prompt}<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n
    public func applyChatTemplate(_ prompt: String) -> String {
        "<|im_start|>user\n\(prompt)<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n"
    }

    /// Full pipeline: prompt → chat template → tokenize → pad/truncate to maxLength.
    /// Returns (input_ids, attention_mask) as flat arrays, both length maxLength.
    public mutating func tokenize(_ prompt: String, maxLength: Int = 512)
        -> (inputIds: [Int], attentionMask: [Int])
    {
        let formatted = applyChatTemplate(prompt)
        var ids = encode(formatted, allowedSpecial: Set(specialTokens.keys))
        if ids.count > maxLength { ids = Array(ids.prefix(maxLength)) }
        let actualLen = ids.count
        while ids.count < maxLength { ids.append(padTokenId) }
        var mask = Array(repeating: 1, count: actualLen)
        while mask.count < maxLength { mask.append(0) }
        return (ids, mask)
    }
}
