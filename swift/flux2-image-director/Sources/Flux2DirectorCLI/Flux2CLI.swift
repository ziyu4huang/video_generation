//
//  Flux2CLI.swift
//  Flux2DirectorCLI
//
//  `flux2` — pure-Swift MLX port of Flux2 Klein 9B + SAM3.1.
//
//  Subcommands are registered incrementally as each port phase lands:
//    t2i          — Phase 2 (MMDiT + VAE + text encoder + scheduler)
//    i2i / angle  — Phase 3 (Flux2KleinEdit reference conditioning)
//    mask         — Phase 4 (SAM3.1 segmentation)
//    swap / remove— Phase 4 (SAM3 mask + inpaint)
//    style        — Phase 5 (comic↔real style transfer)
//    story        — Phase 6 (character-story director workflow)
//    scene        — Phase 8 (multi-reference prompt-directed composition)
//    expand       — Phase 8 v3 (outpaint / image expansion, latent-mask re-injection)
//    models       — list installed Flux2 variants (available now)
//

import ArgumentParser

@main
struct Flux2CLI: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "flux2",
        abstract: "Flux2 Klein image generation + SAM3 segmentation (pure Swift MLX).",
        version: "0.1.0",
        subcommands: [
            T2I.self, Edit.self, Angle.self, Segment.self, Swap.self, Style.self,
            Story.self, Scene.self, Expand.self, Upscale.self, Gate.self, Models.self, VerifyVAE.self, VerifyEncoder.self,
            VerifyTokenizer.self, VerifyTransformer.self, VerifyE2E.self,
            VerifyEdit.self,
        ]
    )
}
