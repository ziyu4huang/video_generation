//
//  CLIPTokenizer.swift
//  ClipDirector
//
//  OpenAI CLIP SimpleTokenizer (byte-level BPE, `</w>` end-of-word convention)
//  — a direct copy of flux2-image-director's numerically-verified
//  KontextCLIPTokenizer (itself ported from HF's CLIPTokenizer slow path),
//  made self-contained for clip-director. CLIP's vocab/merges are identical
//  across openai CLIP checkpoints, so the bundled vocab.json + merges.txt
//  (from openai/clip-vit-base-patch32) work for every CLIP variant.
//
//  Verified path: lowercase + NFC + CJK-space-wrap + collapse-whitespace,
//  OpenAI CLIP regex pre-tokenize, GPT-2 byte-encode, BPE-merge with `</w>`
//  suffix on the last byte-unit, wrap as [bos] + content(maxLen-2) + [eos]
//  padded with eos to maxLen (CLIP pad==eos).
//

import Foundation

public struct CLIPTokenizer {
    let vocab: [String: Int]
    let mergeRanks: [String: Int]
    let byteEncoder: [UInt8: Character]
    let bosId: Int
    let eosId: Int
    var cache: [String: [String]] = [:]

    public static let maxLength = 77

    public init?() {
        guard let vocabURL = Bundle.module.url(forResource: "vocab", withExtension: "json"),
              let mergesURL = Bundle.module.url(forResource: "merges", withExtension: "txt")
        else { return nil }
        guard let vocabData = try? Data(contentsOf: vocabURL),
              let vocabDict = try? JSONSerialization.jsonObject(with: vocabData) as? [String: Int]
        else { return nil }
        self.vocab = vocabDict
        guard let mergesText = try? String(contentsOf: mergesURL, encoding: .utf8) else { return nil }
        var ranks: [String: Int] = [:]
        var rank = 0
        for line in mergesText.split(separator: "\n", omittingEmptySubsequences: true) {
            if line.hasPrefix("#version") { continue }
            ranks[String(line)] = rank; rank += 1
        }
        self.mergeRanks = ranks
        self.byteEncoder = ClipTokenizerUtils.bytesToUnicode()
        self.bosId = vocabDict["<|startoftext|>"] ?? 49406
        self.eosId = vocabDict["<|endoftext|>"] ?? 49407
    }

    private static let pattern = try! NSRegularExpression(
        pattern: #"<\|startoftext\|>|<\|endoftext\|>|'s|'t|'re|'ve|'m|'ll|'d|\p{L}+|\p{N}|[^\s\p{L}\p{N}]+"#,
        options: [.caseInsensitive]
    )

    private static func isCJKUnifiedIdeograph(_ scalar: Unicode.Scalar) -> Bool {
        let cp = scalar.value
        return (cp >= 0x4E00 && cp <= 0x9FFF) || (cp >= 0x3400 && cp <= 0x4DBF)
            || (cp >= 0x20000 && cp <= 0x2A6DF) || (cp >= 0x2A700 && cp <= 0x2B73F)
            || (cp >= 0x2B740 && cp <= 0x2B81F) || (cp >= 0x2B820 && cp <= 0x2CEAF)
            || (cp >= 0xF900 && cp <= 0xFAFF) || (cp >= 0x2F800 && cp <= 0x2FA1F)
    }

    private static func basicCleanAndLower(_ text: String) -> String {
        var spaced = ""
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

    private static func getPairs(_ word: [String]) -> Set<[String]> {
        var pairs = Set<[String]>()
        for i in 0..<max(word.count - 1, 0) { pairs.insert([word[i], word[i + 1]]) }
        return pairs
    }

    private mutating func bpe(_ token: String) -> [String] {
        if let cached = cache[token] { return cached }
        var units = token.map { String($0) }
        guard units.count > 1 else {
            let r = [token + "</w>"]; cache[token] = r; return r
        }
        units[units.count - 1] = units[units.count - 1] + "</w>"
        var word = units
        while true {
            let pairs = Self.getPairs(word)
            var bestPair: [String]? = nil
            var bestRank = Int.max
            for pair in pairs {
                if let rank = mergeRanks["\(pair[0]) \(pair[1])"], rank < bestRank { bestRank = rank; bestPair = pair }
            }
            guard let pair = bestPair else { break }
            var nw: [String] = []
            var i = 0
            while i < word.count {
                if i < word.count - 1 && word[i] == pair[0] && word[i + 1] == pair[1] {
                    nw.append(pair[0] + pair[1]); i += 2
                } else { nw.append(word[i]); i += 1 }
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

    public mutating func tokenize(_ prompt: String, maxLength: Int = CLIPTokenizer.maxLength) -> [Int] {
        var content = encode(prompt)
        if content.count > maxLength - 2 { content = Array(content.prefix(maxLength - 2)) }
        var ids = [bosId] + content + [eosId]
        while ids.count < maxLength { ids.append(eosId) }
        return ids
    }
}

enum ClipTokenizerUtils {
    static func bytesToUnicode() -> [UInt8: Character] {
        let directRanges: [Range<Int>] = [33..<127, 161..<173, 174..<256]
        var bs: Set<UInt8> = []
        for range in directRanges { for v in range { bs.insert(UInt8(v)) } }
        var encoder: [UInt8: Character] = [:]
        var other: UInt16 = 0
        for byte in 0..<256 {
            let v = UInt8(byte)
            if bs.contains(v) {
                encoder[v] = Character(UnicodeScalar(byte)!)
            } else {
                encoder[v] = Character(UnicodeScalar(256 + Int(other))!)
                other += 1
            }
        }
        return encoder
    }
}
