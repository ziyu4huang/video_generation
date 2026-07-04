//
//  MP4Writer.swift
//  LTXVideoDirector
//
//  Muxes a PNG frame sequence (PNGFrameWriter's `frame_%04d.png` convention)
//  plus an optional WAV audio track into a real H.264+AAC `.mp4`, via
//  AVAssetWriter — no ffmpeg dependency, matching this package's existing
//  "AVFoundation for anything AV, hand-rolled only for the trivial WAV
//  header" convention (see WAVWriter.swift's header for that rationale; a
//  compressed video container is exactly the case that DOES need
//  AVAssetWriter's pixel-buffer-pool plumbing PNGFrameWriter's header
//  flagged as future work).
//
//  Video: each PNG is decoded to a BGRA CVPixelBuffer and appended through
//  an AVAssetWriterInputPixelBufferAdaptor at `frame_index / fps`
//  presentation time — H.264, no B-frames complexity, one keyframe cadence
//  left to the encoder's defaults.
//
//  Audio: the WAV's interleaved Int16 PCM is wrapped in CMSampleBuffers and
//  appended to an AAC-output AVAssetWriterInput with a linear-PCM
//  `sourceFormatHint` — AVAssetWriter transcodes PCM -> AAC internally, so
//  no separate encoder is needed here (documented AVFoundation behavior:
//  outputSettings != nil + a PCM-format input buffer triggers transcoding,
//  as opposed to nil outputSettings, which would require the buffer already
//  match the container's format for passthrough).
//

import AVFoundation
import CoreGraphics
import CoreMedia
import CoreVideo
import Foundation

public enum MP4Writer {
    public enum WriteError: Error, CustomStringConvertible {
        case noFramesFound(URL)
        case pixelBufferPoolUnavailable
        case pixelBufferCreationFailed(Int)
        case appendFailed(String)
        case audioFormatDescriptionFailed
        case writerFailed(Error?)

        public var description: String {
            switch self {
            case .noFramesFound(let url): return "MP4Writer: no frame_*.png files found in \(url.path)"
            case .pixelBufferPoolUnavailable: return "MP4Writer: pixel buffer pool unavailable"
            case .pixelBufferCreationFailed(let frame): return "MP4Writer: failed to create pixel buffer for frame \(frame)"
            case .appendFailed(let track): return "MP4Writer: failed to append \(track) sample buffer"
            case .audioFormatDescriptionFailed: return "MP4Writer: failed to create audio format description"
            case .writerFailed(let err): return "MP4Writer: AVAssetWriter failed: \(err?.localizedDescription ?? "unknown error")"
            }
        }
    }

