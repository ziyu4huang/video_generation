//
//  SchemaCommand.swift
//  ZImageDirectorCLI
//
//  `zimage schema-defaults` — emit the effective defaults (resolution tiers,
//  transformer list, per-transformer recommended params) as JSON. Mirrors
//  `run.py schema-defaults`: safe to call at GUI startup — no model loading.
//

import ArgumentParser
import Foundation
import ZImageDirector

extension ZImageCLI {
    struct SchemaDefaults: ParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "schema-defaults",
            abstract: "Print effective defaults + transformer registry as JSON (for GUI sync)."
        )

        @OptionGroup var globals: GlobalOptions

        func run() throws {
            globals.apply()
            print(build())
        }

        /// Build the JSON payload (kept as a string so the command stays
        /// model-load-free; this is a discovery/metadata command only).
        private func build() -> String {
            // Transformer dropdown entries: T2I-applicable transformers tagged
            // with their pipeline (frontend filters by selected pipeline).
            let t2iArchToPipeline = ["zimage-turbo": "zimage", "flux2-klein-9b": "flux2-klein"]
            var transformers: [[String: String]] = []
            for manifest in ModelRegistry.list("transformer") {
                guard let pipeline = t2iArchToPipeline[manifest.arch] else { continue }
                transformers.append([
                    "value": manifest.name,
                    "label": manifest.name,
                    "arch": manifest.arch,
                    "pipeline": pipeline,
                ])
            }

            // Per-transformer recommended params (manifest-first + built-in).
            var defaults: [String: [String: Any]] = [:]
            for (name, resolved) in TransformerDefaultsRegistry.snapshot() {
                defaults[name] = resolved.asDict()
            }

            // Resolution tiers per pipeline (model/benchmark/large).
            let pipelineKeys: [Resolution.Pipeline] = [.zimage, .flux2Klein, .lens, .auto]
            var tiers: [String: [String: [Int]]] = [:]
            for (tierName, perPipeline) in Resolution.tiers {
                var entry: [String: [Int]] = [:]
                for key in pipelineKeys {
                    if let size = perPipeline[key] {
                        entry[key.rawValue] = [size.w, size.h]
                    }
                }
                tiers[tierName] = entry
            }

            let payload: [String: Any] = [
                "t2i": [
                    "pipeline": "zimage",
                    "default_transformer": "moody-pro-mix",
                    "default_width": 640,
                    "default_height": 960,
                    "default_steps": 9,
                    "default_cfg_scale": 4.0,
                    "default_seed": 99,
                    "default_lora_scale": 1.0,
                    "resolution_tiers": tiers,
                    "transformers": transformers,
                    "transformer_defaults": defaults,
                ] as [String: Any],
                "models_root": ModelPaths.modelsRoot.path,
            ]

            let data = (try? JSONSerialization.data(
                withJSONObject: payload, options: [.prettyPrinted, .sortedKeys]
            )) ?? Data()
            return String(data: data, encoding: .utf8) ?? "{}"
        }
    }
}
