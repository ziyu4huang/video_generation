import XCTest
import MLX
@testable import LTXVideoDirector

/// Integration smoke test: load the REAL production LTX-2.3
/// VocoderWithBWE checkpoint (mlx-models/audio/ltx-2.3-audio/
/// vocoder.safetensors — both the base "vocoder." prefix AND
/// "vocoder.bwe_generator."/"vocoder.mel_stft." prefixes) and run a real
/// forward pass end-to-end: mel -> 16kHz base vocoder -> 3x Hann-sinc
/// resample -> BWE residual (fed by its own MelSTFT of the resampled
/// signal) -> clamp. No reference output to diff against — proves the
/// native Swift assembly loads real production weights (confirmed:
/// bwe_generator uses upsample_initial_channel=512, rates (6,5,2,2,2),
/// kernel_sizes (12,11,4,4,4), apply_final_activation=FALSE — read
/// directly from VocoderWithBWE.__init__, not assumed) and produces
/// finite, correctly-shaped, [-1,1]-bounded stereo 48kHz waveform.
/// Skips gracefully if the checkpoint isn't present.
final class VocoderWithBWERealCheckpointTests: XCTestCase {
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

    private func makeVocoder(
        _ weights: [String: MLXArray], prefix: String,
        upsampleRates: [Int], upsampleKernelSizes: [Int], applyFinalActivation: Bool
    ) -> BigVGANVocoder {
        let resblockKernelSizes = [3, 7, 11]
        let resblockDilations = [1, 3, 5]
        let keyPrefix = prefix.isEmpty ? "" : "\(prefix)."
        func w(_ k: String) -> MLXArray { weights["\(keyPrefix)\(k)"]! }

        let stages = (0..<upsampleRates.count).map { i -> BigVGANUpsampleStage in
            let rate = upsampleRates[i]
            let kernel = upsampleKernelSizes[i]
            let padding = (kernel - rate) / 2
            let up = ConvTranspose1d(weight: w("ups.\(i).weight"), bias: w("ups.\(i).bias"), stride: rate, padding: padding)
            let resblocks = resblockKernelSizes.indices.map { j -> AMPBlock1 in
                let idx = i * resblockKernelSizes.count + j
                return makeAMPBlock1(weights, prefix: "\(keyPrefix)resblocks.\(idx)", kernelSize: resblockKernelSizes[j], dilations: resblockDilations)
            }
            return BigVGANUpsampleStage(up: up, resblocks: resblocks)
        }

        let actPost = Activation1d(
            act: SnakeBeta(alpha: w("act_post.act.alpha"), beta: w("act_post.act.beta")),
            upsample: UpSample1d(filter: w("act_post.upsample.filter")),
            downsample: DownSample1d(lowpass: LowPassKernel(filter: w("act_post.downsample.lowpass.filter"))))

        return BigVGANVocoder(
            convPreWeight: w("conv_pre.weight"), convPreBias: w("conv_pre.bias"),
            stages: stages, actPost: actPost, convPostWeight: w("conv_post.weight"),
            applyFinalActivation: applyFinalActivation)
    }

    func testRealCheckpointProducesFiniteBoundedWaveform() throws {
        let checkpointURL = RepoPaths.mlxModelsRoot.appendingPathComponent("audio/ltx-2.3-audio/vocoder.safetensors")
        guard FileManager.default.fileExists(atPath: checkpointURL.path) else {
            throw XCTSkip("real checkpoint not found at \(checkpointURL.path) — skipping integration smoke test")
        }

        let raw = try MLX.loadArrays(url: checkpointURL)
        var weights: [String: MLXArray] = [:]
        let prefix = "vocoder."
        for (key, value) in raw {
            guard key.hasPrefix(prefix) else { continue }
            weights[String(key.dropFirst(prefix.count))] = value.asType(.float32)
        }

        let baseVocoder = makeVocoder(
            weights, prefix: "", upsampleRates: [5, 2, 2, 2, 2, 2], upsampleKernelSizes: [11, 4, 4, 4, 4, 4],
            applyFinalActivation: true)
        let bweGenerator = makeVocoder(
            weights, prefix: "bwe_generator", upsampleRates: [6, 5, 2, 2, 2], upsampleKernelSizes: [12, 11, 4, 4, 4],
            applyFinalActivation: false)
        let melSTFT = MelSTFT(
            melBasis: weights["mel_stft.mel_basis"]!, forwardBasis: weights["mel_stft.stft_fn.forward_basis"]!,
            nFFT: 512, hopLength: 80)
        let resampler = HannSincResampler(upsampleFactor: 3)

        let vocoderWithBWE = VocoderWithBWE(baseVocoder: baseVocoder, resampler: resampler, melSTFT: melSTFT, bweGenerator: bweGenerator)

        // Tiny synthetic stereo mel: real channel layout (2, 64), minimal
        // temporal extent large enough to survive the base vocoder's 160x
        // upsample + hop_length=80 padding without degenerate shapes.
        let mel = MLXArray.zeros([1, 2, 8, 64]).asType(.float32)
        let waveform = vocoderWithBWE(mel)
        MLX.eval(waveform)

        XCTAssertEqual(waveform.dim(0), 1)
        XCTAssertEqual(waveform.dim(1), 2, "stereo output channels")
        let flat = waveform.asArray(Float.self)
        XCTAssertTrue(flat.allSatisfy { $0.isFinite }, "real-checkpoint VocoderWithBWE produced NaN/Inf")
        XCTAssertTrue(flat.allSatisfy { abs($0) <= 1.0 + 1e-4 }, "clamped output should be bounded to [-1,1]")
    }
}
