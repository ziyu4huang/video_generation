//
//  GateCommand.swift
//  Flux2DirectorCLI
//
//  `flux2 gate` — run the shared ImageGate on arbitrary image files.
//  Used by shell pipelines and scene-gallery.ts (canonical, VLM-free quality gate).
//  Loads each PNG/JPG at NATIVE size (no resize) so neighbor_diff stays accurate.
//

import ArgumentParser
import CommonImageDirector
import Flux2Director
import CoreGraphics
import Foundation
import ImageIO
import MLX

extension Flux2CLI {
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

            var results: [(path: String, verdict: ImageGateVerdict?)] = []
            for path in images {
                let url = URL(fileURLWithPath: path)
                guard let size = nativeSize(url: url) else {
                    results.append((path, nil))
                    continue
                }
                let arr = try Flux2ImageLoad.loadArray(from: url, targetSize: size)
                let v = ImageGate.verdict(ImageGate.analyze(arr))
                results.append((path, v))
            }

            if json {
                let arr: [[String: Any]] = results.map { (path, v) in
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
                    return ["path": path, "status": "FAIL", "reason": "could not read image"]
                }
                let data = try JSONSerialization.data(
                    withJSONObject: arr, options: [.prettyPrinted, .sortedKeys])
                print(String(data: data, encoding: .utf8) ?? "[]")
            } else {
                for (path, v) in results {
                    if let v = v {
                        let icon = v.status == .pass ? "✅" : v.status == .warn ? "⚠️ " : "❌"
                        print("\(icon) \(v.status.rawValue)  \(path)")
                        print("     \(v.reason)  [nbr=\(f(v.metrics.neighborDiff)) ent=\(f(v.metrics.entropyBits)) std=\(f(v.metrics.overallStd))]")
                    } else {
                        print("❌ FAIL  \(path)")
                        print("     could not read image")
                    }
                }
            }

            let failed = results.contains { (_, v) in
                v == nil || v?.status == .fail || (strict && v?.status == .warn)
            }
            if failed { throw ExitCode.failure }
        }

        /// Read native pixel dimensions (no decode) for accurate native-size loading.
        private func nativeSize(url: URL) -> (width: Int, height: Int)? {
            guard let src = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
            guard let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any] else {
                return nil
            }
            guard let w = props[kCGImagePropertyPixelWidth] as? Int,
                  let h = props[kCGImagePropertyPixelHeight] as? Int else { return nil }
            return (w, h)
        }

        private func f(_ d: Double) -> String { String(format: "%.2f", d) }
    }
}
