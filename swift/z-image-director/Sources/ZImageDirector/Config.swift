//
//  Config.swift
//  ZImageDirector
//
//  Central configuration for the Z-Image T2I pipeline port.
//

import Foundation
import Synchronization

/// Resolves paths to the repo's converted MLX model artifacts.
///
/// The Swift port reuses the same 8-bit MLX weights already produced by
/// `python/mlx-movie-director` — no re-conversion. Paths are resolved relative
/// to the repo root (detected via the `REPO_ROOT` env var, or by walking up
/// from the executable / cwd looking for `python/mlx-movie-director`).
///
/// The **models root** is overridable via the `MLX_MODELS_DIR` env var (or the
/// `--models-root` CLI flag, which sets the same resolved URL at runtime) so
/// the binary is repo-agnostic: point it at any directory laid out as
/// `{models_root}/{type}/{name}/[manifest.json, model.safetensors]` and the
/// `ModelRegistry` will discover every transformer / lora / vae / encoder in it.
public enum ModelPaths {
    /// Repo root containing `python/mlx-movie-director/` and `swift/`.
    public static let repoRoot: URL = {
        if let env = ProcessInfo.processInfo.environment["REPO_ROOT"] {
            return URL(fileURLWithPath: env)
        }
        return Self.locateRepoRoot()
    }()

    /// The default models root when no override is supplied:
    /// `python/mlx-movie-director/models`.
    private static let defaultModelsRoot: URL = repoRoot
        .appendingPathComponent("python/mlx-movie-director/models")

    /// The effective models root, honoring (in order): an explicit runtime
    /// override via `setModelsRoot(_:)` (used by the `--models-root` CLI flag),
    /// the `MLX_MODELS_DIR` env var, or the repo's default models tree.
    /// Runtime override for the models root (set by the `--models-root` CLI
    /// flag). Guarded by a `Mutex` so the override is concurrency-safe under
    /// Swift 6 strict-concurrency (CLI sets it once at startup; reads happen
    /// later from whatever thread resolves a path).
    private static let overrideMutex = Mutex<URL?>(nil)

    /// Current effective models root.
    public static var modelsRoot: URL {
        if let override = overrideMutex.withLock({ $0 }) { return override }
        if let env = ProcessInfo.processInfo.environment["MLX_MODELS_DIR"],
           !env.isEmpty {
            return URL(fileURLWithPath: env)
        }
        return defaultModelsRoot
    }

    /// Override the models root at runtime (e.g. from the `--models-root`
    /// CLI flag). Subsequent `transformer(_:)` / `lora(_:)` / registry lookups
    /// resolve against this URL.
    public static func setModelsRoot(_ url: URL) {
        overrideMutex.withLock { $0 = url }
    }

    // MARK: - Typed subdir accessors

    /// `{modelsRoot}/transformer/`
    public static var transformerRoot: URL {
        modelsRoot.appendingPathComponent("transformer")
    }

    /// `{modelsRoot}/lora/`
    public static var loraRoot: URL {
        modelsRoot.appendingPathComponent("lora")
    }

    /// `{modelsRoot}/vae/`
    public static var vaeRoot: URL {
        modelsRoot.appendingPathComponent("vae")
    }

    /// `{modelsRoot}/text_encoder/`
    public static var textEncoderRoot: URL {
        modelsRoot.appendingPathComponent("text_encoder")
    }

    /// `{modelsRoot}/tokenizer/`
    public static var tokenizerRoot: URL {
        modelsRoot.appendingPathComponent("tokenizer")
    }

    /// Resolve a named transformer variant (e.g. `moody-pro-mix`) to its
    /// directory. If the name is an existing path on disk, that path wins
    /// (so `--transformer /custom/path/to/dir` keeps working).
    public static func transformer(_ variant: String) -> URL {
        if FileManager.default.fileExists(atPath: variant) {
            return URL(fileURLWithPath: variant)
        }
        return transformerRoot.appendingPathComponent(variant)
    }

    /// Resolve a named LoRA to its directory (path-on-disk wins, same as
    /// `transformer(_:)`).
    public static func lora(_ name: String) -> URL {
        if FileManager.default.fileExists(atPath: name) {
            return URL(fileURLWithPath: name)
        }
        return loraRoot.appendingPathComponent(name)
    }

    /// Resolve a named VAE to its directory (path-on-disk wins).
    public static func vae(_ name: String) -> URL {
        if FileManager.default.fileExists(atPath: name) {
            return URL(fileURLWithPath: name)
        }
        return vaeRoot.appendingPathComponent(name)
    }

    /// Resolve a named text encoder to its directory (path-on-disk wins).
    public static func textEncoder(_ name: String) -> URL {
        if FileManager.default.fileExists(atPath: name) {
            return URL(fileURLWithPath: name)
        }
        return textEncoderRoot.appendingPathComponent(name)
    }

    /// Resolve a named tokenizer to its directory (path-on-disk wins).
    public static func tokenizer(_ name: String) -> URL {
        if FileManager.default.fileExists(atPath: name) {
            return URL(fileURLWithPath: name)
        }
        return tokenizerRoot.appendingPathComponent(name)
    }

    /// Walk up from cwd looking for the `python/mlx-movie-director` marker.
    private static func locateRepoRoot() -> URL {
        var url = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
        for _ in 0..<10 {
            let marker = url.appendingPathComponent("python/mlx-movie-director")
            if FileManager.default.fileExists(atPath: marker.path) {
                return url
            }
            url = url.deletingLastPathComponent()
        }
        // Fallback: assume cwd.
        return URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
    }
}