    /// Reads `frame_%04d.png` files from `frameDirectory` (sorted by
    /// filename) and an optional WAV at `audioURL`, and writes a real
    /// H.264+AAC `.mp4` to `outputURL` (overwritten if it already exists).
    public static func write(frameDirectory: URL, audioURL: URL?, fps: Double, to outputURL: URL) throws {
        let fm = FileManager.default
        let frameFiles = (try fm.contentsOfDirectory(atPath: frameDirectory.path))
            .filter { $0.hasPrefix("frame_") && $0.hasSuffix(".png") }
            .sorted()
        guard !frameFiles.isEmpty else {
            throw WriteError.noFramesFound(frameDirectory)
        }
        guard let firstImage = FrameLoad.loadCGImage(from: frameDirectory.appendingPathComponent(frameFiles[0])) else {
            throw WriteError.noFramesFound(frameDirectory)
        }
        let width = firstImage.width
        let height = firstImage.height

        if fm.fileExists(atPath: outputURL.path) {
            try fm.removeItem(at: outputURL)
        }
        try fm.createDirectory(at: outputURL.deletingLastPathComponent(), withIntermediateDirectories: true)

        let writer = try AVAssetWriter(outputURL: outputURL, fileType: .mp4)

        let videoInput = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: width,
            AVVideoHeightKey: height,
        ])
        videoInput.expectsMediaDataInRealTime = false
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(
            assetWriterInput: videoInput,
            sourcePixelBufferAttributes: [
                kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
                kCVPixelBufferWidthKey as String: width,
                kCVPixelBufferHeightKey as String: height,
            ])
        guard writer.canAdd(videoInput) else {
            throw WriteError.writerFailed(nil)
        }
        writer.add(videoInput)

        var wav: WAVReader.Result?
        var audioInput: AVAssetWriterInput?
        var audioFormatDescription: CMAudioFormatDescription?
        if let audioURL {
            let loaded = try WAVReader.read(url: audioURL)
            wav = loaded
            let numChannels = loaded.channels.count
            let sourceFormat = try pcmFormatDescription(sampleRate: loaded.sampleRate, numChannels: numChannels)
            audioFormatDescription = sourceFormat
            let input = AVAssetWriterInput(
                mediaType: .audio,
                outputSettings: [
                    AVFormatIDKey: kAudioFormatMPEG4AAC,
                    AVSampleRateKey: Double(loaded.sampleRate),
                    AVNumberOfChannelsKey: numChannels,
                ],
                sourceFormatHint: sourceFormat)
            input.expectsMediaDataInRealTime = false
            guard writer.canAdd(input) else {
                throw WriteError.writerFailed(nil)
            }
            writer.add(input)
            audioInput = input
        }

        guard writer.startWriting() else {
            throw WriteError.writerFailed(writer.error)
        }
        writer.startSession(atSourceTime: .zero)

        // Video and audio inputs MUST be fed concurrently, not one to
        // completion before the other starts. AVAssetWriter throttles
        // `isReadyForMoreMediaData` on whichever input runs furthest ahead in
        // presentation time to bound its internal buffering, and expects the
        // OTHER input to be actively draining in parallel to relieve that
        // throttle. Writing all video frames first while the audio input sits
        // untouched (its own `isReadyForMoreMediaData` never even queried)
        // deadlocks the video input forever once it outruns audio far enough
        // — confirmed by a real hang: a tiny 8-frame/1s synthetic test clip
        // (`MP4WriterTests.testWriteVideoWithAudio`) finishes too fast to ever
        // cross that threshold, but a real ~2s/49-frame photographic FFLF
        // clip did, hanging indefinitely in `appendVideoFrames`'s
        // `isReadyForMoreMediaData` poll with the audio input never touched.
        var videoError: Error?
        var audioError: Error?
        let group = DispatchGroup()
        group.enter()
        DispatchQueue.global(qos: .userInitiated).async {
            defer { group.leave() }
            do {
                try appendVideoFrames(
                    frameFiles: frameFiles, frameDirectory: frameDirectory, width: width, height: height,
                    fps: fps, input: videoInput, adaptor: adaptor)
            } catch {
                videoError = error
            }
        }
        if let wav, let audioInput, let audioFormatDescription {
            group.enter()
            DispatchQueue.global(qos: .userInitiated).async {
                defer { group.leave() }
                do {
                    try appendAudio(wav: wav, input: audioInput, formatDescription: audioFormatDescription)
                } catch {
                    audioError = error
                }
            }
        }
        group.wait()
        if let videoError { throw videoError }
        if let audioError { throw audioError }

        let sem = DispatchSemaphore(value: 0)
        writer.finishWriting { sem.signal() }
        sem.wait()

        guard writer.status == .completed else {
            throw WriteError.writerFailed(writer.error)
        }
    }

    private static func appendVideoFrames(
        frameFiles: [String], frameDirectory: URL, width: Int, height: Int, fps: Double,
        input: AVAssetWriterInput, adaptor: AVAssetWriterInputPixelBufferAdaptor
    ) throws {
        guard let pool = adaptor.pixelBufferPool else {
            throw WriteError.pixelBufferPoolUnavailable
        }
        let frameDuration = CMTime(value: 1, timescale: CMTimeScale(fps.rounded()))

        for (index, file) in frameFiles.enumerated() {
            while !input.isReadyForMoreMediaData {
                Thread.sleep(forTimeInterval: 0.005)
            }
            guard let cgImage = FrameLoad.loadCGImage(from: frameDirectory.appendingPathComponent(file)) else {
                throw WriteError.pixelBufferCreationFailed(index)
            }

            var pixelBufferOut: CVPixelBuffer?
            let status = CVPixelBufferPoolCreatePixelBuffer(nil, pool, &pixelBufferOut)
            guard status == kCVReturnSuccess, let pixelBuffer = pixelBufferOut else {
                throw WriteError.pixelBufferCreationFailed(index)
            }

            CVPixelBufferLockBaseAddress(pixelBuffer, [])
            guard let base = CVPixelBufferGetBaseAddress(pixelBuffer) else {
                CVPixelBufferUnlockBaseAddress(pixelBuffer, [])
                throw WriteError.pixelBufferCreationFailed(index)
            }
            let bytesPerRow = CVPixelBufferGetBytesPerRow(pixelBuffer)
            let colorSpace = CGColorSpaceCreateDeviceRGB()
            let bitmapInfo = CGBitmapInfo.byteOrder32Little.rawValue | CGImageAlphaInfo.noneSkipFirst.rawValue
            guard let ctx = CGContext(
                data: base, width: width, height: height, bitsPerComponent: 8,
                bytesPerRow: bytesPerRow, space: colorSpace, bitmapInfo: bitmapInfo
            ) else {
                CVPixelBufferUnlockBaseAddress(pixelBuffer, [])
                throw WriteError.pixelBufferCreationFailed(index)
            }
            ctx.draw(cgImage, in: CGRect(x: 0, y: 0, width: width, height: height))
            CVPixelBufferUnlockBaseAddress(pixelBuffer, [])

            let presentationTime = CMTimeMultiply(frameDuration, multiplier: Int32(index))
            guard adaptor.append(pixelBuffer, withPresentationTime: presentationTime) else {
                throw WriteError.appendFailed("video")
            }
        }
        input.markAsFinished()
    }

    /// Linear-PCM (Int16, interleaved) format description for `numChannels`
    /// @ `sampleRate` — used both as the audio input's `sourceFormatHint`
    /// (so AVAssetWriter configures its PCM->AAC encoder before the first
    /// append, rather than trying to infer it from the first buffer) and to
    /// build each CMSampleBuffer's format description in `appendAudio`.
    private static func pcmFormatDescription(sampleRate: Int, numChannels: Int) throws -> CMAudioFormatDescription {
        let channels = UInt32(numChannels)
        var asbd = AudioStreamBasicDescription(
            mSampleRate: Double(sampleRate),
            mFormatID: kAudioFormatLinearPCM,
            mFormatFlags: kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked,
            mBytesPerPacket: 2 * channels,
            mFramesPerPacket: 1,
            mBytesPerFrame: 2 * channels,
            mChannelsPerFrame: channels,
            mBitsPerChannel: 16,
            mReserved: 0)

        var formatDescription: CMAudioFormatDescription?
        let fmtStatus = CMAudioFormatDescriptionCreate(
            allocator: kCFAllocatorDefault, asbd: &asbd, layoutSize: 0, layout: nil,
            magicCookieSize: 0, magicCookie: nil, extensions: nil, formatDescriptionOut: &formatDescription)
        guard fmtStatus == noErr, let formatDescription else {
            throw WriteError.audioFormatDescriptionFailed
        }
        return formatDescription
    }

    private static func appendAudio(wav: WAVReader.Result, input: AVAssetWriterInput, formatDescription: CMAudioFormatDescription) throws {
        let numChannels = wav.channels.count
        let frameCount = wav.channels[0].count
        // Interleave all channels to Int16 PCM.
        var interleaved = [Int16](repeating: 0, count: frameCount * wav.channels.count)
        for frame in 0..<frameCount {
            for (ch, samples) in wav.channels.enumerated() {
                let clamped = max(-1.0, min(1.0, samples[frame]))
                interleaved[frame * wav.channels.count + ch] = Int16((clamped * Float(Int16.max)).rounded())
            }
        }

        // Chunk into ~1-second CMSampleBuffers to keep block-buffer sizes reasonable.
        let chunkFrames = max(1, wav.sampleRate)
        var frameOffset = 0
        while frameOffset < frameCount {
            while !input.isReadyForMoreMediaData {
                Thread.sleep(forTimeInterval: 0.005)
            }
            let count = min(chunkFrames, frameCount - frameOffset)
            let byteCount = count * Int(numChannels) * MemoryLayout<Int16>.size
            let startIndex = frameOffset * Int(numChannels)

            var blockBuffer: CMBlockBuffer?
            let blockStatus = interleaved.withUnsafeBufferPointer { ptr -> OSStatus in
                CMBlockBufferCreateWithMemoryBlock(
                    allocator: kCFAllocatorDefault, memoryBlock: nil, blockLength: byteCount,
                    blockAllocator: kCFAllocatorDefault, customBlockSource: nil, offsetToData: 0,
                    dataLength: byteCount, flags: 0, blockBufferOut: &blockBuffer)
            }
            guard blockStatus == kCMBlockBufferNoErr, let blockBuffer else {
                throw WriteError.appendFailed("audio")
            }
            let copyStatus = interleaved.withUnsafeBufferPointer { ptr -> OSStatus in
                CMBlockBufferReplaceDataBytes(
                    with: ptr.baseAddress!.advanced(by: startIndex), blockBuffer: blockBuffer,
                    offsetIntoDestination: 0, dataLength: byteCount)
            }
            guard copyStatus == kCMBlockBufferNoErr else {
                throw WriteError.appendFailed("audio")
            }

            let presentationTime = CMTime(value: CMTimeValue(frameOffset), timescale: CMTimeScale(wav.sampleRate))
            var sampleBuffer: CMSampleBuffer?
            let sbStatus = CMAudioSampleBufferCreateWithPacketDescriptions(
                allocator: kCFAllocatorDefault, dataBuffer: blockBuffer, dataReady: true,
                makeDataReadyCallback: nil, refcon: nil, formatDescription: formatDescription,
                sampleCount: count, presentationTimeStamp: presentationTime, packetDescriptions: nil,
                sampleBufferOut: &sampleBuffer)
            guard sbStatus == noErr, let sampleBuffer else {
                throw WriteError.appendFailed("audio")
            }
            guard input.append(sampleBuffer) else {
                throw WriteError.appendFailed("audio")
            }
            frameOffset += count
        }
        input.markAsFinished()
    }
}
