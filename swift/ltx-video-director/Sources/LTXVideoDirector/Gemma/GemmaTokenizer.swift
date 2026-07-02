//
//  GemmaTokenizer.swift
//  LTXVideoDirector
//
//  Gemma-3 BPE tokenizer wrapper: text → left-padded (token_ids, attention_mask),
//  matching base_encoder.tokenize() exactly:
//    tokens = encode(text.strip())
//    if tokens.count > max_length: tokens = tokens.suffix(max_length)
//    left-pad with pad_token_id to max_length
//    attention_mask = 0 for pad + 1 for valid
//
//  Uses ImageGenUtils.BPETokenizer (reads Gemma's HF tokenizer.json). Gemma's
//  pad_token_id is 0.
//

import Foundation
import MLX
import ZImageDirector

public struct GemmaTokenizer {
    public var tokenizer: BPETokenizer
    public let padTokenId: Int
    public let maxLength: Int

    public init(tokenizerURL: URL, maxLength: Int = 1024, padTokenId: Int = 0) throws {
        guard let tok = BPETokenizer(jsonURL: tokenizerURL) else {
            throw NSError(domain: "GemmaTokenizer", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "failed to load \(tokenizerURL.path)"])
        }
        self.tokenizer = tok
        self.maxLength = maxLength
        self.padTokenId = padTokenId
    }

    /// Returns (token_ids, attention_mask), each (1, maxLength) int32.
    public mutating func tokenize(_ text: String) -> (tokenIds: MLXArray, attentionMask: MLXArray) {
        var tokens = tokenizer.encode(text.trimmingCharacters(in: .whitespacesAndNewlines))
        if tokens.count > maxLength {
            tokens = Array(tokens.suffix(maxLength))
        }
        let padLength = maxLength - tokens.count
        let padded = Array(repeating: padTokenId, count: padLength) + tokens
        let mask = Array(repeating: 0, count: padLength) + Array(repeating: 1, count: tokens.count)
        return (MLXArray(padded).reshaped([1, maxLength]).asType(.int32),
                MLXArray(mask).reshaped([1, maxLength]).asType(.int32))
    }
}
