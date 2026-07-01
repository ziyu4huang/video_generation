//
//  AudioProbe.swift
//  LTXVideoDirector
//
//  Native (AVFoundation) loudness/silence probing for the "voice correct?"
//  half of the quality gateway. This is a basic energy-based gate (mean/peak
//  dBFS, silence ratio) — a real speech-presence check would need VAD/ASR,
//  which is out of scope for the basic gateway; see PLAN.md Phase 3.
//

import AVFoundation
import Accelerate
import Foundation

public struct AudioInfo {
    public let hasTrack: Bool
    public let meanDBFS: Double
    public let peakDBFS: Double
    /// Fraction of analysis windows below -50 dBFS (near-silent).
    public let silenceRatio: Double
}

public enum AudioProbe {
    private static let silenceThresholdDBFS: Double = -50.0
    private static let windowSize = 2048

    /// Decode the first audio track to mono Float32 PCM and compute basic
    /// loudness stats. Returns `hasTrack: false` with zeroed stats if the
    /// video has no audio.
    public static func analyze(url: URL) -> AudioInfo {
        let asset = AVURLAsset(url: url)
        guard let track = asset.tracks(withMediaType: .audio).first else {
            return AudioInfo(hasTrack: false, meanDBFS: -.infinity, peakDBFS: -.infinity, silenceRatio: 1.0)
        }
        guard let reader = try? AVAssetReader(asset: asset) else {
            return AudioInfo(hasTrack: true, meanDBFS: -.infinity, peakDBFS: -.infinity, silenceRatio: 1.0)
        }
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVLinearPCMBitDepthKey: 32,
            AVLinearPCMIsFloatKey: true,
            AVLinearPCMIsNonInterleaved: false,
            AVNumberOfChannelsKey: 1,
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
        guard !samples.isEmpty else {
            return AudioInfo(hasTrack: true, meanDBFS: -.infinity, peakDBFS: -.infinity, silenceRatio: 1.0)
        }

        var rms: Float = 0
        vDSP_rmsqv(samples, 1, &rms, vDSP_Length(samples.count))
        let meanDBFS = 20.0 * log10(Double(max(rms, 1e-9)))

        var peak: Float = 0
        vDSP_maxmgv(samples, 1, &peak, vDSP_Length(samples.count))
        let peakDBFS = 20.0 * log10(Double(max(peak, 1e-9)))

        var silentWindows = 0
        var totalWindows = 0
        var i = 0
        while i < samples.count {
            let end = min(i + windowSize, samples.count)
            let chunk = Array(samples[i..<end])
            var windowRMS: Float = 0
            vDSP_rmsqv(chunk, 1, &windowRMS, vDSP_Length(chunk.count))
            let dbfs = 20.0 * log10(Double(max(windowRMS, 1e-9)))
            if dbfs < silenceThresholdDBFS { silentWindows += 1 }
            totalWindows += 1
            i = end
        }
        let silenceRatio = totalWindows > 0 ? Double(silentWindows) / Double(totalWindows) : 1.0

        return AudioInfo(hasTrack: true, meanDBFS: meanDBFS, peakDBFS: peakDBFS, silenceRatio: silenceRatio)
    }
}
