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
    // Style-mechanism knobs (default to ComfyUI _RECOMMENDED). Override for sweeps.
    @Option(help: "V-AdaIN strength 0..1 (how strongly ref V statistics replace target V).")
    var valueAdainStrength: Float = 0.65
    @Option(help: "Q/K cross-batch AdaIN strength 0..1 (ref Q/K stats → target; upstream recommended 0.85).")
    var adainStrength: Float = 0.85
    @Option(help: "Extra reference-K multiplier (per-frequency scale on top of scaleVec).")
    var refKStrength: Float = 1.06
    @Option(help: "High-frequency K-scale ceiling at progress=0 (low-scale at high freqs).")
    var lowScaleEnd: Float = 1.10
    @Option(help: "First DiT block to inject style into (default 7).")
    var activeBlocksStart: Int = 7
    @Option(help: "Last DiT block to inject style into (default 27).")
    var activeBlocksEnd: Int = 27
    @Option(help: "RF-cache Heun blend gamma (model vs linear prior).")
    var gamma: Float = 0.5
    @Flag(help: "Fast RF cache: single-Euler (skip Heun corrector). Halves RF cost; changes the cached ref trajectory but not strength=0.")
    var fastRF = false
    @Option var out: String?

    func run() throws {
        let styleURL = URL(fileURLWithPath: styleImage)
        let outURL = URL(fileURLWithPath: out ?? RepoPaths.defaultOutputDir
            .appendingPathComponent("krea2_styletransfer_s\(seed).png").path)
        try? FileManager.default.createDirectory(at: outURL.deletingLastPathComponent(),
                                                 withIntermediateDirectories: true)
        let knobs = Krea2StyleDefaults(
            valueAdainStrength: valueAdainStrength,
            refKStrength: refKStrength,
            gamma: gamma, lowScaleEnd: lowScaleEnd,
            adainStrength: adainStrength,
            activeBlocks: activeBlocksStart...activeBlocksEnd)
        try Krea2Engine.styleTransfer(
            prompt: prompt, styleImage: styleURL, strength: strength,
            width: width, height: height, steps: steps, seed: seed, mu: mu,
            knobs: knobs, fastRF: fastRF, out: outURL)
        print("[krea2] saved \(outURL.path)")
    }
}
