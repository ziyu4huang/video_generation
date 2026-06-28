//
//  SelfTest.swift
//  ZImageDirector
//
//  Built-in self-test prompt presets, mirroring python/mlx-movie-director's
//  --self-test pattern. Lets the CLI generate canonical test images without
//  an external prompt file.
//

import Foundation

public struct SelfTestPreset: Sendable {
    public let name: String
    public let prompt: String
    public let width: Int
    public let height: Int
    public let steps: Int
    public let seed: UInt64
    public let cfgScale: Float
    public let lora: String?
    public let loraScale: Float
    public let description: String

    public init(name: String, prompt: String, width: Int, height: Int,
                steps: Int, seed: UInt64, cfgScale: Float,
                lora: String? = nil, loraScale: Float = 1.0, description: String = "") {
        self.name = name; self.prompt = prompt
        self.width = width; self.height = height
        self.steps = steps; self.seed = seed; self.cfgScale = cfgScale
        self.lora = lora; self.loraScale = loraScale; self.description = description
    }
}

public enum SelfTestPresets {
    /// Canonical prompts from python/mlx-movie-director/app/test_prompts_image.py.
    public static let all: [SelfTestPreset] = [
        SelfTestPreset(
            name: "portrait",
            prompt: "photorealistic portrait of a young woman, sharp eyes with detailed irises, " +
                "natural skin texture with fine pores, soft studio lighting, bokeh background, " +
                "high detail, ultra sharp focus",
            width: 640, height: 960, steps: 9, seed: 42, cfgScale: 4.0,
            description: "Standard portrait (from python _PROMPTS)"
        ),
        SelfTestPreset(
            name: "landscape",
            prompt: "photorealistic mountain landscape at golden hour, sharp rocky peaks, " +
                "detailed pine forest, dramatic sky with clouds, ultra sharp, high dynamic range",
            width: 960, height: 640, steps: 9, seed: 42, cfgScale: 4.0,
            description: "Landscape (from python _PROMPTS)"
        ),
        SelfTestPreset(
            name: "complex-girl",
            prompt: "a stunningly detailed portrait of a young woman with flowing auburn hair, " +
                "intricate lace dress, freckles across her nose, green eyes catching golden hour " +
                "sunlight, bokeh background of autumn forest, ultra realistic skin texture, " +
                "professional cinematic photography, shallow depth of field, film grain",
            width: 832, height: 1216, steps: 8, seed: 77, cfgScale: 4.0,
            description: "High-detail cinematic portrait (steps=8)"
        ),
        // LoRA self-tests (mirrors python lora:jibmix-portrait)
        SelfTestPreset(
            name: "lora:jibmix",
            prompt: "photorealistic portrait of a young woman, sharp eyes with detailed irises, " +
                "natural skin texture with fine pores, soft studio lighting, bokeh background, " +
                "high detail, ultra sharp focus",
            width: 640, height: 960, steps: 9, seed: 42, cfgScale: 4.0,
            lora: "jib-mix-realistic-z-image-lora", loraScale: 1.0,
            description: "Jib-Mix Realistic style LoRA (scale 1.0)"
        ),
        SelfTestPreset(
            name: "lora:asian-girl",
            prompt: "portrait of a young woman with natural makeup, soft lighting, detailed skin texture",
            width: 640, height: 960, steps: 9, seed: 42, cfgScale: 4.0,
            lora: "z-image-asian-girl-2-2", loraScale: 1.0,
            description: "Z-Image Asian Girl LoRA (scale 1.0)"
        ),
    ]

    public static func find(_ name: String) -> SelfTestPreset? {
        all.first { $0.name == name }
    }
}
