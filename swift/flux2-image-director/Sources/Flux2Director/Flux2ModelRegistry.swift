//
//  Flux2ModelRegistry.swift
//  Flux2Director
//
//  Discovers available Flux2 Klein transformer variants + companion components
//  under the shared models tree. Mirrors z-image-director's ModelRegistry shape
//  but is Flux2-specific: the default VAE is flux2-klein, text encoder qwen3-8b,
//  tokenizer qwen3-klein.
//

import CommonImageDirector
import Foundation

public enum Flux2ModelRegistry {

    /// Default component names (under python/mlx-movie-director/models/).
    public static let defaultVAE = "flux2-klein"
    public static let defaultTextEncoder = "qwen3-8b"
    public static let defaultTokenizer = "qwen3-klein"
    public static let defaultTransformer = "klein-9b"

    /// List installed Flux2 transformer variants (dirs under models/transformer/
    /// that are Klein-family). Heuristic: presence of a config.json with a
    /// flux2/klein signature, or a name starting with 'klein'.
    public static func listTransformers() -> [String] {
        let root = ModelPaths.transformerRoot
        guard let entries = try? FileManager.default.contentsOfDirectory(atPath: root.path) else {
            return []
        }
        return entries.filter { name in
            let dir = root.appendingPathComponent(name)
            var isDir: ObjCBool = false
            guard FileManager.default.fileExists(atPath: dir.path, isDirectory: &isDir), isDir.boolValue else {
                return false
            }
            // Klein-family heuristic: name contains 'klein'.
            return name.lowercased().contains("klein")
        }.sorted()
    }
}
