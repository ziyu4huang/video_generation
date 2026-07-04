//
//  ControlStyleCommand.swift
//  Krea2ImageDirectorCLI
//
//  Composition subcommand: ControlNet (Control LoRA) + training-free Style
//  Transfer in one engine call. The one untested combination of the two shipped
//  krea2 features — see docs/controlnet-styletransfer-validation.md (composition
//  addendum) + Krea2ControlStyle.swift.
//

import ArgumentParser
import Foundation
import Krea2ImageDirector

struct ControlStyleCommand: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "control-style",
        abstract: "Krea 2 Turbo ControlNet + Style Transfer composition (native Swift)."
    )

    @Option(help: "Text prompt (content + composition).") var prompt: String
    @Option(help: "Control image path (depth/pose/edge PNG — preprocessed externally).")
    var controlImage: String
    @Option(help: "Style reference image path (PNG/JPG).") var styleImage: String
    @Option(help: "Control LoRA safetensors path. Omit to use the promoted/staging default.")
    var controlLora: String?
    @Option(help: "Control strength 0..1 (how strongly the control image guides generation).")
    var controlStrength: Float = 1.0
    @Option(help: "Style strength 0..1 (how strongly the reference's style is applied).")
    var strength: Float = 1.0
    @Option(help: "Channel mode: rgb or gray (grayscale recommended for depth).")
    var channelMode: String = "gray"
    @Option(help: "Normalize: none or minmax (per-image min-max; recommended for depth).")
    var normalize: String = "minmax"
    @Flag(help: "Invert the control image (1 - x).") var invert = false
    @Option(name: [.customLong("width"), .customShort("w")]) var width: Int = 1024
    @Option(name: [.customLong("height"), .customShort("h")]) var height: Int = 1024
    @Option var steps: Int = 8
    @Option var seed: Int = 42
    @Option var mu: Double = 1.15
    // Style-mechanism knobs (default to ComfyUI _RECOMMENDED; sweep for stronger transfer).
    @Option var valueAdainStrength: Float = 0.65
    @Option(help: "Q/K cross-batch AdaIN strength 0..1 (ref Q/K stats → target; upstream recommended 0.85).")
    var adainStrength: Float = 0.85
    @Option var refKStrength: Float = 1.06
    @Option var lowScaleEnd: Float = 1.10
    @Option var activeBlocksStart: Int = 7
    @Option var activeBlocksEnd: Int = 27
    @Option var gamma: Float = 0.5
    @Flag(help: "Fast RF cache: single-Euler (skip Heun corrector). Halves RF cost; not strength=0-affecting.")
    var fastRF = false
    @Option var out: String?

    func run() throws {
        let ctrlURL = URL(fileURLWithPath: controlImage)
        let styleURL = URL(fileURLWithPath: styleImage)
        let loraURL = URL(fileURLWithPath: controlLora ?? Krea2Engine.controlLoRAWeights.path)
        guard FileManager.default.fileExists(atPath: loraURL.path) else {
            throw ValidationError("Control LoRA not found at \(loraURL.path). "
                                  + "Download depth-control-lora.safetensors from "
                                  + "huggingface.co/Patil/Krea-2-depth-controlnet.")
        }
        let outURL = URL(fileURLWithPath: out ?? RepoPaths.defaultOutputDir
            .appendingPathComponent("krea2_controlstyle_s\(seed).png").path)
        try? FileManager.default.createDirectory(at: outURL.deletingLastPathComponent(),
                                                 withIntermediateDirectories: true)
        let knobs = Krea2StyleDefaults(
            valueAdainStrength: valueAdainStrength,
            refKStrength: refKStrength,
            gamma: gamma, lowScaleEnd: lowScaleEnd,
            adainStrength: adainStrength,
            activeBlocks: activeBlocksStart...activeBlocksEnd)
        try Krea2Engine.controlStyle(
            prompt: prompt,
            controlImage: ctrlURL, controlLoRA: loraURL, styleImage: styleURL,
            controlStrength: controlStrength,
            grayscale: channelMode == "gray", minmax: normalize == "minmax", invert: invert,
            strength: strength,
            width: width, height: height, steps: steps, seed: seed, mu: mu,
            knobs: knobs, fastRF: fastRF, out: outURL)
        print("[krea2] saved \(outURL.path)")
    }
}
