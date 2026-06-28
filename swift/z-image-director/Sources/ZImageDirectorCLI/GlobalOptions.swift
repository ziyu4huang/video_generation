//
//  GlobalOptions.swift
//  ZImageDirectorCLI
//
//  Shared CLI options composed into subcommands via `@OptionGroup`.
//
//  swift-argument-parser does not propagate a parent command's options into
//  subcommand dispatch (the parent's `run()` is never called when a subcommand
//  runs). The idiomatic fix is an `OptionGroup`: each subcommand that resolves
//  model paths declares `@OptionGroup var globals: GlobalOptions` and calls
//  `globals.apply()` at the top of its `run()`. This makes
//  `zimage models list --models-root /path` (flag AFTER the subcommand) work.
//
//  The env var `MLX_MODELS_DIR` remains the primary mechanism — it needs no
//  flag at all and works everywhere.
//

import ArgumentParser
import Foundation
import ZImageDirector

struct GlobalOptions: ParsableArguments {
    @Option(
        name: .customLong("models-root"),
        help: ArgumentHelp(
            "Root of the models tree ({type}/{name}/[manifest.json, model.safetensors]).",
            discussion: "Default: $MLX_MODELS_DIR or the repo's python/mlx-movie-director/models."
        )
    )
    var modelsRoot: String?

    /// Apply the override (if set) to `ModelPaths` so path resolution + the
    /// registry see the requested root. Call this at the top of `run()`.
    func apply() {
        if let modelsRoot {
            ModelPaths.setModelsRoot(URL(fileURLWithPath: modelsRoot))
        }
    }
}

/// Output-metadata sidecar controls. By default every generation command
/// writes BOTH `.run.json` (reproducible params) and `.manifest.json`
/// (timing/files/status) alongside the PNG — matching run.py, essential for
/// debugging and replay. These flags let you opt OUT when you only want the
/// image (e.g. batch/scripted runs).
struct OutputOptions: ParsableArguments {
    @Flag(
        name: .customLong("no-manifest"),
        help: "Do not write the .manifest.json sidecar (timing/files/status)."
    )
    var noManifest = false

    @Flag(
        name: .customLong("no-run-json"),
        help: "Do not write the .run.json sidecar (reproducible params)."
    )
    var noRunJSON = false

    @Flag(
        name: .customLong("compile"),
        help: ArgumentHelp(
            "Enable MLX graph compilation for the denoise loop (experimental).",
            discussion: "OFF by default. Measured REGRESSION: compile makes denoise ~21% slower " +
                "(26s vs 21s) AND triples peak memory (5.8GB→17.5GB) because MLX-Swift " +
                "retains the compiled graph cache. Swift without compile is already at " +
                "speed parity with Python. Use only to experiment with graph reuse."
        )
    )
    var compile = false

    /// True unless explicitly opted out — shorthand for "write the run config?".
    var writeRunJSON: Bool { !noRunJSON }
    var writeManifest: Bool { !noManifest }
    /// Compile the denoise graph? Opt-in (default off — it's a measured regression).
    var useCompile: Bool { compile }
}
