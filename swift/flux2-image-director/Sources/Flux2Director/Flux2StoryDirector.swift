//
//  Flux2StoryDirector.swift
//  Flux2Director
//
//  Phase 6: Character-story director. Orchestrates T2I + multi-angle generation
//  to produce a consistent character across multiple story scenes:
//    1. Generate a hero character (T2I, front view) from a description.
//    2. For each scene, generate a consistent view (angle + scene prompt) using
//       the hero as reference conditioning.
//  All views preserve identity because the hero image is VAE-encoded into
//  reference tokens seen at every denoise step.
//

import Foundation
import MLX

public struct Flux2StoryScene: Sendable {
    public let anglePreset: String?      // "front", "right", "back-high", nil = front
    public let azimuth: Float?
    public let elevation: Float?
    public let prompt: String            // scene-specific prompt (e.g. "walking through a forest")

    public init(anglePreset: String? = nil, azimuth: Float? = nil, elevation: Float? = nil,
                prompt: String) {
        self.anglePreset = anglePreset; self.azimuth = azimuth
        self.elevation = elevation; self.prompt = prompt
    }
}

public struct Flux2StoryResult {
    public let coverPath: String
    public let scenePaths: [String]
}

public enum Flux2StoryDirector {
    /// Default scene templates if none provided: 4 classic story angles.
    public static let defaultScenes: [Flux2StoryScene] = [
        .init(anglePreset: "front-right", prompt: "looking toward the camera with a determined expression"),
        .init(anglePreset: "right", prompt: "in profile, gazing into the distance"),
        .init(anglePreset: "back-high", prompt: "walking away, viewed from behind and above"),
        .init(anglePreset: "front-low", prompt: "heroic low-angle shot, looking up"),
    ]

    /// Build the full prompt for a scene (character description + scene + angle text).
    public static func scenePrompt(character: String, scene: Flux2StoryScene) -> String {
        let resolved = Flux2Angle.resolve(preset: scene.anglePreset,
                                          azimuth: scene.azimuth, elevation: scene.elevation)
        let angleText = Flux2Angle.angleText(azimuth: resolved.azimuth, elevation: resolved.elevation)
        return "\(character)，\(scene.prompt), \(angleText), "
             + "photorealistic, maintain character identity and appearance consistency"
    }

    /// Cover prompt: front view of the character.
    public static func coverPrompt(character: String) -> String {
        let angleText = Flux2Angle.angleText(azimuth: 0, elevation: 0)
        return "\(character)，\(angleText), photorealistic, character reference sheet"
    }
}
