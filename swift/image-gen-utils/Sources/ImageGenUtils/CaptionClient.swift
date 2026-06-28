//
//  CaptionClient.swift
//  ImageGenUtils
//
//  Client for LM Studio's local OpenAI-compatible vision API (Qwen3-VL by
//  default, or any Gemma-4 / vision model LM Studio exposes). Captions or
//  scores an image. Mirrors `run.py caption` (image → downscale → JPEG →
//  base64 → POST /chat/completions).
//
//  This module is director-agnostic: z-image-director, flux2-image-director,
//  and any future image-gen tool share this one LM-Studio integration.
//
//  Configuration (precedence: explicit arg > env var > baked default):
//    LMSTUDIO_API_URL  — e.g. http://localhost:1234/v1
//    LMSTUDIO_MODEL    — e.g. qwen/qwen3-vl-4b
//

import Foundation

public enum CaptionClient {
    /// Default LM Studio API base. Overridable via `LMSTUDIO_API_URL` env var
    /// so each director install can point at its own LM Studio instance.
    public static var defaultAPIURL: String {
        if let env = ProcessInfo.processInfo.environment["LMSTUDIO_API_URL"],
           !env.isEmpty {
            return env
        }
        return "http://localhost:1234/v1"
    }

    /// Default VLM model id. Overridable via `LMSTUDIO_MODEL` env var so a
    /// director can prefer Gemma-4 or any other loaded vision model.
    public static var defaultModel: String {
        if let env = ProcessInfo.processInfo.environment["LMSTUDIO_MODEL"],
           !env.isEmpty {
            return env
        }
        return "qwen/qwen3-vl-4b"
    }

    // MARK: - Prompt helpers (delegated to StylePrompts)

    /// Build the text prompt for a named style (delegates to `StylePrompts`).
    public static func prompt(
        for style: String, prompt originalPrompt: String? = nil
    ) -> String {
        StylePrompts.prompt(for: style, prompt: originalPrompt)
    }

    // MARK: - High-level caption

    /// Call LM Studio /chat/completions with image + text. Returns raw text.
    public static func caption(
        imageURL: URL, style: String, prompt overridePrompt: String? = nil,
        apiURL: String = defaultAPIURL, model: String = defaultModel,
        maxTokens: Int = 2048
    ) throws -> String {
        let base64 = try ImageEncoder.imageToBase64JPEG(imageURL)
        let textPrompt = overridePrompt ?? prompt(for: style)
        return try callVLM(
            base64: base64, textPrompt: textPrompt,
            apiURL: apiURL, model: model, maxTokens: maxTokens
        )
    }

    /// Convenience: caption then parse as a score/review payload.
    public static func score(
        imageURL: URL, style: String = "score", prompt overridePrompt: String? = nil,
        apiURL: String = defaultAPIURL, model: String = defaultModel,
        maxTokens: Int = 2048
    ) throws -> CaptionScore? {
        let raw = try caption(
            imageURL: imageURL, style: style, prompt: overridePrompt,
            apiURL: apiURL, model: model, maxTokens: maxTokens
        )
        return CaptionScoreParser.parse(raw)
    }

    // MARK: - Low-level VLM call

    /// Low-level POST. Exposed so callers can reuse a pre-encoded image.
    public static func callVLM(
        base64: String, textPrompt: String,
        apiURL: String, model: String, maxTokens: Int
    ) throws -> String {
        let url = URL(string: "\(apiURL)/chat/completions")!
        var request = URLRequest(url: url, timeoutInterval: 180)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body: [String: Any] = [
            "model": model,
            "messages": [[
                "role": "user",
                "content": [
                    ["type": "image_url",
                     "image_url": ["url": "data:image/jpeg;base64,\(base64)"]],
                    ["type": "text", "text": textPrompt],
                ],
            ]],
            "max_tokens": maxTokens,
            "temperature": 0.3,
            "stream": false,
        ]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try URLSession.shared.synchronously(request)
        } catch {
            throw CaptionError.connectionFailed("\(apiURL) — \(error.localizedDescription)")
        }
        guard let http = response as? HTTPURLResponse else {
            throw CaptionError.connectionFailed("non-HTTP response")
        }
        if http.statusCode != 200 {
            let responseBody = String(data: data, encoding: .utf8) ?? ""
            throw CaptionError.httpError(http.statusCode, responseBody)
        }
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let choices = json["choices"] as? [[String: Any]],
              let firstChoice = choices.first,
              let message = firstChoice["message"] as? [String: Any],
              let content = message["content"] as? String else {
            throw CaptionError.badResponse(String(data: data, encoding: .utf8) ?? "")
        }
        return content
    }

    // MARK: - Back-compat parse shim

    /// Parse a raw score/review response into a `CaptionScore`.
    /// Kept on `CaptionClient` for source compatibility with existing
    /// z-image-director call sites; delegates to `CaptionScoreParser`.
    public static func parseScore(_ raw: String) -> CaptionScore? {
        CaptionScoreParser.parse(raw)
    }
}
