//
//  AudioProcessor.swift
//  LTXVideoDirector
//
//  Native port of ltx_core_mlx.model.audio_vae.processor.AudioProcessor —
//  STFT + Slaney mel filterbank, matching torchaudio.transforms.MelSpectrogram
//  (mel_scale="slaney", norm="slaney", center=True, pad_mode="reflect",
//  power=1.0). No learned weights — the mel filterbank and Hann window are
//  computed deterministically at init, same as the vendor. Verified against
//  scripts/dump_audio_processor_reference.py in AudioProcessorParityTests.
//
//  Used by the reverse (encode) direction of the audio path: a user-supplied
//  WAV -> mel -> AudioVAEEncoder latent, so it can be pinned as a preserved
//  audio conditioning track (mirrors VideoConditionByLatentIndex's video-side
//  I2V/FFLF conditioning, applied here to the audio modality — see
//  docs/reference/comfyui_workflows/README.md, finding 5, "Custom Audio").
//

import Foundation
import MLX

public struct AudioProcessor {
    public let sampleRate: Int
    public let nFFT: Int
    public let hopLength: Int
    public let nMels: Int
    public let melBasis: MLXArray  // (nMels, nFFT/2 + 1)
    public let window: MLXArray    // (nFFT,)

    public init(sampleRate: Int = 16000, nFFT: Int = 1024, hopLength: Int = 160, nMels: Int = 64, fMin: Double = 0.0, fMax: Double? = nil) {
        self.sampleRate = sampleRate
        self.nFFT = nFFT
        self.hopLength = hopLength
        self.nMels = nMels
        let resolvedFMax = fMax ?? Double(sampleRate) / 2.0

        self.melBasis = MLXArray(
            AudioProcessor.buildMelFilterbankSlaney(sr: sampleRate, nFFT: nFFT, nMels: nMels, fMin: fMin, fMax: resolvedFMax).flatMap { $0 },
            [nMels, nFFT / 2 + 1]
        )

        // numpy.hanning(n_fft + 1)[:-1] — periodic Hann window.
        var w = [Float](repeating: 0, count: nFFT)
        for n in 0..<nFFT {
            w[n] = Float(0.5 - 0.5 * cos(2.0 * Double.pi * Double(n) / Double(nFFT)))
        }
        self.window = MLXArray(w)
    }

    private static func hzToMelSlaney(_ f: Double) -> Double {
        let fSafe = max(f, 1e-10)
        return f < 1000.0 ? 3.0 * f / 200.0 : 15.0 + 27.0 * log(fSafe / 1000.0) / log(6.4)
    }

    private static func melToHzSlaney(_ m: Double) -> Double {
        m < 15.0 ? 200.0 * m / 3.0 : 1000.0 * exp((m - 15.0) * log(6.4) / 27.0)
    }

    private static func buildMelFilterbankSlaney(sr: Int, nFFT: Int, nMels: Int, fMin: Double, fMax: Double) -> [[Float]] {
        let nFreqs = nFFT / 2 + 1
        let melMin = hzToMelSlaney(fMin)
        let melMax = hzToMelSlaney(fMax)
        let melPoints = (0..<(nMels + 2)).map { melMin + (melMax - melMin) * Double($0) / Double(nMels + 1) }
        let hzPoints = melPoints.map { melToHzSlaney($0) }
        let fftFreqs = (0..<nFreqs).map { Double($0) * (Double(sr) / 2.0) / Double(nFreqs - 1) }

        var filterbank = [[Double]](repeating: [Double](repeating: 0, count: nFreqs), count: nMels)
        for i in 0..<nMels {
            let lower = hzPoints[i], center = hzPoints[i + 1], upper = hzPoints[i + 2]
            for (k, f) in fftFreqs.enumerated() {
                var value = 0.0
                if center > lower, f <= center {
                    value += max(0, (f - lower) / (center - lower))
                }
                if upper > center, f > center {
                    value += max(0, (upper - f) / (upper - center))
                }
                filterbank[i][k] = value
            }
            let enorm = 2.0 / (hzPoints[i + 2] - hzPoints[i])
            for k in 0..<nFreqs { filterbank[i][k] *= enorm }
        }
        return filterbank.map { row in row.map { Float($0) } }
    }

    /// waveform: (C, T) single-batch multi-channel signal, already at
    /// `sampleRate`. Returns mel of shape (C, T', nMels).
    public func waveformToMel(_ waveform: MLXArray) -> MLXArray {
        let numChannels = waveform.dim(0)
        let padAmount = nFFT / 2
        var channelMels: [MLXArray] = []

        for c in 0..<numChannels {
            let signal = waveform[c]
            let t = signal.dim(0)

            // Reflect padding for center=True (torchaudio pad_mode="reflect").
            // signal[1:pad+1][::-1] / signal[-(pad+1):-1][::-1] via explicit
            // reversed gather (no negative-stride slicing in MLX Swift).
            let leftReverseIdx = MLXArray(Array((1...padAmount).reversed()))
            let leftPad = signal.take(leftReverseIdx, axis: 0)
            let rightStart = t - padAmount - 1
            let rightReverseIdx = MLXArray(Array((rightStart..<(t - 1)).reversed()))
            let rightPad = signal.take(rightReverseIdx, axis: 0)
            let padded = MLX.concatenated([leftPad, signal, rightPad], axis: 0)
            let tPadded = padded.dim(0)

            let numFrames = (tPadded - nFFT) / hopLength + 1
            var frames: [MLXArray] = []
            frames.reserveCapacity(numFrames)
            for i in 0..<numFrames {
                let start = i * hopLength
                frames.append(padded[start..<(start + nFFT)])
            }
            let framed = MLX.stacked(frames, axis: 0) * window  // (numFrames, nFFT)

            let spec = MLX.rfft(framed, axis: -1)  // (numFrames, nFFT/2+1) complex
            let mag = MLX.abs(spec)

            var mel = MLX.matmul(mag, melBasis.transposed())  // (numFrames, nMels)
            mel = MLX.log(MLX.maximum(mel, MLXArray(Float(1e-5))))
            channelMels.append(mel)
        }

        return MLX.stacked(channelMels, axis: 0)  // (C, T', nMels)
    }
}
