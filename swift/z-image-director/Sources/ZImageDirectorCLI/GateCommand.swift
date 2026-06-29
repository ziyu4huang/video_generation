//
//  GateCommand.swift
//  ZImageDirectorCLI
//
//  `zimage gate` — run the shared ImageGate on arbitrary image files.
//  Canonical, VLM-free quality gate for shell pipelines and scene-gallery.ts.
//  Loads each PNG/JPG at NATIVE size (targetSize nil → no resize) so the
//  neighbor-diff metric stays accurate.
//

import ArgumentParser
import CommonImageDirector
import Foundation
import MLX
import ZImageDirector

extension ZImageCLI {
    struct Gate: ParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "gate",
            abstract: "Run the shared ImageGate on image files (noise / blank / NaN detector)."
        )

        @Argument(help: "Image file(s) to gate.")
        var images: [String]

        @Flag(help: "Emit machine-readable JSON (one array).")
        var json = false

        @Flag(help: "Treat WARN as failure too (exit 1).")
        var strict = false

        func run() throws {
            setbuf(stdout, nil)
            guard !images.isEmpty else {
                throw ValidationError("at least one image path is required")
            }

            var results: [(path: String, verdict: ImageGateVerdict?, error: String?)] = []
            for path in images {
                let url = URL(fileURLWithPath: path)
                do {
                    let arr = try ImageLoad.loadArray(from: url)  // native size
                    let v = ImageGate.verdict(ImageGate.analyze(arr))
                    results.append((path, v, nil))
                } catch {
                    results.append((path, nil, "could not read image"))
                }
            }

            if json {
                let arr: [[String: Any]] = results.map { (path, v, err) in
                    if let v = v {
                        return [
                            "path": path, "status": v.status.rawValue, "reason": v.reason,
                            "neighbor_diff": v.metrics.neighborDiff,
                            "entropy_bits": v.metrics.entropyBits,
                            "overall_std": v.metrics.overallStd,
                            "near_black": v.metrics.nearBlack, "near_white": v.metrics.nearWhite,
                            "unique_frac": v.metrics.uniqueFrac, "finite": v.metrics.finite ? 1 : 0,
                            "width": v.metrics.width, "height": v.metrics.height,
                        ]
                    }
                    return ["path": path, "status": "FAIL", "reason": err ?? "unknown"]
                }
                let data = try JSONSerialization.data(
                    withJSONObject: arr, options: [.prettyPrinted, .sortedKeys])
                print(String(data: data, encoding: .utf8) ?? "[]")
            } else {
                for (path, v, err) in results {
                    if let v = v {
                        let icon = v.status == .pass ? "✅" : v.status == .warn ? "⚠️ " : "❌"
                        print("\(icon) \(v.status.rawValue)  \(path)")
                        print("     \(v.reason)  [nbr=\(f(v.metrics.neighborDiff)) ent=\(f(v.metrics.entropyBits)) std=\(f(v.metrics.overallStd))]")
                    } else {
                        print("❌ FAIL  \(path)")
                        print("     \(err ?? "error")")
                    }
                }
            }

            let failed = results.contains { _, v, _ in
                v == nil || v?.status == .fail || (strict && v?.status == .warn)
            }
            if failed { throw ExitCode.failure }
        }

        private func f(_ d: Double) -> String { String(format: "%.2f", d) }
    }
}
