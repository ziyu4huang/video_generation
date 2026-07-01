//
//  Paths.swift
//  LTXVideoDirector
//
//  Repo-root discovery so the CLI can be invoked from any cwd. Walks up from
//  this source file's on-disk location (stable at build time) looking for
//  the repo's CLAUDE.md marker, mirroring how run.py resolves paths from
//  __file__ rather than cwd.
//

import Foundation

public enum RepoPaths {
    /// Repo root — the directory containing CLAUDE.md, walking up from this
    /// file's path. Falls back to cwd if the marker can't be found (e.g. the
    /// package is vendored elsewhere).
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

    public static var venvPython: URL {
        root.appendingPathComponent("python/venv/bin/python")
    }

    public static var runPy: URL {
        root.appendingPathComponent("python/mlx-movie-director/run.py")
    }

    public static var mlxModelsRoot: URL {
        root.appendingPathComponent("mlx-models")
    }

    public static var ltxModelsRoot: URL {
        mlxModelsRoot.appendingPathComponent("ltx-mlx")
    }

    public static var defaultOutputDir: URL {
        root.appendingPathComponent("python/mlx-movie-director/output")
    }
}
