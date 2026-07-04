//
//  ControlNetCommand.swift
//  Krea2ImageDirectorCLI
//
//  Native Swift ControlNet (= Control LoRA) subcommand. Mirrors the
//  facok/comfyui-krea2-controlnet node surface: a Control LoRA + a conditioning
//  image (depth/pose/edge). See Krea2ControlLoRA.swift + docs.
//

import ArgumentParser
import Foundation
import Krea2ImageDirector

struct ControlNetCommand: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "controlnet",
        abstract: "Krea 2 Turbo ControlNet (Control LoRA, native Swift)."
    )

    @Option(help: "Text prompt.") var prompt: String
    @Option(help: "Control image path (depth/pose/edge PNG — preprocessed externally).")
    var controlImage: String
    @Option(help: "Control LoRA safetensors path (Patil/Krea-2-depth-controlnet). Omit to use the promoted/staging default.")
    var controlLora: String?
    @Option(help: "Control strength 0..1 (how strongly the control image guides generation).")
    var strength: Float = 1.0
    @Option(help: "Channel mode: rgb or gray (grayscale recommended for depth).")
    var channelMode: String = "gray"
    @Option(help: "Normalize: none or minmax (per-image min-max; recommended for depth).")
    var normalize: String = "minmax"
    @Flag(help: "Invert the control image (1 - x).")
    var invert = false
    @Option(name: [.customLong("width"), .customShort("w")]) var width: Int = 1024
    @Option(name: [.customLong("height"), .customShort("h")]) var height: Int = 1024
    @Option var steps: Int = 8
    @Option var seed: Int = 42
    @Option var mu: Double = 1.15
    @Option var out: String?

    func run() throws {
        let ctrlURL = URL(fileURLWithPath: controlImage)
        let loraURL = URL(fileURLWithPath: controlLora ?? Krea2Engine.controlLoRAWeights.path)
        guard FileManager.default.fileExists(atPath: loraURL.path) else {
            throw ValidationError("Control LoRA not found at \(loraURL.path). "
                                  + "Download depth-control-lora.safetensors from "
                                  + "huggingface.co/Patil/Krea-2-depth-controlnet.")
        }
        let outURL = URL(fileURLWithPath: out ?? RepoPaths.defaultOutputDir
            .appendingPathComponent("krea2_controlnet_s\(seed).png").path)
        try? FileManager.default.createDirectory(at: outURL.deletingLastPathComponent(),
                                                 withIntermediateDirectories: true)
        try Krea2Engine.controlnet(
            prompt: prompt, controlImage: ctrlURL, controlLoRA: loraURL,
            strength: strength,
            grayscale: channelMode == "gray", minmax: normalize == "minmax", invert: invert,
            width: width, height: height, steps: steps, seed: seed, mu: mu, out: outURL)
        print("[krea2] saved \(outURL.path)")
    }
}
