//
//  CaptionClient.swift
//  ZImageDirector
//
//  Calls LM Studio's Qwen3-VL (OpenAI-compatible vision API) to caption or
//  score an image. Mirrors python/mlx-movie-director/app/commands/caption.py:
//  image → downscale to ≤1024px → JPEG → base64 → POST /chat/completions.
//

import CoreGraphics
import Foundation
import ImageIO

/// One VLM quality-score dimension + the parsed JSON payload.
public struct CaptionScore: Sendable {
    public let overall: Int
    public let detail: Int
    public let sharpness: Int
    public let composition: Int
    public let promptAdherence: Int
    public let artifacts: Int
    public let issues: [String]
    public let strengths: [String]
    public let summary: String
    public let rawJSON: String

    /// Passes when overall >= threshold AND artifacts >= threshold (inverted:
    /// artifacts 10 = no defects). A high overall with low artifacts means
    /// the image looks ok but has plasticky skin / hand defects — still bad.
    public func passes(threshold: Int) -> Bool {
        overall >= threshold && artifacts >= threshold
    }
}

public enum CaptionClient {
    public static let defaultAPIURL = "http://localhost:1234/v1"
    public static let defaultModel = "qwen/qwen3-vl-4b"

    // MARK: - Style prompts (ported from python caption.py _STYLE_PROMPTS)

    /// Shared defect-check block used by score + review styles (verbatim from
    /// python _DEFECT_BLOCK — prevents over-praising plasticky-skin images).
    private static let defectBlock = """
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

    public static func prompt(for style: String, prompt: String? = nil) -> String {
        switch style {
        case "default": return "Describe this image in detail."
        case "photography":
            return "Describe this photo as a photography prompt. Include: subject, pose, clothing, lighting, camera angle, composition, mood, and setting."
        case "t2i":
            return "Write a detailed text-to-image generation prompt for this image. Describe subject, appearance, clothing, pose, background, lighting, style, and atmosphere. Output only the prompt, no preamble."
        case "score":
            return """
                You are a STRICT, ADVERSARIAL image quality evaluator. AI-generated images almost always carry subtle flaws — your job is to FIND them, not to praise. Do not be lenient; a polished-looking image can still fail on skin texture or hands.

