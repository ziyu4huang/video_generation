//
//  NativeVLMPromptStage.swift
//  LTXVideoDirector
//
//  Replaces run.py's `caption --style ltx_i2v` (the VLM prompt-expansion
//  stage of t2i2v) with a direct, in-process call through
//  ImageGenUtils.CaptionClient — the SAME Swift HTTP client
//  VLMVerify.swift already uses for keyframe scoring, talking directly to
//  LM Studio's local OpenAI-compatible API. LM Studio is a standing local
//  server (not spawned per-request by run.py), so this was never actually
//  a "run.py wrapper" problem in the same sense as text/video generation
//  — the CLIENT side just hadn't been ported from Python to Swift yet.
//
//  The `ltx_i2v` prompt template is copied VERBATIM from
//  app/commands/caption.py's `_STYLE_PROMPTS["ltx_i2v"]` (not
//  reconstructed from memory) so the VLM sees the identical instructions
//  either way. Python additionally sets `response_format=json_object` for
//  this style (`_JSON_OUTPUT_STYLES`) to stop thinking-only models
//  returning empty content; `ImageGenUtils.CaptionClient` doesn't expose
//  that knob yet (shared by multiple director packages — not touched
//  here to avoid a cross-package behavior change), so this relies on the
//  template's own "Output ONLY a JSON object" instruction instead. Worth
//  upstreaming JSON-mode to CaptionClient if this proves unreliable in
//  practice.
//

import Foundation
import ImageGenUtils

public struct LTXI2VPrompt {
    public let prompt: String
    public let voiceLang: String
    public let motionSummary: String
    public let estimatedSeconds: Int
}

public enum NativeVLMPromptStage {
    public enum StageError: Error, CustomStringConvertible {
        case notJSON(String)
        case missingField(String, String)
        public var description: String {
            switch self {
            case .notJSON(let raw): return "VLM response wasn't valid JSON: \(raw.prefix(200))"
            case .missingField(let field, let raw): return "VLM JSON missing '\(field)': \(raw.prefix(200))"
            }
        }
    }

    /// Verbatim copy of app/commands/caption.py's _STYLE_PROMPTS["ltx_i2v"].
    private static let template = """
    You are an expert LTX-2.3 video generation prompt engineer.

    Analyze this image carefully: note the character's appearance (hair color/style, face, clothing, body type, art style — realistic/anime/3D), the setting, and lighting.

    The user wants the following action:
    ---
    {action}
    ---

    Generate an optimized LTX I2V (image-to-video) prompt in English that includes ALL of:
    1. CHARACTER ANCHOR — 1-2 sentences describing the character's appearance as seen in the image (hair color/style, clothing, body features). This anchors the video to the input frame.
    2. MOTION — detailed, physics-aware motion description matching the action intent. Describe body movement, limb positions, speed, facial expressions, hair/clothing movement from motion.
    3. VOICE LINES — the character's spoken words or vocal sounds in Traditional Chinese (zh-TW) by default, rendered as she says them (e.g., 她輕喘著說「嗯...啊...」). Include vocal quality (husky / high-pitched / breathless / soft). If the action contains no speaking, add natural breathing sounds instead.
    4. AMBIENT AUDIO — background or impact sounds that fit the scene.

    Output ONLY a JSON object (no markdown fences, no extra text):
    {"prompt": "the full LTX I2V prompt as one English paragraph", "voice_lang": "zh_TW", "motion_summary": "one-sentence motion summary in English", "estimated_seconds": <integer seconds>}
    """

    /// Runs the ltx_i2v VLM prompt-expansion stage natively (no run.py).
    public static func expand(
        imageURL: URL, action: String,
        apiURL: String = CaptionClient.defaultAPIURL, model: String = CaptionClient.defaultModel
    ) throws -> LTXI2VPrompt {
        let rendered = template.replacingOccurrences(of: "{action}", with: action)
        let raw = try CaptionClient.caption(imageURL: imageURL, style: "ltx_i2v", prompt: rendered, apiURL: apiURL, model: model)
        return try parse(raw)
    }

    static func parse(_ raw: String) throws -> LTXI2VPrompt {
        // Models sometimes wrap JSON in markdown fences despite instructions;
        // strip those before parsing.
        var text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.hasPrefix("```") {
            text = text.replacingOccurrences(of: "```json", with: "")
            text = text.replacingOccurrences(of: "```", with: "")
            text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        guard let data = text.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            throw StageError.notJSON(raw)
        }
        guard let prompt = json["prompt"] as? String else {
            throw StageError.missingField("prompt", raw)
        }
        let voiceLang = json["voice_lang"] as? String ?? "zh_TW"
        let motionSummary = json["motion_summary"] as? String ?? ""
        let estimatedSeconds = (json["estimated_seconds"] as? Int) ?? Int((json["estimated_seconds"] as? Double) ?? 10)
        return LTXI2VPrompt(prompt: prompt, voiceLang: voiceLang, motionSummary: motionSummary, estimatedSeconds: estimatedSeconds)
    }
}
