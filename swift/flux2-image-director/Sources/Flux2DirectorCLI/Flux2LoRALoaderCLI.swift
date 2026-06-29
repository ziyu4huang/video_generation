//
//  Flux2LoRALoaderCLI.swift
//  Flux2DirectorCLI
//
//  Shared multi-LoRA loading for the CLI commands (style / scene / ...).
//  Resolves each `--lora <name>` to its safetensors file, loads it at the
//  matching `--lora-scale`, and rank-stacks them into one merged adapter via
//  `Flux2LoRALoader.merge`. Returns the merged adapter plus the resolved names
//  and scales (for manifest logging / RunConfig).
//
//  A single LoRA: load + merge-of-one (numerically identical to a direct load,
//  scale folded into sqrt·A, sqrt·B). Zero LoRAs: returns `.none()`.
//

import ArgumentParser
import Flux2Director
import Foundation

enum Flux2LoRALoaderCLI {
    /// Load and merge N LoRAs by name. `scales` is one per `names` (trailing
    /// missing entries default to 1.0; extra entries are ignored). Validates
    /// that the count of non-default scales does not exceed `names.count`.
    static func loadMerged(names: [String], scales: [Float], logPrefix: String = "")
        throws -> (Flux2LoRAAdapters, [String], [Float])
    {
        guard !names.isEmpty else {
            return (Flux2LoRAAdapters.none(), [], [])
        }
        guard scales.count <= names.count else {
            throw ValidationError("--lora-scale count (\(scales.count)) exceeds --lora count (\(names.count))")
        }
        var loaded: [Flux2LoRAAdapters] = []
        var resolvedScales: [Float] = []
        for (i, name) in names.enumerated() {
            let s = i < scales.count ? scales[i] : 1.0
            let url = try Flux2LoRALoader.resolveFile(name: name)
            let ad = try Flux2LoRALoader.load(url: url, scale: s)
            // Surface silent no-ops: 0 adapters means the safetensors keys did
            // not match the BFL format the loader expects (e.g. a WebUI-format
            // LoRA that needs remapping via convert_lora_mlx.py).
            if ad.adapters.isEmpty {
                FileHandle.standardError.write(
                    Data("⚠️  \(name): loaded 0 adapters — key format mismatch (WebUI vs BFL)?\n".utf8))
            }
            loaded.append(ad)
            resolvedScales.append(s)
            print("\(logPrefix)\(name)  (scale=\(s), adapters=\(ad.adapters.count))")
        }
        let merged = Flux2LoRALoader.merge(loaded)
        print("\(logPrefix)merged: \(merged.adapters.count) adapters across \(loaded.count) LoRA(s)")
        return (merged, names, resolvedScales)
    }
}
