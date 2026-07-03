//
//  Krea2TextEncoder.swift
//  Krea2ImageDirector
//
//  Native Swift port of python/mlx-movie-director/app/krea2_encoder.py.
//  Reuses z-image-director's native Qwen3TextEncoder (4-bit) + BPETokenizer,
//  adding the Krea chat-template wrap + 12-layer hidden-state tap + 34-token
//  strip. Loads the qwen3-4b-instruct weights extracted in Phase 1c.
//

import Foundation
import MLX
import ZImageDirector

public struct Krea2TextEncoder {
    public static let selectLayers = [2, 5, 8, 11, 14, 17, 20, 23, 26, 29, 32, 35]
    public static let prefixIdx = 34
    public static let suffixIdx = 5
    public static let maxLength = 512

    public let encoder: Qwen3TextEncoder
    public let tokenizer: BPETokenizer

    /// Krea's fixed prompt template (encoder.py).
    static let prefix =
        "<|im_start|>system\nDescribe the image by detailing the color, shape, " +
        "size, texture, quantity, text, spatial relationships of the objects and " +
        "background:<|im_end|>\n<|im_start|>user\n"
    static let suffix = "<|im_end|>\n<|im_start|>assistant\n"

    public init(weightsDir: URL, tokenizerDir: URL) throws {
        let teWeights = try TextEncoderWeights.load(dir: weightsDir)
        self.encoder = Qwen3TextEncoder.build(weights: teWeights)
        guard var tok = BPETokenizer(jsonURL: tokenizerDir.appendingPathComponent("tokenizer.json")) else {
            throw NSError(domain: "Krea2TextEncoder", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "failed to load tokenizer.json"])
        }
        self.tokenizer = tok
        _ = tok  // silence mutability warning
    }

    /// Encode prompts -> (hiddens (B, L, 12, 2560), mask (B, L) bool).
    public func encode(_ prompts: [String]) -> (MLXArray, MLXArray) {
        let specialTokens: Set<String> = ["<|im_start|>", "<|im_end|>", "<|endoftext|>"]
        let paddedLen = Krea2TextEncoder.maxLength + Krea2TextEncoder.prefixIdx - Krea2TextEncoder.suffixIdx  // 541
        var batchIds: [[Int]] = []
        var batchMask: [[Bool]] = []
        for prompt in prompts {
            var tok = tokenizer
            let textIds = tok.encode(Krea2TextEncoder.prefix + prompt, allowedSpecial: specialTokens)
            let suffixIds = tok.encode(Krea2TextEncoder.suffix, allowedSpecial: specialTokens)
            // pad textIds to paddedLen
            var padded = Array(textIds.prefix(paddedLen))
            let textMask = Array(repeating: true, count: padded.count) +
                           Array(repeating: false, count: max(0, paddedLen - padded.count))
            while padded.count < paddedLen { padded.append(0) }   // pad token 0
            let ids = padded + suffixIds
            let mask = textMask + Array(repeating: true, count: suffixIds.count)
            batchIds.append(ids)
            batchMask.append(mask)
        }
        let B = batchIds.count, L = batchIds[0].count
        let flatIds = MLXArray(batchIds.flatMap { $0 }).reshaped([B, L])
        let flatMask = MLXArray(batchMask.flatMap { $0.map { $0 ? 1 : 0 } }).reshaped([B, L])

        let hs = encoder.forwardHiddenStates(flatIds)         // 38 entries
        let selected = Krea2TextEncoder.selectLayers.map { hs[$0] }
        var stacked = MLX.stacked(selected, axis: 2)           // (B, L, 12, 2560)
        // strip first 34 prefix tokens
        let hiddens = stacked[0..., Krea2TextEncoder.prefixIdx..., 0..., 0...]
        let mask = flatMask[0..., Krea2TextEncoder.prefixIdx...].asType(.bool)
        _ = stacked
        return (hiddens, mask)
    }
}
