//
//  Paths.swift
//  Krea2ImageDirector
//
//  Repo-root discovery so the CLI works from any cwd. Walks up from this
//  source file's path (stable at build time) to find CLAUDE.md — mirrors
//  run.py's __file__-relative path resolution.
//

import Foundation

public enum RepoPaths {
    /// Repo root (contains CLAUDE.md), walking up from this file.
    public static let root: URL = {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            if FileManager.default.fileExists(atPath: dir.appendingPathComponent("CLAUDE.md").path) {
                return dir
            }
            dir = dir.deletingLastPathComponent()
        }
        return URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
    }()

    /// The relocated mlx venv (worktree-symlink memory): ../video_generation__venv.
    public static var venvPython: URL {
        root.deletingLastPathComponent().appendingPathComponent("video_generation__venv/bin/python")
    }

    public static var runPy: URL {
        root.appendingPathComponent("python/mlx-movie-director/run.py")
    }

    public static var mlxModelsRoot: URL {
        root.appendingPathComponent("mlx-models")
    }

    /// Krea 2 weights live in the external content-addressed store staging dir
    /// until promoted into mlx-models/ (manifest + symlinks). Phase 0 bridge
    /// resolves them via the python config; the native port reads them here.
    public static var krea2Staging: URL {
        root.deletingLastPathComponent().appendingPathComponent("video_generation__models/_staging_krea2")
    }

    /// run.py's DEFAULT_OUTPUT_DIR (sibling to repo), overridable via MLX_OUTPUT_DIR.
    public static var defaultOutputDir: URL {
        if let env = ProcessInfo.processInfo.environment["MLX_OUTPUT_DIR"], !env.isEmpty {
            return URL(fileURLWithPath: env)
        }
        return root.deletingLastPathComponent().appendingPathComponent("video_generation__output")
    }
}
