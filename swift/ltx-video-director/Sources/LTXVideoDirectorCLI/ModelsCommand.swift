//
//  ModelsCommand.swift
//  LTXVideoDirectorCLI
//
//  `ltx-video models` — list installed LTX-2.3 transformer variants.
//

import ArgumentParser
import LTXVideoDirector

extension LTXVideoDirectorCLI {
    struct Models: ParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "models",
            abstract: "List installed LTX-2.3 transformer variants."
        )

        func run() throws {
            let installed = LTXModelRegistry.installedVariants()
            if installed.isEmpty {
                print("(no LTX-2.3 variants found under mlx-models/ltx-mlx/)")
                return
            }
            print("LTX-2.3 transformer variants:")
            for v in installed {
                let files = LTXModelRegistry.checkpointFiles(v)
                let marker = v == .defaultForI2V ? " (default for i2v)" : ""
                print("  • \(v.rawValue)\(marker) — \(files.count) checkpoint file(s)")
            }
        }
    }
}
