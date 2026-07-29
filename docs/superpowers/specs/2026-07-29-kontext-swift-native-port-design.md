# Kontext Swift-native port (`image kontext` off Python)

## Context

Standing architecture rule (reaffirmed 2026-07-27, see
`project_ltx_swift_native_port` memory): Python is dev/spike-only; every
production CLI surface the TS agent bridge calls into must be Swift-native.
`music_generation` was the last known violation and was closed out 2026-07-28
(PR #922, `swift/musicgen-director`). `image kontext` is the next candidate —
surveyed alongside `purify`/`cutout`/`styletransfer` (the other remaining
`runpy_image`-routed sub-actions) this session.

`runpy_image`'s `commands[]` list
(`bun-apps/pi-agent-ext-movie-director/src/registry.ts:142`) still routes
`kontext` (and `storyboard`, for its `--kontext-lock` recurring-character
mode) to `python/mlx-movie-director/app/commands/image-kontext.py`, which
instantiates `mflux`'s `Flux1Kontext` directly — "Kontext is its own model
family, not reachable via the repo's ZImage/Flux2Klein pipelines" per that
file's own docstring.

Unlike `cutout` (core dependency is SAM3, a HuggingFace/PyTorch model — a
different framework requiring a full from-scratch model port, comparable in
scope to MusicGen or LTX) and `purify`'s default backend (SeedVR2, also
PyTorch/MPS, staying permanently Python like `multicouple`), Kontext's hard
numeric-parity work is **already done**: the 2026-07-14 kontext epic
(`project_kontext_epic_phase4b_clip_t5_20260714` /
`project_kontext_epic_scoped_20260714` memories) ported and verified
`KontextTransformer`/`KontextCLIPEncoder`/`KontextT5Encoder` against the real
HF/PyTorch reference (transformer cos=1.00000, VAE encode/decode
cos=0.997/0.995, CLIP/T5 merged to main) — all living in
`swift/flux2-image-director/Sources/Flux2Director/Kontext*.swift`. What's
missing is exactly "phase 5" from that epic: a real generation path (denoise
loop) wired to a CLI command and the registry, plus a proper weight-import
step. This spec scopes that remaining work.

## Scope (v1)

**In scope:**
- `KontextPipeline` — a new denoise-loop/generation class reusing the
  already-verified `KontextTransformer`/`KontextCLIPEncoder`/
  `KontextT5Encoder` and the existing `mlx-models/vae/flux-kontext-ae`
  weights.
- `KontextCommand.swift` — a new `flux2 kontext` CLI subcommand exposing it,
  parameter-compatible with Python's `run_kontext` (single hero image +
  prompt, optional `--scenes N --prompt-subject` certify mode, LoRA,
  guidance/steps/scheduler/quantize/seed/width/height).
- `import-kontext.py` — converts the already-locally-cached HF snapshot
  (`~/.cache/huggingface/hub/models--black-forest-labs--FLUX.1-Kontext-dev`)
  into this repo's externalized-weight convention:
  `mlx-models/transformer/kontext-dev/` (transformer) and Kontext's own
  `text_encoder`/`text_encoder_2` weights (CLIP/T5 — confirmed
  Kontext-specific, not shared with Flux2 Klein's; see
  `VerifyKontextCLIPCommand.swift`/`VerifyKontextT5Command.swift`'s
  `--weights` defaults, which point at FLUX.1-Kontext-dev's own snapshot
  subdirectories). VAE needs no import — already present.
- `kontext_native.ts` + `bridge.ts`/`registry.ts` wiring — same shape as
  `music_native.ts`/`musicgen_music` from the MusicGen port: `ensureBinary()`,
  a `bun:kontext-native` invoke key, `cwd: resolveRepoRoot()` set explicitly
  from the start (Task 10 of the MusicGen port found this exact bug — a
  missing `cwd` broke the binary's relative `--model-dir` default — get it
  right the first time here), and a `probeConfigured` binary-presence gate
  (`kontextBinaryPresent()`, mirroring `musicgenBinaryPresent()`).
  `runpy_image`'s `commands[]` drops `"kontext"`.
- One end-to-end sanity check: real Swift generation vs. `run.py image
  kontext --self-test` output, pixel-level comparison (same shape as the
  MusicGen port's `compare_musicgen_e2e.py` Layer-4 spectral check) — not a
  from-scratch full numeric re-verification, since the component-level
  parity already exists.

**Out of scope (deferred, not dropped):**
- `storyboard --kontext-lock` integration. `image-storyboard.py` currently
  calls `_kontext_module()._run_kontext_generation` in-process, not through
  the CLI/registry route this spec adds. Switching that over is a natural
  follow-up once the standalone command is proven in production, not bundled
  into this port.
- `purify`, `cutout`, `styletransfer`, `multicouple` — surveyed this session,
  not part of this port (see Context above for why each is a separate
  decision).

## 1. `KontextPipeline` (new file:
`swift/flux2-image-director/Sources/Flux2Director/KontextPipeline.swift`)

