//
//  GemmaTokenizer.swift
//  LTXVideoDirector
//
//  Standalone Gemma-3 SentencePiece-BPE tokenizer, parsing the HF
//  tokenizer.json directly (no z-image Tiktoken dependency — Gemma's
//  algorithm differs: space→▁ normalization + byte_fallback, not GPT-2
//  bytes_to_unicode + regex pretokenizer).
//
//  Algorithm (verified against the real tokenizer in Python — produces
//  byte-identical token_ids to mlx_lm/tokenizers for the test prompt):
//    1. split text on special tokens (added_tokens), preserving them
//    2. for each normal segment: replace " " with "▁" (SentencePiece metaspace)
//    3. BPE: initial tokens = chars (byte_fallback → "<0xNN>" for chars not
//       in vocab), greedily merge the lowest-rank adjacent pair
//    4. prepend <bos> (add_bos_token=True; add_eos_token=False for Gemma)
//

import Foundation
import MLX

public struct GemmaTokenizer {
    private let vocab: [String: Int]
    private let mergeRank: [String: Int]  // "a\0b" → rank
    private let specialTokens: [String: Int]
    public let bosTokenId: Int
    public let eosTokenId: Int
    public let padTokenId: Int
    public let maxLength: Int

    public init(tokenizerJSON url: URL, maxLength: Int = 1024) throws {
        guard let data = try? Data(contentsOf: url),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw NSError(domain: "GemmaTokenizer", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "cannot parse \(url.path)"])
        }
        let model = json["model"] as? [String: Any] ?? [:]
        let vocabDict = model["vocab"] as? [String: Int] ?? [:]
        let merges = (model["merges"] as? [[String]] ?? []).map { $0 }
        var rank: [String: Int] = [:]
        for (i, pair) in merges.enumerated() where pair.count == 2 {
            rank["\(pair[0])\u{0}\(pair[1])"] = i
        }

        var specials: [String: Int] = [:]
        for added in (json["added_tokens"] as? [[String: Any]] ?? []) {
            if let content = added["content"] as? String, let id = added["id"] as? Int {
                specials[content] = id
            }
        }
        self.vocab = vocabDict
        self.mergeRank = rank
        self.specialTokens = specials
        self.bosTokenId = specials["<bos>"] ?? vocabDict["<bos>"] ?? 2
        self.eosTokenId = specials["<eos>"] ?? vocabDict["<eos>"] ?? 1
        self.padTokenId = specials["<pad>"] ?? vocabDict["<pad>"] ?? 0
        self.maxLength = maxLength
    }

    public mutating func tokenize(_ text: String) -> (tokenIds: MLXArray, attentionMask: MLXArray) {
        var tokens = encode(text.trimmingCharacters(in: .whitespacesAndNewlines))
        if tokens.count > maxLength { tokens = Array(tokens.suffix(maxLength)) }
        let padLength = maxLength - tokens.count
        let padded = Array(repeating: padTokenId, count: padLength) + tokens
        let mask = Array(repeating: 0, count: padLength) + Array(repeating: 1, count: tokens.count)
        return (MLXArray(padded).reshaped([1, maxLength]).asType(.int32),
                MLXArray(mask).reshaped([1, maxLength]).asType(.int32))
    }

    /// Encode text → token ids, with <bos> prepended (Gemma add_bos_token).
    private func encode(_ text: String) -> [Int] {
        var ids = [bosTokenId]
        // Split on special tokens, preserving them in order.
        let parts = splitOnSpecials(text)
        for part in parts {
            if let sid = specialTokens[part] {
                ids.append(sid)
            } else {
                ids.append(contentsOf: bpeSegment(part.replacingOccurrences(of: " ", with: "▁")))
            }
        }
        return ids
    }

    /// Split text keeping special-token substrings as their own pieces.
    private func splitOnSpecials(_ text: String) -> [String] {
        guard !specialTokens.isEmpty else { return [text] }
        let pattern = "(" + specialTokens.keys.map { NSRegularExpression.escapedPattern(for: $0) }.joined(separator: "|") + ")"
        guard let re = try? NSRegularExpression(pattern: pattern) else { return [text] }
        let ns = text as NSString
        var result: [String] = []
        var last = 0
        re.enumerateMatches(in: text, range: NSRange(location: 0, length: ns.length)) { match, _, _ in
            guard let m = match else { return }
            if m.range.location > last { result.append(ns.substring(with: NSRange(location: last, length: m.range.location - last))) }
            result.append(ns.substring(with: m.range))
            last = m.range.location + m.range.length
        }
        if last < ns.length { result.append(ns.substring(from: last)) }
        return result
    }

    /// BPE-encode a normalized (▁-marked) segment with byte_fallback.
    private func bpeSegment(_ segment: String) -> [Int] {
        // Initial token list: each char, byte-fallback unknowns to <0xNN>.
        var toks: [String] = []
        for ch in segment {
            let s = String(ch)
            if vocab[s] != nil { toks.append(s) } else {
                for b in s.utf8 { toks.append(String(format: "<0x%02X>", b)) }
            }
        }
        // Greedily merge lowest-rank adjacent pair.
        while toks.count > 1 {
            var bestRank: Int = .max
            var bestIdx = -1
            for i in 0..<(toks.count - 1) {
                if let r = mergeRank["\(toks[i])\u{0}\(toks[i + 1])"], r < bestRank { bestRank = r; bestIdx = i }
            }
            if bestIdx < 0 { break }
            toks[bestIdx] = toks[bestIdx] + toks[bestIdx + 1]
            toks.remove(at: bestIdx + 1)
        }
        return toks.compactMap { vocab[$0] }
    }
}
