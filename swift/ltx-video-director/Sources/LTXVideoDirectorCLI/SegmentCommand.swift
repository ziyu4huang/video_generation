//
//  SegmentCommand.swift
//  LTXVideoDirectorCLI
//
//  `ltx-video segment` — PURE SWIFT (no run.py): native port of
//  `run.py video segment`'s scene-cut detection (VideoSceneDetector.swift).
//  Mirrors app/commands/video-segment.py's CLI surface (--segment-input,
//  --threshold, --min-frames, --json) but omits --segment-vlm/--frames-per-seg
//  — VLM scoring is a separate LM Studio HTTP call, not part of this CV
//  algorithm; not ported (yet).
//

import ArgumentParser
import AVFoundation
import Foundation
import LTXVideoDirector

extension LTXVideoDirectorCLI {
    struct Segment: ParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "segment",
            abstract: "Detect scene cuts via HSV histogram correlation (no VLM scoring)."
        )

        @Option(name: .customLong("segment-input"), help: "Input video file to analyze.")
        var input: String

        @Option(help: "Scene change sensitivity: lower = more sensitive (0.3-0.5, default: 0.4).")
        var threshold: Double = 0.4

        @Option(name: .customLong("min-frames"), help: "Minimum frames per scene (shorter scenes merged, default: 8).")
        var minFrames: Int = 8

        @Option(help: "Save per-segment report as JSON.")
        var json: String?

        func run() throws {
            let url = URL(fileURLWithPath: input)
            guard FileManager.default.fileExists(atPath: url.path) else {
                FileHandle.standardError.write(Data("ERROR: file not found: \(input)\n".utf8))
                throw ExitCode.failure
            }

            let info = try VideoProbe.info(url: url)
            print("[segment] \(url.lastPathComponent)")
            print("[segment] Threshold: \(threshold), min frames: \(minFrames)")
            print("[segment] Detecting scene changes...")

            let scenes = try VideoSceneDetector.detectScenes(url: url, threshold: threshold, minSceneFrames: minFrames)
            let timestamps = VideoSceneDetector.scenesToTimestamps(scenes, fps: info.fps)
            // The scenes returned by detectScenes fully partition [0, totalFrames):
            // its last end_frame + 1 IS the real decoded frame count. Using that
            // everywhere below (rather than VideoProbe.info's separate
            // duration*fps estimate) as the single source of truth keeps
            // "total_frames" and the last scene's end_frame from ever
            // disagreeing on VFR/edit-list content.
            let totalFrames = (timestamps.last?.endFrame ?? -1) + 1
            print("[segment] \(totalFrames) frames, \(info.width)×\(info.height), \(String(format: "%.1f", info.fps))fps")

            if timestamps.count == 1 {
                print("[segment] Detected 1 scene")
            } else {
                print("[segment] Detected \(timestamps.count) scene(s)")
            }
            print()
            for seg in timestamps {
                let duration = String(format: "%.1f", seg.durationSec)
                print("  Scene \(seg.sceneNum): frames \(seg.startFrame)-\(seg.endFrame) (\(seg.frames) frames, \(duration)s)")
            }

            if let jsonPath = json {
                let report: [String: Any] = [
                    "video": url.absoluteURL.path,
                    "total_frames": totalFrames,
                    "fps": info.fps,
                    "resolution": [info.width, info.height],
                    "threshold": threshold,
                    "min_frames": minFrames,
                    "generated_at": ISO8601DateFormatter().string(from: Date()),
                    "scenes": timestamps.map { seg -> [String: Any] in
                        [
                            "scene_num": seg.sceneNum, "start_frame": seg.startFrame, "end_frame": seg.endFrame,
                            "frames": seg.frames, "start_sec": seg.startSec, "end_sec": seg.endSec,
                            "duration_sec": seg.durationSec,
                        ]
                    },
                ]
                let data = try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
                try data.write(to: URL(fileURLWithPath: jsonPath))
                print("\n[segment] JSON report: \(jsonPath)")
            }
        }
    }
}
