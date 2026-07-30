# styletransfer Swift-native port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port `image styletransfer` (preset/prompt-driven Flux2 Klein restyle) off Python onto a new native Swift `flux2 styletransfer` CLI command, then repoint the TS agent bridge at it.

**Architecture:** `Flux2EditPipeline.generate` already implements the exact SDEdit-style partial-denoise mechanism this needs (`initImagePath`/`denoiseStrength`, already wired by `InpaintCommand.swift` and `SceneCommand.swift`) — so this port needs zero new pipeline/model code. A new `StyleTransferCommand.swift` resolves a style prompt from `--style-preset`/`--prompt`, calls the existing pipeline with `imagePaths: []` (no identity refs), and writes artifacts. Then `commands.ts`/`registry.ts` move routing from the Python bridge onto this new Swift command, purely as data changes (no new invoke key or spawn code).

**Tech Stack:** Swift/MLX (`swift/flux2-image-director`), TypeScript/Bun (`bun-apps/pi-agent-ext-flux2`, `bun-apps/pi-agent-ext-movie-director`), Python (verification script only, no production changes).

---

## Task 1: `StyleTransferCommand.swift`

**Files:**
- Create: `swift/flux2-image-director/Sources/Flux2DirectorCLI/StyleTransferCommand.swift`
- Modify: `swift/flux2-image-director/Sources/Flux2DirectorCLI/Flux2CLI.swift`

