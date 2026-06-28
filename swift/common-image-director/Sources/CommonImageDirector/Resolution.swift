//
//  Resolution.swift
//  ZImageDirector
//
//  Resolution alignment + presets for Z-Image generation.
//  Z-Image requires pixel dimensions that are multiples of 16
//  (height/8 must be even for the /2 patchify step).
//

import Foundation

public enum Resolution {
    /// Pixel dimensions must be a multiple of this (16 = 8 downsample × 2 patchify).
    public static let alignment = 16

    /// Minimum dimension (px). Below this the latent is too small.
    public static let minDimension = 256

    /// Maximum dimension (px). Z-Image handles arbitrary sizes, but this caps
    /// memory on Apple Silicon (latent tokens grow quadratically).
    public static let maxDimension = 2048

    /// Named resolution presets (the long edge × short edge).
    public static let presets: [String: (w: Int, h: Int)] = [
        // Square
        "512": (512, 512),
        "1024": (1024, 1024),
        // Portrait (default aspect for character/portrait work)
        "portrait": (640, 960),
        "9:16": (720, 1280),
        // Landscape
        "landscape": (960, 640),
        "16:9": (1280, 720),
        // HD / 1080p
        "720p": (1280, 720),
        "1080p": (1920, 1088),  // 1080 → 1088 (nearest multiple of 16)
        // 4K-ish
        "4k": (3840, 2160),     // will be capped to maxDimension unless raised
    ]

    /// Pipeline family for per-model resolution tiers. Mirrors python's
    /// `_PIPELINE_DEFAULT_RESOLUTION` / `_RESOLUTION_TIERS` so Swift and the
    /// Bun GUI resolve the same training-optimal size for a given checkpoint.
    public enum Pipeline: String, Sendable {
        case zimage
        case flux2Klein = "flux2-klein"
        case lens
        case auto

        /// Canonical family used for tier lookup when the pipeline is `auto`
        /// or unknown (falls back to the zimage portrait default).
        var tierKey: Pipeline { self == .auto ? .zimage : self }
    }

    /// Resolution tiers, decoupling "what the model was trained on" from
    /// "what we want to benchmark / self-learn at". Mirrors python
    /// `app/commands/_shared.py:_RESOLUTION_TIERS`. All values are multiples
    /// of 16 (Flux2 / zimage VAE /8 × patchify /2).
    public static let tiers: [String: [Pipeline: (w: Int, h: Int)]] = [
        // tier: { pipeline: (w, h) }
        "model": [  // per-pipeline training-optimal (the historical default)
            .zimage: (640, 960), .flux2Klein: (640, 960), .lens: (1024, 1024),
            .auto: (640, 960),
        ],
        "benchmark": [  // ~1.5–1.6MP — the self-learning / quality-benchmark default
            .zimage: (1024, 1536), .flux2Klein: (1024, 1536), .lens: (1280, 1280),
            .auto: (1024, 1536),
        ],
        "large": [  // ~2.4MP — stress test (slower; watch for OOD artifacts on distilled models)
            .zimage: (1280, 1920), .flux2Klein: (1280, 1920), .lens: (1536, 1536),
            .auto: (1280, 1920),
        ],
    ]

    /// Align a single dimension to the nearest valid multiple of `alignment`.
    /// Returns the aligned value and whether it was changed.
    public static func align(_ value: Int) -> (aligned: Int, changed: Bool) {
        var aligned = value
        // Round to nearest multiple of alignment (not just floor — better UX).
        let half = alignment / 2
        let remainder = aligned % alignment
        if remainder != 0 {
            if remainder >= half {
                aligned += (alignment - remainder)  // round up
            } else {
                aligned -= remainder                 // round down
            }
        }
        // Clamp to [minDimension, maxDimension].
        let clamped = max(minDimension, min(maxDimension, aligned))
        return (clamped, clamped != value)
    }

    /// Resolve a `--resolution` preset string into concrete (width, height).
    /// Returns nil if the string is not a known preset.
    ///
    /// Accepts: a named preset (portrait|landscape|1024|...), a tier
    /// (`model`|`benchmark`|`large`, resolved per-pipeline), or explicit `WxH`.
    public static func resolvePreset(_ name: String, pipeline: Pipeline = .zimage) -> (w: Int, h: Int)? {
        let lower = name.lowercased()
        // Tier lookup takes precedence over the bare-preset table so a pipeline's
        // training-optimal size wins even if "model"/"large" aren't in `presets`.
        if let tier = tiers[lower], let size = tier[pipeline.tierKey] {
            let (wAligned, _) = align(size.w)
            let (hAligned, _) = align(size.h)
            return (wAligned, hAligned)
        }
        if let preset = presets[lower] {
            let (wAligned, _) = align(preset.w)
            let (hAligned, _) = align(preset.h)
            return (wAligned, hAligned)
        }
        // Also accept "WxH" notation, e.g. "1920x1080".
        let parts = name.split(separator: "x")
        if parts.count == 2, let parsedW = Int(parts[0]), let parsedH = Int(parts[1]) {
            return (align(parsedW).aligned, align(parsedH).aligned)
        }
        // A bare integer = that size square.
        if let size = Int(name) {
            let aligned = align(size).aligned
            return (aligned, aligned)
        }
        return nil
    }

    /// Align both width and height, clamping to bounds. Prints adjustment messages.
    /// Returns the final (width, height).
    @discardableResult
    public static func validate(width: Int, height: Int) -> (width: Int, height: Int) {
        let (wAligned, wChanged) = align(width)
        let (hAligned, hChanged) = align(height)

        if wChanged {
            print("  ⚠️  width  \(width) → \(wAligned) " +
                  "(multiple of \(alignment), clamped [\(minDimension)–\(maxDimension)])")
        }
        if hChanged {
            print("  ⚠️  height \(height) → \(hAligned) " +
                  "(multiple of \(alignment), clamped [\(minDimension)–\(maxDimension)])")
        }
        return (wAligned, hAligned)
    }
}
