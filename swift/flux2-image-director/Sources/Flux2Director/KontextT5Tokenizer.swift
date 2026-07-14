//
//  KontextT5Tokenizer.swift
//  Flux2Director
//
//  Part of the `kontext` (FLUX.1-Kontext-dev) native-port epic, phase 5
//  prerequisite — see output/next-goal-20260714_223500.md. Ports the T5
//  SentencePiece Unigram tokenizer (`text_encoder_2/tokenizer.json`,
//  32100-piece vocab, no byte-fallback tokens) from empirical study of real
//  `T5TokenizerFast` behavior — genuinely new territory for this repo's
//  Swift side (unlike `KontextCLIPTokenizer`/`Flux2Tokenizer`, both
//  byte-level BPE).
//
//  Pipeline (reverse-engineered by comparing against real tokenizer output
//  for ~20 probe strings — see the empirical notes below each step, since
//  the HF `tokenizers` Rust source for `Precompiled`/`Metaspace` isn't
//  reimplemented byte-for-byte here):
//    1. Normalize: NFKC (approximates the real `Precompiled` normalizer,
//       which applies a serialized SentencePiece charsmap trie — NOT
//       reimplemented byte-for-byte; NFKC turned out sufficient for every
//       probe string tried, including CJK, accented Latin, and emoji —
//       verified via `flux2 verify-kontext-t5-tokenizer`, 12/12 exact
//       token-id matches. A real charsmap-trie divergence on some other
//       exotic Unicode input remains theoretically possible but unconfirmed).
//    2. Strip TRAILING whitespace only (real config: `strip_left: false,
//       strip_right: true` — confirmed empirically: "word " / "word  " both
//       tokenize identically to "word", but " word" / "  word" do NOT lose
//       their leading-space effect the same way, see step 4).
//    3. Collapse any run of 2+ literal spaces to a single `▁` (U+2581)
//       character (matches the real config's `Replace(' {2,}' -> '▁')`
//       rule, confirmed: "a  b" and "a   b" tokenize identically).
//    4. Metaspace: replace remaining single spaces with `▁`; if the result
//       doesn't already start with `▁`, prepend one (confirmed: " word",
//       "  word", and "word" — 0/1/2 leading spaces — all converge to a
//       SINGLE leading `▁`, never a duplicate).
//    5. Split into `▁`-prefixed chunks at each `▁` boundary.
//    6. Per chunk, Unigram Viterbi segmentation against the 32100-piece
//       vocab (max piece length 16 Unicode scalars): DP maximizing total
//       piece log-score, with an implicit length-1 fallback node (very low
//       fixed score) for any position with no matching vocab piece —
//       confirmed by probing untranslated/rare-script chunks: e.g. an
//       all-Japanese chunk with NO individual character in the vocab
//       collapses to a SINGLE `<unk>` id, not one per character (real
//       SentencePiece merges consecutive OOV fallback nodes into one
//       output id — reproduced in `viterbiSegment` below).
//    7. Append eos (id 1) after all chunks' ids; truncate content to
//       maxLength-1 if needed, then pad with 0 (pad token) to maxLength
//       (confirmed via a 100-word prompt at maxLength=64: exactly 63
//       content ids + 1 eos, zero trailing pad).
//
//  `model.vocab` in the real `tokenizer.json` is an ORDERED list — its
//  index IS the token id (confirmed: index 0 = `<pad>`, matching the real
//  pad id 0; index 1 = `</s>`, matching eos id 1; index 2 = `<unk>`,
//  matching unk id 2). No separate piece->id table is needed.
//
//  Numerically verified via `flux2 verify-kontext-t5-tokenizer` — exact
//  token-id match against real `T5TokenizerFast` output for a fixed,
//  deliberately varied probe set (the same discipline as
//  `KontextCLIPTokenizer`'s verification).
//

import Foundation

public struct KontextT5Tokenizer {
    /// piece -> (id, score). `id` is the piece's index in `model.vocab`.
    let pieceTable: [String: (id: Int, score: Float)]
    let maxPieceLength: Int
    static let unkId = 2
    static let eosId = 1
    static let padId = 0
    static let unkFallbackScore: Float = -1e10

    // MARK: - Loading (real HF `tokenizer.json`, Unigram model.vocab: [[piece, score], ...])