This command has no unit-test harness in this repo (like `InpaintCommand`/`SceneCommand`/`KontextCommand`, it's a GPU-heavy MLX pipeline command — verification is build + a real smoke-test run against real checkpoints, not XCTest). Follow the steps below in order.

- [ ] **Step 1: Create `StyleTransferCommand.swift`**

```swift
//
//  StyleTransferCommand.swift
//  Flux2DirectorCLI
//
//  `flux2 styletransfer` — restyle a content image to a target visual
//  language (preset/prompt-driven), port of image-styletransfer.py.
//
//  Reuses Flux2EditPipeline.generate's existing initImagePath/denoiseStrength
//  params (SDEdit-style partial denoise, already wired by InpaintCommand's
//  --denoise-strength and SceneCommand's --bg/--bg-strength) — no new
//  denoise-loop or pipeline code, just CLI plumbing + style-prompt
//  resolution. Called with imagePaths: [] (no identity references — the
//  content image IS the canvas, not a reference).
//
//  --playbook style-source support (OM playbook YAML → image_prompt_prefix/
//  consistency_anchors/aesthetic) is deliberately OUT of v1 — no playbook
//  YAML parser exists anywhere in Swift/TS yet (see
//  docs/superpowers/specs/2026-07-30-styletransfer-swift-native-port-design.md).
//

import ArgumentParser
import CommonImageDirector
import Flux2Director
import Foundation
import MLX

extension Flux2CLI {
    struct StyleTransfer: ParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "styletransfer",
            abstract: "Restyle a content image to a target visual language (Flux2 Klein SDEdit img2img)."
        )

        @OptionGroup var globals: GlobalOptions

        @Option(help: "Content image path (structure preserved).")
        var input: String

        @Option(name: .customLong("style-preset"),
                help: "Named style preset: clean-professional | watercolor | oil-painting | anime | cinematic | 3d-render | line-art | low-poly.")
        var stylePreset: String?

        @Option(help: "Free-form style description (amplifies or overrides the preset).")
        var prompt: String = ""

        @Option(help: "Style strength = img2img denoise (0-1]. Lower preserves more content structure; higher applies the style harder.")
        var strength: Float = 0.55

        @Option var transformer: String = Flux2ModelRegistry.defaultTransformer
        @Option var seed: UInt64 = 42
        @Option var width: Int = 1024
        @Option var height: Int = 1024
        @Option var steps: Int = 4
        @Option var cfgScale: Float = 1.0
        @Option var output: String = ""
        @Option var outputDir: String?
        @Option var name: String?
        @Option var vae: String = Flux2ModelRegistry.defaultVAE
        @Option var encoder: String = Flux2ModelRegistry.defaultTextEncoder
        @Option var tokenizerDir: String = Flux2ModelRegistry.defaultTokenizer
        @Flag var noArtifacts: Bool = false

        @Flag(help: "Abort (exit 1) if the output FAILs the image gate.")
        var strictGate: Bool = false

        /// LoRA name(s) (directories under models/lora/), repeatable. Multiple
        /// are rank-stacked into one merged adapter (see Flux2LoRALoader.merge).
        @Option(help: "LoRA name under models/lora/ (repeatable: --lora A --lora B stacks them).")
        var lora: [String] = []
        @Option(help: "Per-LoRA scale (repeatable, one per --lora; trailing ones default to 1.0).")
        var loraScale: [Float] = []

        static let stylePresets: [String: String] = [
            "clean-professional": "clean professional flat illustration, corporate style, white background, blue and orange accents, soft even lighting, generous whitespace, no grain, vector aesthetic",
            "watercolor": "loose watercolor painting, soft pigment bleeds, wet-on-wet washes, delicate color transitions, textured paper, hand-painted, artistic",
            "oil-painting": "classical oil painting, rich visible brushstrokes, warm golden lighting, chiaroscuro, museum-quality portraiture, impasto texture",
            "anime": "anime key visual, cel-shaded, clean line art, vibrant flat colors, detailed eyes, studio anime production, high quality",
            "cinematic": "cinematic film still, dramatic volumetric lighting, shallow depth of field, teal-and-orange color grade, anamorphic, 35mm film grain, moody atmosphere",
            "3d-render": "3D render, soft global illumination, subsurface scattering, Pixar-style stylized characters, rounded forms, polished materials",
            "line-art": "clean line art, single-weight ink outlines, minimal shading, monochrome, technical illustration, crisp vector strokes",
            "low-poly": "low-poly 3D illustration, faceted geometric surfaces, flat-shaded triangles, stylized minimal palette, isometric, clean",
        ]

        func validate() throws {
            guard strength > 0 && strength <= 1.0 else {
                throw ValidationError("--strength must be in (0, 1.0]")
            }
            if let stylePreset, !stylePreset.isEmpty {
                guard Self.stylePresets[stylePreset.lowercased()] != nil else {
                    throw ValidationError(
                        "unknown --style-preset '\(stylePreset)'. Available: "
                        + Self.stylePresets.keys.sorted().joined(separator: ", "))
                }
            } else if prompt.isEmpty {
                throw ValidationError("a style source is required — pass --style-preset <preset> and/or --prompt <text>.")
            }
        }

        private func resolveStylePrompt() -> String {
            var parts: [String] = []
            if let stylePreset, let text = Self.stylePresets[stylePreset.lowercased()] {
                parts.append(text)
            }
            if !prompt.isEmpty { parts.append(prompt) }
            return parts.joined(separator: ", ")
        }

        func run() throws {
            setbuf(stdout, nil)
            globals.apply()

            let stylePrompt = resolveStylePrompt()
            print("flux2 styletransfer — restyle to target visual language")
            print("  input     : \(input)")
            print("  style     : \(stylePrompt.prefix(100))\(stylePrompt.count > 100 ? "…" : "")")
            print("  strength  : \(strength), steps: \(steps), size: \(width)×\(height), seed: \(seed)")

            let (loraAdapters, loraNames, _) = try Flux2LoRALoaderCLI.loadMerged(
                names: lora, scales: loraScale, logPrefix: "  lora      : ")
            if !loraNames.isEmpty {
                print("               merged \(loraAdapters.adapters.count) adapters from \(loraNames.count) LoRA(s)")
            }

            print("  loading models...")
            let tfW = try Flux2TransformerWeights.load(
                dir: ModelPaths.transformerRoot.appendingPathComponent(transformer))
            let tf = Flux2Transformer.build(weights: tfW, lora: loraAdapters)
            let teW = try Flux2TextEncoderWeights.load(
                dir: ModelPaths.textEncoderRoot.appendingPathComponent(encoder))
            let te = Flux2TextEncoder.build(weights: teW)
            let tok = Flux2Tokenizer(jsonURL: ModelPaths.tokenizerRoot
                .appendingPathComponent(tokenizerDir).appendingPathComponent("tokenizer.json"))!
            let vaeURL = ModelPaths.vaeRoot.appendingPathComponent(vae)
            let vaeWeights = try loadAllShards(url: vaeURL)
            let bn = Flux2BatchNormStats(
                runningMean: vaeWeights["bn.running_mean"]!,
                runningVar: vaeWeights["bn.running_var"]!)
            let pipeline = Flux2EditPipeline(
                transformer: tf, textEncoder: te, tokenizer: tok,
                vaeEncoder: Flux2VAEEncoder(weights: vaeWeights),
                vaeDecoder: Flux2VAEDecoder(weights: vaeWeights), bn: bn)

            print("  generating...")
            let (pixels, elapsed) = pipeline.generate(
                prompt: stylePrompt, imagePaths: [], seed: seed,
                height: height, width: width, steps: steps, guidance: cfgScale,
                initImagePath: URL(fileURLWithPath: input), denoiseStrength: strength)

            try ImageGate.check(pixels, label: "styletransfer", strict: strictGate)

            let paths = try OutputPathResolver.makePaths(
                explicitOutput: output.isEmpty ? nil : output,
                outputDir: outputDir, customName: name)
            let imagePath = URL(fileURLWithPath: paths.png)
            try Flux2T2IPipeline.saveImage(pixels, to: imagePath)
            print("")
            print("✅ restyled \(imagePath.lastPathComponent)  (\(String(format: "%.1f", elapsed))s)")
            print("   \(imagePath.path)")

            if !noArtifacts {
                try writeArtifacts(paths: paths, stylePrompt: stylePrompt, elapsed: elapsed,
                                    loraNames: loraNames)
            }
        }

        private func writeArtifacts(paths: OutputPaths, stylePrompt: String, elapsed: Double,
                                     loraNames: [String]) throws {
            let startTime = Manifest.nowISO()
            let runConfig = RunConfig(
                transformer: transformer, prompt: stylePrompt,
                width: width, height: height, steps: steps, seed: seed, cfgScale: cfgScale,
                loraPaths: loraNames.isEmpty ? nil : loraNames, loraScale: 1.0,
                textEncoder: encoder, tokenizer: tokenizerDir, vae: vae,
                quantBits: 8, quantGroupSize: 64, command: "styletransfer", pipeline: "flux2"
            )
            try runConfig.write(to: paths.runJSON)
            let sizeBytes = (try? FileManager.default.attributesOfItem(
                atPath: paths.png)[.size] as? Int64) ?? 0
            let manifest = Manifest.success(
                runFile: paths.runJSON, startTime: startTime, endTime: Manifest.nowISO(),
                timings: ["generation": elapsed], models: [:],
                outputFiles: [ManifestOutput(path: URL(fileURLWithPath: paths.png).lastPathComponent,
                                             seed: Int(seed), sizeBytes: sizeBytes,
                                             width: width, height: height)],
                quality: nil, perf: nil)
            try manifest.write(to: paths.manifestJSON)
            print("   run.json:   \(paths.runJSON)")
            print("   manifest:   \(paths.manifestJSON)")
        }

        private func loadAllShards(url: URL) throws -> [String: MLXArray] {
            var all: [String: MLXArray] = [:]
            let files = (try FileManager.default.contentsOfDirectory(at: url, includingPropertiesForKeys: nil))
                .filter { $0.pathExtension == "safetensors" && !$0.lastPathComponent.hasPrefix("._") }
                .sorted { $0.lastPathComponent < $1.lastPathComponent }
            for f in files { all.merge(try loadArrays(url: f)) { _, new in new } }
            return all
        }
    }
}
```

- [ ] **Step 2: Register the command in `Flux2CLI.swift`**

Open `swift/flux2-image-director/Sources/Flux2DirectorCLI/Flux2CLI.swift`. Find the `subcommands:` array (starts around line 32) and add `StyleTransfer.self` right after `Inpaint.self`:

```swift
        subcommands: [
            T2I.self, Edit.self, Angle.self, Segment.self, Swap.self, Style.self,
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

- [ ] **Step 4: Smoke test against real checkpoints**

First generate a real content image to restyle (any existing photo/render works; if none is at hand, generate one):

```bash
python/venv/bin/python python/mlx-movie-director/run.py image t2i \
  --prompt "a detective in a trench coat standing in a rainy noir alley, holding a magnifying glass, dramatic street lamp lighting, wet cobblestone, medium shot" \
  --seed 42 --steps 9 --width 768 --height 1024 \
  --gen-output-dir /tmp/styletransfer-smoke
```

Then run the new Swift command against it:

```bash
swift/flux2-image-director/.build/release/flux2 styletransfer \
  --input $(ls /tmp/styletransfer-smoke/*.png | head -1) \
  --style-preset watercolor --width 768 --height 1024 \
  --output /tmp/styletransfer-smoke/restyled.png
```

Expected: exits 0, prints `✅ restyled restyled.png`, writes `restyled.png` +
`.run.json` + `.manifest.json`. Open the PNG and confirm: the original
detective/alley composition and pose are still recognizable (structure
preserved), but the rendering reads as a watercolor painting (style
applied) — not a blank/noise image.

- [ ] **Step 5: Commit**

```bash
git add swift/flux2-image-director/Sources/Flux2DirectorCLI/StyleTransferCommand.swift \
        swift/flux2-image-director/Sources/Flux2DirectorCLI/Flux2CLI.swift
git commit -m "feat(flux2): add styletransfer command (SDEdit img2img restyle, no new pipeline code)"
```

---

## Task 2: TS command definition (`pi-agent-ext-flux2`)

**Files:**
- Modify: `bun-apps/pi-agent-ext-flux2/src/commands.ts`
- Modify: `bun-apps/pi-agent-ext-flux2/src/commands.test.ts`

- [ ] **Step 1: Update the failing test first**

Open `bun-apps/pi-agent-ext-flux2/src/commands.test.ts`. Find the test `"has exactly the 22 documented flux2 subcommands"` (around line 116) and change it to 23, adding `"styletransfer"` to the array:

```ts
  test("has exactly the 23 documented flux2 subcommands", () => {
    expect(Object.keys(COMMANDS).sort()).toEqual(
      [
        "angle", "edit", "expand", "faceswap", "gate", "inpaint", "kontext", "kv-style-transfer", "models", "scene", "segment",
        "story", "style", "styletransfer", "swap", "t2i", "upscale",
        "verify-e2e", "verify-edit", "verify-encoder", "verify-tokenizer",
        "verify-transformer", "verify-vae",
      ].sort(),
    );
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd bun-apps/pi-agent-ext-flux2 && bun test src/commands.test.ts`
Expected: FAIL — `Object.keys(COMMANDS).sort()` is missing `"styletransfer"` (22 actual vs 23 expected).

- [ ] **Step 3: Add the `styletransfer` entry to `COMMANDS`**

Open `bun-apps/pi-agent-ext-flux2/src/commands.ts`. Find the `inpaint:` entry (ends around line 356) and insert a new `styletransfer:` entry right after its closing `},` (before the `upscale:` entry):

```ts
  styletransfer: {
    name: "styletransfer",
    writesImage: true,
    acceptsGlobals: true,
    when: "Restyle a content image to a target visual language via Flux2 Klein SDEdit img2img (preset/prompt-driven, structure preserved).",
    fields: {
      input: { flag: "--input", type: "string", isPath: true, description: "Content image path (structure preserved)." },
      stylePreset: { flag: "--style-preset", type: "string", description: "Named style preset: clean-professional | watercolor | oil-painting | anime | cinematic | 3d-render | line-art | low-poly." },
      prompt: { flag: "--prompt", type: "string", description: "Free-form style description (amplifies or overrides the preset)." },
      strength: { flag: "--strength", type: "number", description: "Style strength = img2img denoise (0-1]. Default 0.55." },
      lora: { flag: "--lora", type: "string[]", isPathComponent: true, description: "LoRA name(s) under models/lora/ (stackable)." },
      loraScale: { flag: "--lora-scale", type: "number[]", description: "Per-LoRA scale, one per --lora." },
      ...GEN_FIELDS,
    },
  },

```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd bun-apps/pi-agent-ext-flux2 && bun test src/commands.test.ts`
Expected: PASS (all tests, including the field-validity and name-matches-key generic tests that iterate every `COMMANDS` entry).

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-flux2/src/commands.ts bun-apps/pi-agent-ext-flux2/src/commands.test.ts
git commit -m "feat(flux2-ext): add styletransfer to the COMMANDS dispatcher"
```

---

## Task 3: Registry routing (`pi-agent-ext-movie-director`)

**Files:**
- Modify: `bun-apps/pi-agent-ext-movie-director/src/registry.ts`
- Modify: `bun-apps/pi-agent-ext-movie-director/src/selector.test.ts`

- [ ] **Step 1: Update the failing test first**

Open `bun-apps/pi-agent-ext-movie-director/src/selector.test.ts`.

First, fix the stale comment above the `"routes image_generation:<run.py-only command> → runpy-image"` test (around line 198-213) — remove `styletransfer` from the enumeration and add a departure note, matching the existing pattern for `kontext`/`inpaint`/etc:

```ts
  it("routes image_generation:<run.py-only command> → runpy-image (the force multiplier)", () => {
    // runpy_image declares purify/multicouple/storyboard/cutout —
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
    // moved OFF (2026-07-29) onto flux2_image, and "styletransfer" moved
    // OFF (2026-07-30) onto flux2_image — see the dedicated tests.
    // "multicouple" stays here permanently (genuine MLX/GPU latent-couple
    // compute, unportable).
    for (const cmd of ["multicouple"]) {
      const e = selectProvider("image_generation", { command: cmd, env: NO_ENV });
      expect(e.provider).toBe("runpy-image");
      expect(e.invoke).toBe("mlx:runpy-image");
    }
  });
```

Then add a new dedicated routing test right after the existing `kontext` test (around line 317, after its closing `});`):

```ts

  it("routes image_generation:styletransfer → flux2 (Swift-native, StyleTransferCommand.swift)", () => {
    // 2026-07-30: image-styletransfer.py's core mechanism (Flux2 Klein
    // SDEdit img2img: content image as init canvas + denoise strength)
    // already existed natively as Flux2EditPipeline.generate's
    // initImagePath/denoiseStrength params (already wired by
    // InpaintCommand's --denoise-strength and SceneCommand's --bg/
    // --bg-strength) — this port is a new CLI file (StyleTransferCommand.swift)
    // wiring that existing capability, zero new pipeline code. Moved off
    // runpy_image onto flux2_image. --playbook style-source support stays
    // deferred (no playbook YAML parser exists anywhere in Swift/TS yet —
    // see docs/superpowers/specs/2026-07-30-styletransfer-swift-native-port-design.md).
    const e = selectProvider("image_generation", { command: "styletransfer", env: NO_ENV });
    expect(e.provider).toBe("flux2");
    expect(e.invoke).toBe("swift:flux2");
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd bun-apps/pi-agent-ext-movie-director && bun test src/selector.test.ts`
Expected: FAIL — the new `styletransfer` test expects `provider: "flux2"` but the registry still routes it to `runpy-image` (it's still in `runpy_image.commands[]`, not yet in `flux2_image.commands[]`).

- [ ] **Step 3: Move `styletransfer` in `registry.ts`**

Open `bun-apps/pi-agent-ext-movie-director/src/registry.ts`.

In the `flux2_image` entry's `commands:` array (around line 113-118), add `"styletransfer"` right after `"kontext"`:

```ts
    commands: [
      "t2i", "scene", "edit", "style", "kv-style-transfer", "angle", "swap",
      "expand", "upscale", "gate", "segment", "story", "inpaint", "faceswap",
      "kontext", "styletransfer",
      "anime2real", "expansion", // legacy run.py aliases — see notes above
    ],
```

In the same entry's `notes` string, append this sentence right after the existing kontext arrival sentence (`` "...see docs/superpowers/plans/2026-07-29-kontext-swift-native-port.md. `storyboard --kontext-lock` stays on runpy_image..." ``), before the closing quote:

```
 `styletransfer` moved here (2026-07-30) from runpy_image — image-styletransfer.py's core mechanism (Flux2 Klein SDEdit img2img: content image as init canvas, style prompt repaints it, `--strength` controls the balance) already existed natively as Flux2EditPipeline.generate's initImagePath/denoiseStrength params (already wired by InpaintCommand/SceneCommand); this port is a new CLI file (StyleTransferCommand.swift) wiring that existing capability, no new pipeline code. DEFERRED to Python (documented, not silently dropped — see runpy_image if a caller still needs it): `--playbook` style-source support (OM playbook YAML → image_prompt_prefix/consistency_anchors/aesthetic) — no playbook YAML parser exists anywhere in Swift/TS yet, see docs/superpowers/specs/2026-07-30-styletransfer-swift-native-port-design.md.
```

In the `runpy_image` entry's `commands:` array (around line 141-145), remove `"styletransfer"`:

```ts
    commands: [
      "purify", "multicouple",
      "storyboard",
      "cutout",
    ],
```

In the same entry's `notes` string, append this sentence right after the existing kontext departure sentence (`` "...`storyboard --kontext-lock` stays here — image-storyboard.py still calls Python's _run_kontext_generation in-process, a deliberately separate follow-up." ``), before `Local MLX, never a cloud GAI API.`:

```
 `styletransfer` moved OFF this adapter (2026-07-30) onto flux2_image above — see that entry's notes; the SDEdit img2img mechanism it needs was already Swift-native (Flux2EditPipeline.generate's initImagePath/denoiseStrength), just missing a CLI command exposing it without identity refs. `--playbook` style-source support stays here (no Swift/TS playbook YAML parser exists yet).
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd bun-apps/pi-agent-ext-movie-director && bun test src/selector.test.ts`
Expected: PASS (both the updated `<run.py-only command>` test and the new `styletransfer` routing test).

- [ ] **Step 5: Run the full movie-director test suite**

Run: `cd bun-apps/pi-agent-ext-movie-director && bun test`
Expected: PASS (no regressions elsewhere in the package).

- [ ] **Step 6: Validate against the schema**

Run: `bun run --cwd bun-apps/gui-movie-director check:schema`
Expected: PASS — confirms the registry change didn't break schema validation.

- [ ] **Step 7: Commit**

```bash
git add bun-apps/pi-agent-ext-movie-director/src/registry.ts bun-apps/pi-agent-ext-movie-director/src/selector.test.ts
git commit -m "feat(movie-director): route styletransfer to flux2_image (Swift-native)"
```

---

## Task 4: End-to-end sanity comparison

**Files:**
- Create: `python/mlx-movie-director/app/tests/compare_styletransfer_e2e.py`

This mirrors `compare_kontext_e2e.py`'s shape exactly: not a bit-exact
numeric-parity gate (two independent implementations of a multi-step
denoise loop will diverge in floating point even with matching components),
just a smoke check that both outputs are real non-degenerate images, plus a
logged (non-gating) pixel cosine similarity as a diagnostic.

- [ ] **Step 1: Create the script**

```python
#!/usr/bin/env python3
"""compare_styletransfer_e2e.py — sanity comparison between the Swift
`flux2 styletransfer` port and the Python `run.py image styletransfer`
reference (Task 4 of
docs/superpowers/plans/2026-07-30-styletransfer-swift-native-port.md).

NOT a bit-exact numeric-parity gate: two independent implementations of a
multi-step SDEdit denoise loop compound floating-point divergence even when
every underlying component (transformer/VAE/text-encoder) matches. This
checks both outputs are real, non-degenerate images (not blank/noise) and
LOGS (does not gate on) their pixel cosine similarity as a diagnostic for a
human to judge convergence quality.

Run from repo root (requires a built flux2 Swift binary and a working Python
mflux install):
    python/venv/bin/python python/mlx-movie-director/app/tests/compare_styletransfer_e2e.py
"""
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image

REPO = Path(__file__).resolve().parents[4]
CONTENT_PROMPT = (
    "a detective in a trench coat standing in a rainy noir alley, holding "
    "a magnifying glass, dramatic street lamp lighting, wet cobblestone, "
    "medium shot, detailed, high quality."
)
STYLE_PRESET = "watercolor"
SEED = 42
STEPS = 4
STRENGTH = 0.55
WIDTH = 768
HEIGHT = 1024


def load_rgb(path: Path) -> np.ndarray:
    return np.array(Image.open(path).convert("RGB")).astype(np.float64)


def analyze(path: Path, label: str) -> np.ndarray:
    arr = load_rgb(path)
    mean = float(arr.mean())
    std = float(arr.std())
    print(f"\n[{label}] {path}")
    print(f"  shape={arr.shape}  mean={mean:.2f}  std={std:.2f}")
    # A blank/degenerate image has near-zero std; real photos have substantial
    # pixel variance. 5.0 (on a 0-255 scale) is a generous floor.
    ok = std > 5.0
    print(f"  {'PASS' if ok else 'FAIL'}: non-degenerate (std={std:.2f})")
    if not ok:
        sys.exit(1)
    return arr


def find_single_png(dir_path: Path) -> Path:
    """run.py image t2i/styletransfer have no --output flag — they write an
    auto-timestamped <base_name>.png (plus .run.json/.manifest.json sidecars)
    into the generation output dir. Point --gen-output-dir at an empty tmp
    dir per call so exactly one .png is ever present to find."""
    pngs = sorted(dir_path.glob("*.png"))
    if len(pngs) != 1:
        print(f"ERROR: expected exactly 1 .png in {dir_path}, found {len(pngs)}: {pngs}",
              file=sys.stderr)
        sys.exit(1)
    return pngs[0]


def main() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        content_dir = tmp_path / "content"
        python_out_dir = tmp_path / "python_styletransfer"
        content_dir.mkdir()
        python_out_dir.mkdir()
        swift_out = tmp_path / "swift.png"

        # Synthesize a deterministic content image (same fixture as
        # image-styletransfer.py's own --self-test _synth_content: fixed
        # prompt/seed/steps/size).
        #
        # NOTE: `run.py image t2i` has no --output flag — it always writes an
        # auto-timestamped <base_name>.png into the generation output dir
        # (overridden per-call via the global --gen-output-dir flag). Point
        # it at an isolated tmp dir and glob for the resulting file.
        print("[compare_styletransfer_e2e] synthesizing a content image...")
        subprocess.run(
            [sys.executable, str(REPO / "python" / "mlx-movie-director" / "run.py"),
             "image", "t2i", "--prompt", CONTENT_PROMPT,
             "--seed", "42", "--steps", "9", "--width", str(WIDTH), "--height", str(HEIGHT),
             "--gen-output-dir", str(content_dir)],
            check=True, cwd=REPO,
        )
        content_path = find_single_png(content_dir)
        print(f"[compare_styletransfer_e2e] content: {content_path}")

        print("[compare_styletransfer_e2e] running Swift flux2 styletransfer...")
        flux2_bin = REPO / "swift" / "flux2-image-director" / ".build" / "release" / "flux2"
        if not flux2_bin.exists():
            print(f"ERROR: {flux2_bin} not built — run: "
                  f"swift build -c release --package-path swift/flux2-image-director", file=sys.stderr)
            sys.exit(1)
        # Swift `flux2 styletransfer` DOES accept an explicit --output path
        # (StyleTransferCommand.swift's `output` option, via OutputPathResolver).
        subprocess.run(
            [str(flux2_bin), "styletransfer", "--input", str(content_path),
             "--style-preset", STYLE_PRESET, "--strength", str(STRENGTH),
             "--seed", str(SEED), "--steps", str(STEPS),
             "--width", str(WIDTH), "--height", str(HEIGHT),
             "--output", str(swift_out), "--no-artifacts"],
            check=True, cwd=REPO,
        )

        print("[compare_styletransfer_e2e] running run.py image styletransfer (Python reference)...")
        # Same --output caveat as t2i above: `run.py image styletransfer` has
        # no --output flag either — use --gen-output-dir + glob.
        subprocess.run(
            [sys.executable, str(REPO / "python" / "mlx-movie-director" / "run.py"),
             "image", "styletransfer", "--input", str(content_path),
             "--style-preset", STYLE_PRESET, "--strength", str(STRENGTH),
             "--seed", str(SEED), "--steps", str(STEPS),
             "--width", str(WIDTH), "--height", str(HEIGHT),
             "--gen-output-dir", str(python_out_dir)],
            check=True, cwd=REPO,
        )
        python_out = find_single_png(python_out_dir)

        swift_arr = analyze(swift_out, "swift")
        python_arr = analyze(python_out, "python")

        if swift_arr.shape != python_arr.shape:
            # Diagnostic-only (see module docstring) — the pass/fail gate is
            # each analyze() call above, already satisfied independently. A
            # shape mismatch shouldn't happen given both invocations pass the
            # same --width/--height, but skip the dot product rather than let
            # np.dot raise an unguarded ValueError on mismatched 1-D lengths.
            print(f"\n[compare_styletransfer_e2e] shape mismatch swift={swift_arr.shape} "
                  f"python={python_arr.shape} — skipping cosine similarity diagnostic")
        else:
            flat_s, flat_p = swift_arr.flatten(), python_arr.flatten()
            cos = float(np.dot(flat_s, flat_p) / (np.linalg.norm(flat_s) * np.linalg.norm(flat_p) + 1e-12))
            print(f"\n[compare_styletransfer_e2e] pixel cosine similarity (diagnostic, not gated): {cos:.4f}")

    print("\n✅ both outputs are real, non-degenerate images")


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Run it**

Run: `python/venv/bin/python python/mlx-movie-director/app/tests/compare_styletransfer_e2e.py`
Expected: exits 0, both `[swift]`/`[python]` blocks print `PASS: non-degenerate`, and a
final `✅ both outputs are real, non-degenerate images` line. Note the logged
cosine similarity for reference — it's a diagnostic, not a gate.

- [ ] **Step 3: Commit**

```bash
git add python/mlx-movie-director/app/tests/compare_styletransfer_e2e.py
git commit -m "test(styletransfer): add Swift-vs-Python E2E sanity comparison"
```

---

## Plan self-review notes

- **Spec coverage:** §1 (CLI command) → Task 1. §2 (TS integration) → Tasks 2+3.
  §3.1 (local end-to-end run) → Task 1 Step 4. §3.2 (E2E comparison) → Task 4.
  §3.3/3.4 (TS/registry tests) → Tasks 2+3. §3.5 (schema check) → Task 3 Step 6.
  `--playbook` deferral and `cutout` non-scope are documented in Task 3's
  registry notes text, matching the spec's Out-of-scope section.
- **Type consistency:** `StyleTransferCommand`'s `stylePreset`/`prompt`/
  `strength`/`lora`/`loraScale` field names match `commands.ts`'s
  `styletransfer` entry field keys and flag strings exactly (`--style-preset`,
  `--prompt`, `--strength`, `--lora`, `--lora-scale`).
