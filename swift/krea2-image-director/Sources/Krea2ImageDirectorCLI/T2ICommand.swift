//
//  T2ICommand.swift
//  Krea2ImageDirectorCLI
//

import ArgumentParser
import Foundation
import Krea2ImageDirector

struct T2ICommand: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "t2i",
        abstract: "Krea 2 Turbo text-to-image (Phase 0: bridges to the python MLX pipeline)."
    )

    @Option var prompt: String
    @Option(name: [.customLong("width"), .customShort("w")], help: "Output width (multiple of 16).") var width: Int = 1024
    @Option(name: [.customLong("height"), .customShort("h")], help: "Output height (multiple of 16).") var height: Int = 1024
    @Option(help: "Denoise steps (Turbo: 8).") var steps: Int = 8
    @Option(help: "Random seed.") var seed: Int = 42
    @Option(help: "Timestep-shift mu (Turbo: 1.15).") var mu: Double = 1.15
    @Option(help: "Output PNG path.") var out: String?
    @Flag(help: "Use the Python bridge instead of the native Swift engine.") var bridge = false

    func run() throws {
        let outURL = URL(fileURLWithPath: out ?? RepoPaths.defaultOutputDir
            .appendingPathComponent("krea2_t2i_s\(seed).png").path)
        try? FileManager.default.createDirectory(at: outURL.deletingLastPathComponent(),
                                                 withIntermediateDirectories: true)
        if bridge {
            let req = Krea2T2IRequest(prompt: prompt, width: width, height: height,
                                      steps: steps, seed: seed, mu: mu, out: outURL)
            print("[krea2] t2i (bridge) \(width)x\(height) steps=\(steps) mu=\(mu) seed=\(seed)")
            try Krea2Bridge.t2i(req)
        } else {
            print("[krea2] t2i (native) \(width)x\(height) steps=\(steps) mu=\(mu) seed=\(seed)")
            try Krea2Engine.t2i(prompt: prompt, width: width, height: height,
                                steps: steps, seed: seed, mu: mu, out: outURL)
        }
        print("[krea2] saved \(outURL.path)")
    }
}
