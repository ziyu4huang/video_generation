//
//  main.swift
//  ZImageDirectorCLI
//
//  `zimage` — pure-Swift MLX port of `run.py image t2i`.
//  Subcommands live in their own files (T2ICommand, VerifyCommands,
//  LoraCommand, CaptionCommand).
//

import ArgumentParser

@main
struct ZImageCLI: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "zimage",
        abstract: "Z-Image text-to-image generation (pure Swift MLX).",
        version: "0.1.0",
        subcommands: [
            T2I.self, Verify.self, VerifyVAE.self, VerifyT2I.self,
            VerifyEncoder.self, VerifyTokenizer.self, Lora.self, Caption.self,
        ]
    )
}
