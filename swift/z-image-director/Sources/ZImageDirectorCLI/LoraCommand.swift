//
//  LoraCommand.swift
//  ZImageDirectorCLI
//
//  `zimage lora` — LoRA discovery (list / info), backed by ModelRegistry.
//

import CommonImageDirector
import ArgumentParser
import Foundation
import MLX
import ZImageDirector

extension ZImageCLI {
    struct Lora: ParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "lora",
            abstract: "List and inspect available LoRA adapters.",
            subcommands: [List.self, Info.self]
        )
    }
}

extension ZImageCLI.Lora {
    /// `zimage lora list` — enumerate all LoRAs via the registry.
    struct List: ParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "list", abstract: "List all available LoRA adapters."
        )

        @OptionGroup var globals: GlobalOptions

        @Flag(help: "Show only Z-Image (arch=zimage-turbo) LoRAs.")
        var zimage: Bool = false

        func run() throws {
            globals.apply()
            var manifests = ModelRegistry.list("lora")
            if zimage {
                manifests = manifests.filter { $0.arch == "zimage-turbo" }
            }
            print("Available LoRA adapters (\(manifests.count) found under \(ModelPaths.loraRoot.path)):")
            print("")
            for manifest in manifests {
                let present = manifest.isPresent ? "✓" : "✗"
                let descSuffix = manifest.description.isEmpty
                    ? ""
                    : " — \(manifest.description.prefix(60))"
                print("  \(present) \(manifest.name)  [\(manifest.arch)/\(manifest.format)]\(descSuffix)")
                if !manifest.triggerWords.isEmpty {
                    print("      triggers: \(manifest.triggerWords.joined(separator: ", "))")
                }
                if let scale = manifest.recommendedScale {
                    print("      recommended scale: \(scale)")
                }
            }
            print("")
            print("Use: zimage t2i --lora <name> --lora-scale 1.0")
        }
    }

    /// `zimage lora info NAME` — inspect a specific LoRA via the registry.
    struct Info: ParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "info", abstract: "Show details + target layers for a LoRA."
        )

        @OptionGroup var globals: GlobalOptions

        @Argument(help: "LoRA name (under models/lora/).")
        var name: String

        func run() throws {
            globals.apply()
            // Registry first; fall back to a direct path so loose .safetensors
            // files without a manifest.json still inspect usefully.
            let manifest = ModelRegistry.manifest(forType: "lora", name: name)
            let loraDir = manifest?.directory ?? ModelPaths.lora(name)
            guard FileManager.default.fileExists(atPath: loraDir.path) else {
                throw ValidationError("LoRA not found: \(name) (try 'zimage lora list')")
            }
            if let manifest {
                print("LoRA: \(name)")
                print("  description : \(manifest.description.isEmpty ? "-" : manifest.description)")
                print("  arch        : \(manifest.arch.isEmpty ? "-" : manifest.arch)")
                print("  format      : \(manifest.format.isEmpty ? "-" : manifest.format)")
                print("  compatible  : \(manifest.compatibleWith.isEmpty ? "-" : manifest.compatibleWith.joined(separator: ", "))")
                print("  source      : \(manifest.source.isEmpty ? "-" : manifest.source)")
                if let size = manifest.sizeBytes {
                    print("  size        : \(String(format: "%.1f", Double(size) / 1e6)) MB")
                }
                if !manifest.triggerWords.isEmpty {
                    print("  triggers    : \(manifest.triggerWords.joined(separator: ", "))")
                }
                if let scale = manifest.recommendedScale {
                    print("  rec. scale  : \(scale)")
                }
            } else {
                print("LoRA: \(name)  (no manifest.json — inspecting files directly)")
            }
            let contents = (try? FileManager.default.contentsOfDirectory(atPath: loraDir.path)) ?? []
            guard let safetensorsFile = contents.first(
                where: { $0.hasSuffix(".safetensors") && !$0.hasPrefix(".") }
            ) else {
                print("  ⚠️ no .safetensors file found")
                return
            }
            let stURL = loraDir.appendingPathComponent(safetensorsFile)
            let tensors = try loadArrays(url: stURL)
            print("")
            print("  file        : \(safetensorsFile) (\(tensors.count) tensors)")
            var modules = Set<String>()
            for key in tensors.keys where !key.hasSuffix(".scale") {
                var base = key
                if let range = base.range(of: ".lora_A.weight") { base = String(base[..<range.lowerBound]) }
                if let range = base.range(of: ".lora_B.weight") { base = String(base[..<range.lowerBound]) }
                if base != key { modules.insert(base) }
            }
            let firstA = tensors.keys.first { $0.contains("lora_A") && !$0.hasSuffix(".scale") }
            let rank = firstA.flatMap { tensors[$0]?.shape.first } ?? 0
            print("  target modules: \(modules.count) (rank=\(rank))")
            let expectedApplied = Int(Double(modules.count) * 0.75)
            print("  expected applied: ~\(expectedApplied) (adaLN.0/to_out.0 skipped as in Python)")
        }
    }
}
