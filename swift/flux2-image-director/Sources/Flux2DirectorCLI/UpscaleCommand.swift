//
//  UpscaleCommand.swift
//  Flux2DirectorCLI
//
//  `flux2 upscale` — 4K修復: 4× super-resolution via the native Swift/MLX
//  RealPLKSR port (4xNomosWebPhoto_RealPLKSR). Pure convolutional upscaler —
//  no diffusion model loaded, ~instant vs SeedVR2.
//

import ArgumentParser
import CommonImageDirector
import Flux2Director
import Foundation
import MLX

extension Flux2CLI {
    struct Upscale: ParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "upscale",
            abstract: "4× super-resolution (RealPLKSR, native Swift MLX). 4K修復."
        )

        @OptionGroup var globals: GlobalOptions

        @Option(help: "Input image to upscale.")
        var input: String

        @Option(help: "ESRGAN model name under models/upscale/ (default 4x-nomos-webphoto-realplksr).")
        var model: String = "4x-nomos-webphoto-realplksr"

        /// Tiled inference (overlap-and-blend) avoids OOM on large inputs by
        /// processing the image in `--tile-size` LR tiles with `--tile-overlap`
        /// px of feather-blended context. Auto-enabled when either input dim
        /// exceeds `--tile-size`; --no-tile forces the whole-image path.
        @Option(help: "LR tile size for tiled inference (auto-enables when input > tile). Default 256.")
        var tileSize: Int = 256
        @Option(help: "Tile overlap (LR px) feather-blended between tiles. Default 32.")
        var tileOverlap: Int = 32
        @Flag(help: "Force whole-image inference (no tiling). May OOM on 4K+ sources.")
        var noTile: Bool = false

        @Option var output: String = ""
        @Option var outputDir: String?
        @Option var name: String?
        @Flag var noArtifacts: Bool = false

        @Flag(help: "Abort (exit 1) if the output FAILs the image gate.")
        var strictGate: Bool = false

        func run() throws {
            setbuf(stdout, nil)
            globals.apply()

            let inputURL = URL(fileURLWithPath: input)
            let (iw, ih) = try Flux2ImageLoad.imageSize(at: inputURL)
            let modelDir = ModelPaths.upscaleRoot.appendingPathComponent(model)
            // Prefer the MLX safetensors (converted from .pth); fall back to .pth is
            // unsupported (Swift can't read torch pickles) — error guides the user.
            let stFile = (try? FileManager.default.contentsOfDirectory(at: modelDir, includingPropertiesForKeys: nil))?
                .first { $0.pathExtension == "safetensors" && !$0.lastPathComponent.hasPrefix("._") }
            guard let stURL = stFile else {
                throw ValidationError("no .safetensors in \(modelDir.path) — convert the .pth via spandrel (see README)")
            }

            print("flux2 upscale — RealPLKSR 4× (native MLX)")
            print("  input : \(inputURL.lastPathComponent) (\(iw)×\(ih))")
            print("  model : \(stURL.lastPathComponent)")

            let sr = try ESRGANLoader.loadRealPLKSR(url: stURL)

            // Load input at native res → NHWC (1,H,W,3) [0,1].
            let nchw = try Flux2ImageLoad.loadArray(from: inputURL, targetSize: (width: iw, height: ih))
            let nhwc = nchw.transposed(0, 2, 3, 1).asType(.float32)

            let start = DispatchTime.now()
            // Tiled inference when the input exceeds one tile (avoids OOM on
            // large sources); --no-tile forces the whole-image path.
            let useTiled = !noTile && (iw > tileSize || ih > tileSize)
            let out: MLXArray
            if useTiled {
                print("  tiling : \(tileSize)px tiles, \(tileOverlap)px overlap (input \(iw)×\(ih) > tile)")
                out = sr.tiledUpscale(nhwc, tileSize: tileSize, overlap: tileOverlap)
            } else {
                out = sr(nhwc)   // (1, 4H, 4W, 3)
            }
            let clamped = MLX.clip(out, min: 0.0, max: 1.0).asType(.float32)
            MLX.eval(clamped)
            let elapsed = Double(DispatchTime.now().uptimeNanoseconds - start.uptimeNanoseconds) / 1e9

            // Back to NCHW for the shared saver.
            let pixels = clamped.transposed(0, 3, 1, 2)
            let oh = pixels.dim(2), ow = pixels.dim(3)
            print("  output: \(ow)×\(oh)  (\(String(format: "%.2f", elapsed))s)")
            try ImageGate.check(pixels, label: "upscale", strict: strictGate)

            let paths = try OutputPathResolver.makePaths(
                explicitOutput: output.isEmpty ? nil : output,
                outputDir: outputDir, customName: name)
            try Flux2T2IPipeline.saveImage(pixels, to: URL(fileURLWithPath: paths.png))
            print("")
            print("✅ upscaled \(URL(fileURLWithPath: paths.png).lastPathComponent)")
            print("   \(paths.png)")
            if !noArtifacts {
                let runConfig = RunConfig(
                    transformer: "", prompt: "",
                    width: ow, height: oh, steps: 0, seed: 0, cfgScale: 1.0,
                    loraPaths: nil, loraScale: 1.0,
                    textEncoder: "", tokenizer: "", vae: model,
                    quantBits: 0, quantGroupSize: 0, command: "upscale", pipeline: "esrgan")
                try runConfig.write(to: paths.runJSON)
                print("   run.json: \(paths.runJSON)")
            }
        }
    }
}
