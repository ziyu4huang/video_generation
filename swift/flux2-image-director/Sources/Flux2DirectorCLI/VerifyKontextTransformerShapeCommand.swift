//
//  VerifyKontextTransformerShapeCommand.swift
//  Flux2DirectorCLI
//
//  `flux2 verify-kontext-transformer-shape` — kontext epic, phase 2
//  structural checkpoint (see output/next-goal-20260714_063909.md). No real
//  Kontext-dev checkpoint has been converted yet (that's a separate, still-open
//  action item — see the goal doc's phase 4 VAE-conversion note), so there is
//  nothing to numerically parity-test against. This instead builds the full
//  19+38-block `KontextTransformer` with random weights and runs one forward
//  pass, verifying every reshape/concat/broadcast in the block loop stays
//  dimensionally consistent end to end — the failure mode most likely in a
//  ~700-line 1:1 port done without a compiler-checked reference.
//

import ArgumentParser
import Flux2Director
import Foundation

extension Flux2CLI {
    struct VerifyKontextTransformerShape: ParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "verify-kontext-transformer-shape",
            abstract: "Structural (shape-only) smoke test for the new base-FLUX.1-dev KontextTransformer port."
        )

        func run() throws {
            print("flux2 verify-kontext-transformer-shape — kontext epic phase 2 checkpoint")
            print(KontextTransformer.shapeSelfTest())
        }
    }
}
