//
//  CutoutCommand.swift
//  Flux2DirectorCLI
//
//  `flux2 cutout` — transparent-background cutout via SAM3 text
//  segmentation (port of image-cutout.py). SAM3 segmentation runs through
//  the existing Python subprocess bridge (sam3_segment_bridge.py — the
//  SAME one `flux2 segment` already calls, unchanged); the alpha
//  compositing (RGB + mask → transparent RGBA PNG) is new, self-contained
//  Swift code — no model in the compositing loop, subject pixels preserved
//  verbatim. Architecturally this command has no model-loading/RunConfig
//  (unlike InpaintCommand/StyleTransferCommand) — it mirrors
//  SegmentCommand.swift's shape instead.
//
//  --feather/--fill-holes are NOT exposed: the bridge feathers with a fixed
//  radius of 10 and never fills interior holes; v1 reuses it unchanged. See
//  docs/superpowers/specs/2026-07-31-cutout-swift-native-port-design.md.
//

import ArgumentParser
import CommonImageDirector
import Flux2Director
import Foundation
import MLX

extension Flux2CLI {
    struct Cutout: ParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "cutout",
            abstract: "Transparent-background cutout via SAM3 text segmentation (no regeneration)."
        )

        @Option(help: "Source image path.")
        var input: String

        @Option(help: "SAM3 text prompt for the subject to cut out (e.g. 'woman', 'coffee cup'). Falls back to --prompt if omitted.")
        var subject: String?

        @Option(help: "Fallback subject text if --subject is omitted.")
        var prompt: String = ""

        @Option(name: .customLong("sam-threshold"), help: "SAM3 detection score threshold (0-1).")
        var samThreshold: Float = 0.3

        @Flag(help: "Crop the result to the alpha bounding box + 5% margin.")
        var trim: Bool = false

        @Flag(name: .customLong("save-mask"), help: "Also save the SAM3 mask + a green-tint overlay alongside the cutout, for inspection.")
        var saveMask: Bool = false

        @Option(help: "Output RGBA PNG path.")
        var output: String

        func validate() throws {
            guard !resolveSubject().isEmpty else {
                throw ValidationError("a subject is required — pass --subject <text> and/or --prompt <text>.")
            }
        }

        private func resolveSubject() -> String {
            (subject?.isEmpty == false) ? subject! : prompt
        }

        func run() throws {
            setbuf(stdout, nil)
            let resolvedSubject = resolveSubject()
            print("flux2 cutout — transparent-background cutout")
            print("  input     : \(input)")
            print("  subject   : \(resolvedSubject)")
            print("  threshold : \(samThreshold)  trim: \(trim)  save-mask: \(saveMask)")

            let (width, height) = try Flux2ImageLoad.imageSize(at: URL(fileURLWithPath: input))

            let outputURL = URL(fileURLWithPath: output)
            try FileManager.default.createDirectory(
                at: outputURL.deletingLastPathComponent(), withIntermediateDirectories: true)

            let tempMask = URL(fileURLWithPath: NSTemporaryDirectory())
                .appendingPathComponent("flux2-cutout-\(UUID().uuidString).png")
            defer {
                try? FileManager.default.removeItem(at: tempMask)
                try? FileManager.default.removeItem(at: tempMask.appendingPathExtension("json"))
            }

            try Self.runSAM3Bridge(image: input, prompt: resolvedSubject,
                                    outMask: tempMask.path, threshold: samThreshold)

            let metaURL = tempMask.appendingPathExtension("json")
            guard let data = try? Data(contentsOf: metaURL),
                  let meta = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                throw NSError(domain: "flux2 cutout", code: 1,
                              userInfo: [NSLocalizedDescriptionKey: "could not read SAM3 mask metadata at \(metaURL.path)"])
            }
            let count = meta["count"] as? Int ?? 0
            if count == 0 {
                print("[cutout] No detections for '\(resolvedSubject)'. Try lowering --sam-threshold.")
                throw ExitCode(2)
            }
            let bestScore = meta["best_score"] as? Double ?? 0
            let bestBox = meta["best_box"] as? [Double] ?? []
            let boxStr = bestBox.count == 4
                ? "(\(Int(bestBox[0])),\(Int(bestBox[1])),\(Int(bestBox[2])),\(Int(bestBox[3])))"
                : "(?)"
            print("[cutout] Best: score=\(String(format: "%.3f", bestScore)) box=\(boxStr)")

            let rgb = try Flux2ImageLoad.loadArray(from: URL(fileURLWithPath: input),
                                                    targetSize: (width, height))
            let alpha = try Flux2ImageLoad.loadMaskAsChannel(from: tempMask, width: width, height: height)

            var outRGB = rgb
            var outAlpha = alpha
            if trim {
                (outRGB, outAlpha) = Self.trimToAlpha(rgb: outRGB, alpha: outAlpha, padding: 0.05)
            }

            try ImageSave.savePNGRGBA(rgb: outRGB, alpha: outAlpha, to: outputURL)
            print("")
            print("✅ cutout saved: \(outputURL.path)")

            if saveMask {
                try Self.saveMaskDebug(rgb: outRGB, alpha: outAlpha, outputBase: outputURL)
            }
        }

        /// Invoke the SAM3.1 subprocess bridge (python/mlx-movie-director/
        /// app/tests/sam3_segment_bridge.py) — the same one `flux2 segment`
        /// (SegmentCommand.swift) already calls. Duplicated rather than
        /// shared: both are ~15-line leaf CLI commands and there is no
        /// existing shared module to host a helper for just two callers.
        static func runSAM3Bridge(image: String, prompt: String, outMask: String, threshold: Float) throws {
            var repoRoot = FileManager.default.currentDirectoryPath
            for _ in 0..<8 {
                let p = (repoRoot as NSString).appendingPathComponent("python/venv/bin/python")
                if FileManager.default.isExecutableFile(atPath: p) { break }
                repoRoot = (repoRoot as NSString).deletingLastPathComponent
            }
            let bridge = (repoRoot as NSString)
                .appendingPathComponent("python/mlx-movie-director/app/tests/sam3_segment_bridge.py")
            let python = (repoRoot as NSString).appendingPathComponent("python/venv/bin/python")
            guard FileManager.default.isExecutableFile(atPath: python) else {
                throw ValidationError("python venv not found at \(python)")
            }
            guard FileManager.default.fileExists(atPath: bridge) else {
                throw ValidationError("SAM3 bridge not found at \(bridge)")
            }

            let process = Process()
            process.executableURL = URL(fileURLWithPath: python)
            process.arguments = [
                bridge,
                "--image", image,
                "--prompt", prompt,
                "--out-mask", outMask,
                "--threshold", String(threshold),
            ]
            // Inherit stdout/stderr so the user sees SAM3 load + detection logs.
            try process.run()
            process.waitUntilExit()
            if process.terminationStatus != 0 {
                throw NSError(domain: "flux2 cutout", code: 2,
                              userInfo: [NSLocalizedDescriptionKey: "SAM3 bridge exited \(process.terminationStatus)"])
            }
        }

        /// Bounding box of non-zero alpha + `padding` fraction margin on each
        /// side (mirrors Python's `_trim_to_alpha`, image-cutout.py). Crops
        /// both rgb (1,3,H,W) and alpha (1,1,H,W) to the same box. No-op if
        /// alpha is all-zero (mirrors Python's early return).
        static func trimToAlpha(rgb: MLXArray, alpha: MLXArray, padding: Float) -> (MLXArray, MLXArray) {
            let height = alpha.shape[2]
            let width = alpha.shape[3]
            let flat = alpha.reshaped([height, width]).asType(.float32)
            MLX.eval(flat)
            let a = flat.asArray(Float.self)

            var yMin = -1, yMax = -1, xMin = width, xMax = -1
            for y in 0..<height {
                var rowHasAlpha = false
                for x in 0..<width where a[y * width + x] > 0 {
                    rowHasAlpha = true
                    if x < xMin { xMin = x }
                    if x > xMax { xMax = x }
                }
                if rowHasAlpha {
                    if yMin == -1 { yMin = y }
                    yMax = y
                }
            }
            guard yMin >= 0 else { return (rgb, alpha) }

            let bw = xMax - xMin + 1
            let bh = yMax - yMin + 1
            let px = Int(Float(max(bw, bh)) * padding)
            let cropYMin = max(0, yMin - px)
            let cropYMax = min(height - 1, yMax + px)
            let cropXMin = max(0, xMin - px)
            let cropXMax = min(width - 1, xMax + px)

            let croppedRGB = rgb[0..., 0..., cropYMin..<(cropYMax + 1), cropXMin..<(cropXMax + 1)]
            let croppedAlpha = alpha[0..., 0..., cropYMin..<(cropYMax + 1), cropXMin..<(cropXMax + 1)]
            return (croppedRGB, croppedAlpha)
        }

        /// `--save-mask`: `<output>_mask.png` (the bridge's already-feathered
        /// alpha, re-saved as a grayscale PNG via the existing opaque
        /// `savePNG`, broadcasting the single alpha channel to all 3 RGB
        /// channels) + `<output>_overlay.png` (a continuous alpha-weighted
        /// green tint). This deliberately differs from Python's hard
        /// binary-mask overlay — the bridge only ever returns a feathered
        /// mask, not Python's pre-feather binary one; see design spec §1.5.
        static func saveMaskDebug(rgb: MLXArray, alpha: MLXArray, outputBase: URL) throws {
            let base = outputBase.deletingPathExtension().lastPathComponent
            let dir = outputBase.deletingLastPathComponent()
            let maskURL = dir.appendingPathComponent("\(base)_mask.png")
            let overlayURL = dir.appendingPathComponent("\(base)_overlay.png")

            let maskRGB = MLX.concatenated([alpha, alpha, alpha], axis: 1)
            try ImageSave.savePNG(maskRGB, to: maskURL)

            let green = MLXArray([Float(0.0), Float(1.0), Float(0.0)], [1, 3, 1, 1])
            let overlay = rgb * (1.0 - 0.5 * alpha) + green * (0.5 * alpha)
            try ImageSave.savePNG(overlay, to: overlayURL)

            print("   mask:    \(maskURL.path)")
            print("   overlay: \(overlayURL.path)")
        }
    }
}
