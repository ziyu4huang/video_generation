# cutout Swift-native port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port `image cutout` (transparent-background subject cutout via SAM3 text segmentation) off Python onto a new native Swift `flux2 cutout` CLI command, then repoint the TS agent bridge at it.

**Architecture:** SAM3 segmentation stays on the existing Python subprocess bridge (`sam3_segment_bridge.py`) — the same one `flux2 segment` already calls, unchanged. What's missing is purely the downstream alpha-compositing (RGB + mask → transparent RGBA PNG), which is new, self-contained Swift code: a new `ImageSave.savePNGRGBA` (real-alpha PNG writer, `common-image-director`) plus a new `CutoutCommand.swift` that invokes the bridge, composites via MLX arrays, optionally trims to the alpha bbox, and optionally dumps mask/overlay debug files. `CutoutCommand` follows `SegmentCommand.swift`'s shape (no model loading, no `RunConfig`, explicit `--output`) — it is architecturally NOT a generation command like `InpaintCommand`/`StyleTransferCommand`.

**Tech Stack:** Swift/MLX (`swift/common-image-director`, `swift/flux2-image-director`), TypeScript/Bun (`bun-apps/pi-agent-ext-flux2`, `bun-apps/pi-agent-ext-movie-director`), Python (verification script only, no production changes).

---

## Task 1: `ImageSave.savePNGRGBA`

**Files:**
- Modify: `swift/common-image-director/Sources/CommonImageDirector/ImageSave.swift`

This is a pure, model-free function — no unit-test harness exists in this repo for `common-image-director` (no XCTest target is declared in its `Package.swift`). Verify by build only here; the real functional check happens in Task 2's smoke test, which is the first actual caller.

- [ ] **Step 1: Add `savePNGRGBA` to `ImageSave.swift`**

