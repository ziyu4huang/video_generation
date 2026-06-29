//
//  StylePrompts.swift
//  ImageGenUtils
//
//  Style → system/user prompt registry for the VLM caption client.
//  Ported verbatim from python/mlx-movie-director/app/commands/caption.py
//  (_STYLE_PROMPTS + _DEFECT_BLOCK) so Swift and Python directors produce
//  directly comparable score/review JSON.
//
//  The defect-check block is shared by the `score` and `review` styles and is
//  deliberately adversarial — it prevents the VLM from over-praising
//  plasticky-skin / bad-hands images that look ok at a glance.
//

import Foundation

/// Shared defect-check block used by score + review styles (verbatim from
/// python _DEFECT_BLOCK — prevents over-praising plasticky-skin images).
public enum DefectBlock {
    public static let text = """
        DEFECT CHECK (do this first; be ruthless — hunt for each of these):
        - PLASTICKY / WAXY / OVERSMOOTHED SKIN: skin with no visible pores that looks like a mannequin, wax doll, or airbrushed plastic. This is the most common AI defect — check forehead, cheeks, shoulders, hands, and arms.
        - HANDS & FINGERS: wrong finger count, fused/merged fingers, extra or missing fingers, malformed hands, or extra/missing/fused limbs.
        - FACE: asymmetric eyes or ears, mismatched pupils, deformed teeth, melting or drifting features.
        - STRUCTURE & SYMMETRY: warped body proportions, fused clothing, floating or duplicated objects.
        - BACKGROUND: chaotic/melting background, nonsensical objects, seams, or ghosting.

        HARD RULES (override any holistic impression):
        - If skin looks plasticky/waxy/oversmoothed (no visible pores): artifacts <= 5, detail <= 6, AND overall <= 7.
        - If ANY hand has a wrong finger count or fused fingers: artifacts <= 4 AND overall <= 6.
        - If there are extra limbs or fused body parts: artifacts <= 3 AND overall <= 4.
        - Give artifacts 9-10 ONLY if you genuinely cannot find ANY defect above.

        """
}

/// Known caption style names (mirrors `run.py caption --style`).
public enum CaptionStyle: String, CaseIterable, Sendable {
    case `default`
    case photography
    case t2i
    case score
    case review
}

public enum StylePrompts {
    /// Build the text prompt for a named style. Unknown styles are treated as
    /// literal free-form prompts (same fallback as python caption.py).
    ///
    /// - Parameters:
    ///   - style: style name (one of `CaptionStyle` cases) or a literal prompt.
    ///   - prompt: the original T2I prompt — required only by `review` to check
    ///     element-level prompt adherence.
    public static func prompt(for style: String, prompt originalPrompt: String? = nil) -> String {
        switch style {
        case "default": return "Describe this image in detail."
        case "photography":
            return "Describe this photo as a photography prompt. Include: subject, pose, clothing, lighting, camera angle, composition, mood, and setting."
        case "t2i":
            return "Write a detailed text-to-image generation prompt for this image. Describe subject, appearance, clothing, pose, background, lighting, style, and atmosphere. Output only the prompt, no preamble."
        case "score":
            return """
                You are a STRICT, ADVERSARIAL image quality evaluator. AI-generated images almost always carry subtle flaws — your job is to FIND them, not to praise. Do not be lenient; a polished-looking image can still fail on skin texture or hands.

                """ + DefectBlock.text + """
                Then score on a 1-10 scale (respect the HARD RULES caps on overall/artifacts):
                1. overall — overall image quality and aesthetic appeal
                2. detail — level of fine detail (textures, fabric, skin pores, hair)
                3. sharpness — image sharpness and clarity across the frame
                4. composition — framing, rule of thirds, visual balance
                5. prompt_adherence — how well the image matches a typical text-to-image prompt intent
                6. artifacts — absence of rendering artifacts (INVERTED: 10 = no artifacts, 1 = severe)

                Respond with ONLY a JSON object (no markdown fences, no explanation):
                {"overall": N, "detail": N, "sharpness": N, "composition": N, "prompt_adherence": N, "artifacts": N, "issues": ["..."], "strengths": ["..."], "summary": "one sentence"}
                Each score is an integer 1-10. List EVERY defect you found in issues[].
                """
        case "review":
            let promptBlock = originalPrompt ?? "(unknown)"
            return """
                You are a STRICT image quality evaluator reviewing a TEXT-TO-IMAGE output.

                ORIGINAL PROMPT given to the generator:
                ---
                \(promptBlock)
                ---

                STEP 1 — ELEMENT CHECK (do this first; be literal and strict):
                Split the prompt into its key elements: subject, clothing, pose, setting/background, STYLE or MEDIUM (oil painting, watercolor, anime, 3D render, photograph, etc.), lighting, color palette. For each element mark PRESENT or ABSENT in the image. STYLE/MEDIUM is CRITICAL: if the prompt names a style/medium and the image is NOT in that style, mark it ABSENT.

                STEP 2 — prompt_adherence is a DETERMINISTIC function of the element check, NOT a holistic guess: adherence = round(10 x present_count / total_count), then if ANY style/medium element is ABSENT, CAP adherence at 5.

                """ + DefectBlock.text + """
                STEP 3 — general quality dimensions (1-10, respect the HARD RULES caps above):
                1. overall — overall image quality and aesthetic appeal
                2. detail — level of fine detail (textures, fabric, skin pores, hair)
                3. sharpness — image sharpness and clarity across the frame
                4. composition — framing, rule of thirds, visual balance
                5. artifacts — absence of rendering artifacts (INVERTED: 10 = no artifacts)

                List captured[] (PRESENT elements) and missed[] (ABSENT/wrong elements).

                Respond with ONLY a JSON object (no markdown fences):
                {"overall": N, "detail": N, "sharpness": N, "composition": N, "prompt_adherence": N, "artifacts": N, "captured": ["..."], "missed": ["..."], "issues": ["..."], "strengths": ["..."], "summary": "one sentence"}
                Each score is an integer 1-10.
                """
        default:
            return style // treat unknown style as a literal prompt
        }
    }
}
