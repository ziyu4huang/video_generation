//
//  Krea2ImageDirectorCLI.swift
//  Krea2ImageDirectorCLI
//
//  Entry point. Subcommands mirror run.py's krea2 surface (t2i now; i2i next).
//

import ArgumentParser
import Krea2ImageDirector

@main
struct Krea2ImageDirectorCLI: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "krea2",
        abstract: "Krea 2 Turbo image generation (pure-Swift port in progress; Phase 0 bridge).",
        subcommands: [T2ICommand.self, I2ICommand.self, ControlNetCommand.self,
                      StyleTransferCommand.self, ControlStyleCommand.self]
    )
}
