//
//  ModelRegistry.swift
//  ZImageDirector
//
//  Discovers and enumerates model instances from manifest.json files.
//  Swift port of python/mlx-movie-director/app/model_registry.py.
//
//  Directory convention:
//    {models_root}/{type}/{name}/manifest.json
//
//  Each manifest.json describes one model instance. The registry scans
//  subdirectories under each type and reads their manifests, allowing multiple
//  instances per type (e.g. transformer/moody-pro-mix/ and
//  transformer/dark-beast-dbzit9/). A manifest is a loose-typed JSON document;
//  well-known fields are surfaced via typed accessors but unknown keys survive
//  so newly-added metadata does not require a registry rebuild.
//

import Foundation

/// One model instance's manifest, decoded loosely so unknown keys survive.
/// Fields mirror the python `models/{type}/{name}/manifest.json` schema.
///
/// `@unchecked Sendable`: the `raw` dictionary is built once from JSON at
/// init and never mutated; treating it as read-only across threads is safe.
public struct ModelManifest: @unchecked Sendable {
    public let name: String
    public let type: String          // "transformer" | "lora" | "vae" | ...
    public let arch: String          // "zimage-turbo" | "flux2-klein-9b" | ...
    public let format: String        // "mlx-8bit" | "mlx-4bit-gs32" | "mlx-int8" | ...
    public let description: String
    public let source: String
    public let directory: URL        // resolved on-disk dir
    public let raw: [String: Any]    // full JSON for forward-compat access

    /// The weight file to load (default "model.safetensors" when omitted).
    public var weightFile: String {
        (raw["weight_file"] as? String) ?? "model.safetensors"
    }

    /// Full path to the weight file.
    public var weightURL: URL {
        directory.appendingPathComponent(weightFile)
    }

    /// True if the weight file (symlink target included) is present on disk.
    public var isPresent: Bool {
        FileManager.default.fileExists(atPath: weightURL.path)
    }

    /// Size in bytes, if declared.
    public var sizeBytes: Int64? {
        (raw["size_bytes"] as? Int64)
            ?? (raw["size_bytes"] as? Int).map(Int64.init)
    }

    /// Pipelines this model belongs to (e.g. ["zimage-turbo"]).
    public var pipelines: [String] {
        if let arr = raw["pipeline"] as? [String] { return arr }
        if let single = raw["pipeline"] as? String { return [single] }
        return []
    }

    /// Models this one is compatible with (e.g.
    /// ["text_encoder/qwen3-4b", "tokenizer/qwen3", "vae/zimage-ae"]).
    public var compatibleWith: [String] {
        (raw["compatible_with"] as? [String]) ?? []
    }

    /// Trigger words for LoRAs (empty for non-LoRA models).
    public var triggerWords: [String] {
        (raw["trigger_words"] as? [String]) ?? []
    }

    // MARK: - Recommended params (per-checkpoint defaults, axis 4)

    /// Recommended LoRA scale (LoRAs only).
    public var recommendedScale: Float? {
        (raw["recommended_scale"] as? Double).map(Float.init)
            ?? (raw["recommended_scale"] as? Int).map { Float($0) }
    }

    /// Recommended denoising steps (transformers).
    public var recommendedSteps: Int? {
        (raw["recommended_steps"] as? Int)
            ?? (raw["recommended_steps"] as? Double).map(Int.init)
    }

    /// Recommended CFG scale (transformers).
    public var recommendedCfg: Float? {
        (raw["recommended_cfg"] as? Double).map(Float.init)
            ?? (raw["recommended_cfg"] as? Int).map { Float($0) }
    }

    /// Recommended resolution description (free-form string, e.g.
    /// "1M-2M px (ZIT-distilled family typical)").
    public var recommendedResolution: String? {
        raw["recommended_resolution"] as? String
    }
}

/// Scans `models/{type}/{name}/manifest.json` files under a root directory.
///
/// The root is resolved by `ModelPaths` (env var `MLX_MODELS_DIR` overrides,
/// otherwise the repo's `python/mlx-movie-director/models` tree).
public enum ModelRegistry {

    /// The models root this registry scans.
    public static var modelsRoot: URL { ModelPaths.modelsRoot }

    /// All known top-level model types (subdirectory names that contain at
    /// least one manifest.json).
    public static func listTypes() -> [String] {
        guard let entries = try? FileManager.default.contentsOfDirectory(
            atPath: modelsRoot.path
        ) else { return [] }
        return entries.filter { name in
            let dir = modelsRoot.appendingPathComponent(name)
            var isDir: ObjCBool = false
            guard FileManager.default.fileExists(atPath: dir.path, isDirectory: &isDir),
                  isDir.boolValue else { return false }
            // A type dir is "real" if it contains >=1 manifest.json (at any depth 1).
            if let kids = try? FileManager.default.contentsOfDirectory(atPath: dir.path) {
                return kids.contains { kid in
                    let manifest = dir.appendingPathComponent(kid)
                        .appendingPathComponent("manifest.json")
                    return FileManager.default.fileExists(atPath: manifest.path)
                }
            }
            return false
        }.sorted()
    }

    /// Return all manifests for a given type, sorted by name. Skips dirs whose
    /// manifest.json is missing or unparseable (matches python's tolerant scan).
    public static func list(_ type: String) -> [ModelManifest] {
        let typeDir = modelsRoot.appendingPathComponent(type)
        guard let entries = try? FileManager.default.contentsOfDirectory(
            atPath: typeDir.path
        ) else { return [] }
        return entries.sorted().compactMap { name -> ModelManifest? in
            manifest(forType: type, name: name)
        }
    }

    /// Load one manifest by type + name. Returns nil if missing/unparseable.
    public static func manifest(forType type: String, name: String) -> ModelManifest? {
        let dir = modelsRoot.appendingPathComponent(type).appendingPathComponent(name)
        let manifestURL = dir.appendingPathComponent("manifest.json")
        guard FileManager.default.fileExists(atPath: manifestURL.path),
              let data = try? Data(contentsOf: manifestURL),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return nil }
        return ModelManifest(
            name: (obj["name"] as? String) ?? name,
            type: (obj["type"] as? String) ?? type,
            arch: (obj["arch"] as? String) ?? "",
            format: (obj["format"] as? String) ?? "",
            description: (obj["description"] as? String) ?? "",
            source: (obj["source"] as? String) ?? "",
            directory: dir,
            raw: obj
        )
    }

    /// Find the first manifest of a type whose `name` matches.
    public static func find(_ type: String, name: String) -> ModelManifest? {
        list(type).first { $0.name == name }
    }

    /// Find manifests of a type whose `arch` matches (e.g. all "zimage-turbo"
    /// transformers, excluding seedvr2 / ltx / klein).
    public static func findByArch(_ type: String, arch: String) -> [ModelManifest] {
        list(type).filter { $0.arch == arch }
    }
}
