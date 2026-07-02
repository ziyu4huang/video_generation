//
//  MelSTFT.swift
//  LTXVideoDirector
//
//  Native port of ltx_core_mlx.model.audio_vae.bwe.MelSTFT — computes a
//  log-mel spectrogram of the 3x-resampled 48kHz signal, which becomes
//  the BWE generator's own mel input (hop_length=80, NOT the audio VAE's
//  160, so the BWE generator's output length lines up with the resampled
//  skip connection: mel_frames * 240 == vocoder_output * 3 — confirmed by
//  reading the reference docstring directly).
//

import MLX

public struct MelSTFT {
    public let melBasis: MLXArray       // (n_mels, n_fft/2+1)
    public let forwardBasis: MLXArray   // (n_fft+2, n_fft, 1) MLX Conv1d format
    public let nFFT: Int
    public let hopLength: Int

    public init(melBasis: MLXArray, forwardBasis: MLXArray, nFFT: Int = 512, hopLength: Int = 80) {
        self.melBasis = melBasis
        self.forwardBasis = forwardBasis
        self.nFFT = nFFT
        self.hopLength = hopLength
    }

    /// waveform: (B, T) -> (B, T', n_mels) log-mel spectrogram.
    public func callAsFunction(_ waveform: MLXArray) -> MLXArray {
        var x = waveform.expandedDimensions(axis: 2)  // (B, T, 1)

        let leftPad = max(0, nFFT - hopLength)
        x = MLX.padded(x, widths: [IntOrPair([0, 0]), IntOrPair([leftPad, 0]), IntOrPair([0, 0])])

        let stftOut = MLX.conv1d(x, forwardBasis, stride: hopLength)  // (B, T', n_fft+2)

        let nFFTBins = nFFT / 2 + 1
        let real = stftOut[0..., 0..., 0..<nFFTBins]
        let imag = stftOut[0..., 0..., nFFTBins...]

        let mag = MLX.sqrt(real * real + imag * imag + 1e-9)

        let mel = MLX.matmul(mag, melBasis.transposed(1, 0))

        return MLX.log(MLX.maximum(mel, MLXArray(Float(1e-5))))
    }
}
