//
//  CaptionScore.swift
//  ImageGenUtils
//
//  Parsed VLM quality-score payload + the JSON extraction logic.
//  The model sometimes wraps its JSON in ```json fences despite instructions;
//  parseScore() handles that robustly.
//

import Foundation

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

    public init(
        overall: Int, detail: Int, sharpness: Int, composition: Int,
        promptAdherence: Int, artifacts: Int,
        issues: [String], strengths: [String], summary: String, rawJSON: String
    ) {
        self.overall = overall
        self.detail = detail
        self.sharpness = sharpness
        self.composition = composition
        self.promptAdherence = promptAdherence
        self.artifacts = artifacts
        self.issues = issues
        self.strengths = strengths
        self.summary = summary
        self.rawJSON = rawJSON
    }

    /// Passes when overall >= threshold AND artifacts >= threshold (inverted:
    /// artifacts 10 = no defects). A high overall with low artifacts means
    /// the image looks ok but has plasticky skin / hand defects — still bad.
    public func passes(threshold: Int) -> Bool {
        overall >= threshold && artifacts >= threshold
    }
}

public enum CaptionScoreParser {
    /// Extract the JSON object from a VLM score/review response (the model
    /// sometimes wraps it in ```json fences despite instructions) and parse it.
    public static func parse(_ raw: String) -> CaptionScore? {
        var trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        // Strip ```json ... ``` fences if present.
        if trimmed.hasPrefix("```") {
            if let newlineIdx = trimmed.firstIndex(of: "\n") {
                trimmed = String(trimmed[trimmed.index(after: newlineIdx)...])
            }
            if let fenceEnd = trimmed.range(of: "```") {
                trimmed = String(trimmed[..<fenceEnd.lowerBound])
            }
            trimmed = trimmed.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        guard let braceStart = trimmed.firstIndex(of: "{"),
              let braceEnd = trimmed.lastIndex(of: "}"),
              braceStart < braceEnd else { return nil }
        let jsonSlice = String(trimmed[braceStart...braceEnd])
        guard let data = jsonSlice.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }
        func number(_ key: String) -> Int {
            if let intValue = obj[key] as? Int { return intValue }
            if let doubleValue = obj[key] as? Double { return Int(doubleValue) }
            if let stringValue = obj[key] as? String, let intValue = Int(stringValue) {
                return intValue
            }
            return 0
        }
        func strings(_ key: String) -> [String] {
            (obj[key] as? [String]) ?? []
        }
        return CaptionScore(
            overall: number("overall"), detail: number("detail"),
            sharpness: number("sharpness"), composition: number("composition"),
            promptAdherence: number("prompt_adherence"), artifacts: number("artifacts"),
            issues: strings("issues"), strengths: strings("strengths"),
            summary: (obj["summary"] as? String) ?? "",
            rawJSON: jsonSlice
        )
    }
}
