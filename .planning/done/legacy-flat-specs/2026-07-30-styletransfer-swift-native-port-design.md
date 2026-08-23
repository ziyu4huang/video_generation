# styletransfer Swift-native port (`image styletransfer` off Python)

## Context

Standing architecture rule (reaffirmed 2026-07-27, see `project_ltx_swift_native_port`
memory): Python is dev/spike-only; every production CLI surface the TS agent
bridge calls into must be Swift-native. `music_generation` closed out
2026-07-28 (PR #922). `kontext` closed out 2026-07-29 (PR #943). This spec
scopes the next target, chosen from the remaining `runpy_image`-routed
sub-actions (`purify`, `multicouple`, `storyboard`, `cutout`,
`styletransfer`).

`multicouple` (genuine MLX latent-couple compute) and `purify`'s default
SeedVR2 backend (PyTorch/MPS-only) both stay permanently on Python — settled
in prior sessions. `storyboard --kontext-lock` is an explicitly deferred
follow-up to the Kontext port, not this one. `cutout` is a reasonable next
candidate after this one (SAM3 mask via the existing Python bridge +
new Swift-side alpha-compositing) but is out of scope here.

`runpy_image`'s `commands[]` list
(`bun-apps/pi-agent-ext-movie-director/src/registry.ts:141`) still routes
`styletransfer` to
`python/mlx-movie-director/app/commands/image-styletransfer.py`, which
restyles a content image to a named visual language using "the PROVEN Flux2
Klein img2img path" — its own docstring's words: the content image is the
img2img base (structure preserved via VAE-encoded latent), a style prompt
repaints it, and `--strength` (denoise) controls the style/content balance.

**Key finding from this session's investigation:** the exact mechanism this
needs — SDEdit-style partial-denoise from an encoded init image — already
exists natively in Swift as `Flux2EditPipeline.generate`'s
`initImagePath`/`denoiseStrength` parameters
(`swift/flux2-image-director/Sources/Flux2Director/Flux2T2IPipeline.swift:155-221`).
It is already wired to a CLI flag twice: `InpaintCommand.swift`'s
`--denoise-strength` (masked-region variant, via `pipeline.inpaint`) and
`SceneCommand.swift`'s `--bg`/`--bg-strength` (whole-canvas variant, via
`pipeline.generate` directly — the exact call shape this port needs, just
with `imagePaths: []` since styletransfer has no identity references). This
means the port needs **zero new denoise-loop or model code** — it is a new
CLI file wiring an already-verified pipeline capability, comparable in scope
to `InpaintCommand.swift` itself.

## Scope (v1)

**In scope:**
- `StyleTransferCommand.swift` — a new `flux2 styletransfer` CLI subcommand.
  Style source is `--style-preset` (8 built-in presets, ported verbatim from
  Python's `_STYLE_PRESETS` dict) and/or `--prompt` (free-form, amplifies or
  stands alone) — see §1 for the resolution logic.
  **Narrowed vs. the Python original:** `--playbook` (OM playbook YAML →
  `image_prompt_prefix`/`consistency_anchors`/`aesthetic`) is dropped from
  v1. There is currently no playbook YAML parser anywhere in the Swift/TS
  side of the repo (Python's `app.planning.playbook` is the only one); adding
  one is new parsing work with no evidence of a driving caller yet. This is a
  deliberate scope cut, not a silent drop — documented here and in the
  shipped CLI's option descriptions.
- Reuses `Flux2EditPipeline.generate(imagePaths: [], initImagePath:,
  denoiseStrength:)` — no new pipeline file, no new denoise loop.
- Optional LoRA support via the existing `Flux2LoRALoaderCLI` (same mechanism
  `StyleCommand`/`SceneCommand` already use) — cheap to include since the
  loader is shared infrastructure, not new work.
- TS integration (`pi-agent-ext-flux2/src/commands.ts` +
  `pi-agent-ext-movie-director/src/registry.ts`) — same pure-data-addition
  shape as the Kontext port: no new invoke key, no new binary-resolution
  file, `styletransfer` moves from `runpy_image.commands[]` to
  `flux2_image.commands[]`.
- One end-to-end sanity check: real Swift generation vs. `run.py image
  styletransfer --self-test` output, pixel-level comparison — same shape as
  `compare_kontext_e2e.py`.

**Out of scope (deferred, not dropped):**
- `--playbook` support (see above).
- Python's `--self-test` content-image synthesis (a ZImage T2I call to
  generate a throwaway content image) — the Swift command always takes a
  real `--input`; synthesizing a test fixture is scaffolding, not the
  restyle mechanism itself. The E2E comparison script (§4) supplies a fixed
  real input image instead.
- `cutout` and any further `runpy_image` commands — separate future work.

## 1. `StyleTransferCommand.swift` (new file:
`swift/flux2-image-director/Sources/Flux2DirectorCLI/StyleTransferCommand.swift`)

