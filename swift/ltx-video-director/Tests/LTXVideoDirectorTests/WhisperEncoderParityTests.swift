//
//  WhisperEncoderParityTests.swift
//  LTXVideoDirectorTests
//
//  Numerical parity against the REAL mlx_whisper.whisper.AudioEncoder (small
//  config, random weights — see scripts/dump_whisper_encoder_reference.py's
//  header for why real large-v3 weights aren't committed here).
//

import Foundation
import MLX
import XCTest
@testable import LTXVideoDirector

final class WhisperEncoderParityTests: XCTestCase {
    private var refsDir: URL {
        var dir = URL(fileURLWithPath: #filePath)
        for _ in 0..<6 {
            let candidate = dir.appendingPathComponent("test_refs/whisper_encoder")
            if FileManager.default.fileExists(atPath: candidate.path) {
                return candidate
            }
            dir = dir.deletingLastPathComponent()
        }
        return URL(fileURLWithPath: "test_refs/whisper_encoder")
    }

    func testEncoderMatchesRealMlxWhisper() throws {
        try XCTSkipUnless(
            FileManager.default.fileExists(atPath: refsDir.appendingPathComponent("whisper_encoder.safetensors").path),
            "whisper_encoder reference not dumped — run scripts/dump_whisper_encoder_reference.py"
        )
        let arrays = try MLX.loadArrays(url: refsDir.appendingPathComponent("whisper_encoder.safetensors"))
        func w(_ key: String) -> MLXArray { arrays[key]!.asType(.float32) }

        let numLayers = 2
        var blocks: [WhisperEncoderBlock] = []
        for i in 0..<numLayers {
            let p = "blocks.\(i)."
            let attn = WhisperAttention(
                numHeads: 4,
                queryWeight: w(p + "attn.query.weight"), queryBias: w(p + "attn.query.bias"),
                keyWeight: w(p + "attn.key.weight"),
                valueWeight: w(p + "attn.value.weight"), valueBias: w(p + "attn.value.bias"),
                outWeight: w(p + "attn.out.weight"), outBias: w(p + "attn.out.bias")
            )
            blocks.append(WhisperEncoderBlock(
                attn: attn,
                attnLnWeight: w(p + "attn_ln.weight"), attnLnBias: w(p + "attn_ln.bias"),
                mlp1Weight: w(p + "mlp1.weight"), mlp1Bias: w(p + "mlp1.bias"),
                mlp2Weight: w(p + "mlp2.weight"), mlp2Bias: w(p + "mlp2.bias"),
                mlpLnWeight: w(p + "mlp_ln.weight"), mlpLnBias: w(p + "mlp_ln.bias")
            ))
        }

        let encoder = WhisperEncoder(
            conv1Weight: w("conv1.weight"), conv1Bias: w("conv1.bias"),
            conv2Weight: w("conv2.weight"), conv2Bias: w("conv2.bias"),
            blocks: blocks,
            lnPostWeight: w("ln_post.weight"), lnPostBias: w("ln_post.bias")
        )

        let melInput = w("mel_input")
        let expected = w("encoder_output")

        let actual = encoder(melInput)
        MLX.eval(actual)

        XCTAssertEqual(actual.shape, expected.shape)
        let diff = MLX.abs(actual - expected).max().item(Float.self)
        XCTAssertLessThan(diff, 1e-3, "encoder output max abs diff \(diff)")
    }

    func testSinusoidsMatchesRealMlxWhisperFormula() throws {
        // Independent check of the positional-embedding math alone (no
        // weights involved), against mlx_whisper.whisper.sinusoids' known
        // closed form for a config small enough to hand-verify boundary
        // values: sinusoids(length:4, channels:4) row 0 must be
        // [sin(0), sin(0), cos(0), cos(0)] = [0, 0, 1, 1].
        let pe = WhisperEncoder.sinusoids(length: 4, channels: 4)
        MLX.eval(pe)
        XCTAssertEqual(pe.shape, [4, 4])
        let row0 = pe[0].asArray(Float.self)
        XCTAssertEqual(row0[0], 0.0, accuracy: 1e-6)
        XCTAssertEqual(row0[1], 0.0, accuracy: 1e-6)
        XCTAssertEqual(row0[2], 1.0, accuracy: 1e-6)
        XCTAssertEqual(row0[3], 1.0, accuracy: 1e-6)
    }
}
