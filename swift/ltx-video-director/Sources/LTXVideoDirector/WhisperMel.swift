//
//  WhisperMel.swift
//  LTXVideoDirector
//
//  First real, parity-verified step of a native Swift/MLX Whisper port —
//  the log-mel-spectrogram feature extraction that feeds Whisper's encoder.
//  ASRGate.swift's transcription still bridges to mlx_whisper (see its
//  header comment + PLAN.md Phase 3); this is the first piece of THAT
//  bridge being replaced, ported line-for-line from mlx_whisper's own
//  audio.py (same mlx-swift MLXFFT.rfft + MLX.asStrided primitives that
//  package uses under mlx.core, just in Swift) and verified against real
//  output — see scripts/dump_whisper_mel_reference.py +
//  Tests/LTXVideoDirectorTests/WhisperMelParityTests.swift.
//
//  What remains to make ASR fully native (tracked in docs/TODO.md): the
//  encoder+decoder transformer stack, the tokenizer, and the decode loop.
//  This module only produces the (n_mels, n_frames) input those would
//  consume — it does not itself transcribe anything yet.
//

import AVFoundation
import Foundation
import MLX
import MLXFFT

public enum WhisperMel {
    public static let sampleRate = 16000
    public static let nFFT = 400
    public static let hopLength = 160

