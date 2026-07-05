//
//  DualStyleTransferCommand.swift
//  Krea2ImageDirectorCLI
//
//  `krea2 dual-style-transfer` — two-reference training-free style transfer
//  (plain_average fusion, Gap 2). The two refs' K/V contributions are
//  weighted-mean fused. See Krea2StyleTransfer.dualStyleTransfer.
//

import ArgumentParser
import Foundation
import Krea2ImageDirector

struct DualStyleTransferCommand: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "dual-style-transfer",
        abstract: "Krea 2 Turbo dual-reference style transfer (plain_average fusion, native Swift)."
    )

    @Option(help: "Text prompt (content + composition).") var prompt: String
    @Option(help: "TWO style reference image paths, comma-separated.")
    var styleImages: String
    @Option(help: "Per-ref weights, comma-separated (e.g. 0.7,0.3). Default 0.5,0.5.")
    var weights: String = "0.5,0.5"
    @Option(help: "Style strength 0..1 (0 = byte-identical to vanilla t2i at --seed).")
    var strength: Float = 1.0
    @Option(name: [.customLong("width"), .customShort("w")]) var width: Int = 1024
    @Option(name: [.customLong("height"), .customShort("h")]) var height: Int = 1024
    @Option var steps: Int = 8
    @Option var seed: Int = 42
    @Option var mu: Double = 1.15
    @Option var valueAdainStrength: Float = 0.65
    @Option var adainStrength: Float = 0.85
    @Option var refKStrength: Float = 1.06
    @Option var lowScaleEnd: Float = 1.10
    @Option var activeBlocksStart: Int = 7
    @Option var activeBlocksEnd: Int = 27
    @Option var gamma: Float = 0.5
    @Option var rfMode: RFMode = .flowturboPC
    @Flag var fastRF = false
    @Option var out: String?

    func run() throws {
        let urls = styleImages.split(separator: ",").map {
            URL(fileURLWithPath: String($0).trimmingCharacters(in: .whitespaces))
        }
        let w = weights.split(separator: ",").compactMap { Float(String($0).trimmingCharacters(in: .whitespaces)) }
        guard urls.count == 2 else {
            throw ValidationError("dual-style-transfer requires exactly 2 --style-images (comma-separated).")
        }
        let weightArr = w.count == 2 ? w : [0.5, 0.5]
        let outURL = URL(fileURLWithPath: out ?? RepoPaths.defaultOutputDir
            .appendingPathComponent("krea2_dualstyletransfer_s\(seed).png").path)
        try? FileManager.default.createDirectory(at: outURL.deletingLastPathComponent(),
                                                 withIntermediateDirectories: true)
        let knobs = Krea2StyleDefaults(
            valueAdainStrength: valueAdainStrength,
            refKStrength: refKStrength,
            gamma: gamma, lowScaleEnd: lowScaleEnd,
            adainStrength: adainStrength,
            rfMode: rfMode,
            activeBlocks: activeBlocksStart...activeBlocksEnd)
        try Krea2Engine.dualStyleTransfer(
            prompt: prompt, styleImages: urls, weights: weightArr, strength: strength,
            width: width, height: height, steps: steps, seed: seed, mu: mu,
            knobs: knobs, fastRF: fastRF, out: outURL)
        print("[krea2] saved \(outURL.path)")
    }
}
