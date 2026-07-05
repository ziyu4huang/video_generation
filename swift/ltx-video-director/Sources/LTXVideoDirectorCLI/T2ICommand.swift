//
//  T2ICommand.swift
//  LTXVideoDirectorCLI
//
//  `ltx-video t2i` — the T2I half of t2i2v, running natively via
//  NativeT2IStage (ZImageDirector's T2IPipeline in-process). No run.py,
//  no RunPyBridge. See PLAN.md's "native T2I stage" milestone.
//

import ArgumentParser
import Foundation
import LTXVideoDirector

struct T2I: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "t2i",
        abstract: "Generate an image natively (ZImageDirector in-process, no run.py) for the t2i2v pipeline."
    )

    @Option(help: "Text prompt.")
    var prompt: String

    @Option(help: "Transformer variant under models/transformer/.")
    var transformer: String = "moody-pro-mix"

    @Option(help: "Output width.")
    var width: Int = 640

    @Option(help: "Output height.")
    var height: Int = 960

    @Option(help: "Denoising steps. Omit for the transformer's recommended value.")
    var steps: Int?

    @Option(help: "Random seed.")
    var seed: UInt64 = 99

    @Option(name: .shortAndLong, help: "Output PNG path.")
    var output: String = "t2i_native_output.png"

    @Flag(help: "Break each denoise step's timing into forward-pass vs scheduler-step (adds an extra sync point per step; off by default).")
    var profileSubsteps: Bool = false

    func run() throws {
        let stage = NativeT2IStage(
            transformer: transformer, width: width, height: height, steps: steps, seed: seed,
            profileSubsteps: profileSubsteps)
        print("Generating natively (ZImageDirector in-process, no run.py)...")
        print("  transformer: \(transformer), size: \(width)x\(height), seed: \(seed)")
        _ = try stage.generate(prompt: prompt, outputURL: URL(fileURLWithPath: output))
        print("Wrote \(output) — 100% native Swift/MLX, zero run.py calls.")
    }
}
