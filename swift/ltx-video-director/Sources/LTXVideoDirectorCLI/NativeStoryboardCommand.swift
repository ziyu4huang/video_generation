//
//  NativeStoryboardCommand.swift
//  LTXVideoDirectorCLI
//
//  `ltx-video native-storyboard` — JSON-config-driven front end over the
//  two existing native stages (NativeI2VStage / NativeRelayStage), instead
//  of hand-assembling long `--grid-*`/`--prompts` flag runs. See
//  StoryboardConfig.swift's header for the full design rationale (why
//  `transitionMode: "camera-move"` routes to NativeI2VStage and
//  `"hard-cut"` routes to NativeRelayStage).
//

import ArgumentParser
import Foundation
import LTXVideoDirector

struct NativeStoryboard: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "native-storyboard",
        abstract: "Generate a multi-segment/multi-panel storyboard video from a single JSON config file, 100% natively (no run.py, no ffmpeg)."
    )

    @Option(name: .shortAndLong, help: "Path to the storyboard JSON config file (segments, transitionMode, grid layout, per-panel frame index/strength).")
    var config: String

    @Option(name: .shortAndLong, help: "Output directory override. Defaults to the config file's own `output` field, or native_storyboard_output.")
    var output: String?

    func run() throws {
        let configURL = URL(fileURLWithPath: config)
        let storyboard = try StoryboardConfig.load(from: configURL)
        let baseDir = configURL.deletingLastPathComponent()
        let outputDir = URL(fileURLWithPath: output ?? storyboard.output ?? "native_storyboard_output")

        switch storyboard.transitionMode {
        case .cameraMove:
            print("→ native storyboard (camera-move, no run.py): \(storyboard.segments.count) grid panel(s) as keyframes in ONE continuous shot")
            let request = try storyboard.toCameraMoveRequest(baseDir: baseDir)
            let wallStart = Date()
            let result = try NativeI2VStage().generate(request, outputDir: outputDir)
            print("\n✅ wall time: \(String(format: "%.1f", Date().timeIntervalSince(wallStart)))s")
            print("   \(result.frameCount) frames: \(result.frameDirectory.path)")
            print("   audio: \(result.audioURL.path)")

        case .hardCut:
            print("→ native storyboard (hard-cut, no run.py): \(storyboard.segments.count) discrete segment(s), each its own storyboard panel")
            let request = try storyboard.toHardCutRequest(baseDir: baseDir)
            let wallStart = Date()
            let result = try NativeRelayStage().generate(request, outputDir: outputDir)
            print("\n✅ wall time: \(String(format: "%.1f", Date().timeIntervalSince(wallStart)))s")
            for (i, url) in result.segmentVideoURLs.enumerated() {
                print("   segment \(i + 1): \(url.path)")
            }
            print("   final: \(result.finalVideoURL.path)")
        }
        print("   100% native Swift/MLX — zero run.py calls, config-driven (one JSON file, no per-flag CLI args needed).")
    }
}
