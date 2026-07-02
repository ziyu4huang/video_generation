//
//  VocoderWithBWE.swift
//  LTXVideoDirector
//
//  Native assembly of the LTX-2.3 full audio pipeline
//  (ltx_core_mlx.model.audio_vae.bwe.VocoderWithBWE.__call__, ported
//  line-for-line from the real source, not inferred from the docstring):
//
//    input: (B, 2, T, 64) stereo mel
//    1. rearrange stereo channels into mel bins: (B,2,T,64) -> (B,T,128)
//       -> base BigVGANVocoder -> (B, T16k, 2) -> transpose (B,2,T16k)
//       -> pad to a multiple of mel_stft.hop_length
//    2. flatten (B,2,T16k) -> (B*2,T16k) -> MelSTFT -> (B*2,T',64)
//       -> reshape (B,2,T',64) -> same (B,2,T',64)->(B,T',128) rearrange
//       -> BWE BigVGANVocoder -> (B,T_bwe,2) -> transpose (B,2,T_bwe)
//    3. resample EACH of the 2 base-16kHz channels independently via
//       HannSincResampler -> stack -> (B,2,T48k) skip connection
//    4. output = clip(skip[..., :minLen] + residual[..., :minLen], -1, 1),
//       truncated to T16k*3
//
//  This project only has B=1 in practice (single audio stream per
//  generation), so the batch dimension is threaded through but not
//  exercised beyond 1 in the real-checkpoint smoke test.
//

import MLX

public struct VocoderWithBWE {
    public let baseVocoder: BigVGANVocoder
    public let resampler: HannSincResampler
    public let melSTFT: MelSTFT
    public let bweGenerator: BigVGANVocoder

    public init(baseVocoder: BigVGANVocoder, resampler: HannSincResampler, melSTFT: MelSTFT, bweGenerator: BigVGANVocoder) {
        self.baseVocoder = baseVocoder
        self.resampler = resampler
        self.melSTFT = melSTFT
        self.bweGenerator = bweGenerator
    }

    private func rearrangeStereoMelToConcatBins(_ mel: MLXArray) -> MLXArray {
        // (B, C, T, M) -> (B, C, M, T) -> (B, C*M, T) -> (B, T, C*M)
        let b = mel.dim(0), c = mel.dim(1), t = mel.dim(2), m = mel.dim(3)
        var x = mel.transposed(0, 1, 3, 2)
        x = x.reshaped([b, c * m, t])
        return x.transposed(0, 2, 1)
    }

    /// mel: (B, 2, T, 64) stereo mel. Returns 48kHz stereo waveform (B, 2, T48k).
    public func callAsFunction(_ mel: MLXArray) -> MLXArray {
        let melF32 = mel.asType(.float32)
        let b = melF32.dim(0), c = melF32.dim(1)

        let melConcat = rearrangeStereoMelToConcatBins(melF32)  // (B, T, 128)
        var waveform16k = baseVocoder(melConcat)  // (B, T16k, 2)
        waveform16k = waveform16k.transposed(0, 2, 1)  // (B, 2, T16k)

        let length16k = waveform16k.dim(2)
        let outputLength = length16k * 3

        let hop = melSTFT.hopLength
        let remainder = length16k % hop
        if remainder != 0 {
            let padAmount = hop - remainder
            waveform16k = MLX.padded(waveform16k, widths: [IntOrPair([0, 0]), IntOrPair([0, 0]), IntOrPair([0, padAmount])])
        }

        let flatWav = waveform16k.reshaped([b * c, waveform16k.dim(2)])  // (B*2, T)
        let bweMelFlat = melSTFT(flatWav)  // (B*2, T', 64)
        let tFrames = bweMelFlat.dim(1)
        let mDim = bweMelFlat.dim(2)
        let bweMel = bweMelFlat.reshaped([b, c, tFrames, mDim])  // (B, 2, T', 64)

        let bweMelConcat = rearrangeStereoMelToConcatBins(bweMel)  // (B, T', 128)
        var residual = bweGenerator(bweMelConcat)  // (B, T_bwe, 2)
        residual = residual.transposed(0, 2, 1)  // (B, 2, T_bwe)

        var skipChannels: [MLXArray] = []
        for ch in 0..<c {
            skipChannels.append(resampler(waveform16k[0..., ch, 0...]))  // (B, T48k)
        }
        let skip = MLX.stacked(skipChannels, axis: 1)  // (B, 2, T48k)

        let minLen = min(skip.dim(2), residual.dim(2))
        var output = skip[0..., 0..., 0..<minLen] + residual[0..., 0..., 0..<minLen]
        output = MLX.clip(output, min: -1.0, max: 1.0)
        return output[0..., 0..., 0..<outputLength]
    }
}
