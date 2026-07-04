//
//  StyleTransferCommand.swift
//  Krea2ImageDirectorCLI
//
//  Native Swift training-free style transfer (jieg9341-lab port). Uses a style
//  reference image to restyle the prompt's generation — no adapter weights.
//  See Krea2StyleTransfer.swift + docs/controlnet-styletransfer-port.md.
//

import ArgumentParser
import Foundation
import Krea2ImageDirector

struct StyleTransferCommand: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "style-transfer",
        abstract: "Krea 2 Turbo training-free style transfer (native Swift)."
    )

    @Option(help: "Text prompt (content + composition).") var prompt: String
    @Option(help: "Style reference image path (PNG/JPG).") var styleImage: String
    @Option(help: "Style strength 0..1 (how strongly the reference's style is applied).")
    var strength: Float = 1.0
    @Option(name: [.customLong("width"), .customShort("w")]) var width: Int = 1024
    @Option(name: [.customLong("height"), .customShort("h")]) var height: Int = 1024
    @Option var steps: Int = 8
    @Option var seed: Int = 42
    @Option var mu: Double = 1.15
    @Option var out: String?

    func run() throws {
        let styleURL = URL(fileURLWithPath: styleImage)
        let outURL = URL(fileURLWithPath: out ?? RepoPaths.defaultOutputDir
            .appendingPathComponent("krea2_styletransfer_s\(seed).png").path)
        try? FileManager.default.createDirectory(at: outURL.deletingLastPathComponent(),
                                                 withIntermediateDirectories: true)
        try Krea2Engine.styleTransfer(
            prompt: prompt, styleImage: styleURL, strength: strength,
            width: width, height: height, steps: steps, seed: seed, mu: mu, out: outURL)
        print("[krea2] saved \(outURL.path)")
    }
}
