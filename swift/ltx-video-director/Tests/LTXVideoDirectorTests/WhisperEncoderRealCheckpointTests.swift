//
//  WhisperEncoderRealCheckpointTests.swift
//  LTXVideoDirectorTests
//
//  Numerical parity against a REAL production checkpoint (whisper-large-v3-
//  mlx, the exact model python/mlx-movie-director's ASR gate transcribes
//  with) — conv stem + positional embedding + ONE real transformer block,
//  on REAL log-mel features extracted from an actual generated clip's
//  speech audio. Mirrors this repo's own "one real block, real checkpoint"
//  precedent (LTXModelRealCheckpointTests.testOneRealBlockProducesFiniteOutput)
//  rather than running the full 32-layer/1280-dim encoder. See
//  scripts/dump_whisper_real_encoder_block_reference.py.
//

import Foundation
import MLX
import MLXNN
import XCTest
@testable import LTXVideoDirector

final class WhisperEncoderRealCheckpointTests: XCTestCase {
    private var refsDir: URL {
        var dir = URL(fileURLWithPath: #filePath)
        for _ in 0..<6 {
            let candidate = dir.appendingPathComponent("test_refs/whisper_real_encoder_block")
            if FileManager.default.fileExists(atPath: candidate.path) {
                return candidate
            }
            dir = dir.deletingLastPathComponent()
        }
        return URL(fileURLWithPath: "test_refs/whisper_real_encoder_block")
    }

    func testConvStemPlusOneRealBlockMatchesRealCheckpoint() throws {
        try XCTSkipUnless(
            FileManager.default.fileExists(atPath: refsDir.appendingPathComponent("whisper_real_encoder_block.safetensors").path),
            "whisper_real_encoder_block reference not dumped — run scripts/dump_whisper_real_encoder_block_reference.py (requires the large-v3-mlx checkpoint + a real speech clip)"
        )
        let arrays = try MLX.loadArrays(url: refsDir.appendingPathComponent("whisper_real_encoder_block.safetensors"))
        func w(_ key: String) -> MLXArray { arrays[key]!.asType(.float32) }

        let attn = WhisperAttention(
            numHeads: 20,
            queryWeight: w("blocks.0.attn.query.weight"), queryBias: w("blocks.0.attn.query.bias"),
            keyWeight: w("blocks.0.attn.key.weight"),
            valueWeight: w("blocks.0.attn.value.weight"), valueBias: w("blocks.0.attn.value.bias"),
            outWeight: w("blocks.0.attn.out.weight"), outBias: w("blocks.0.attn.out.bias")
        )
        let block = WhisperEncoderBlock(
            attn: attn,
            attnLnWeight: w("blocks.0.attn_ln.weight"), attnLnBias: w("blocks.0.attn_ln.bias"),
            mlp1Weight: w("blocks.0.mlp1.weight"), mlp1Bias: w("blocks.0.mlp1.bias"),
            mlp2Weight: w("blocks.0.mlp2.weight"), mlp2Bias: w("blocks.0.mlp2.bias"),
            mlpLnWeight: w("blocks.0.mlp_ln.weight"), mlpLnBias: w("blocks.0.mlp_ln.bias")
        )

        // Real production conv stem, same shapes as WhisperEncoder expects
        // (1280-dim large-v3 conv1/conv2), run standalone (not through the
        // full WhisperEncoder struct, since this fixture only carries
        // block-0 weights, not ln_post/all 32 blocks).
        var x = MLX.conv1d(w("mel_input"), w("conv1.weight"), stride: 1, padding: 1)
        x = x + w("conv1.bias")
        x = MLXNN.gelu(x)
        x = MLX.conv1d(x, w("conv2.weight"), stride: 2, padding: 1)
        x = x + w("conv2.bias")
        x = MLXNN.gelu(x)
        let pos = WhisperEncoder.sinusoids(length: x.dim(1), channels: x.dim(2))
        x = x + pos

        let actual = block(x)
        MLX.eval(actual)

        let expected = w("block0_output")
        XCTAssertEqual(actual.shape, expected.shape)
        let diff = MLX.abs(actual - expected).max().item(Float.self)
        // fp16-checkpoint-derived reference (weights loaded as float16 then
        // upcast) — looser tolerance than the random-fp32-weight test above.
        XCTAssertLessThan(diff, 5e-2, "real-checkpoint block-0 output max abs diff \(diff)")
    }
}
