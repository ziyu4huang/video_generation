//
//  Tokenizer.swift
//  ZImageDirector
//
//  Phase 3: Qwen3 BPE tokenizer — text → token IDs.
//  Implements GPT-2 byte-level BPE with the GPT-4 pre-tokenizer regex.
//  Loads vocab + merges from tokenizer.json.
//

import Foundation

// MARK: - Byte-level BPE tokenizer

public struct BPETokenizer {
    /// Maps byte-level encoded strings → token IDs.
    let vocab: [String: Int]
    /// Merge rules as "left right" → rank (lower = higher priority).
    let mergeRanks: [String: Int]
    /// Special tokens (e.g. "<|im_start|>") → fixed IDs.
    let specialTokens: [String: Int]
    /// Byte → unicode char mapping (GPT-2 bytes_to_unicode).
    let byteEncoder: [UInt8: Character]
    /// Reverse: unicode char → byte (for reference / debugging).
    let byteDecoder: [Character: UInt8]
    /// Pad token ID.
    let padTokenId: Int
    /// GPT-4 pre-tokenizer regex.
    let patRegex: NSRegularExpression

    /// Number of vocab entries.
    public var vocabCount: Int { vocab.count }
    /// Number of merge rules.
    public var mergeCount: Int { mergeRanks.count }

    // BPE cache (token string → token IDs).
    var cache: [String: [Int]] = [:]

    // MARK: - Loading

    public init?(jsonURL: URL) {
        guard let data = try? Data(contentsOf: jsonURL),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let model = json["model"] as? [String: Any],
              let vocabDict = model["vocab"] as? [String: Int]
        else { return nil }

        self.vocab = vocabDict

        // Build merge ranks from the merges list.
        var ranks: [String: Int] = [:]
        if let merges = model["merges"] as? [[String]] {
            for (rank, pair) in merges.enumerated() where pair.count == 2 {
                ranks["\(pair[0]) \(pair[1])"] = rank
            }
        } else if let merges = model["merges"] as? [String] {
            for (rank, line) in merges.enumerated() {
                ranks[line] = rank
            }
        }
        self.mergeRanks = ranks

        // Special tokens from added_tokens.
        var specials: [String: Int] = [:]
        if let added = json["added_tokens"] as? [[String: Any]] {
            for token in added {
                if let content = token["content"] as? String,
                   let id = token["id"] as? Int {
                    specials[content] = id
                }
            }
        }
        self.specialTokens = specials
        self.padTokenId = specials["<|endoftext|>"] ?? vocabDict["<|endoftext|>"] ?? 151643

        // Byte-level mapping.
        let (enc, dec) = BPETokenizer.bytesToUnicode()
        self.byteEncoder = enc
        self.byteDecoder = dec

        // GPT-4 regex pattern (same as tiktoken/cl100k_base).
        let pattern = #"(?i:'s|'t|'re|'ve|'m|'ll|'d)|[^\r\n\p{L}\p{N}]?\p{L}+|\p{N}| ?[^\s\p{L}\p{N}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+"#
        let regex: NSRegularExpression
        do {
            regex = try NSRegularExpression(pattern: pattern)
        } catch {
            fatalError("Invalid BPE regex pattern: \(error)")
        }
        self.patRegex = regex
    }

    // MARK: - GPT-2 bytes_to_unicode

    private static func bytesToUnicode() -> ([UInt8: Character], [Character: UInt8]) {
        // Visible ASCII printable chars + Latin-1 supplement that map to themselves.
        let directRanges: [Range<Int>] = [
            33..<127, 161..<173, 174..<256
        ]
        var bs: Set<UInt8> = []
        for range in directRanges {
            for value in range { bs.insert(UInt8(value)) }
        }

        var encoder: [UInt8: Character] = [:]
        var decoder: [Character: UInt8] = [:]
        var otherByte: UInt16 = 0

        for byte in 0..<256 {
            let value = UInt8(byte)
            if bs.contains(value) {
                let char = Character(UnicodeScalar(byte)!)  // byte is Int here
                encoder[value] = char
                decoder[char] = value
            } else {
                let char = Character(UnicodeScalar(256 + Int(otherByte))!)
                encoder[value] = char
                decoder[char] = value
                otherByte += 1
            }
        }

        return (encoder, decoder)
    }

    // MARK: - BPE algorithm

    /// Get all adjacent string pairs in a list.
    private static func getPairs(_ word: [String]) -> Set<[String]> {
        var pairs = Set<[String]>()
        for index in 0..<word.count - 1 {
            pairs.insert([word[index], word[index + 1]])
        }
        return pairs
    }

