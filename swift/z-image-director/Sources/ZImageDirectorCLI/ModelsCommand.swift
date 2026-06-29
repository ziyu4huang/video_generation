//
//  ModelsCommand.swift
//  ZImageDirectorCLI
//
//  `zimage models` — discover and list model instances (transformers, LoRAs,
//  VAEs, encoders, tokenizers) from the models root's manifest.json files.
//  Mirrors the discovery half of python/mlx-movie-director/app/model_registry.py.
//

import CommonImageDirector
import ArgumentParser
import Foundation
import ZImageDirector

extension ZImageCLI {
    struct Models: ParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "models",
            abstract: "List models discoverable under the models root (reads manifest.json).",
            subcommands: [List.self, Path.self]
        )

        // `zimage models` with no subcommand => `models list`.
        func run() throws { try Self.List().run() }

        // MARK: - list

        struct List: ParsableCommand {
            static let configuration = CommandConfiguration(
                commandName: "list",
                abstract: "List model instances, optionally filtered by type."
            )

            @OptionGroup var globals: GlobalOptions

            @Option(help: "Filter by type: transformer|lora|vae|text_encoder|tokenizer|... Omit for all.")
            var type: String?

            @Flag(help: "Show only models compatible with the Z-Image pipeline (arch=zimage-turbo).")
            var zimage: Bool = false

            @Flag(help: "Machine-readable: tab-separated name\\ttype\\tarch\\tformat.")
            var plain: Bool = false

            func run() throws {
                globals.apply()
                let types: [String]
                if let type {
                    types = [type]
                } else {
                    types = ModelRegistry.listTypes()
                }
                guard !types.isEmpty else {
                    print("No models found under \(ModelPaths.modelsRoot.path)")
                    print("(override via --models-root or $MLX_MODELS_DIR)")
                    return
                }

                var anyEmitted = false
                for typeKey in types {
                    var manifests = ModelRegistry.list(typeKey)
                    if zimage {
                        manifests = manifests.filter { $0.arch == "zimage-turbo" }
                    }
                    if manifests.isEmpty { continue }
                    anyEmitted = true
                    if !plain { print("== \(typeKey) (\(manifests.count)) ==") }
                    for manifest in manifests {
                        if plain {
                            print("\(manifest.name)\\t\(manifest.type)\\t\(manifest.arch)\\t\(manifest.format)")
                        } else {
                            printRow(manifest)
                        }
                    }
                    if !plain { print("") }
                }
                if !anyEmitted {
                    print("No models matched the filter under \(ModelPaths.modelsRoot.path)")
                }
            }

            private func printRow(_ manifest: ModelManifest) {
                let present = manifest.isPresent ? "✓" : "✗"
                let size = manifest.sizeBytes.map { formatBytes($0) } ?? "-"
                print("  \(present) \(pad(manifest.name, width: 30)) " +
                      "[\(pad(manifest.arch, width: 16))] \(pad(manifest.format, width: 14)) " +
                      "\(size)")
                if !manifest.description.isEmpty {
                    print("      \(truncate(manifest.description, length: 96))")
                }
                if !manifest.pipelines.isEmpty {
                    print("      pipelines: \(manifest.pipelines.joined(separator: ", "))")
                }
                if !manifest.compatibleWith.isEmpty {
                    print("      works with: \(manifest.compatibleWith.joined(separator: ", "))")
                }
            }

            private func formatBytes(_ bytes: Int64) -> String {
                let formatter = ByteCountFormatter()
                formatter.allowedUnits = [.useMB, .useGB]
                formatter.countStyle = .file
                return formatter.string(fromByteCount: bytes)
            }

            private func truncate(_ text: String, length: Int) -> String {
                text.count <= length ? text : String(text.prefix(length - 1)) + "…"
            }

            private func pad(_ text: String, width: Int) -> String {
                text.count >= width ? text : text + String(repeating: " ", count: width - text.count)
            }
        }

        // MARK: - path

        struct Path: ParsableCommand {
            static let configuration = CommandConfiguration(
                commandName: "path",
                abstract: "Resolve and print the on-disk path / metadata for one model."
            )

            @OptionGroup var globals: GlobalOptions

            @Option(help: "Model type: transformer|lora|vae|text_encoder|tokenizer|...")
            var type: String

            @Option(help: "Model name (under {type}/).")
            var name: String

            @Flag(help: "Print only the directory path (for shell scripting).")
            var dir: Bool = false

            func run() throws {
                globals.apply()
                guard let manifest = ModelRegistry.manifest(forType: type, name: name) else {
                    throw ValidationError("No manifest found: \(type)/\(name) under \(ModelPaths.modelsRoot.path)")
                }
                if dir {
                    print(manifest.directory.path)
                    return
                }
                print("name     : \(manifest.name)")
                print("type     : \(manifest.type)")
                print("arch     : \(manifest.arch)")
                print("format   : \(manifest.format)")
                print("dir      : \(manifest.directory.path)")
                print("weights  : \(manifest.weightURL.path)  [\(manifest.isPresent ? "present" : "MISSING")]")
                if let size = manifest.sizeBytes {
                    print("size     : \(size) bytes")
                }
                print("source   : \(manifest.source.isEmpty ? "-" : manifest.source)")
                if !manifest.pipelines.isEmpty {
                    print("pipelines: \(manifest.pipelines.joined(separator: ", "))")
                }
                if !manifest.compatibleWith.isEmpty {
                    print("works with: \(manifest.compatibleWith.joined(separator: ", "))")
                }
                if !manifest.triggerWords.isEmpty {
                    print("triggers : \(manifest.triggerWords.joined(separator: ", "))")
                }
                for key in ["recommended_steps", "recommended_cfg", "recommended_scale", "recommended_resolution"] {
                    if let value = manifest.raw[key] {
                        print("\(key.padding(toLength: 18, withPad: " ", startingAt: 0)): \(value)")
                    }
                }
            }
        }
    }
}
