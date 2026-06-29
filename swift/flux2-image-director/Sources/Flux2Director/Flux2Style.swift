//
//  Flux2Style.swift
//  Flux2Director
//
//  Phase 5: Style transfer preserving character identity. Uses Flux2KleinEdit
//  reference conditioning (the input character is "seen" at every denoise step)
//  + a style-biasing prompt. The LoRA-augmented path (anime2real LoRA) is
//  deferred: it requires porting mflux's BFL→diffusers LoRA key-mapping +
//  int8 LoRA dequantization (~200 LOC), which is a separate effort.
//

import Foundation

public enum Flux2Style {
    /// Style transfer presets: prompt + recommended steps + ref count.
    public struct Preset: Sendable {
        public let prompt: String
        public let steps: Int
        public let refCount: Int
        public init(prompt: String, steps: Int, refCount: Int) {
            self.prompt = prompt; self.steps = steps; self.refCount = refCount
        }
    }

    public static let presets: [String: Preset] = [
        // Anime/illustration → semi-realistic. ref-count 1 is sufficient (verified
        // in run.py A/B testing; 3 is slower with similar result).
        "anime2real": Preset(
            prompt: "A photorealistic portrait of the same character, detailed realistic skin "
                  + "texture, natural lighting, DSLR camera, shallow depth of field, "
                  + "keeping the original hair color, clothing, and all character features",
            steps: 8, refCount: 1),
        // Real photo → anime/illustration.
        "real2anime": Preset(
            prompt: "An anime-style illustration of the same character, cel-shaded, vibrant "
                  + "colors, clean line art, keeping the original hair color, clothing, "
                  + "and all character features",
            steps: 8, refCount: 1),
        // Enhance toward photorealism (same medium, more detail).
        "photorealistic": Preset(
            prompt: "A photorealistic photograph of the same scene and character, detailed "
                  + "realistic skin texture, natural lighting, DSLR camera, sharp focus",
            steps: 6, refCount: 1),
        // 3D render style.
        "3d-render": Preset(
            prompt: "A 3D-rendered game character model of the same character, octane render, "
                  + "smooth shading, keeping the original hair color, clothing, and features",
            steps: 8, refCount: 1),
    ]
}
