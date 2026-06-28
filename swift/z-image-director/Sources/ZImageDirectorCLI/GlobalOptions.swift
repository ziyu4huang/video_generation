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
