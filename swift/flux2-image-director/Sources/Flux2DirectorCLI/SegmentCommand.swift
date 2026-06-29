//
//  SegmentCommand.swift
//  Flux2DirectorCLI
//
//  Phase 4.1: `flux2 segment` — text-prompted segmentation via SAM3.1.
//
//  SAM3.1 is a 3400-LOC VLM-grounded segmentation model (image encoder + text
//  grounding backbone + mask decoder). A full native Swift MLX port is a
//  multi-day effort comparable to the entire Flux2 port, so this command
//  integrates via Python subprocess (mlx-vlm). The resulting mask is a standard
//  PNG usable by all downstream Swift operations (swap/remove/inpaint).
//

import ArgumentParser
import CommonImageDirector
import Foundation

extension Flux2CLI {
    struct Segment: ParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "segment",
            abstract: "Text-prompted segmentation via SAM3.1 (Python mlx-vlm bridge)."
        )

        @Option(help: "Input image to segment.")
        var image: String

        @Option(help: "Text prompt describing the object to segment (e.g. \"woman's face\").")
        var prompt: String

        @Option(help: "Detection score threshold (0-1).")
        var threshold: Float = 0.3

        @Option(help: "Output mask PNG path (white=object, feathered edges).")
        var output: String

        func run() throws {
            setbuf(stdout, nil)
            print("flux2 segment — SAM3.1 text-prompted segmentation")
            print("  image     : \(image)")
            print("  prompt    : \(prompt)")
            print("  threshold : \(threshold)")

            // Resolve repo root from cwd (the CLI is run from the repo root).
            // Walk up until we find python/venv/bin/python.
            var repoRoot = FileManager.default.currentDirectoryPath
            for _ in 0..<8 {
                let p = (repoRoot as NSString).appendingPathComponent("python/venv/bin/python")
                if FileManager.default.isExecutableFile(atPath: p) { break }
                repoRoot = (repoRoot as NSString).deletingLastPathComponent
            }
            let bridge = (repoRoot as NSString)
                .appendingPathComponent("python/mlx-movie-director/app/tests/sam3_segment_bridge.py")
            let python = (repoRoot as NSString)
                .appendingPathComponent("python/venv/bin/python")
            guard FileManager.default.isExecutableFile(atPath: python) else {
                throw ValidationError("python venv not found at \(python)")
            }
            guard FileManager.default.fileExists(atPath: bridge) else {
                throw ValidationError("SAM3 bridge not found at \(bridge)")
            }

            let outURL = URL(fileURLWithPath: output)
            try FileManager.default.createDirectory(
                at: outURL.deletingLastPathComponent(),
                withIntermediateDirectories: true)

            let process = Process()
            process.executableURL = URL(fileURLWithPath: python)
            process.arguments = [
                bridge,
                "--image", image,
                "--prompt", prompt,
                "--out-mask", output,
                "--threshold", String(threshold),
            ]
            // Inherit stdout/stderr so the user sees SAM3 load + detection logs.
            try process.run()
            process.waitUntilExit()
            if process.terminationStatus != 0 {
                throw NSError(domain: "flux2 segment", code: 1,
                              userInfo: [NSLocalizedDescriptionKey: "SAM3 bridge exited \(process.terminationStatus)"])
            }

            // Read the JSON metadata sidecar.
            let metaURL = URL(fileURLWithPath: output + ".json")
            if let data = try? Data(contentsOf: metaURL),
               let meta = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                let count = meta["count"] as? Int ?? 0
                let bestScore = meta["best_score"] as? Double
                print("")
                if count == 0 {
                    print("⚠️  no detections — saved empty mask: \(output)")
                } else {
                    print("✅ \(count) detection(s); best score=\(String(format: "%.3f", bestScore ?? 0))")
                    print("   mask: \(output)")
                }
            } else {
                print("   mask: \(output)")
            }
        }
    }
}
