//
//  KokoroTTSCLI.swift
//  KokoroTTSCLI
//
//  `kokoro-tts` — local text-to-speech via Kokoro-82M, wiring
//  mlx-audio-swift's existing MLXAudioTTS/Kokoro implementation (this repo
//  writes no new model code — see docs/superpowers/specs/2026-08-01-kokoro-
//  tts-swift-native-port-design.md).
//

import ArgumentParser

@main
struct KokoroTTSCLI: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "kokoro-tts",
        abstract: "Local text-to-speech via Kokoro-82M (pure Swift MLX, via mlx-audio-swift).",
        version: "0.1.0",
        subcommands: [Generate.self]
    )
}