Open `swift/common-image-director/Sources/CommonImageDirector/ImageSave.swift`. Add this new function inside `public enum ImageSave { ... }`, right after the existing `savePNG` function (after its closing `}` on line 70, before the enum's closing `}` on line 71):

```swift

    /// Save `rgb` (1, 3, H, W) float32 [0,1] + `alpha` (1, 1, H, W) float32
    /// [0,1] to a real RGBA PNG file. Unlike `savePNG` (always opaque,
    /// `.noneSkipLast`), this writes `.last` — a genuine alpha channel.
    public static func savePNGRGBA(rgb: MLXArray, alpha: MLXArray, to url: URL) throws {
        let dims = rgb.shape
        precondition(dims.count == 4 && dims[0] == 1 && dims[1] == 3,
                     "expected rgb (1, 3, H, W), got \(dims)")
        let height = dims[2]
        let width = dims[3]
        precondition(alpha.shape == [1, 1, height, width],
                     "expected alpha (1, 1, \(height), \(width)), got \(alpha.shape)")

        let flatRGB = rgb.reshaped([3, height, width]).asType(.float32)
        let flatA = alpha.reshaped([height, width]).asType(.float32)
        MLX.eval(flatRGB, flatA)
        let rArr = flatRGB[0].asArray(Float.self)
        let gArr = flatRGB[1].asArray(Float.self)
        let bArr = flatRGB[2].asArray(Float.self)
        let aArr = flatA.asArray(Float.self)

        var rgba = [UInt8](repeating: 0, count: width * height * 4)
        for idx in 0..<(width * height) {
            let outIdx = idx * 4
            rgba[outIdx]     = UInt8(max(0, min(255, rArr[idx] * 255)))
            rgba[outIdx + 1] = UInt8(max(0, min(255, gArr[idx] * 255)))
            rgba[outIdx + 2] = UInt8(max(0, min(255, bArr[idx] * 255)))
            rgba[outIdx + 3] = UInt8(max(0, min(255, aArr[idx] * 255)))
        }

        let colorSpace = CGColorSpaceCreateDeviceRGB()
        // kCGImageAlphaLast = real RGBA (unlike savePNG's opaque .noneSkipLast).
        let alphaInfo = CGImageAlphaInfo.last.rawValue
        let orderInfo = CGBitmapInfo.byteOrder32Big.rawValue
        let bitmapInfo = CGBitmapInfo(rawValue: alphaInfo | orderInfo)
        let provider = CGDataProvider(data: Data(rgba) as CFData)!
        guard let cgImage = CGImage(
            width: width, height: height,
            bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: width * 4,
            space: colorSpace, bitmapInfo: bitmapInfo,
            provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent
        ) else {
            throw NSError(domain: "ImageSave", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "CGImage creation failed"])
        }

        var fileURL = url
        if fileURL.pathExtension.lowercased() != "png" {
            fileURL = fileURL.appendingPathExtension("png")
        }
        guard let dest = CGImageDestinationCreateWithURL(
            fileURL as CFURL, UTType.png.identifier as CFString, 1, nil
        ) else {
            throw NSError(domain: "ImageSave", code: 2,
                          userInfo: [NSLocalizedDescriptionKey: "CGImageDestination creation failed"])
        }
        CGImageDestinationAddImage(dest, cgImage, nil)
        guard CGImageDestinationFinalize(dest) else {
            throw NSError(domain: "ImageSave", code: 3, userInfo: [NSLocalizedDescriptionKey: "PNG write failed"])
        }
    }
```

`savePNG` itself is untouched — every existing caller (all opaque-image
generation commands) keeps working exactly as before.

- [ ] **Step 2: Build `common-image-director`**

Run: `swift build -c release --package-path swift/common-image-director`
Expected: build succeeds with no errors.

- [ ] **Step 3: Commit**

```bash
git add swift/common-image-director/Sources/CommonImageDirector/ImageSave.swift
git commit -m "feat(common-image-director): add ImageSave.savePNGRGBA (real-alpha PNG writer)"
```

---

## Task 2: `CutoutCommand.swift`

**Files:**
- Create: `swift/flux2-image-director/Sources/Flux2DirectorCLI/CutoutCommand.swift`
- Modify: `swift/flux2-image-director/Sources/Flux2DirectorCLI/Flux2CLI.swift`

Like Task 1, this command has no unit-test harness in this repo (like `SegmentCommand`/`StyleTransferCommand`, it's verified by build + a real smoke-test run, not XCTest). Follow the steps below in order.

- [ ] **Step 1: Create `CutoutCommand.swift`**

```swift
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
            let resolved = (subject?.isEmpty == false) ? subject! : prompt
            guard !resolved.isEmpty else {
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
                exit(2)
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

            let outputURL = URL(fileURLWithPath: output)
            try FileManager.default.createDirectory(
                at: outputURL.deletingLastPathComponent(), withIntermediateDirectories: true)
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
```

- [ ] **Step 2: Register the command in `Flux2CLI.swift`**

Open `swift/flux2-image-director/Sources/Flux2DirectorCLI/Flux2CLI.swift`. Find the `subcommands:` array and add `Cutout.self` right after `Segment.self`:

```swift
        subcommands: [
            T2I.self, Edit.self, Angle.self, Segment.self, Cutout.self, Swap.self, Style.self,
            Story.self, Kontext.self, Scene.self, Expand.self, Inpaint.self, StyleTransfer.self, FaceSwap.self, Upscale.self, Gate.self, Models.self, VerifyVAE.self, VerifyEncoder.self,
            VerifyTokenizer.self, VerifyTransformer.self, VerifyE2E.self,
            VerifyEdit.self, KVStyleTransfer.self, VerifyKontextTransformerShape.self,
            VerifyKontextTransformer.self, VerifyKontextVAE.self,
            VerifyKontextCLIP.self, VerifyKontextT5.self,
            VerifyKontextCLIPTokenizer.self, VerifyKontextT5Tokenizer.self,
        ]
```

- [ ] **Step 3: Build**

Run: `swift build -c release --package-path swift/flux2-image-director`
Expected: build succeeds with no errors (warnings about unrelated pre-existing code are fine).

- [ ] **Step 4: Smoke test against a real image**

Synthesize a source image with a clearly segmentable subject (a red circle
on a sky-gradient background — same fixture shape as `image-cutout.py`'s own
`--self-test`):

```bash
python/venv/bin/python -c "
from PIL import Image, ImageDraw
import numpy as np
w, h = 640, 480
grad = np.zeros((h, w, 3), dtype=np.uint8)
for y in range(h):
    t = y / max(1, h - 1)
    grad[y, :, 0] = int(135 * (1 - t) + 200 * t)
    grad[y, :, 1] = int(206 * (1 - t) + 230 * t)
    grad[y, :, 2] = int(235 * (1 - t) + 255 * t)
src = Image.fromarray(grad, mode='RGB')
draw = ImageDraw.Draw(src)
cx, cy, r = int(w * 0.5), int(h * 0.5), 90
draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(220, 40, 40))
src.save('/tmp/cutout-smoke-src.png')
print('wrote /tmp/cutout-smoke-src.png')
"
```

Then run the new Swift command against it:

```bash
swift/flux2-image-director/.build/release/flux2 cutout \
  --input /tmp/cutout-smoke-src.png --subject "red balloon" \
  --output /tmp/cutout-smoke-out.png --trim --save-mask
```

Expected: exits 0, prints `[cutout] Best: score=... box=(...)`, then
`✅ cutout saved: /tmp/cutout-smoke-out.png`, then `mask:`/`overlay:` lines.
Open `/tmp/cutout-smoke-out.png` and confirm: background is transparent
(checkerboard in an image viewer that shows alpha), the red circle is
opaque and preserved, and the canvas is cropped tighter than the original
640×480 (the `--trim` bbox). Open `/tmp/cutout-smoke-out_overlay.png` and
confirm the circle region is tinted green.

- [ ] **Step 5: Commit**

```bash
git add swift/flux2-image-director/Sources/Flux2DirectorCLI/CutoutCommand.swift \
        swift/flux2-image-director/Sources/Flux2DirectorCLI/Flux2CLI.swift
git commit -m "feat(flux2): add cutout command (SAM3 bridge + Swift-native alpha compositing)"
```

---

## Task 3: TS command definition (`pi-agent-ext-flux2`)

**Files:**
- Modify: `bun-apps/pi-agent-ext-flux2/src/commands.ts`
- Modify: `bun-apps/pi-agent-ext-flux2/src/commands.test.ts`

- [ ] **Step 1: Update the failing test first**

Open `bun-apps/pi-agent-ext-flux2/src/commands.test.ts`. Find the test
`"has exactly the 23 documented flux2 subcommands"` and change it to 24,
adding `"cutout"` to the array:

```ts
  test("has exactly the 24 documented flux2 subcommands", () => {
    expect(Object.keys(COMMANDS).sort()).toEqual(
      [
        "angle", "cutout", "edit", "expand", "faceswap", "gate", "inpaint", "kontext", "kv-style-transfer", "models", "scene", "segment",
        "story", "style", "styletransfer", "swap", "t2i", "upscale",
        "verify-e2e", "verify-edit", "verify-encoder", "verify-tokenizer",
        "verify-transformer", "verify-vae",
      ].sort(),
    );
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd bun-apps/pi-agent-ext-flux2 && bun test src/commands.test.ts`
Expected: FAIL — `Object.keys(COMMANDS).sort()` is missing `"cutout"` (23 actual vs 24 expected).

- [ ] **Step 3: Add the `cutout` entry to `COMMANDS`**

Open `bun-apps/pi-agent-ext-flux2/src/commands.ts`. Find the `segment:`
entry and insert a new `cutout:` entry right after its closing `},` (before
the `story:` entry):

```ts
  cutout: {
    name: "cutout",
    writesImage: true,
    when: "Transparent-background cutout: SAM3 text segmentation → alpha-composited RGBA PNG. No regeneration — subject pixels preserved verbatim.",
    fields: {
      input: { flag: "--input", type: "string", isPath: true, description: "Source image path." },
      subject: { flag: "--subject", type: "string", description: "SAM3 text prompt for the subject to cut out (e.g. 'woman', 'coffee cup'). Falls back to --prompt if omitted." },
      prompt: { flag: "--prompt", type: "string", description: "Fallback subject text if --subject is omitted." },
      samThreshold: { flag: "--sam-threshold", type: "number", description: "SAM3 detection score threshold (0-1). Default 0.3." },
      trim: { flag: "--trim", type: "boolean", description: "Crop the result to the alpha bounding box + 5% margin." },
      saveMask: { flag: "--save-mask", type: "boolean", description: "Also save the SAM3 mask + a green-tint overlay alongside the cutout, for inspection." },
      output: { flag: "--output", type: "string", isPath: true, description: "Output RGBA PNG path." },
    },
  },

```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd bun-apps/pi-agent-ext-flux2 && bun test src/commands.test.ts`
Expected: PASS (all tests, including the field-validity and
name-matches-key generic tests that iterate every `COMMANDS` entry).

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-flux2/src/commands.ts bun-apps/pi-agent-ext-flux2/src/commands.test.ts
git commit -m "feat(flux2-ext): add cutout to the COMMANDS dispatcher"
```

---

## Task 4: Registry routing (`pi-agent-ext-movie-director`)

**Files:**
- Modify: `bun-apps/pi-agent-ext-movie-director/src/registry.ts`
- Modify: `bun-apps/pi-agent-ext-movie-director/src/selector.test.ts`

- [ ] **Step 1: Update the failing test first**

Open `bun-apps/pi-agent-ext-movie-director/src/selector.test.ts`.

First, fix the stale comment above the
`"routes image_generation:<run.py-only command> → runpy-image"` test —
remove `cutout` from the enumeration and add a departure note, matching the
existing pattern for `kontext`/`styletransfer`:

```ts
  it("routes image_generation:<run.py-only command> → runpy-image (the force multiplier)", () => {
    // runpy_image declares purify/multicouple/storyboard —
    // commands the Swift directors don't claim. Command routing sends them
    // to the run.py adapter with no provider hint, unlocking local
    // capabilities the agent otherwise can't reach.
    // NOTE: "twosubject" moved OFF this adapter (2026-07-13) onto twosubject_native,
    // "restore" moved OFF (2026-07-13, session 3) onto krea2_image as an i2i alias,
    // "profile" moved OFF (2026-07-13, session 4) onto profile_native,
    // "controlnet" moved OFF (2026-07-13, session 3) onto controlnet_hybrid
    // (a style-forked native/python split, not a full move), "inpaint"
    // moved OFF (2026-07-13, session 5) onto flux2_image, "faceswap"
    // moved OFF (2026-07-13, session 4) onto flux2_image, "character"
    // moved OFF (2026-07-13, session 6) onto character_native, "kontext"
    // moved OFF (2026-07-29) onto flux2_image, "styletransfer" moved OFF
    // (2026-07-30) onto flux2_image, and "cutout" moved OFF (2026-07-31)
    // onto flux2_image — see the dedicated tests.
    // "multicouple" stays here permanently (genuine MLX/GPU latent-couple
    // compute, unportable).
    for (const cmd of ["multicouple"]) {
      const e = selectProvider("image_generation", { command: cmd, env: NO_ENV });
      expect(e.provider).toBe("runpy-image");
      expect(e.invoke).toBe("mlx:runpy-image");
    }
  });
```

Then add a new dedicated routing test right after the existing
`styletransfer` test (find `it("routes image_generation:styletransfer →
flux2 ...` and insert after its closing `});`, before the `i2i` test):

```ts

  it("routes image_generation:cutout → flux2 (Swift-native, CutoutCommand.swift)", () => {
    // 2026-07-31: image-cutout.py's SAM3 segmentation step already had a
    // working Python-subprocess bridge (sam3_segment_bridge.py) that Swift
    // calls today via `flux2 segment` — SAM3 itself stays out of the native
    // port (SegmentCommand.swift's own header comment: a full port would be
    // "a multi-day effort comparable to the entire Flux2 port"). This port
    // adds the missing piece: Swift-native alpha compositing (new
    // ImageSave.savePNGRGBA + CutoutCommand.swift, common-image-director/
    // flux2-image-director), reusing the bridge unchanged. Moved off
    // runpy_image onto flux2_image. --feather/--fill-holes configurability
    // stays deferred (the bridge has a fixed feather radius and never fills
    // holes) — see
    // docs/superpowers/specs/2026-07-31-cutout-swift-native-port-design.md.
    const e = selectProvider("image_generation", { command: "cutout", env: NO_ENV });
    expect(e.provider).toBe("flux2");
    expect(e.invoke).toBe("swift:flux2");
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd bun-apps/pi-agent-ext-movie-director && bun test src/selector.test.ts`
Expected: FAIL — the new `cutout` test fails because `registry.ts` still
routes `cutout` to `runpy_image`, not `flux2_image`.

- [ ] **Step 3: Move `cutout` in `registry.ts`**

Open `bun-apps/pi-agent-ext-movie-director/src/registry.ts`.

In the `flux2_image` entry, find the `commands:` array:

```ts
    commands: [
      "t2i", "scene", "edit", "style", "kv-style-transfer", "angle", "swap",
      "expand", "upscale", "gate", "segment", "story", "inpaint", "faceswap",
      "kontext", "styletransfer",
      "anime2real", "expansion", // legacy run.py aliases — see notes above
    ],
```

Change it to add `"cutout"`:

```ts
    commands: [
      "t2i", "scene", "edit", "style", "kv-style-transfer", "angle", "swap",
      "expand", "upscale", "gate", "segment", "story", "inpaint", "faceswap",
      "kontext", "styletransfer", "cutout",
      "anime2real", "expansion", // legacy run.py aliases — see notes above
    ],
```

Append an arrival sentence to `flux2_image`'s `notes` string (it currently
ends with `` ...see docs/superpowers/specs/2026-07-30-styletransfer-swift-native-port-design.md.", `` — insert the new sentence right before that closing
quote, keeping the trailing `.` at the very end):

```
 `cutout` moved here (2026-07-31) from runpy_image — image-cutout.py's SAM3 segmentation step already had a working Python-subprocess bridge (sam3_segment_bridge.py) that flux2's own `segment` command already calls; this port keeps that bridge unchanged and adds the missing downstream piece, Swift-native alpha compositing (new ImageSave.savePNGRGBA + CutoutCommand.swift) — no SAM3 port, no new pipeline/model code. DEFERRED to Python (documented, not silently dropped — see runpy_image if a caller still needs it): `--feather`/`--fill-holes` configurability (the bridge has a fixed feather radius of 10 and never fills interior holes), see docs/superpowers/specs/2026-07-31-cutout-swift-native-port-design.md.
```

Now find the `runpy_image` entry's `commands:` array:

```ts
    commands: [
      "purify", "multicouple",
      "storyboard",
      "cutout",
    ],
```

Remove `"cutout"`:

```ts
    commands: [
      "purify", "multicouple",
      "storyboard",
    ],
```

Append a departure sentence to `runpy_image`'s `notes` string. Find this
substring inside it —

```
`--playbook` style-source support stays here (no Swift/TS playbook YAML parser exists yet) — NOTE: command-routing now sends ALL `styletransfer` traffic to flux2_image by default (commands[] moved wholesale, not style-forked like controlnet_hybrid/workflow_hybrid above), so a `--playbook` caller must pass an explicit `provider: \"runpy-image\"` hint to reach this adapter; there is no request-shape-based fallback for it. Local MLX, never a cloud GAI API.
```

— and insert a new sentence right before `Local MLX, never a cloud GAI
API.` (keep that final sentence last):

```
`cutout` moved OFF this adapter (2026-07-31) onto flux2_image above — see that entry's notes; the SAM3 segmentation mechanism it needs was already Swift-native (flux2's own `segment` command, same bridge), just missing Swift-side alpha compositing. Local MLX, never a cloud GAI API.
```

Also update the earlier top-of-file comment block above the `runpy_image`
declaration (`// run.py image adapter — the force multiplier for the LONG
TAIL...`) — no change needed there, since it never enumerated `cutout` by
name; skip this.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd bun-apps/pi-agent-ext-movie-director && bun test src/selector.test.ts`
Expected: PASS (all tests, including the updated `<run.py-only command>` test and the new `cutout` routing test).

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-movie-director/src/registry.ts bun-apps/pi-agent-ext-movie-director/src/selector.test.ts
git commit -m "feat(movie-director-ext): route cutout to flux2 (Swift-native)"
```

---

## Task 5: End-to-end sanity comparison + final verification

**Files:**
- Create: `python/mlx-movie-director/app/tests/compare_cutout_e2e.py`

- [ ] **Step 1: Create `compare_cutout_e2e.py`**

```python
#!/usr/bin/env python3
"""compare_cutout_e2e.py — sanity comparison between the Swift `flux2
cutout` port and the Python `run.py image cutout` reference (Task 5 of
docs/superpowers/plans/2026-07-31-cutout-swift-native-port.md).

NOT a bit-exact numeric-parity gate: two independent SAM3-consuming
compositing paths can diverge slightly at mask edges even when both use the
same underlying SAM3 model/bridge. This checks both outputs are real
transparent cutouts (opaque subject core, transparent background corners)
and LOGS (does not gate on) their pixel cosine similarity as a diagnostic
for a human to judge convergence quality.

Run from repo root (requires a built flux2 Swift binary and a working
python/venv):
    python/venv/bin/python python/mlx-movie-director/app/tests/compare_cutout_e2e.py
"""
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

