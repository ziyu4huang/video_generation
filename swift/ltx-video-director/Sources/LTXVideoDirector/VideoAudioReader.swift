//
//  VideoAudioReader.swift
//  LTXVideoDirector
//
//  Extracts a video file's own audio track to raw Float32 PCM per channel —
//  the same shape WAVReader.Result produces for standalone .wav files — so
//  NativeUpscaleStage.generateLipdub can feed a reference VIDEO's audio
//  straight into the same resample-then-AudioVAEEncoderLoader-encode code
//  generateRestyle/generateHD/refine already all repeat for standalone WAVs.
//  Same AVAssetReader extraction pattern AudioProbe.analyze already uses,
//  returning raw samples instead of collapsing them to loudness stats.
//

import AVFoundation
import Foundation

public enum VideoAudioReaderError: Error, CustomStringConvertible {
    case noAudioTrack(URL)
    case readFailed(URL)
    public var description: String {
        switch self {
        case .noAudioTrack(let url): return "VideoAudioReader: no audio track in \(url.path)"
        case .readFailed(let url): return "VideoAudioReader: failed to read audio track in \(url.path)"
        }
    }
}

public enum VideoAudioReader {
    public static func read(url: URL) throws -> WAVReader.Result {
        let asset = AVURLAsset(url: url)
        guard let track = asset.tracks(withMediaType: .audio).first else {
            throw VideoAudioReaderError.noAudioTrack(url)
        }
        let formatDescriptions = track.formatDescriptions as? [CMFormatDescription] ?? []
        let streamDesc = formatDescriptions.first.flatMap { CMAudioFormatDescriptionGetStreamBasicDescription($0)?.pointee }
        let sampleRate = Int(streamDesc?.mSampleRate ?? 44100)
        let numChannels = max(1, Int(streamDesc?.mChannelsPerFrame ?? 1))

        let reader = try AVAssetReader(asset: asset)
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVLinearPCMBitDepthKey: 32,
            AVLinearPCMIsFloatKey: true,
            AVLinearPCMIsNonInterleaved: false,
            AVNumberOfChannelsKey: numChannels,
        ]
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: settings)
        reader.add(output)
        guard reader.startReading() else {
            throw VideoAudioReaderError.readFailed(url)
        }

        var interleaved: [Float] = []
        while let buffer = output.copyNextSampleBuffer() {
            guard let blockBuffer = CMSampleBufferGetDataBuffer(buffer) else { continue }
            let length = CMBlockBufferGetDataLength(blockBuffer)
            var data = [UInt8](repeating: 0, count: length)
            CMBlockBufferCopyDataBytes(blockBuffer, atOffset: 0, dataLength: length, destination: &data)
            data.withUnsafeBytes { raw in
                let floats = raw.bindMemory(to: Float32.self)
                interleaved.append(contentsOf: floats)
            }
        }

        guard reader.status == .completed else {
            throw VideoAudioReaderError.readFailed(url)
        }

        let frameCount = interleaved.count / numChannels
        var channels = [[Float]](repeating: [Float](repeating: 0, count: frameCount), count: numChannels)
        for frame in 0..<frameCount {
            for ch in 0..<numChannels {
                channels[ch][frame] = interleaved[frame * numChannels + ch]
            }
        }
        return WAVReader.Result(channels: channels, sampleRate: sampleRate)
    }
}