Follows `InpaintCommand.swift`'s shape (model loading, artifact writing,
`ImageGate.check`) but calls `Flux2EditPipeline.generate` directly instead of
`pipeline.inpaint` — no mask, whole-image restyle, matching
`SceneCommand.swift`'s `--bg`/`--bg-strength` call shape:

```swift
let (image, elapsed) = pipeline.generate(
    prompt: stylePrompt, imagePaths: [], seed: seed,
    height: height, width: width, steps: steps, guidance: cfgScale,
    initImagePath: inputURL, denoiseStrength: strength)
```

**Style preset table** (ported verbatim from Python's `_STYLE_PRESETS`,
`python/mlx-movie-director/app/commands/image-styletransfer.py:46-80`):

```swift
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
```

**Style prompt resolution** (simplified from Python's `build_style_prompt`
now that `--playbook` is out of scope — at most two sources instead of
three):

```swift
func resolveStylePrompt(preset: String?, prompt: String) throws -> String {
    var parts: [String] = []
    if let preset, !preset.isEmpty {
        guard let text = Self.stylePresets[preset.lowercased()] else {
            throw ValidationError(
                "unknown --style-preset '\(preset)'. Available: "
                + Self.stylePresets.keys.sorted().joined(separator: ", "))
        }
        parts.append(text)
    }
    if !prompt.isEmpty { parts.append(prompt) }
    guard !parts.isEmpty else {
        throw ValidationError("a style source is required — pass --style-preset <preset> and/or --prompt <text>.")
    }
    return parts.joined(separator: ", ")
}
```

**CLI options** (defaults follow `InpaintCommand`/`SceneCommand`
precedent — `--steps 4` matches Python's "Flux2 Klein distilled default"):

```
flux2 styletransfer --input <content-image> [--style-preset <preset>]
  [--prompt <text>] [--strength F=0.55] [--seed U=42] [--width 1024]
  [--height 1024] [--steps 4] [--cfg-scale F=1.0] [--output ...]
  [--transformer ...] [--vae ...] [--encoder ...] [--tokenizer-dir ...]
  [--lora ...] [--lora-scale ...] [--output-dir ...] [--name ...]
  [--no-artifacts] [--strict-gate]
```

`validate()` mirrors `InpaintCommand`'s pattern: `--strength` must be in
`(0, 1.0]`; at least one of `--style-preset`/`--prompt` must be given
(checked in `resolveStylePrompt`, called from `run()`).

Artifact writing: same `RunConfig`/`OutputPathResolver` pattern as
`InpaintCommand.swift:134-151`, with `command: "styletransfer", pipeline:
"flux2"`.

## 2. TS integration (`pi-agent-ext-flux2/src/commands.ts` +
`pi-agent-ext-movie-director/src/registry.ts`)

Pure data addition, identical shape to the Kontext port (no new invoke key,
no new spawn code — `commands.ts`'s declarative `COMMANDS` map +
`invoke.ts`'s generic spawn already handle any registered subcommand):

- `pi-agent-ext-flux2/src/commands.ts` — add a `styletransfer` entry to
  `COMMANDS`:
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
      ...GEN_FIELDS_NO_STRICT_GATE,
    },
  },
  ```
  (`GEN_FIELDS_NO_STRICT_GATE` already supplies `seed`/`width`/`height`/
  `steps`/`cfgScale`/`output`/`outputDir`/`name`/`vae`/`encoder`/
  `tokenizerDir` — same shared block `style`/`scene` use.)
- `pi-agent-ext-movie-director/src/registry.ts` — `runpy_image`'s
  `commands[]` drops `"styletransfer"`; `flux2_image`'s `commands[]` gains
  it. `flux2_image`'s `notes` string gets an arrival sentence (same pattern
  as the `kontext`/`inpaint`/`faceswap` entries already there); `runpy_image`'s
  `notes` string gets a matching departure sentence.

## 3. Verification plan

1. Build `StyleTransferCommand`, confirm it runs end-to-end locally (no
   crash, valid image output, structure visibly preserved from a real input
   image) before touching the TS layer.
2. `compare_styletransfer_e2e.py` (new file, same shape as
   `compare_kontext_e2e.py`) — same real content image + `--style-preset`
   through both `run.py image styletransfer` (real `--input`, not
   `--self-test`'s synthesized content) and `flux2 styletransfer`, compare
   output pixels (cosine similarity / mean/max diff thresholds).
3. TS: unit tests for the new `commands.ts` entry (field-order /
   subcommand-count tests, same pattern `commands.test.ts` already has for
   `kontext`) and a `selector.test.ts` addition asserting
   `selectProvider("image_generation", {command:"styletransfer"})` routes to
   `flux2` / `swift:flux2`.
4. `bun run --cwd bun-apps/gui-movie-director check:schema` to confirm the
   registry change doesn't break schema validation.

## Out of scope

- `--playbook` support (see Scope above) — deferred, not dropped.
- `cutout` — separate future port (see Context).
- `purify`/`multicouple`/`storyboard --kontext-lock` — settled as permanent-
  Python or separately-deferred in prior sessions (see Context).
