//
//  main.swift
//  ZImageDirectorCLI
//
//  `zimage` — pure-Swift MLX port of `run.py image t2i`.
//  Subcommands live in their own files (T2ICommand, VerifyCommands,
//  LoraCommand, CaptionCommand, ModelsCommand).
//
//  Global `--models-root` flag: see GlobalOptions.swift (composed into each
//  subcommand via @OptionGroup, since ArgumentParser does not propagate a
//  parent's options through subcommand dispatch). The env var `MLX_MODELS_DIR`
//  works everywhere with no flag.
//

import ArgumentParser

@main
struct ZImageCLI: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "zimage",
        abstract: "Z-Image text-to-image generation (pure Swift MLX).",
        version: "0.1.0",
        subcommands: [
            T2I.self, I2I.self, InpaintCN.self, Verify.self, VerifyVAE.self, VerifyT2I.self,
            VerifyVAEEncoder.self, VerifyTokenizer.self, VerifyControlNet.self,
            Lora.self, Caption.self, Models.self, SchemaDefaults.self, Upscale.self, Gate.self,
        ]
    )
}