Mirrors `Flux2EditPipeline`'s shape (`Flux2T2IPipeline.swift`): load
transformer/VAE/CLIP/T5 once, run the denoise loop, decode, return an image.
Key difference from Edit: Kontext conditions on exactly one hero image (no
multi-ref concatenation), matching Python's `_run_kontext_generation` single-
`--input` contract. Reuses `KontextTransformer.callAsFunction` (already
verified) as the per-step forward pass; the loop itself (scheduler stepping,
guidance blend, latent packing/unpacking around the transformer call) is new
code, following the same linear-scheduler shape Python's `run_kontext` uses
(`DEFAULT_KONTEXT_GUIDANCE`, `scheduler="linear"`).

LoRA: `Flux2LoRALoaderCLI` is reused if Kontext's LoRA weight shapes match
what that loader expects (same transformer architecture family) — confirm
during implementation; if shapes diverge, LoRA support narrows to "not in
v1" rather than blocking the base pipeline.

## 2. Checkpoint import (new file:
`python/mlx-movie-director/app/commands/import-kontext.py`)

Same pattern as `import-musicgen.py` (2026-07-28): read the local HF
snapshot directly (no re-download — it's already cached from this session's
verification work), convert transformer weights into
`mlx-models/transformer/kontext-dev/`, write a `manifest.json` with the
fields `run.py check-model` requires (`format`/`description`/
`compatible_with`/`size_bytes`/`created_at`) plus a `README.md`, externalize
weights over the repo's 2MB tracked-file limit, and clean up on failure.
CLIP/T5 (`text_encoder`/`text_encoder_2`) get the same treatment — either as
part of the same script or a second import pass, decided during
implementation based on whether `VerifyKontextCLIPCommand`/
`VerifyKontextT5Command`'s existing raw-HF-dir loaders can point at the new
`mlx-models/` location without changes.

## 3. CLI (new file:
`swift/flux2-image-director/Sources/Flux2DirectorCLI/KontextCommand.swift`)

`flux2 kontext --input <hero> --prompt <text> [--scenes N
--prompt-subject <text>] [--guidance F] [--scheduler linear]
[--quantize 8|4] [--seed U] [--lora-path ... --lora-scale ...]
[--width 1024] [--height 1024] [--steps N] [--output ...]` — same option
surface as Python's `add_kontext_args`/`run_kontext`, using
`Flux2ModelRegistry`-style path resolution against the new
`mlx-models/transformer/kontext-dev/` location instead of a hardcoded HF
cache path (the `Verify*Command`s' hardcoded snapshot path stays as-is; it's
a dev-only numeric-parity tool, not the production path this spec adds).

## 4. TS integration (replaces the Python bridge for `kontext`)

- `bun-apps/pi-agent-ext-movie-director/src/kontext_native.ts` — spawns the
  compiled `flux2` binary's `kontext` subcommand via `ensureBinary()`, `cwd:
  resolveRepoRoot()` set from the first commit (not retrofitted).
- `bridge.ts` — new `realKontextNative` function + `"bun:kontext-native"`
  entry in `realAdapters`.
- `registry.ts` — `runpy_image`'s `commands[]` drops `"kontext"`; a new
  registry entry (`kontext_native`, `capability: "image"` command-routed same
  as the other native image adapters) with `invoke: "bun:kontext-native"`,
  `probeConfigured` gated on a new `kontextBinaryPresent()` (mirrors
  `musicgenBinaryPresent()` in `providers.ts`, including the `_set*ForTest`
  hook for test hermeticity).

## 5. Verification plan

1. Build `KontextPipeline` + `KontextCommand`, confirm it runs end-to-end
   locally (no crash, valid image output) against the already-cached HF
   snapshot path first (proving the pipeline logic before the import step is
   even built).
2. Build `import-kontext.py`, re-point the CLI at
   `mlx-models/transformer/kontext-dev/`, confirm `run.py check-model`
   passes on the new manifest.
3. `compare_kontext_e2e.py` — same hero image + prompt through both `run.py
   image kontext --self-test` and `flux2 kontext`, compare output pixels
   (mean/max diff thresholds, same shape as `compare_musicgen_e2e.py`).
4. TS: `kontext_native.test.ts` (mirrors `music_native.test.ts`),
   `bridge.test.ts`/`selector.test.ts` additions for the new
   `_setKontextBinaryForTest` hook (the MusicGen port's Task 10 code review
   caught a missing-mock regression here — write these mocks alongside the
   registry change, not as an afterthought).
5. `bun run --cwd bun-apps/gui-movie-director check:schema` to confirm the
   registry change doesn't break schema validation.

## Out of scope

- `storyboard --kontext-lock` (see Scope above).
- `purify`/`cutout`/`styletransfer`/`multicouple` (surveyed, not ported —
  see Context).
- MusicGen-medium/-large-style "other variants" question doesn't apply here
  (Kontext is a single model, not a size family) — no equivalent deferral
  needed.
- Kontext LoRA support is best-effort (see §1) — may ship without it if
  weight shapes don't match the existing loader.