    /// Native (AVFoundation) equivalent of mlx_whisper.audio.load_audio —
    /// decodes a video/audio file's first audio track to mono Float32 PCM
    /// resampled to 16kHz, no ffmpeg subprocess (this package's existing
    /// convention — see MP4Writer.swift's header). Uses
    /// LinearResampler.resample for the rate conversion (documented
    /// aliasing tradeoff there — adequate for speech, not broadcast-grade).
    public static func loadAudio(url: URL) throws -> [Float] {
        let asset = AVURLAsset(url: url)
        guard let track = asset.tracks(withMediaType: .audio).first else {
            return []
        }
        let reader = try AVAssetReader(asset: asset)
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVLinearPCMBitDepthKey: 32,
            AVLinearPCMIsFloatKey: true,
            AVLinearPCMIsNonInterleaved: false,
            AVNumberOfChannelsKey: 1,  // ask AVFoundation to down-mix to mono directly
        ]
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: settings)
        reader.add(output)
        reader.startReading()

        var samples: [Float] = []
        while let buffer = output.copyNextSampleBuffer() {
            guard let blockBuffer = CMSampleBufferGetDataBuffer(buffer) else { continue }
            let length = CMBlockBufferGetDataLength(blockBuffer)
            var data = [UInt8](repeating: 0, count: length)
            CMBlockBufferCopyDataBytes(blockBuffer, atOffset: 0, dataLength: length, destination: &data)
            data.withUnsafeBytes { raw in
                let floats = raw.bindMemory(to: Float32.self)
                samples.append(contentsOf: floats)
            }
        }

        // Synchronous formatDescriptions (deprecated in favor of the async
        // load(.formatDescriptions) API) — matches this package's existing
        // tolerance of that same deprecation elsewhere (VideoProbe.swift),
        // kept for a simple non-async call site here.
        let sourceRate = track.formatDescriptions.first
            .map { $0 as! CMFormatDescription }
            .flatMap { CMAudioFormatDescriptionGetStreamBasicDescription($0)?.pointee.mSampleRate }
            .map { Int($0) } ?? sampleRate
        return LinearResampler.resample(samples, fromRate: sourceRate, toRate: sampleRate)
    }

    /// Precomputed librosa mel filterbank, embedded from mlx_whisper's own
    /// mel_filters.npz (converted to safetensors — see Package.swift's
    /// resource comment). Keyed "mel_80" / "mel_128", shape (n_mels, 201).
    // MLXArray isn't Sendable, but this is computed once from an immutable
    // bundled resource and never mutated afterward — same safe-cache shape
    // as mlx_whisper's own @lru_cache mel_filters().
    nonisolated(unsafe) private static let filterArrays: [String: MLXArray] = {
        guard let url = Bundle.module.url(forResource: "whisper_mel_filters", withExtension: "safetensors") else {
            fatalError("whisper_mel_filters.safetensors missing from bundle resources")
        }
        return (try? MLX.loadArrays(url: url)) ?? [:]
    }()

    public enum MelBins: Int {
        case eighty = 80
        case oneTwentyEight = 128
    }

    private static func melFilters(_ nMels: MelBins) -> MLXArray {
        guard let f = filterArrays["mel_\(nMels.rawValue)"] else {
            fatalError("mel_\(nMels.rawValue) filterbank not found in bundled resource")
        }
        return f
    }

    private static func hanningWindow(_ size: Int) -> MLXArray {
        // np.hanning(size+1)[:-1] — matches mlx_whisper's `hanning()` exactly
        // (periodic Hann window, not the symmetric np.hanning(size) form).
        var values = [Float](repeating: 0, count: size)
        let denom = Double(size)  // np.hanning(N) uses (N-1) internally; N here is size+1, so N-1 == size
        for i in 0..<size {
            values[i] = Float(0.5 - 0.5 * cos(2.0 * Double.pi * Double(i) / denom))
        }
        return MLXArray(values)
    }

    /// Reflect-pad a 1-D array by `padding` samples on both sides (mirrors
    /// mlx_whisper.audio.stft's `_pad(..., pad_mode="reflect")`:
    /// `prefix = x[1:padding+1][::-1]`, `suffix = x[-(padding+1):-1][::-1]`).
    private static func reflectPad(_ x: MLXArray, padding: Int) -> MLXArray {
        let n = x.shape[0]
        let prefix = x[1..<(padding + 1)][stride: -1]
        let suffix = x[(n - padding - 1)..<(n - 1)][stride: -1]
        return concatenated([prefix, x, suffix], axis: 0)
    }

    /// Short-time Fourier transform via overlapping asStrided windows +
    /// rfft, matching mlx_whisper.audio.stft(nperseg=nFFT, noverlap=hopLength)
    /// exactly (same reflect-padding, same frame count formula).
    private static func stft(_ x: MLXArray, window: MLXArray, nperseg: Int, noverlap: Int) -> MLXArray {
        let padding = nperseg / 2
        let padded = reflectPad(x, padding: padding)
        let totalLen = padded.shape[0]
        let numFrames = (totalLen - nperseg + noverlap) / noverlap
        let framed = MLX.asStrided(padded, [numFrames, nperseg], strides: [noverlap, 1])
        return MLXFFT.rfft(framed * window, axis: -1)
    }

    /// Compute the log-mel spectrogram of a 16kHz mono Float32 waveform.
    /// Mirrors mlx_whisper.audio.log_mel_spectrogram exactly (same padding,
    /// window, STFT, filterbank, and dB-floor/normalize steps) — returns
    /// shape (n_frames, n_mels), matching mlx_whisper's own array layout
    /// (that package's `mel_spec = magnitudes @ filters.T` before any
    /// transpose for the encoder, which is the encoder's own concern, not
    /// this feature-extraction step's).
    public static func logMelSpectrogram(audio: MLXArray, nMels: MelBins = .oneTwentyEight) -> MLXArray {
        let window = hanningWindow(nFFT)
        let freqs = stft(audio, window: window, nperseg: nFFT, noverlap: hopLength)
        // freqs[:-1, :] drops the STFT's final (partial) frame, exactly as
        // mlx_whisper.audio.log_mel_spectrogram does before magnitude-squaring.
        let freqsTrimmed = freqs[0..<(freqs.shape[0] - 1)]
        let magnitudes = MLX.square(MLX.abs(freqsTrimmed))
        let filters = melFilters(nMels)
        let melSpec = MLX.matmul(magnitudes, filters.transposed())
        var logSpec = MLX.log10(MLX.maximum(melSpec, MLXArray(Float(1e-10))))
        let logMax = logSpec.max().item(Float.self)
        logSpec = MLX.maximum(logSpec, MLXArray(logMax - 8.0))
        logSpec = (logSpec + 4.0) / 4.0
        return logSpec
    }
}
