//
//  GlobalOptions.swift
//  Flux2DirectorCLI
//
//  Shared CLI options composed into subcommands via @OptionGroup — mirrors
//  z-image-director's pattern. swift-argument-parser doesn't propagate a
//  parent's flags through subcommand dispatch, so each subcommand declares
//  @OptionGroup var globals and calls globals.apply().
//

import CommonImageDirector
import ArgumentParser
import Foundation

struct GlobalOptions: ParsableArguments {
    @Option(
        name: .customLong("models-root"),
        help: ArgumentHelp(
            "Root of the models tree ({type}/{name}/[manifest.json, model.safetensors]).",
            discussion: "Default: $MLX_MODELS_DIR or the repo's python/mlx-movie-director/models."
        )
    )
    var modelsRoot: String?

    func apply() {
        if let modelsRoot {
            ModelPaths.setModelsRoot(URL(fileURLWithPath: modelsRoot))
        }
    }
}

/// Output-metadata sidecar controls (same semantics as z-image-director):
/// by default write BOTH .run.json + .manifest.json; --no-* opts out.
struct OutputOptions: ParsableArguments {
    @Flag(name: .customLong("no-manifest"),
          help: "Do not write the .manifest.json sidecar.")
    var noManifest = false

    @Flag(name: .customLong("no-run-json"),
          help: "Do not write the .run.json sidecar.")
    var noRunJSON = false

    var writeRunJSON: Bool { !noRunJSON }
    var writeManifest: Bool { !noManifest }
}