    /// Apply BPE merges to a byte-level encoded word.
    private mutating func bpe(token: String) -> [Int] {
        if let cached = cache[token] { return cached }

        var word = token.map { String($0) }  // [Character] → [String]
        if word.count <= 1 {
            let result = [vocab[token]].compactMap { $0 }
            cache[token] = result
            return result
        }

        while true {
            let pairs = BPETokenizer.getPairs(word)
            // Find the pair with the lowest merge rank.
            var bestPair: [String]? = nil
            var bestRank = Int.max
            for pair in pairs {
                let key = "\(pair[0]) \(pair[1])"
                if let rank = mergeRanks[key], rank < bestRank {
                    bestRank = rank
                    bestPair = pair
                }
            }
            guard let pair = bestPair else { break }

            // Merge all occurrences of the pair into a single string token.
            var newWord: [String] = []
            var index = 0
            while index < word.count {
                if index < word.count - 1 && word[index] == pair[0] && word[index + 1] == pair[1] {
                    // Merge: concatenate the two strings into one.
                    newWord.append(pair[0] + pair[1])
                    index += 2
                } else {
                    newWord.append(word[index])
                    index += 1
                }
            }
            word = newWord
            if word.count == 1 { break }
        }

        // Look up each merged token in vocab.
        let result = word.compactMap { vocab[$0] }
        cache[token] = result
        return result
    }

    // MARK: - Encoding

    /// Encode text into token IDs (no special token handling).
    private mutating func encodeOrdinary(_ text: String) -> [Int] {
        // NFC normalization.
        let normalized = text.precomposedStringWithCanonicalMapping

        // GPT-4 regex split into pre-tokens.
        let range = NSRange(normalized.startIndex..., in: normalized)
        var preTokens: [String] = []
        patRegex.enumerateMatches(in: normalized, options: [], range: range) { match, _, _ in
            guard let match = match,
                  let range = Range(match.range, in: normalized) else { return }
            preTokens.append(String(normalized[range]))
        }

        // Byte-level encode + BPE each pre-token.
        var allIds: [Int] = []
        for preToken in preTokens {
            // Convert pre-token to UTF-8 bytes, then to byte-level unicode chars.
            let utf8 = Array(preToken.utf8)
            let encoded = String(utf8.compactMap { byteEncoder[$0] })
            let ids = bpe(token: encoded)
            allIds.append(contentsOf: ids)
        }
        return allIds
    }

    /// Encode text, splitting on special tokens first.
    public mutating func encode(_ text: String, allowedSpecial: Set<String>? = nil) -> [Int] {
        let specials = allowedSpecial ?? Set(specialTokens.keys)
        if specials.isEmpty {
            return encodeOrdinary(text)
        }

        // Build regex to split on special tokens.
        let escaped = specials.map { NSRegularExpression.escapedPattern(for: $0) }
            .joined(separator: "|")
        guard let splitRegex = try? NSRegularExpression(pattern: escaped) else {
            return encodeOrdinary(text)
        }

        var ids: [Int] = []
        let range = NSRange(text.startIndex..., in: text)
        var lastEnd = text.startIndex

        splitRegex.enumerateMatches(in: text, options: [], range: range) { match, _, _ in
            guard let match = match,
                  let matchRange = Range(match.range, in: text) else { return }

            // Encode text before the special token.
            if lastEnd < matchRange.lowerBound {
                ids.append(contentsOf: encodeOrdinary(String(text[lastEnd..<matchRange.lowerBound])))
            }

            // Add the special token ID directly.
            let specialStr = String(text[matchRange])
            if let specialId = specialTokens[specialStr] {
                ids.append(specialId)
            }

            lastEnd = matchRange.upperBound
        }

        // Encode remaining text after last special token.
        if lastEnd < text.endIndex {
            ids.append(contentsOf: encodeOrdinary(String(text[lastEnd..<text.endIndex])))
        }

        return ids
    }

    // MARK: - Chat template (simplified Qwen3)

    /// Wrap a prompt in the Qwen3 chat template (user message + assistant prefix).
    public func applyChatTemplate(prompt: String) -> String {
        "<|im_start|>user\n\(prompt)<|im_end|>\n<|im_start|>assistant\n"
    }

    /// Full pipeline: prompt → chat template → tokenize → pad/truncate to maxLen.
    public mutating func encodePrompt(_ prompt: String, maxLength: Int = 512) -> [Int] {
        let formatted = applyChatTemplate(prompt: prompt)
        var ids = encode(formatted, allowedSpecial: Set(specialTokens.keys))

        // Truncate to maxLength.
        if ids.count > maxLength {
            ids = Array(ids.prefix(maxLength))
        }

        // Pad to maxLength with pad_token_id.
        while ids.count < maxLength {
            ids.append(padTokenId)
        }

        return ids
    }
}
