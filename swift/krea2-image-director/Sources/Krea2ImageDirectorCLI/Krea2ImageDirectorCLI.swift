//
//  Krea2ImageDirectorCLI.swift
//  Krea2ImageDirectorCLI
//
//  Entry point. Subcommands mirror run.py's krea2 surface (t2i now; i2i next).
//

import ArgumentParser
import Krea2ImageDirector

// Retroactive conformance so `--rf-mode flowturbo_pc|rf_gamma|rf_gamma_rk2|linear`
// parses into the library's RFMode. ArgumentParser's default String initializer is
// sufficient; the conformance lives in the CLI target (the library doesn't depend
// on ArgumentParser).
extension RFMode: ExpressibleByArgument {}

@main
struct Krea2ImageDirectorCLI: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "krea2",
        abstract: "Krea 2 Turbo image generation (pure-Swift port in progress; Phase 0 bridge).",
        subcommands: [T2ICommand.self, I2ICommand.self, ControlNetCommand.self,
                      StyleTransferCommand.self, ControlStyleCommand.self]
    )
}
