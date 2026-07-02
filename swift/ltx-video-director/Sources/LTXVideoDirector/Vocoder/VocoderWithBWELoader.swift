//
//  VocoderWithBWELoader.swift
//  LTXVideoDirector
//
//  Production loader for VocoderWithBWE against the real checkpoint at
//  mlx-models/audio/ltx-2.3-audio/vocoder.safetensors. Promotes the
//  weight-wiring logic already verified in
//  VocoderWithBWERealCheckpointTests.swift out of test code so the CLI
//  can use it directly.
//

import Foundation
import MLX

public enum VocoderWithBWELoader {
    public enum LoadError: Error, CustomStringConvertible {
        case missingCheckpoint(URL)
        case missingKey(String)

        public var description: String {
            switch self {
            case .missingCheckpoint(let url): return "vocoder checkpoint not found at \(url.path)"
            case .missingKey(let key): return "vocoder checkpoint missing expected key: \(key)"
            }
        }
    }

    private static func makeAMPBlock1(_ weights: [String: MLXArray], prefix: String, kernelSize: Int, dilations: [Int]) throws -> AMPBlock1 {
        func need(_ key: String) throws -> MLXArray {
            guard let v = weights[key] else { throw LoadError.missingKey(key) }
            return v
        }
        func makeActivation1d(_ p: String) throws -> Activation1d {
            Activation1d(
                act: SnakeBeta(alpha: try need("\(p).act.alpha"), beta: try need("\(p).act.beta")),
                upsample: UpSample1d(filter: try need("\(p).upsample.filter")),
                downsample: DownSample1d(lowpass: LowPassKernel(filter: try need("\(p).downsample.lowpass.filter"))))
        }
        let layers = try dilations.enumerated().map { (i, d) -> AMPBlock1Layer in
            let conv1Padding = (kernelSize * d - d) / 2
            let conv2Padding = kernelSize / 2
            return AMPBlock1Layer(
                act1: try makeActivation1d("\(prefix).acts1.\(i)"),
                conv1Weight: try need("\(prefix).convs1.\(i).weight"), conv1Bias: try need("\(prefix).convs1.\(i).bias"),
                conv1Padding: conv1Padding, conv1Dilation: d,
                act2: try makeActivation1d("\(prefix).acts2.\(i)"),
                conv2Weight: try need("\(prefix).convs2.\(i).weight"), conv2Bias: try need("\(prefix).convs2.\(i).bias"),
                conv2Padding: conv2Padding)
        }
        return AMPBlock1(layers: layers)
    }

    private static func makeVocoder(
        _ weights: [String: MLXArray], prefix: String,
        upsampleRates: [Int], upsampleKernelSizes: [Int], applyFinalActivation: Bool
    ) throws -> BigVGANVocoder {
        let resblockKernelSizes = [3, 7, 11]
        let resblockDilations = [1, 3, 5]
        let keyPrefix = prefix.isEmpty ? "" : "\(prefix)."
        func need(_ key: String) throws -> MLXArray {
            guard let v = weights["\(keyPrefix)\(key)"] else { throw LoadError.missingKey("\(keyPrefix)\(key)") }
            return v
        }

        let stages = try (0..<upsampleRates.count).map { i -> BigVGANUpsampleStage in
            let rate = upsampleRates[i]
            let kernel = upsampleKernelSizes[i]
            let padding = (kernel - rate) / 2
            let up = ConvTranspose1d(weight: try need("ups.\(i).weight"), bias: try need("ups.\(i).bias"), stride: rate, padding: padding)
            let resblocks = try resblockKernelSizes.indices.map { j -> AMPBlock1 in
                let idx = i * resblockKernelSizes.count + j
                return try makeAMPBlock1(weights, prefix: "\(keyPrefix)resblocks.\(idx)", kernelSize: resblockKernelSizes[j], dilations: resblockDilations)
            }
            return BigVGANUpsampleStage(up: up, resblocks: resblocks)
        }

        let actPost = Activation1d(
            act: SnakeBeta(alpha: try need("act_post.act.alpha"), beta: try need("act_post.act.beta")),
            upsample: UpSample1d(filter: try need("act_post.upsample.filter")),
            downsample: DownSample1d(lowpass: LowPassKernel(filter: try need("act_post.downsample.lowpass.filter"))))

        return BigVGANVocoder(
            convPreWeight: try need("conv_pre.weight"), convPreBias: try need("conv_pre.bias"),
            stages: stages, actPost: actPost, convPostWeight: try need("conv_post.weight"),
            applyFinalActivation: applyFinalActivation)
    }

    /// Loads the real production VocoderWithBWE (base vocoder + BWE
    /// generator + MelSTFT) from
    /// `mlx-models/audio/ltx-2.3-audio/vocoder.safetensors`. Weights are
    /// upcast to float32, matching the class's documented fp32 requirement
    /// (bf16 accumulation error compounds through 108 sequential convs).
    public static func loadReal(checkpointURL: URL) throws -> VocoderWithBWE {
        guard FileManager.default.fileExists(atPath: checkpointURL.path) else {
            throw LoadError.missingCheckpoint(checkpointURL)
        }
        let raw = try MLX.loadArrays(url: checkpointURL)
        var weights: [String: MLXArray] = [:]
        let prefix = "vocoder."
        for (key, value) in raw {
            guard key.hasPrefix(prefix) else { continue }
            weights[String(key.dropFirst(prefix.count))] = value.asType(.float32)
        }

        let baseVocoder = try makeVocoder(
            weights, prefix: "", upsampleRates: [5, 2, 2, 2, 2, 2], upsampleKernelSizes: [11, 4, 4, 4, 4, 4],
            applyFinalActivation: true)
        let bweGenerator = try makeVocoder(
            weights, prefix: "bwe_generator", upsampleRates: [6, 5, 2, 2, 2], upsampleKernelSizes: [12, 11, 4, 4, 4],
            applyFinalActivation: false)
        guard let melBasis = weights["mel_stft.mel_basis"], let forwardBasis = weights["mel_stft.stft_fn.forward_basis"] else {
            throw LoadError.missingKey("mel_stft.mel_basis / mel_stft.stft_fn.forward_basis")
        }
        let melSTFT = MelSTFT(melBasis: melBasis, forwardBasis: forwardBasis, nFFT: 512, hopLength: 80)
        let resampler = HannSincResampler(upsampleFactor: 3)

        return VocoderWithBWE(baseVocoder: baseVocoder, resampler: resampler, melSTFT: melSTFT, bweGenerator: bweGenerator)
    }
}
