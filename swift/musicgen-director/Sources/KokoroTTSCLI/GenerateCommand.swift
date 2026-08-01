//
//  GenerateCommand.swift
//  KokoroTTSCLI
//
//  `kokoro-tts generate` — stub scaffold; real implementation lands in the
//  next task (TTS.loadModel -> generate -> WAV write).
//

import ArgumentParser

extension KokoroTTSCLI {
    struct Generate: AsyncParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "generate",
            abstract: "Synthesize speech from text via local Kokoro-82M."
        )

        func run() async throws {
            print("kokoro-tts generate: not yet implemented")
        }
    }
}
