//
//  TransformerDefaults.swift
//  ZImageDirector
//
//  Per-checkpoint built-in parameter defaults (steps, cfg-scale, resolution).
//  Swift port of python/mlx-movie-director/app/transformer_defaults.py,
//  enriched with manifest-driven lookup: the registry's manifest.json now
//  carries `recommended_steps` / `recommended_cfg` / `recommended_resolution`,
//  so defaults resolve (1) from the manifest when declared, then (2) from the
//  built-in table below, then (3) the global RunConfig defaults.
//
//  Apply rule (matches python `RunConfig.from_args`): a default is applied ONLY
//  when the caller did not pass the flag explicitly — detected via the `nil`
//  sentinel. An explicit user value always wins (avoids the magic-number-compare
//  trap; see memory `argparse-sentinel-for-user-override`).
//

import CommonImageDirector
import Foundation

/// Effective per-transformer recommended parameters, resolved manifest-first.
public struct TransformerDefaults: Sendable {
    public let steps: Int?
    public let cfgScale: Float?
    public let recommendedResolutionLabel: String?

    public init(steps: Int? = nil, cfgScale: Float? = nil, recommendedResolutionLabel: String? = nil) {
        self.steps = steps
        self.cfgScale = cfgScale
        self.recommendedResolutionLabel = recommendedResolutionLabel
    }

    /// True if at least one default is present.
    public var isEmpty: Bool {
        steps == nil && cfgScale == nil && recommendedResolutionLabel == nil
    }

    /// JSON-friendly form (used by `schema-defaults`).
    public func asDict() -> [String: Any] {
        var dict: [String: Any] = [:]
        if let steps { dict["recommended_steps"] = steps }
        if let cfgScale { dict["recommended_cfg"] = cfgScale }
        if let recommendedResolutionLabel {
            dict["recommended_resolution"] = recommendedResolutionLabel
        }
        return dict
    }
}

public enum TransformerDefaultsRegistry {
    /// Built-in defaults for transformer instances whose manifests do not
    /// declare `recommended_*`. Ported verbatim from python
    /// `app/transformer_defaults.py:TRANSFORMER_DEFAULTS`. Add an entry only
    /// after an A/B test confirms the value (record in kb.jsonl).
    ///
    /// The manifest is the preferred source — this table is the fallback.
    private static let builtIn: [String: [String: Double]] = [
        "dark-beast-dbzit9": [
            // cfg≈3.0 proven optimal on this ZImageTurbo finetune: overall 4→6,
            // prompt_adherence 8→10, sharpness 7→8 (kb.jsonl group D, 2026-06-18).
            // ZImagePipeline runs CFG only when cfg_scale > 1.0 (dual forward/step).
            "cfg_scale": 3.0,
        ],
    ]

    /// Resolve defaults for a transformer instance. Precedence (per-field):
    /// **built-in A/B-tested table first**, then the manifest's `recommended_*`
    /// fields. This matches python `transformer_defaults.py` semantics — the
    /// hardcoded table holds A/B-verified values that can contradict a stale
    /// manifest entry (e.g. dark-beast-dbzit9: manifest says cfg=1.0, but the
    /// A/B test proved cfg=3.0 optimal, so the built-in 3.0 wins). The manifest
    /// fills fields the built-in table doesn't cover. Returns an empty struct
    /// if neither source declares anything.
    public static func resolve(forTransformer name: String?) -> TransformerDefaults {
        guard let name, !name.isEmpty else { return TransformerDefaults() }

        var steps: Int?
        var cfgScale: Float?
        var resolutionLabel: String?

        // 1. Built-in A/B-tested table (highest precedence for the fields it sets).
        if let table = builtIn[name] {
            if let value = table["cfg_scale"] { cfgScale = Float(value) }
            if let value = table["steps"] { steps = Int(value) }
        }

        // 2. Manifest fills whatever the built-in table left unset.
        if let manifest = ModelRegistry.manifest(forType: "transformer", name: name) {
            if steps == nil { steps = manifest.recommendedSteps }
            if cfgScale == nil { cfgScale = manifest.recommendedCfg }
            resolutionLabel = manifest.recommendedResolution
        }

        return TransformerDefaults(
            steps: steps, cfgScale: cfgScale,
            recommendedResolutionLabel: resolutionLabel
        )
    }

    /// Full registry snapshot (built-in + all manifests declaring recommended_*),
    /// used by `schema-defaults` to publish to the GUI.
    public static func snapshot() -> [String: TransformerDefaults] {
        var out: [String: TransformerDefaults] = [:]
        for manifest in ModelRegistry.list("transformer") {
            let resolved = resolve(forTransformer: manifest.name)
            if !resolved.isEmpty {
                out[manifest.name] = resolved
            }
        }
        return out
    }
}