                """ + defectBlock + """
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
            let promptBlock = prompt ?? "(unknown)"
            return """
                You are a STRICT image quality evaluator reviewing a TEXT-TO-IMAGE output.

                ORIGINAL PROMPT given to the generator:
                ---
                \(promptBlock)
                ---

                STEP 1 — ELEMENT CHECK (do this first; be literal and strict):
                Split the prompt into its key elements: subject, clothing, pose, setting/background, STYLE or MEDIUM (oil painting, watercolor, anime, 3D render, photograph, etc.), lighting, color palette. For each element mark PRESENT or ABSENT in the image. STYLE/MEDIUM is CRITICAL: if the prompt names a style/medium and the image is NOT in that style, mark it ABSENT.

                STEP 2 — prompt_adherence is a DETERMINISTIC function of the element check, NOT a holistic guess: adherence = round(10 x present_count / total_count), then if ANY style/medium element is ABSENT, CAP adherence at 5.

                """ + defectBlock + """
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

    // MARK: - Image → base64 JPEG

    /// Load image, downscale to ≤maxSize on the longest edge, JPEG-encode at
    /// quality 85, return base64 string. Mirrors python _image_to_base64.
    public static func imageToBase64JPEG(_ url: URL, maxSize: Int = 1024) throws -> String {
        guard let src = CGImageSourceCreateWithURL(url as CFURL, nil),
              let cg = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
            throw CaptionError.unreadableImage(url.path)
        }
        let w = cg.width
        let h = cg.height
        var drawW = w
        var drawH = h
        if max(w, h) > maxSize {
            let scale = Double(maxSize) / Double(max(w, h))
            drawW = max(1, Int(Double(w) * scale))
            drawH = max(1, Int(Double(h) * scale))
        }

        // Render into a JPEG via a bitmap context + ImageIO destination.
        let cs = CGColorSpace(name: CGColorSpace.sRGB)!
        guard let ctx = CGContext(
            data: nil, width: drawW, height: drawH,
            bitsPerComponent: 8, bytesPerRow: 0,
            space: cs,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { throw CaptionError.encodeFailed }
        ctx.interpolationQuality = .high
        ctx.draw(cg, in: CGRect(x: 0, y: 0, width: drawW, height: drawH))
        guard let drawn = ctx.makeImage() else { throw CaptionError.encodeFailed }

        let mutable = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(
            mutable as CFMutableData, "public.jpeg" as CFString, 1, nil
        ) else { throw CaptionError.encodeFailed }
        CGImageDestinationAddImage(dest, drawn,
            [kCGImageDestinationLossyCompressionQuality: 0.85] as CFDictionary)
        guard CGImageDestinationFinalize(dest) else { throw CaptionError.encodeFailed }
        return mutable.base64EncodedString()
    }

    // MARK: - VLM call

    /// Call LM Studio /chat/completions with image + text. Returns raw text.
    public static func caption(
        imageURL: URL, style: String, prompt overridePrompt: String? = nil,
        apiURL: String = defaultAPIURL, model: String = defaultModel,
        maxTokens: Int = 2048
    ) throws -> String {
        let b64 = try imageToBase64JPEG(imageURL)
        let textPrompt = overridePrompt ?? prompt(for: style)
        return try callVLM(
            b64: b64, textPrompt: textPrompt,
            apiURL: apiURL, model: model, maxTokens: maxTokens
        )
    }

    /// Low-level POST. Exposed so callers can reuse a pre-encoded image.
    public static func callVLM(
        b64: String, textPrompt: String,
        apiURL: String, model: String, maxTokens: Int
    ) throws -> String {
        let url = URL(string: "\(apiURL)/chat/completions")!
        var req = URLRequest(url: url, timeoutInterval: 180)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body: [String: Any] = [
            "model": model,
            "messages": [[
                "role": "user",
                "content": [
                    ["type": "image_url",
                     "image_url": ["url": "data:image/jpeg;base64,\(b64)"]],
                    ["type": "text", "text": textPrompt],
                ],
            ]],
            "max_tokens": maxTokens,
            "temperature": 0.3,
            "stream": false,
        ]
        req.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, resp): (Data, URLResponse)
        do {
            (data, resp) = try URLSession.shared.synchronously(req)
        } catch {
            throw CaptionError.connectionFailed("\(apiURL) — \(error.localizedDescription)")
        }
        guard let http = resp as? HTTPURLResponse else {
            throw CaptionError.connectionFailed("non-HTTP response")
        }
        if http.statusCode != 200 {
            let body = String(data: data, encoding: .utf8) ?? ""
            throw CaptionError.httpError(http.statusCode, body)
        }
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let choices = json["choices"] as? [[String: Any]],
              let first = choices.first,
              let message = first["message"] as? [String: Any],
              let content = message["content"] as? String else {
            throw CaptionError.badResponse(String(data: data, encoding: .utf8) ?? "")
        }
        return content
    }

    // MARK: - Score parsing

    /// Extract the JSON object from a VLM score/review response (the model
    /// sometimes wraps it in ```json fences despite instructions) and parse it.
    public static func parseScore(_ raw: String) -> CaptionScore? {
        var trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        // Strip ```json ... ``` fences if present.
        if trimmed.hasPrefix("```") {
            if let nlIdx = trimmed.firstIndex(of: "\n") {
                trimmed = String(trimmed[trimmed.index(after: nlIdx)...])
            }
            if let fenceEnd = trimmed.range(of: "```") {
                trimmed = String(trimmed[..<fenceEnd.lowerBound])
            }
            trimmed = trimmed.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        guard let bracStart = trimmed.firstIndex(of: "{"),
              let bracEnd = trimmed.lastIndex(of: "}"),
              bracStart < bracEnd else { return nil }
        let jsonSlice = String(trimmed[bracStart...bracEnd])
        guard let data = jsonSlice.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }
        func num(_ key: String) -> Int {
            if let n = obj[key] as? Int { return n }
            if let d = obj[key] as? Double { return Int(d) }
            if let s = obj[key] as? String, let n = Int(s) { return n }
            return 0
        }
        func strs(_ key: String) -> [String] {
            (obj[key] as? [String]) ?? []
        }
        return CaptionScore(
            overall: num("overall"), detail: num("detail"),
            sharpness: num("sharpness"), composition: num("composition"),
            promptAdherence: num("prompt_adherence"), artifacts: num("artifacts"),
            issues: strs("issues"), strengths: strs("strengths"),
            summary: (obj["summary"] as? String) ?? "",
            rawJSON: jsonSlice
        )
    }
}

public enum CaptionError: Error, CustomStringConvertible {
    case unreadableImage(String)
    case encodeFailed
    case connectionFailed(String)
    case httpError(Int, String)
    case badResponse(String)

    public var description: String {
        switch self {
        case .unreadableImage(let p): return "cannot read image: \(p)"
        case .encodeFailed: return "failed to JPEG-encode the image"
        case .connectionFailed(let d): return "VLM connection failed: \(d). Is LM Studio running on :1234?"
        case .httpError(let code, let body): return "VLM HTTP \(code): \(body.prefix(200))"
        case .badResponse(let r): return "VLM returned unparseable response: \(r.prefix(200))"
        }
    }
}

// MARK: - Synchronous URLSession helper

private extension URLSession {
    func synchronously(_ request: URLRequest) throws -> (Data, URLResponse) {
        let semaphore = DispatchSemaphore(value: 0)
        var result: Result<(Data, URLResponse), Error>!
        let task = self.dataTask(with: request) { data, resp, err in
            if let err = err { result = .failure(err) }
            else { result = .success((data ?? Data(), resp!)) }
            semaphore.signal()
        }
        task.resume()
        semaphore.wait()
        return try result.get()
    }
}
