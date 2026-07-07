//
//  CFGGuidance.swift
//  LTXVideoDirector
//
//  Milestone 2a+2b of the native CFG/STG port (see
//  docs/native-i2v-dev-variant-study.md's "Status update (2026-07-07)"
//  section) — classifier-free guidance plus STG (spatio-temporal guidance,
//  self-attention perturbation on specific blocks). Modality guidance
//  (cross-modal A2V/V2A perturbation) is NOT implemented here; that is the
//  study doc's separate 2c sub-milestone.
//
//  Reference: ltx_pipelines_mlx's `MultiModalGuider.calculate`
//  (packages/ltx-pipelines-mlx's vendored `ltx_core_mlx.components.guiders`),
//  restricted to the cfg_scale/stg_scale terms — modality_scale is treated
//  as its off value (1.0), so the general formula
//    cond + (cfg_scale-1)*(cond-uncond_text) + stg_scale*(cond-uncond_ptb)
//         + (modality_scale-1)*(cond-uncond_mod)
//  reduces to just the first three terms.
//

import MLX

public enum CFGGuidance {
    /// Same negative prompt every production LTX pipeline encodes for CFG's
    /// unconditional pass — `ltx_pipelines_mlx.utils.constants.DEFAULT_NEGATIVE_PROMPT`,
    /// copied verbatim so guidance direction matches production exactly.
    public static let defaultNegativePrompt =
        "blurry, out of focus, overexposed, underexposed, low contrast, washed out colors, excessive noise, " +
        "grainy texture, poor lighting, flickering, motion blur, distorted proportions, unnatural skin tones, " +
        "deformed facial features, asymmetrical face, missing facial features, extra limbs, disfigured hands, " +
        "wrong hand count, artifacts around text, inconsistent perspective, camera shake, incorrect depth of " +
        "field, background too sharp, background clutter, distracting reflections, harsh shadows, inconsistent " +
        "lighting direction, color banding, cartoonish rendering, 3D CGI look, unrealistic materials, uncanny " +
        "valley effect, incorrect ethnicity, wrong gender, exaggerated expressions, wrong gaze direction, " +
        "mismatched lip sync, silent or muted audio, distorted voice, robotic voice, echo, background noise, " +
        "off-sync audio, incorrect dialogue, added dialogue, repetitive speech, jittery movement, awkward " +
        "pauses, incorrect timing, unnatural transitions, inconsistent framing, tilted camera, flat lighting, " +
        "inconsistent tone, cinematic oversaturation, stylized filters, or AI artifacts."

    /// True iff `cfgScale` differs from 1.0 (reference: `do_unconditional_generation`,
    /// `not math.isclose(cfg_scale, 1.0)`).
    public static func isActive(cfgScale: Float) -> Bool {
        abs(cfgScale - 1.0) > 1e-6
    }

    /// True iff `stgScale` differs from 0.0 (reference: `MultiModalGuider
    /// .do_perturbed_generation`, `not math.isclose(stg_scale, 0.0)`).
    public static func isSTGActive(stgScale: Float) -> Bool {
        abs(stgScale) > 1e-6
    }

    /// `cond + (cfgScale - 1) * (cond - uncond)`, optionally rescaled to
    /// preserve `cond`'s variance (reference: `guiders.py`'s
    /// `rescale_scale` blend). `rescaleScale == 0` skips rescaling entirely,
    /// matching the reference's `if self.params.rescale_scale != 0`.
    public static func blend(cond: MLXArray, uncond: MLXArray, cfgScale: Float, rescaleScale: Float) -> MLXArray {
        blend(cond: cond, uncond: uncond, uncondPerturbed: nil, cfgScale: cfgScale, stgScale: 0, rescaleScale: rescaleScale)
    }

    /// Full `MultiModalGuider.calculate` blend restricted to the CFG + STG
    /// terms (modality guidance is 2c, not implemented):
    /// `cond + (cfgScale-1)*(cond-uncond) + stgScale*(cond-uncondPerturbed)`,
    /// optionally rescaled to preserve `cond`'s variance. `uncondPerturbed`
    /// is ignored when `stgScale == 0` (matches the reference: the STG term
    /// drops out and `uncondPerturbed`'s forward pass need not even run).
    public static func blend(
        cond: MLXArray, uncond: MLXArray, uncondPerturbed: MLXArray?,
        cfgScale: Float, stgScale: Float, rescaleScale: Float
    ) -> MLXArray {
        var pred = cond + (cfgScale - 1) * (cond - uncond)
        if isSTGActive(stgScale: stgScale), let uncondPerturbed {
            pred = pred + stgScale * (cond - uncondPerturbed)
        }
        if rescaleScale != 0 {
            let condStd = MLX.sqrt(MLX.variance(cond))
            let predStd = MLX.sqrt(MLX.variance(pred))
            let factor = rescaleScale * (condStd / (predStd + 1e-8)) + (1 - rescaleScale)
            pred = pred * factor
        }
        return pred
    }
}
