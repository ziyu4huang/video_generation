//
//  MusicGenCLI.swift
//  MusicGenDirectorCLI
//
//  `musicgen` — pure-Swift MLX port of Meta's MusicGen (facebook/musicgen-small).
//  Subcommands land incrementally as each port task completes:
//    verify-t5            — Task 3 (T5 text encoder numeric parity)
//    verify-encodec        — Task 5 (EnCodec decoder numeric parity)
//    verify-decoder-step   — Task 7 (LM decoder single-step logits parity)
//    generate              — Task 8 (full text-to-music generation)
//

import ArgumentParser

@main
struct MusicGenCLI: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "musicgen",
        abstract: "Text-to-music via MusicGen-small (pure Swift MLX).",
        version: "0.1.0",
        subcommands: [VerifyT5.self, VerifyEncodec.self, VerifyDecoderStep.self, Generate.self]
    )
}
