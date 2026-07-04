//
//  VideoConcatenator.swift
//  LTXVideoDirector
//
//  Concatenates N .mp4 files into one, via AVMutableComposition +
//  AVAssetExportSession — pure Swift/AVFoundation, no ffmpeg. This is the
//  native equivalent of app/commands/video-relay.py's `_concat_videos`
//  (which shells out to `ffmpeg -f concat -c copy`); this package has no
//  ffmpeg dependency anywhere else, so re-encoding via AVAssetExportSession
//  (rather than a stream-copy concat demuxer) is the deliberate tradeoff —
//  slower than a pure remux, but works uniformly regardless of whether the
//  segment mp4s share identical encoder parameters.
//

import AVFoundation
import Foundation

public enum VideoConcatenator {
    public enum ConcatError: Error, CustomStringConvertible {
        case noSegments
        case noVideoTrack(URL)
        case noAudioTrack(URL)
        case compositionTrackCreationFailed
        case exportSessionCreationFailed
        case exportFailed(String)

        public var description: String {
            switch self {
            case .noSegments: return "VideoConcatenator: no segments to concatenate"
            case .noVideoTrack(let url): return "VideoConcatenator: no video track found in \(url.path)"
            case .noAudioTrack(let url): return "VideoConcatenator: no audio track found in \(url.path)"
            case .compositionTrackCreationFailed: return "VideoConcatenator: failed to create composition track"
            case .exportSessionCreationFailed: return "VideoConcatenator: failed to create AVAssetExportSession"
            case .exportFailed(let reason): return "VideoConcatenator: export failed — \(reason)"
            }
        }
    }

    /// Concatenates `segmentURLs` in order into a single `.mp4` at `outputURL`.
    /// Each segment's video (and audio, if present) track is appended back to
    /// back on a shared timeline. Segments without an audio track are simply
    /// silent for their span — the output audio track only exists at all if
    /// at least one segment provides one.
    public static func concatenate(_ segmentURLs: [URL], to outputURL: URL) throws {
        guard !segmentURLs.isEmpty else { throw ConcatError.noSegments }

        let composition = AVMutableComposition()
        guard let videoTrack = composition.addMutableTrack(
            withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid
        ) else {
            throw ConcatError.compositionTrackCreationFailed
        }
        let audioTrack = composition.addMutableTrack(
            withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid)
        var audioTrackHasContent = false

        var cursor = CMTime.zero
        for url in segmentURLs {
            let asset = AVURLAsset(url: url)
            guard let assetVideoTrack = asset.tracks(withMediaType: .video).first else {
                throw ConcatError.noVideoTrack(url)
            }
            let range = CMTimeRange(start: .zero, duration: asset.duration)
            try videoTrack.insertTimeRange(range, of: assetVideoTrack, at: cursor)
            videoTrack.preferredTransform = assetVideoTrack.preferredTransform

            if let assetAudioTrack = asset.tracks(withMediaType: .audio).first, let audioTrack {
                try audioTrack.insertTimeRange(range, of: assetAudioTrack, at: cursor)
                audioTrackHasContent = true
            }
            cursor = CMTimeAdd(cursor, asset.duration)
        }

        // A composition audio track with zero inserted content (every
        // segment was video-only) is degenerate and makes
        // AVAssetExportSession fail outright ("此媒體不支援此操作" /
        // AVFoundationErrorDomain -11838) rather than just export a silent
        // track — remove it before exporting if nothing was ever inserted.
        if !audioTrackHasContent, let audioTrack {
            composition.removeTrack(audioTrack)
        }

        try _export(composition, to: outputURL)
    }

    /// Replaces `videoURL`'s existing audio track (if any) with `audioURL`'s
    /// content — the native equivalent of `app/commands/video-relay.py`'s
    /// `_mux_audio_track(mode: "replace")` (this package's first cut only
    /// covers the Python version's default/simplest mode; `mix`/`keep` are
    /// not ported). AVFoundation decodes WAV/MP3/M4A/AAC natively, matching
    /// the Python version's "any ffmpeg-supported format" note without an
    /// actual ffmpeg dependency. If `audioURL` is shorter than the video,
    /// only that shorter span is covered (mirrors ffmpeg's `-shortest`); if
    /// longer, it's trimmed to the video's duration.
    public static func replaceAudioTrack(videoURL: URL, audioURL: URL, to outputURL: URL) throws {
        let videoAsset = AVURLAsset(url: videoURL)
        let audioAsset = AVURLAsset(url: audioURL)
        guard let sourceVideoTrack = videoAsset.tracks(withMediaType: .video).first else {
            throw ConcatError.noVideoTrack(videoURL)
        }
        guard let sourceAudioTrack = audioAsset.tracks(withMediaType: .audio).first else {
            throw ConcatError.noAudioTrack(audioURL)
        }

        let composition = AVMutableComposition()
        guard let videoTrack = composition.addMutableTrack(
            withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid
        ) else {
            throw ConcatError.compositionTrackCreationFailed
        }
        guard let audioTrack = composition.addMutableTrack(
            withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid
        ) else {
            throw ConcatError.compositionTrackCreationFailed
        }

        let videoRange = CMTimeRange(start: .zero, duration: videoAsset.duration)
        try videoTrack.insertTimeRange(videoRange, of: sourceVideoTrack, at: .zero)
        videoTrack.preferredTransform = sourceVideoTrack.preferredTransform

        let sharedDuration = CMTimeMinimum(videoAsset.duration, audioAsset.duration)
        let audioRange = CMTimeRange(start: .zero, duration: sharedDuration)
        try audioTrack.insertTimeRange(audioRange, of: sourceAudioTrack, at: .zero)

        try _export(composition, to: outputURL)
    }

    private static func _export(_ composition: AVMutableComposition, to outputURL: URL) throws {
        guard let exporter = AVAssetExportSession(asset: composition, presetName: AVAssetExportPresetHighestQuality) else {
            throw ConcatError.exportSessionCreationFailed
        }
        if FileManager.default.fileExists(atPath: outputURL.path) {
            try FileManager.default.removeItem(at: outputURL)
        }
        exporter.outputURL = outputURL
        exporter.outputFileType = .mp4

        let semaphore = DispatchSemaphore(value: 0)
        exporter.exportAsynchronously { semaphore.signal() }
        semaphore.wait()

        if exporter.status != .completed {
            let reason: String
            if let error = exporter.error as NSError? {
                reason = "\(error.domain) code=\(error.code): \(error.localizedDescription) — \(error.userInfo)"
            } else {
                reason = "status=\(exporter.status.rawValue)"
            }
            throw ConcatError.exportFailed(reason)
        }
    }
}
