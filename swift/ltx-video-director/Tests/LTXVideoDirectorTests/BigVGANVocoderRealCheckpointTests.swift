import XCTest
import MLX
@testable import LTXVideoDirector

/// Integration smoke test: load the REAL production LTX-2.3 BigVGAN v2
/// vocoder checkpoint (mlx-models/audio/ltx-2.3-audio/vocoder.safetensors,
/// "vocoder." prefix — the base vocoder path only, NOT
/// "vocoder.bwe_generator.*") and run a real forward pass on a tiny mel
/// spectrogram. No reference output to diff against — proves the native
/// Swift assembly loads real production weights (1227 tensors; confirmed
/// via direct inspection: `ups.N.weight` shape (C_out, K, C_in), matching
/// MLX.convTransposed1d's weight layout with no transpose needed) and
/// produces finite, correctly-shaped waveform output. Skips gracefully if
/// the checkpoint isn't present.
final class BigVGANVocoderRealCheckpointTests: XCTestCase {
    private func makeAMPBlock1(_ arrays: [String: MLXArray], prefix: String, kernelSize: Int, dilations: [Int]) -> AMPBlock1 {
        func makeActivation1d(_ p: String) -> Activation1d {
            Activation1d(
                act: SnakeBeta(alpha: arrays["\(p).act.alpha"]!, beta: arrays["\(p).act.beta"]!),
                upsample: UpSample1d(filter: arrays["\(p).upsample.filter"]!),
                downsample: DownSample1d(lowpass: LowPassKernel(filter: arrays["\(p).downsample.lowpass.filter"]!)))
        }
        let layers = dilations.enumerated().map { (i, d) -> AMPBlock1Layer in
            let conv1Padding = (kernelSize * d - d) / 2
            let conv2Padding = kernelSize / 2
            return AMPBlock1Layer(
                act1: makeActivation1d("\(prefix).acts1.\(i)"),
                conv1Weight: arrays["\(prefix).convs1.\(i).weight"]!, conv1Bias: arrays["\(prefix).convs1.\(i).bias"]!,
                conv1Padding: conv1Padding, conv1Dilation: d,
                act2: makeActivation1d("\(prefix).acts2.\(i)"),
                conv2Weight: arrays["\(prefix).convs2.\(i).weight"]!, conv2Bias: arrays["\(prefix).convs2.\(i).bias"]!,
                conv2Padding: conv2Padding)
        }
        return AMPBlock1(layers: layers)
    }

    func testRealCheckpointProducesFiniteWaveform() throws {
        let checkpointURL = RepoPaths.mlxModelsRoot.appendingPathComponent("audio/ltx-2.3-audio/vocoder.safetensors")
        guard FileManager.default.fileExists(atPath: checkpointURL.path) else {
            throw XCTSkip("real checkpoint not found at \(checkpointURL.path) — skipping integration smoke test")
        }

        let raw = try MLX.loadArrays(url: checkpointURL)
        var weights: [String: MLXArray] = [:]
        let prefix = "vocoder."
        for (key, value) in raw {
            guard key.hasPrefix(prefix), !key.hasPrefix("vocoder.bwe_generator.") else { continue }
            weights[String(key.dropFirst(prefix.count))] = value.asType(.float32)
        }

        let upsampleRates = [5, 2, 2, 2, 2, 2]
        let upsampleKernelSizes = [11, 4, 4, 4, 4, 4]
        let resblockKernelSizes = [3, 7, 11]
        let resblockDilations = [1, 3, 5]

        let stages = (0..<upsampleRates.count).map { i -> BigVGANUpsampleStage in
            let rate = upsampleRates[i]
            let kernel = upsampleKernelSizes[i]
            let padding = (kernel - rate) / 2
            let up = ConvTranspose1d(
                weight: weights["ups.\(i).weight"]!, bias: weights["ups.\(i).bias"],
                stride: rate, padding: padding)
            let resblocks = resblockKernelSizes.indices.map { j -> AMPBlock1 in
                let idx = i * resblockKernelSizes.count + j
                return makeAMPBlock1(weights, prefix: "resblocks.\(idx)", kernelSize: resblockKernelSizes[j], dilations: resblockDilations)
            }
            return BigVGANUpsampleStage(up: up, resblocks: resblocks)
        }

        let actPost = Activation1d(
            act: SnakeBeta(alpha: weights["act_post.act.alpha"]!, beta: weights["act_post.act.beta"]!),
            upsample: UpSample1d(filter: weights["act_post.upsample.filter"]!),
            downsample: DownSample1d(lowpass: LowPassKernel(filter: weights["act_post.downsample.lowpass.filter"]!)))

        let vocoder = BigVGANVocoder(
            convPreWeight: weights["conv_pre.weight"]!, convPreBias: weights["conv_pre.bias"]!,
            stages: stages, actPost: actPost, convPostWeight: weights["conv_post.weight"]!)

        // Tiny synthetic mel: real channel count (128), minimal temporal extent.
        let mel = MLXArray.zeros([1, 4, 128]).asType(.float32)
        let waveform = vocoder(mel)
        MLX.eval(waveform)

        XCTAssertEqual(waveform.dim(0), 1)
        XCTAssertEqual(waveform.dim(2), 2, "stereo output channels")
        let flat = waveform.asArray(Float.self)
        XCTAssertTrue(flat.allSatisfy { $0.isFinite }, "real-checkpoint vocoder produced NaN/Inf")
        XCTAssertTrue(flat.allSatisfy { abs($0) <= 1.0 + 1e-4 }, "tanh output should be bounded to [-1,1]")
    }
}
