//
//  LoraCommand.swift
//  ZImageDirectorCLI
//
//  `zimage lora` — LoRA discovery (list / info).
//

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
    /// `zimage lora list` — enumerate all LoRAs in models/lora/.
    struct List: ParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "list", abstract: "List all available LoRA adapters."
        )
        func run() throws {
            let loraDir = ModelPaths.repoRoot
                .appendingPathComponent("python/mlx-movie-director/models/lora")
            let contents = (try? FileManager.default.contentsOfDirectory(atPath: loraDir.path)) ?? []
            let dirs = contents.filter { name in
                var isDir: ObjCBool = false
                let path = loraDir.appendingPathComponent(name).path
                return FileManager.default.fileExists(atPath: path, isDirectory: &isDir) && isDir.boolValue
            }.sorted()

            print("Available LoRA adapters (\(dirs.count) found):")
            print("")
            for name in dirs {
                let manifestURL = loraDir.appendingPathComponent(name).appendingPathComponent("manifest.json")
                var desc = ""
                var arch = ""
                var fmt = ""
                if let data = try? Data(contentsOf: manifestURL),
                   let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                    desc = (json["description"] as? String) ?? ""
                    arch = (json["arch"] as? String) ?? "?"
                    fmt = (json["format"] as? String) ?? "?"
                }
                let descSuffix = desc.isEmpty ? "" : " — \(desc.prefix(60))"
                print("  \(name)  [\(arch)/\(fmt)]\(descSuffix)")
            }
            print("")
            print("Use: zimage t2i --lora <name> --lora-scale 1.0")
        }
    }

    /// `zimage lora info NAME` — inspect a specific LoRA.
    struct Info: ParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "info", abstract: "Show details + target layers for a LoRA."
        )
        @Argument(help: "LoRA name (under models/lora/).")
        var name: String

        func run() throws {
            let loraDir = ModelPaths.repoRoot
                .appendingPathComponent("python/mlx-movie-director/models/lora/\(name)")
            guard FileManager.default.fileExists(atPath: loraDir.path) else {
                throw ValidationError("LoRA not found: \(name) (try 'zimage lora list')")
            }
            let manifestURL = loraDir.appendingPathComponent("manifest.json")
            if let data = try? Data(contentsOf: manifestURL),
               let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                print("LoRA: \(name)")
                print("  description : \(json["description"] as? String ?? "-")")
                print("  arch        : \(json["arch"] as? String ?? "-")")
                print("  format      : \(json["format"] as? String ?? "-")")
                let compat = (json["compatible_with"] as? [String])?.joined(separator: ", ") ?? "-"
                print("  compatible  : \(compat)")
                print("  source      : \(json["source_url"] as? String ?? "-")")
                if let size = json["size_bytes"] as? Int {
                    print("  size        : \(String(format: "%.1f", Double(size) / 1e6)) MB")
                }
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
