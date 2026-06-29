//
//  UpscaleCommand.swift
//  ZImageDirectorCLI
//
//  `zimage upscale <IMAGE>` — basic image upscale (CoreImage Lanczos).
//  The Swift counterpart of `run.py upscale --method esrgan` (the fast pixel
//  path; no diffusion model loaded). AI-diffusion upscale (SeedVR2) and the
//  learned ESRGAN RealPLKSR model are deferred — see ImageGenUtils/Upscaler.swift.
//

import ArgumentParser
import Foundation
import ImageGenUtils

extension ZImageCLI {
    struct Upscale: ParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "upscale",
            abstract: "Upscale an image (CoreImage Lanczos; no model weights)."
        )

        @Argument(help: "Input image path.")
        var image: String

        @Option(help: "Scale factor (e.g. 2, 3, 4). Default 4 (matches python ESRGAN 4×).")
        var factor: Double = 4

        @Option(help: "Target longest edge in px. Overrides --factor.")
        var longestEdge: Int?

        @Option(help: "Output PNG path (default: <input>_<factor>x.png).")
        var output: String?

        func run() throws {
            let inputURL = URL(fileURLWithPath: image)
            guard FileManager.default.fileExists(atPath: inputURL.path) else {
                throw ValidationError("Image not found: \(image)")
            }
            let outputPath = output.map(URL.init(fileURLWithPath:))
            let dest: URL
            if let longestEdge {
                dest = try Upscaler.scaleToLongestEdge(
                    input: inputURL, longestEdge: longestEdge, output: outputPath
                )
            } else {
                dest = try Upscaler.scale(
                    input: inputURL, factor: factor, output: outputPath
                )
            }
            print("Upscaled → \(dest.path)")
        }
    }
}
