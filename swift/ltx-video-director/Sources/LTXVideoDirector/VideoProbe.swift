//
//  VideoProbe.swift
//  LTXVideoDirector
//
//  Native (AVFoundation) video introspection: duration/fps/resolution and
//  keyframe extraction as CGImage. No Python involved — this is the base
//  layer for both the quality gateway (VideoGate) and VLM keyframe verify.
//

import AVFoundation
import CoreGraphics
import Foundation

public struct VideoInfo {
    public let duration: Double
    public let fps: Double
    public let width: Int
    public let height: Int
    public let frameCount: Int
    public let hasAudioTrack: Bool
}

public enum VideoProbeError: Error, CustomStringConvertible {
    case noVideoTrack(URL)
    case frameExtractionFailed(Double)
    case readerFailedToStart(URL)
    public var description: String {
        switch self {
        case .noVideoTrack(let u): return "no video track in \(u.path)"
        case .frameExtractionFailed(let t): return "could not extract frame at t=\(t)s"
        case .readerFailedToStart(let u): return "cannot open/decode video: \(u.path)"
        }
    }
}

public enum VideoProbe {
    public static func info(url: URL) throws -> VideoInfo {
        let asset = AVURLAsset(url: url)
        guard let track = asset.tracks(withMediaType: .video).first else {
            throw VideoProbeError.noVideoTrack(url)
        }
        let duration = asset.duration.seconds
        let fps = Double(track.nominalFrameRate)
        let size = track.naturalSize.applying(track.preferredTransform)
        let width = Int(abs(size.width))
        let height = Int(abs(size.height))
        let frameCount = Int((duration * Double(fps)).rounded())
        let hasAudio = !asset.tracks(withMediaType: .audio).isEmpty
        return VideoInfo(duration: duration, fps: fps, width: width, height: height,
                          frameCount: frameCount, hasAudioTrack: hasAudio)
    }

    /// Extract a single frame at time `t` (seconds) as a CGImage.
    public static func frame(url: URL, at t: Double) throws -> CGImage {
        let asset = AVURLAsset(url: url)
        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true
        generator.requestedTimeToleranceBefore = .zero
        generator.requestedTimeToleranceAfter = .zero
        let time = CMTime(seconds: t, preferredTimescale: 600)
        do {
            return try generator.copyCGImage(at: time, actualTime: nil)
        } catch {
            throw VideoProbeError.frameExtractionFailed(t)
        }
    }

    /// Extract `count` CONSECUTIVE frames (spaced by 1/fps) starting at
    /// `startTime` — for motion detection, which needs adjacent-frame deltas,
    /// not deltas between far-apart samples (see VideoGate's motion check:
    /// samples 1s+ apart accumulate both real motion AND diffusion
    /// frame-to-frame flicker/noise, making the two indistinguishable).
    public static func consecutiveFrames(url: URL, startTime: Double, count: Int, fps: Double) throws -> [CGImage] {
        guard count > 0, fps > 0 else { return [] }
        let step = 1.0 / fps
        var frames: [CGImage] = []
        frames.reserveCapacity(count)
        for i in 0..<count {
            if let img = try? frame(url: url, at: startTime + Double(i) * step) {
                frames.append(img)
            }
        }
        return frames
    }

    /// Extract `count` frames evenly spaced across the clip (excluding the
    /// very first/last few ms to avoid black lead-in/out frames some
    /// encoders emit).
    public static func evenlySpacedFrames(url: URL, count: Int) throws -> [(time: Double, image: CGImage)] {
        let info = try info(url: url)
        guard count > 0, info.duration > 0 else { return [] }
        let margin = min(0.15, info.duration * 0.05)
        let usable = max(0.001, info.duration - 2 * margin)
        var results: [(Double, CGImage)] = []
        for i in 0..<count {
            let frac = count == 1 ? 0.5 : Double(i) / Double(count - 1)
            let t = margin + frac * usable
            if let img = try? frame(url: url, at: t) {
                results.append((t, img))
            }
        }
        return results
    }
}
