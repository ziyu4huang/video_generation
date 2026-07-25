//
//  LipsyncMetricsCommand.swift
//  LTXVideoDirectorCLI
//
//  `ltx-video lipsync-metrics` — measure whether generated mouth motion
//  tracks the audio. Pure Swift port of
//  python/mlx-movie-director/app/lipsync_metrics.py's
//  measure_lipsync_precision(); see LTXVideoDirector/LipsyncMetrics.swift.
//

import ArgumentParser
import Foundation
import LTXVideoDirector

extension LTXVideoDirectorCLI {
    struct LipsyncMetricsCommand: ParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "lipsync-metrics",
            abstract: "Measure mouth-motion/audio correlation for a talking-head video (no Python)."
        )

        @Argument(help: "Video file to measure.")
        var video: String

        @Flag(help: "Emit machine-readable JSON.")
        var json = false

        func run() throws {
            let url = URL(fileURLWithPath: video)
            let result = try LipsyncMetrics.measure(url: url)

            if json {
                let encoder = JSONEncoder()
                encoder.outputFormatting = [.sortedKeys]
                let data = try encoder.encode(result)
                print(String(data: data, encoding: .utf8) ?? "{}")
            } else {
                print("verdict: \(result.verdict)")
                if let r = result.pearsonR { print("pearson_r: \(r)") }
                if let std = result.mouthRatioStd { print("mouth_ratio_std: \(std)") }
                if let lag = result.bestLagFrames { print("best_lag_frames: \(lag)") }
                if let caveat = result.caveat { print("caveat: \(caveat)") }
                if let note = result.note { print("note: \(note)") }
            }
        }
    }
}
