//
//  PostProcessCommand.swift
//  Flux2DirectorCLI
//
//  `flux2 postprocess` — film grain / CAS+unsharp sharpening / bilateral
//  noise-clean / CLAHE skin-contrast pixel filters (port of
//  app/postprocess.py's PostProcessChain). No model loading — mirrors
//  CutoutCommand.swift's shape. LUT grading is NOT exposed (deferred, see
//  .planning/specs/2026-08-03-postprocess-swift-native-port-design.md —
//  zero .cube assets exist anywhere in this repo, no caller has ever
//  exercised that path).
//

import ArgumentParser
import CommonImageDirector
import Flux2Director
import Foundation
import MLX

extension Flux2CLI {
    struct PostProcess: ParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "postprocess",
            abstract: "Pixel-filter post-processing (film grain / CAS+unsharp sharpening / bilateral noise-clean / CLAHE skin-contrast)."
        )

        @Option(help: "Source image path.") var input: String
        @Option(name: .customLong("film-grain"), help: "Film grain intensity (0 = off).") var filmGrain: Float = 0
        @Option(help: "CAS sharpening strength (0 = off).") var sharpening: Float = 0
        @Flag(name: .customLong("skin-contrast"), help: "Apply CLAHE contrast enhancement to detected skin-tone regions.") var skinContrast: Bool = false
        @Flag(name: .customLong("noise-clean"), help: "Apply bilateral denoise + JPEG-artifact scrub.") var noiseClean: Bool = false
        @Option var seed: UInt64 = 42
        @Option var output: String

        func run() throws {
            setbuf(stdout, nil)
            print("flux2 postprocess")
            print("  input: \(input)  film-grain: \(filmGrain)  sharpening: \(sharpening)  skin-contrast: \(skinContrast)  noise-clean: \(noiseClean)")

            let (width, height) = try Flux2ImageLoad.imageSize(at: URL(fileURLWithPath: input))
            let rgb = try Flux2ImageLoad.loadArray(from: URL(fileURLWithPath: input), targetSize: (width, height))

            var config = PostProcessConfig()
            config.filmGrain = filmGrain
            config.sharpening = sharpening
            config.skinContrast = skinContrast
            config.noiseClean = noiseClean
            config.seed = seed

            let result = PostProcessChain.apply(rgb, config: config)
            MLX.eval(result)

            let outputURL = URL(fileURLWithPath: output)
            try FileManager.default.createDirectory(at: outputURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            try ImageSave.savePNG(result, to: outputURL)
            print("")
            print("✅ postprocess saved: \(outputURL.path)")
        }
    }
}
