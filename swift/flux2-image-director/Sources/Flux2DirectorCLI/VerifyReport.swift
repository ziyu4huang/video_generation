//
//  VerifyReport.swift
//  Flux2DirectorCLI
//
//  Shared JSON summary writer for the `flux2 verify-*` checkpoints. Each verify
//  command compares a Swift Flux2 stage against the Python mflux reference
//  (cosine similarity) and prints PASS/FAIL. This helper captures the same
//  results as structured JSON and writes them under
//  `<repoRoot>/output/flux2-<command>/summary.json` so a Bun script can aggregate
//  all checkpoints into one self-contained HTML review.
//
//  Why output lives OUTSIDE the swift app tree: verify artifacts are generated
//  results, not source — they belong in the repo-root `output/` dir (gitignored),
//  not under `swift/flux2-image-director/`.
//

import CommonImageDirector
import Foundation

/// One comparison within a verify checkpoint (e.g. "encode", "decode").
public struct VerifyCheck: Encodable {
    public let name: String
    public let pass: Bool
    public let cosine: Double?
    public let threshold: Double?
    public let detail: String?
}

/// Full summary of one `flux2 verify-*` run.
public struct VerifySummary: Encodable {
    public let app: String                 // "flux2"
    public let command: String             // "verify-vae", "verify-e2e", ...
    public let overall_pass: Bool
    public let threshold: Double
    public let checks: [VerifyCheck]
    public let timestamp: String           // ISO 8601
}

public enum VerifyReport {
    public static let app = "flux2"

    /// Write `summary.json` under `<repoRoot>/output/<app>-<command>/`.
    /// Returns the file URL (and prints it). Errors are non-fatal — a failed
    /// write must not mask the actual verify result already printed to stdout.
    @discardableResult
    public static func write(_ summary: VerifySummary) -> URL? {
        let dir = ModelPaths.repoRoot
            .appendingPathComponent("output")
            .appendingPathComponent("\(summary.app)-\(summary.command)")
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        } catch {
            print("⚠ could not create \(dir.path): \(error)")
            return nil
        }
        let url = dir.appendingPathComponent("summary.json")
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        do {
            let data = try encoder.encode(summary)
            try data.write(to: url)
            print("📄 summary → \(url.path)")
            return url
        } catch {
            print("⚠ could not write summary: \(error)")
            return nil
        }
    }

    /// Current time as ISO 8601 (UTC).
    public static func now() -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f.string(from: Date())
    }
}
