//
//  I2ICommand.swift
//  Krea2ImageDirectorCLI
//

import ArgumentParser
import Foundation
import Krea2ImageDirector

struct I2ICommand: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "i2i",
        abstract: "Krea 2 Turbo image-to-image (native Swift, SDEditor-style)."
    )

    @Option(help: "Input image path (PNG/JPG).") var input: String
    @Option var prompt: String
    @Option(help: "Denoise strength 0..1 (how much to change).") var strength: Float = 0.6
    @Option(name: [.customLong("width"), .customShort("w")]) var width: Int = 1024
    @Option(name: [.customLong("height"), .customShort("h")]) var height: Int = 1024
    @Option var steps: Int = 8
    @Option var seed: Int = 42
    @Option var mu: Double = 1.15
    @Option var out: String?

    func run() throws {
        let inURL = URL(fileURLWithPath: input)
        let outURL = URL(fileURLWithPath: out ?? RepoPaths.defaultOutputDir
            .appendingPathComponent("krea2_i2i_s\(seed).png").path)
        try? FileManager.default.createDirectory(at: outURL.deletingLastPathComponent(),
                                                 withIntermediateDirectories: true)
        try Krea2Engine.i2i(inputImage: inURL, prompt: prompt, strength: strength,
                            width: width, height: height, steps: steps, seed: seed,
                            mu: mu, out: outURL)
        print("[krea2] saved \(outURL.path)")
    }
}
