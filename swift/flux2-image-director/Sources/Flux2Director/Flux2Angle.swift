//
//  Flux2Angle.swift
//  Flux2Director
//
//  Phase 3.2: Multi-angle consistent character generation. Ported from run.py's
//  image-angle command. Builds an angle-view prompt from azimuth/elevation and
//  drives the edit pipeline with the input image repeated ×ref_count (identity
//  conditioning). 1-3 refs; >3 over-conditions the distilled pipeline.
//

import Foundation

public enum Flux2Angle {
    /// Named camera-angle presets → (azimuth_deg, elevation_deg).
    public static let presets: [String: (azimuth: Float, elevation: Float)] = [
        "front": (0, 0), "front-right": (45, 0), "right": (90, 0),
        "rear-right": (135, 0), "back": (180, 0), "rear-left": (225, 0),
        "left": (270, 0), "front-left": (315, 0),
        "front-high": (0, 45), "right-high": (90, 45), "back-high": (180, 45),
        "front-low": (0, -45), "right-low": (90, -45),
        "birds-eye": (0, 75), "worms-eye": (0, -75),
    ]

    /// 8-way azimuth direction text.
    static let azimuthDirections = [
        "front view", "front-right three-quarter view", "right side profile",
        "rear-right three-quarter view", "back view", "rear-left three-quarter view",
        "left side profile", "front-left three-quarter view",
    ]

    /// Convert azimuth/elevation degrees → camera-angle phrase.
    /// Byte-identical to run.py image-angle._angle_to_text (rich=false path).
    public static func angleText(azimuth: Float, elevation: Float) -> String {
        let azMod = azimuth.truncatingRemainder(dividingBy: 360)
        let azIdx = Int((azMod + 22.5) / 45) % 8
        let azText = azimuthDirections[(azIdx < 0 ? azIdx + 8 : azIdx) % 8]
        var elText = ""
        if elevation > 20 {
            elText = ", high angle shot (camera above, looking down)"
        } else if elevation < -20 {
            elText = ", low angle shot (camera below, looking up)"
        }
        return azText + elText
    }

    /// Build the Flux2-Klein angle prompt (identity-preserving).
    public static func buildPrompt(userPrompt: String?, angleText: String) -> String {
        let base = (userPrompt?.isEmpty ?? true)
            ? "保持人物外貌、服裝、髮型完全一致，"
            : "\(userPrompt!)，"
        return "\(base)\(angleText), photorealistic, maintain character identity and appearance consistency"
    }

    /// Clamp reference count to the safe 1-3 range (>3 over-conditions).
    public static func clampRefCount(_ count: Int) -> Int {
        max(1, min(3, count))
    }

    /// Resolve (azimuth, elevation) from a preset name, falling back to raw values.
    public static func resolve(preset: String?, azimuth: Float?, elevation: Float?)
        -> (azimuth: Float, elevation: Float)
    {
        if let p = preset, let v = presets[p] {
            return (azimuth ?? v.azimuth, elevation ?? v.elevation)
        }
        return (azimuth ?? 90, elevation ?? 0)
    }
}
