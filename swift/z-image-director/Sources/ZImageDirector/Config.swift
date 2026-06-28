//
//  Config.swift
//  ZImageDirector
//
//  Central configuration for the Z-Image T2I pipeline port.
//

import Foundation

/// Resolves paths to the repo's converted MLX model artifacts.
///
/// The Swift port reuses the same 8-bit MLX weights already produced by
/// `python/mlx-movie-director` — no re-conversion. Paths are resolved relative
/// to the repo root (detected via the `REPO_ROOT` env var, or by walking up
/// from the executable / cwd looking for `python/mlx-movie-director`).
public enum ModelPaths {
    /// Repo root containing `python/mlx-movie-director/` and `swift/`.
    public static let repoRoot: URL = {
        if let env = ProcessInfo.processInfo.environment["REPO_ROOT"] {
            return URL(fileURLWithPath: env)
        }
        return Self.locateRepoRoot()
    }()

    /// `python/mlx-movie-director/models/transformer/`
    public static var transformerRoot: URL {
        repoRoot
            .appendingPathComponent("python/mlx-movie-director/models/transformer")
    }

    /// Resolve a named transformer variant (e.g. `moody-pro-mix`) to its directory.
    public static func transformer(_ variant: String) -> URL {
        transformerRoot.appendingPathComponent(variant)
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
