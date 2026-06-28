//
//  ModelsCommand.swift
//  Flux2DirectorCLI
//
//  `flux2 models list` — show installed Flux2 Klein transformer variants.
//

import Flux2Director
import ArgumentParser

extension Flux2CLI {
    struct Models: ParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "models",
            abstract: "List installed Flux2 Klein model variants.",
            subcommands: [List.self]
        )

        static func run() throws {
            // delegated to subcommands
            try Self.parseAsRoot([])
        }

        struct List: ParsableCommand {
            static let configuration = CommandConfiguration(commandName: "list")

            @OptionGroup var globals: GlobalOptions

            func run() throws {
                globals.apply()
                let variants = Flux2ModelRegistry.listTransformers()
                if variants.isEmpty {
                    print("(no Flux2 Klein transformer variants found under models/transformer/)")
                } else {
                    print("Flux2 Klein transformer variants:")
                    for v in variants { print("  • \(v)") }
                }
                print("\nDefault components:")
                print("  transformer : \(Flux2ModelRegistry.defaultTransformer)")
                print("  vae         : \(Flux2ModelRegistry.defaultVAE)")
                print("  text_encoder: \(Flux2ModelRegistry.defaultTextEncoder)")
                print("  tokenizer   : \(Flux2ModelRegistry.defaultTokenizer)")
            }
        }
    }
}