REPO = Path(__file__).resolve().parents[4]
SUBJECT = "red balloon"
THRESHOLD = 0.3


def synth_source(path: Path) -> None:
    """Same deterministic fixture as image-cutout.py's own --self-test
    _synth_source: a sky gradient with a red circle ('balloon') — easy for
    SAM3 to segment, so the comparison isn't gated by segmentation quality."""
    w, h = 640, 480
    grad = np.zeros((h, w, 3), dtype=np.uint8)
    for y in range(h):
        t = y / max(1, h - 1)
        grad[y, :, 0] = int(135 * (1 - t) + 200 * t)
        grad[y, :, 1] = int(206 * (1 - t) + 230 * t)
        grad[y, :, 2] = int(235 * (1 - t) + 255 * t)
    src = Image.fromarray(grad, mode="RGB")
    draw = ImageDraw.Draw(src)
    cx, cy, r = int(w * 0.5), int(h * 0.5), 90
    draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(220, 40, 40))
    src.save(path)


def load_rgba(path: Path) -> np.ndarray:
    return np.array(Image.open(path).convert("RGBA")).astype(np.float64)


def analyze(path: Path, label: str) -> np.ndarray:
    arr = load_rgba(path)
    H, W = arr.shape[:2]
    corners = [arr[0, 0, 3], arr[0, W - 1, 3], arr[H - 1, 0, 3], arr[H - 1, W - 1, 3]]
    center_alpha = arr[H // 2, W // 2, 3]
    print(f"\n[{label}] {path}")
    print(f"  shape={arr.shape}  corner alphas={corners} (expect ~0)  "
          f"center alpha={center_alpha:.1f} (expect >200)")
    ok = max(corners) <= 30.0 and center_alpha >= 180.0
    print(f"  {'PASS' if ok else 'FAIL'}: transparent background + opaque subject core")
    if not ok:
        sys.exit(1)
    return arr


def find_single_png(dir_path: Path) -> Path:
    """run.py image cutout has no --output flag — it writes an
    auto-timestamped <base_name>_cutout_<ts>.png (no sidecars, --save-mask
    not passed) into the generation output dir. Point --gen-output-dir at
    an empty tmp dir per call so exactly one .png is ever present."""
    pngs = sorted(dir_path.glob("*.png"))
    if len(pngs) != 1:
        print(f"ERROR: expected exactly 1 .png in {dir_path}, found {len(pngs)}: {pngs}",
              file=sys.stderr)
        sys.exit(1)
    return pngs[0]


def main() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        content_path = tmp_path / "src.png"
        python_out_dir = tmp_path / "python_cutout"
        python_out_dir.mkdir()
        swift_out = tmp_path / "swift.png"

        print("[compare_cutout_e2e] synthesizing a segmentable source image...")
        synth_source(content_path)

        print("[compare_cutout_e2e] running Swift flux2 cutout...")
        flux2_bin = REPO / "swift" / "flux2-image-director" / ".build" / "release" / "flux2"
        if not flux2_bin.exists():
            print(f"ERROR: {flux2_bin} not built — run: "
                  f"swift build -c release --package-path swift/flux2-image-director", file=sys.stderr)
            sys.exit(1)
        subprocess.run(
            [str(flux2_bin), "cutout", "--input", str(content_path),
             "--subject", SUBJECT, "--sam-threshold", str(THRESHOLD),
             "--output", str(swift_out)],
            check=True, cwd=REPO,
        )

        print("[compare_cutout_e2e] running run.py image cutout (Python reference)...")
        subprocess.run(
            [sys.executable, str(REPO / "python" / "mlx-movie-director" / "run.py"),
             "image", "cutout", "--input", str(content_path),
             "--subject", SUBJECT, "--sam-threshold", str(THRESHOLD),
             "--gen-output-dir", str(python_out_dir)],
            check=True, cwd=REPO,
        )
        python_out = find_single_png(python_out_dir)

        swift_arr = analyze(swift_out, "swift")
        python_arr = analyze(python_out, "python")

        if swift_arr.shape != python_arr.shape:
            # Diagnostic-only (see module docstring) — the pass/fail gate is
            # each analyze() call above, already satisfied independently.
            print(f"\n[compare_cutout_e2e] shape mismatch swift={swift_arr.shape} "
                  f"python={python_arr.shape} — skipping cosine similarity diagnostic")
        else:
            flat_s, flat_p = swift_arr.flatten(), python_arr.flatten()
            cos = float(np.dot(flat_s, flat_p) / (np.linalg.norm(flat_s) * np.linalg.norm(flat_p) + 1e-12))
            print(f"\n[compare_cutout_e2e] pixel cosine similarity (diagnostic, not gated): {cos:.4f}")

    print("\n✅ both outputs are real transparent cutouts")


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Run it**

Run: `python/venv/bin/python python/mlx-movie-director/app/tests/compare_cutout_e2e.py`
Expected: exits 0, both `[swift]`/`[python]` blocks print `PASS`, ends with
`✅ both outputs are real transparent cutouts`. If either side's `subject`
detection fails (`count == 0` in the Swift error path, or Python's
`sys.exit(2)` in `run_cutout`), lower `THRESHOLD` in the script or confirm
the SAM3 bridge itself works via `flux2 segment` first.

- [ ] **Step 3: Commit**

```bash
git add python/mlx-movie-director/app/tests/compare_cutout_e2e.py
git commit -m "test(cutout): add Swift-vs-Python E2E sanity comparison script"
```

- [ ] **Step 4: Final verification — schema check**

Run: `bun run --cwd bun-apps/gui-movie-director check:schema`
Expected: passes (the `registry.ts`/`commands.ts` changes from Tasks 3-4
don't break schema validation).

- [ ] **Step 5: Final verification — full test suites**

Run:
```bash
( cd bun-apps/pi-agent-ext-flux2 && bun test )
( cd bun-apps/pi-agent-ext-movie-director && bun test )
```
Expected: both suites pass in full (not just the files touched in Tasks 3-4).
