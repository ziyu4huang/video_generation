//
//  VbvrCommand.swift
//  LTXVideoDirectorCLI
//
//  `ltx-video vbvr` — Swift parity with `run.py video vbvr`: I2V/T2V
//  generation with a "reasoning" LoRA auto-detected from mlx-models/lora/
//  (any directory with "vbvr" in its name), or an explicit --vbvr-lora path.
//  No new engine — this is the same NativeI2VStage pipeline NativeI2V
//  already drives, with the VBVR LoRA fused in via the existing --lora
//  path (LoRAFusion.swift). Mode (I2V vs T2V) is inferred from whether
//  --input-image is given, mirroring the Python CLI exactly.
//

import ArgumentParser
import Foundation
import LTXVideoDirector

extension LTXVideoDirectorCLI {
    struct Vbvr: ParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "vbvr",
            abstract: "I2V/T2V generation with the VBVR reasoning LoRA (auto-detected from mlx-models/lora/vbvr*)."
        )

        @Option(help: "Text prompt.")
        var prompt: String

        @Option(name: .customLong("input-image"), help: "Conditioning image for I2V mode. Omit for T2V mode.")
        var inputImage: String?

        @Option(help: "Explicit path to the VBVR .safetensors LoRA (auto-detected from mlx-models/lora/vbvr* if not set).")
        var vbvrLora: String?

        @Option(help: "VBVR LoRA fusion strength.")
        var loraScale: Double = 1.0

        @Option(help: "Target clip duration in seconds.")
        var seconds: Double = 0.5

        @Option(help: "Output frame rate.")
        var fps: Double = 24.0

        @Option(help: "Output width (must be a multiple of 32).")
        var width: Int = 640

        @Option(help: "Output height (must be a multiple of 32).")
        var height: Int = 960

        @Option(help: "Random seed.")
        var seed: UInt64 = 42

        @Option(help: "T2I transformer variant under mlx-models/transformer/ (only used in T2V mode, i.e. no --input-image).")
        var t2iTransformer: String = "moody-pro-mix"

        @Option(name: .shortAndLong, help: "Output directory (source.png, frames/, audio.wav, video.mp4).")
        var output: String = "vbvr_output"

        func run() throws {
            let resolvedLora: URL
            if let vbvrLora {
                resolvedLora = URL(fileURLWithPath: vbvrLora)
                guard FileManager.default.fileExists(atPath: resolvedLora.path) else {
                    throw ValidationError("--vbvr-lora path does not exist: \(vbvrLora)")
                }
            } else {
                guard let found = Self.findVbvrLora() else {
                    throw ValidationError(
                        "no VBVR LoRA found under \(RepoPaths.mlxModelsRoot.appendingPathComponent("lora").path) "
                        + "(looked for a directory with 'vbvr' in its name). Pass --vbvr-lora explicitly, or download one, e.g.:\n"
                        + "  huggingface-cli download siraxe/VBVR-LTX2.3-diffsynth_comfyui --local-dir mlx-models/lora/vbvr-ltx2.3")
                }
                resolvedLora = found
            }

            let mode = inputImage != nil ? "VBVR-I2V" : "VBVR-T2V"
            print("[vbvr] mode: \(mode)")
            print("[vbvr] LoRA: \(resolvedLora.path) (scale=\(loraScale))")

            var request = NativeI2VStage.Request(
                prompt: prompt, seconds: seconds, fps: fps, width: width, height: height,
                seed: seed, t2iTransformer: t2iTransformer, textMaxLength: 128)
            request.inputImagePath = inputImage.map { URL(fileURLWithPath: $0) }
            request.loraPaths = [(path: resolvedLora, strength: Float(loraScale))]

            let stage = NativeI2VStage()
            let result = try stage.generate(request, outputDir: URL(fileURLWithPath: output))

            print("\n✅ \(result.frameCount) frames: \(result.frameDirectory.path)")
            print("   source image: \(result.sourceImageURL.path)")
            print("   audio: \(result.audioURL.path)")

            let mp4URL = URL(fileURLWithPath: output).appendingPathComponent("video.mp4")
            do {
                try MP4Writer.write(frameDirectory: result.frameDirectory, audioURL: result.audioURL, fps: fps, to: mp4URL)
                print("   mp4: \(mp4URL.path)")
            } catch {
                print("⚠️  mp4 mux failed, PNG frame sequence + audio.wav above are still valid: \(error)")
            }
        }

        /// Mirrors `_find_vbvr_lora()` in video-vbvr.py: scan mlx-models/lora/
        /// for any directory with "vbvr" in its (lowercased) name, pick one
        /// deterministically (sorted, unlike Python's listdir-order "first"),
        /// then require exactly one .safetensors file inside it.
        static func findVbvrLora() -> URL? {
            let loraBase = RepoPaths.mlxModelsRoot.appendingPathComponent("lora")
            let fm = FileManager.default
            guard let entries = try? fm.contentsOfDirectory(atPath: loraBase.path) else { return nil }

            let matches = entries.filter { entry in
                guard entry.lowercased().contains("vbvr") else { return false }
                var isDir: ObjCBool = false
                fm.fileExists(atPath: loraBase.appendingPathComponent(entry).path, isDirectory: &isDir)
                return isDir.boolValue
            }.sorted()

            guard let chosen = matches.first else { return nil }
            if matches.count > 1 {
                FileHandle.standardError.write("[vbvr] Multiple VBVR LoRA dirs found: \(matches.joined(separator: ", "))\n".data(using: .utf8)!)
                FileHandle.standardError.write("[vbvr] Using: \(chosen). Use --vbvr-lora to be explicit.\n".data(using: .utf8)!)
            }

            let chosenDir = loraBase.appendingPathComponent(chosen)
            guard let files = try? fm.contentsOfDirectory(atPath: chosenDir.path) else { return nil }
            let safetensors = files.filter { $0.hasSuffix(".safetensors") }
            guard safetensors.count == 1 else {
                if safetensors.count > 1 {
                    FileHandle.standardError.write("[vbvr] Multiple .safetensors in \(chosenDir.path): \(safetensors.joined(separator: ", "))\n".data(using: .utf8)!)
                    FileHandle.standardError.write("[vbvr] Use --vbvr-lora <path> to specify which one.\n".data(using: .utf8)!)
                }
                return nil
            }
            return chosenDir.appendingPathComponent(safetensors[0])
        }
    }
}
