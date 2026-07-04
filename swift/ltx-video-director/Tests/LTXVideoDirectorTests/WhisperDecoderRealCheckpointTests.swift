//
//  WhisperDecoderRealCheckpointTests.swift
//  LTXVideoDirectorTests
//
//  Numerical parity against the REAL whisper-large-v3-mlx checkpoint's
//  decoder block-0 (self-attn causal-masked + cross-attn to real encoder
//  output + MLP), on real special-token ids + the real
//  token/positional embeddings. See
//  scripts/dump_whisper_real_decoder_block_reference.py.
//

import Foundation
import MLX
import XCTest
@testable import LTXVideoDirector

final class WhisperDecoderRealCheckpointTests: XCTestCase {
    private var refsDir: URL {
        var dir = URL(fileURLWithPath: #filePath)
        for _ in 0..<6 {
            let candidate = dir.appendingPathComponent("test_refs/whisper_real_decoder_block")
            if FileManager.default.fileExists(atPath: candidate.path) {
                return candidate
            }
            dir = dir.deletingLastPathComponent()
        }
        return URL(fileURLWithPath: "test_refs/whisper_real_decoder_block")
    }

    func testCausalSelfAttnPlusCrossAttnPlusMLPMatchesRealCheckpoint() throws {
        try XCTSkipUnless(
            FileManager.default.fileExists(atPath: refsDir.appendingPathComponent("whisper_real_decoder_block.safetensors").path),
            "whisper_real_decoder_block reference not dumped — run scripts/dump_whisper_real_decoder_block_reference.py (requires the encoder-block fixture + the large-v3-mlx checkpoint)"
        )
        let arrays = try MLX.loadArrays(url: refsDir.appendingPathComponent("whisper_real_decoder_block.safetensors"))
        func w(_ key: String) -> MLXArray { arrays[key]!.asType(.float32) }

        let selfAttn = WhisperAttention(
            numHeads: 20,
            queryWeight: w("blocks.0.attn.query.weight"), queryBias: w("blocks.0.attn.query.bias"),
            keyWeight: w("blocks.0.attn.key.weight"),
            valueWeight: w("blocks.0.attn.value.weight"), valueBias: w("blocks.0.attn.value.bias"),
            outWeight: w("blocks.0.attn.out.weight"), outBias: w("blocks.0.attn.out.bias")
        )
        let crossAttn = WhisperAttention(
            numHeads: 20,
            queryWeight: w("blocks.0.cross_attn.query.weight"), queryBias: w("blocks.0.cross_attn.query.bias"),
            keyWeight: w("blocks.0.cross_attn.key.weight"),
            valueWeight: w("blocks.0.cross_attn.value.weight"), valueBias: w("blocks.0.cross_attn.value.bias"),
            outWeight: w("blocks.0.cross_attn.out.weight"), outBias: w("blocks.0.cross_attn.out.bias")
        )
        let block = WhisperDecoderBlock(
            selfAttn: selfAttn, attnLnWeight: w("blocks.0.attn_ln.weight"), attnLnBias: w("blocks.0.attn_ln.bias"),
            crossAttn: crossAttn, crossAttnLnWeight: w("blocks.0.cross_attn_ln.weight"), crossAttnLnBias: w("blocks.0.cross_attn_ln.bias"),
            mlp1Weight: w("blocks.0.mlp1.weight"), mlp1Bias: w("blocks.0.mlp1.bias"),
            mlp2Weight: w("blocks.0.mlp2.weight"), mlp2Bias: w("blocks.0.mlp2.bias"),
            mlpLnWeight: w("blocks.0.mlp_ln.weight"), mlpLnBias: w("blocks.0.mlp_ln.bias")
        )

        let x = w("token_embedding_slice") + w("positional_embedding_slice")
        let encoderOutput = w("encoder_output")
        let textLen = x.dim(1)
        let causalMask = WhisperDecoder.causalMask(length: textLen)

        let actual = block(x, encoderOutput: encoderOutput, causalMask: causalMask)
        MLX.eval(actual)

        let expected = w("block0_output")
        XCTAssertEqual(actual.shape, expected.shape)
        let diff = MLX.abs(actual - expected).max().item(Float.self)
        XCTAssertLessThan(diff, 5e-2, "real-checkpoint decoder block-0 output max abs diff \(diff)")
    }

    func testCausalMaskShapeAndUpperTriangleIsNegativeInfinity() {
        let mask = WhisperDecoder.causalMask(length: 4)
        MLX.eval(mask)
        XCTAssertEqual(mask.shape, [4, 4])
        let flat = mask.asArray(Float.self)
        // row 0, col 1 (future position) must be -inf; row 1, col 0 (past) must be 0.
        XCTAssertTrue(flat[0 * 4 + 1].isInfinite && flat[0 * 4 + 1] < 0)
        XCTAssertEqual(flat[1 * 4 + 0], 0.0)
        XCTAssertEqual(flat[0 * 4 + 0], 0.0)
    }
}