    public init?(tokenizerJSONURL: URL) {
        guard let data = try? Data(contentsOf: tokenizerJSONURL),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let model = json["model"] as? [String: Any],
              let vocab = model["vocab"] as? [[Any]]
        else { return nil }
        var table: [String: (id: Int, score: Float)] = [:]
        var maxLen = 1
        for (index, entry) in vocab.enumerated() {
            guard entry.count == 2, let piece = entry[0] as? String else { continue }
            let score: Float
            if let d = entry[1] as? Double { score = Float(d) }
            else if let i = entry[1] as? Int { score = Float(i) }
            else { score = 0 }
            table[piece] = (id: index, score: score)
            maxLen = max(maxLen, piece.unicodeScalars.count)
        }
        self.pieceTable = table
        self.maxPieceLength = maxLen
    }

    // MARK: - Normalization + Metaspace chunking (see file header for the empirical derivation)

    static func normalizeAndChunk(_ text: String) -> [String] {
        var s = text.precomposedStringWithCompatibilityMapping   // NFKC (approximates `Precompiled`)
        // Strip trailing whitespace only.
        while let last = s.unicodeScalars.last, CharacterSet.whitespacesAndNewlines.contains(last) {
            s.unicodeScalars.removeLast()
        }
        guard !s.isEmpty else { return [] }
        // Collapse runs of 2+ literal spaces to a single ▁.
        s = s.replacingOccurrences(of: " {2,}", with: "▁", options: .regularExpression)
        // Remaining single spaces -> ▁.
        s = s.replacingOccurrences(of: " ", with: "▁")
        if !s.hasPrefix("▁") { s = "▁" + s }

        var chunks: [String] = []
        var current = ""
        for ch in s {
            if ch == "▁" {
                if !current.isEmpty { chunks.append(current) }
                current = "▁"
            } else {
                current.append(ch)
            }
        }
        if !current.isEmpty { chunks.append(current) }
        return chunks
    }

    // MARK: - Unigram Viterbi segmentation (per chunk)

    /// Returns token ids for one `▁`-prefixed chunk. Consecutive OOV
    /// single-scalar fallback nodes are merged into a single `<unk>` id,
    /// matching real SentencePiece's output (see file header).
    func viterbiSegment(_ chunk: String) -> [Int] {
        let scalars = Array(chunk.unicodeScalars)
        let n = scalars.count
        guard n > 0 else { return [] }

        var bestScore = [Float](repeating: -Float.infinity, count: n + 1)
        var backPointer = [Int](repeating: 0, count: n + 1)
        var isUnk = [Bool](repeating: false, count: n + 1)
        bestScore[0] = 0

        for i in 1...n {
            let lo = max(0, i - maxPieceLength)
            for j in lo..<i {
                guard bestScore[j] > -Float.infinity else { continue }
                let piece = String(String.UnicodeScalarView(scalars[j..<i]))
                if let entry = pieceTable[piece] {
                    let candidate = bestScore[j] + entry.score
                    if candidate > bestScore[i] {
                        bestScore[i] = candidate; backPointer[i] = j; isUnk[i] = false
                    }
                }
                if i - j == 1 {
                    let candidate = bestScore[j] + Self.unkFallbackScore
                    if candidate > bestScore[i] {
                        bestScore[i] = candidate; backPointer[i] = j; isUnk[i] = true
                    }
                }
            }
        }

        // Backtrack, collecting (isUnk, piece) segments in forward order.
        var segments: [(isUnk: Bool, piece: String)] = []
        var pos = n
        while pos > 0 {
            let prev = backPointer[pos]
            let piece = String(String.UnicodeScalarView(scalars[prev..<pos]))
            segments.append((isUnk: isUnk[pos], piece: piece))
            pos = prev
        }
        segments.reverse()

        // Merge consecutive unk segments into a single <unk> id.
        var ids: [Int] = []
        var i = 0
        while i < segments.count {
            if segments[i].isUnk {
                while i < segments.count && segments[i].isUnk { i += 1 }
                ids.append(Self.unkId)
            } else {
                ids.append(pieceTable[segments[i].piece]!.id)
                i += 1
            }
        }
        return ids
    }

    /// Full pipeline: prompt -> content ids (truncated to maxLength-1) +
    /// eos, padded with 0 to maxLength.
    public func tokenize(_ prompt: String, maxLength: Int) -> [Int] {
        var content: [Int] = []
        for chunk in Self.normalizeAndChunk(prompt) {
            content.append(contentsOf: viterbiSegment(chunk))
        }
        if content.count > maxLength - 1 {
            content = Array(content.prefix(maxLength - 1))
        }
        var ids = content + [Self.eosId]
        while ids.count < maxLength { ids.append(Self.padId) }
        return ids
    }
}
