//
//  WAVWriter.swift
//  LTXVideoDirector
//
//  Minimal PCM16 WAV file writer — no external dependencies (AVFoundation
//  is for reading/probing elsewhere in this package; writing a 44-byte
//  canonical WAV header by hand is simpler than routing through
//  AVAssetWriter for raw interleaved samples). Used by the native
//  (run.py-free) audio decode path to persist VocoderWithBWE's waveform
//  output to disk.
//

import Foundation

public enum WAVWriter {
    public enum WriteError: Error, CustomStringConvertible {
        case emptySamples
        public var description: String { "cannot write a WAV file with zero samples" }
    }

    /// `channels`: interleaved sample buffers, one array per channel (e.g.
    /// `[left, right]` for stereo), each in [-1, 1]. All channels must have
    /// equal length.
    public static func write(channels: [[Float]], sampleRate: Int, to url: URL) throws {
        guard let frameCount = channels.first?.count, frameCount > 0 else {
            throw WriteError.emptySamples
        }
        let numChannels = channels.count
        let bitsPerSample = 16
        let bytesPerSample = bitsPerSample / 8
        let blockAlign = numChannels * bytesPerSample
        let byteRate = sampleRate * blockAlign
        let dataSize = frameCount * blockAlign

        var data = Data(capacity: 44 + dataSize)

        func appendString(_ s: String) { data.append(s.data(using: .ascii)!) }
        func appendUInt32(_ v: UInt32) { data.append(contentsOf: withUnsafeBytes(of: v.littleEndian, Array.init)) }
        func appendUInt16(_ v: UInt16) { data.append(contentsOf: withUnsafeBytes(of: v.littleEndian, Array.init)) }

        appendString("RIFF")
        appendUInt32(UInt32(36 + dataSize))
        appendString("WAVE")
        appendString("fmt ")
        appendUInt32(16)
        appendUInt16(1)  // PCM
        appendUInt16(UInt16(numChannels))
        appendUInt32(UInt32(sampleRate))
        appendUInt32(UInt32(byteRate))
        appendUInt16(UInt16(blockAlign))
        appendUInt16(UInt16(bitsPerSample))
        appendString("data")
        appendUInt32(UInt32(dataSize))

        for frame in 0..<frameCount {
            for ch in 0..<numChannels {
                let clamped = max(-1.0, min(1.0, channels[ch][frame]))
                let intSample = Int16((clamped * Float(Int16.max)).rounded())
                appendUInt16(UInt16(bitPattern: intSample))
            }
        }

        try data.write(to: url)
    }
}
