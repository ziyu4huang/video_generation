//
//  OutputPaths.swift
//  ZImageDirector
//
//  Mirrors python/mlx-movie-director/app/commands/_shared.py OutputPaths.
//  Produces run.py-compatible output paths: output_YYYYMMDD_HHMMSS with
//  .png / .run.json / .manifest.json siblings.
//

import Foundation

/// The three sibling files run.py writes for every generation, plus the shared
/// base name. Mirrors python `_shared.OutputPaths` exactly so Swift output is
/// indistinguishable from run.py output to downstream consumers (Bun GUI etc.).
public struct OutputPaths: Sendable {
    public let baseName: String      // "output_20260628_143022"
    public let png: String           // "<dir>/output_XXXX.png"
    public let runJSON: String       // "<dir>/output_XXXX.run.json"
    public let manifestJSON: String  // "<dir>/output_XXXX.manifest.json"
    public let reviewJSON: String?   // "<dir>/output_XXXX.review.json" (when --review)

    public init(baseName: String, dir: String, suffix: String = "",
                ext: String = ".png", review: Bool = false) {
        self.baseName = baseName
        let suffixExt = "\(suffix)\(ext)"
        self.png = (dir as NSString).appendingPathComponent("\(baseName)\(suffixExt)")
        self.runJSON = (dir as NSString).appendingPathComponent("\(baseName).run.json")
        self.manifestJSON = (dir as NSString).appendingPathComponent("\(baseName).manifest.json")
        self.reviewJSON = review
            ? (dir as NSString).appendingPathComponent("\(baseName).review.json")
            : nil
    }
}

/// Resolves the output directory + filename, mirroring run.py's
/// `_resolve_output_dir` + `make_output_paths`.
public enum OutputPathResolver {
    /// Default output dir (repo-relative "../video_generation__output"),
    /// overridable via the MLX_OUTPUT_DIR env var — exactly like run.py.
    public static func resolveOutputDir(override: String? = nil) -> String {
        if let override, !override.isEmpty { return normalizeDir(override) }
        if let envDir = ProcessInfo.processInfo.environment["MLX_OUTPUT_DIR"], !envDir.isEmpty {
            return normalizeDir(envDir)
        }
        // Default: sibling of repo root → ../video_generation__output
        return normalizeDir(
            (ModelPaths.repoRoot.deletingLastPathComponent()
                .appendingPathComponent("video_generation__output")).path
        )
    }

    /// Generate the timestamped base name: "output_YYYYMMDD_HHMMSS".
    /// Mirrors python `generate_base_name()` = time.strftime('%Y%m%d_%H%M%S').
    public static func generateBaseName(custom: String? = nil) -> String {
        if let custom, !custom.isEmpty { return custom }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone.current
        formatter.dateFormat = "yyyyMMdd_HHmmss"
        return "output_\(formatter.string(from: Date()))"
    }

    /// Build the full OutputPaths. If `explicitOutput` is given (the --output
    /// flag), the PNG uses that exact path and the JSON siblings derive from it
    /// (drop .png → .run.json / .manifest.json). Otherwise use the run.py
    /// timestamp pattern in the resolved output dir.
    public static func makePaths(
        explicitOutput: String? = nil,
        outputDir: String? = nil,
        customName: String? = nil
    ) throws -> OutputPaths {
        if let explicitOutput, !explicitOutput.isEmpty {
            // User gave an explicit --output path. Derive siblings from it.
            let url = URL(fileURLWithPath: explicitOutput)
            let dir = url.deletingLastPathComponent().path
            let baseName = url.deletingPathExtension().lastPathComponent
            let ext = url.pathExtension.isEmpty ? ".png" : ".\(url.pathExtension)"
            return OutputPaths(baseName: baseName, dir: dir, ext: ext)
        }
        let resolvedDir = resolveOutputDir(override: outputDir)
        try FileManager.default.createDirectory(
            atPath: resolvedDir, withIntermediateDirectories: true)
        return OutputPaths(baseName: generateBaseName(custom: customName), dir: resolvedDir)
    }

    /// Repo-relative → absolute (mirrors python _resolve_output_dir).
    private static func normalizeDir(_ raw: String) -> String {
        let expanded = raw.hasPrefix("~")
            ? (raw as NSString).expandingTildeInPath : raw
        if (expanded as NSString).isAbsolutePath {
            return (expanded as NSString).standardizingPath
        }
        // Repo-relative: join to repo root, then normalize away any /../.
        let joined = ModelPaths.repoRoot.appendingPathComponent(expanded).path
        return (joined as NSString).standardizingPath
    }
}
