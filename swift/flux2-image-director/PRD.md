# flux2-image-director — Product / Architecture (PRD)

Swift CLI for **Flux2 Klein 9B** image generation on Apple Silicon (MLX): a
multi-reference image *director* for scene composition, style transfer,
identity-preserving edit, outpaint, swap, and super-resolution.

This doc is the **feature + architecture** reference, with every key tech
linked to its source. For per-command CLI usage/examples see [`README.md`](README.md);
for the deep multi-reference internals see
[`docs/multi-reference-architecture.md`](docs/multi-reference-architecture.md).

---

## 1. Key features (the commands)

| command | what it does | key tech |
|---|---|---|
| `flux2 scene` | compose a scene from N distinct reference identities + a prompt | multi-reference conditioning + LoRA stack |
| `flux2 style` | identity-preserving style transfer (one ref → restyled output) | reference conditioning (single ref) |
| `flux2 swap` | replace an object/face (SAM3-segmented) with a reference, seamlessly | SAM3 segmentation + latent-mask inpaint |
| `flux2 expand` | outpaint beyond the image borders (擴圖) | latent-mask re-injection |
| `flux2 upscale` | 4× super-resolution (4K修復) | RealPLKSR (native MLX) |
| `flux2 gate` | self-gate an image (noise/blank/NaN) | ImageGate (shared) |

All diffusion commands share one runtime: Qwen3-8B text encoder → (optional)
reference conditioning → Flux2 Klein 9B MMDiT denoise → VAE decode → post-passes.

---

## 2. Architecture (end-to-end pipeline)

```
 prompt ─► Qwen3-8B text encoder (layers 9/18/27) ─► prompt embeds (1,L,12288)
              │
 refs[]  ─► Flux2ReferenceConditioning.prepare ─► ref tokens (per-ref RoPE t_coord)
              │   (VAE-enc → patchify 32→128ch → BN → pack → ×strength)
              ▼
 noise (or SDEdit init from --bg) ──► concat [noise | refs]
              ▼
 Flux2 Klein 9B MMDiT (+ rank-stacked LoRA adapter)
   attends over [noise | refs | text];  WS3 gate: refs only t < gateStep
              ▼  (slice to noise tokens)
 flow-match scheduler step  ──► latent-mask re-injection (outpaint/inpaint) ──┐
              ▼                                                               │
 VAE-decode (BatchNorm denorm) ◄─────────────────────────────────────────────┘
              ▼
 pixels ─► post-passes: --regional · --hand-repair · ImageGate self-check ─► PNG
```

### Model components → source

| component | model | source |
|---|---|---|
| transformer (MMDiT) | Flux2 Klein 9B (`klein-9b`), 8 double + 24 single blocks, inner 4096 | [`Sources/Flux2Director/Flux2Transformer.swift`](Sources/Flux2Director/Flux2Transformer.swift) |
| text encoder | Qwen3-8B, 8-bit, layers 9/18/27 stacked → 12288 | [`Sources/Flux2Director/Flux2TextEncoder.swift`](Sources/Flux2Director/Flux2TextEncoder.swift) |
| tokenizer | `qwen3-klein` | [`Sources/Flux2Director/Flux2Tokenizer.swift`](Sources/Flux2Director/Flux2Tokenizer.swift) |
| VAE | AutoencoderKLFlux2 (32 latent ch) + BatchNorm stats | [`Sources/Flux2Director/Flux2VAE.swift`](Sources/Flux2Director/Flux2VAE.swift) |
| denoise loop / edit / SDEdit | flow-match steps + latent-mask re-inject | [`Sources/Flux2Director/Flux2T2IPipeline.swift`](Sources/Flux2Director/Flux2T2IPipeline.swift) |
| reference conditioning | multi-ref token build (the `scene` identity path) | [`Sources/Flux2Director/Flux2ReferenceConditioning.swift`](Sources/Flux2Director/Flux2ReferenceConditioning.swift) |
| LoRA load + rank-stack | up to 12 LoRAs → one adapter | [`Sources/Flux2Director/Flux2LoRA.swift`](Sources/Flux2Director/Flux2LoRA.swift) |
| outpaint canvas/mask | latent-mask re-injection recipe | [`Sources/Flux2Director/Flux2Outpaint.swift`](Sources/Flux2Director/Flux2Outpaint.swift) |
| swap composite | feathered mask composite | [`Sources/Flux2Director/Flux2Composite.swift`](Sources/Flux2Director/Flux2Composite.swift) |
| story director | consistent character across scenes | [`Sources/Flux2Director/Flux2StoryDirector.swift`](Sources/Flux2Director/Flux2StoryDirector.swift) |
| super-resolution | RealPLKSR 4× (channels-last NHWC, tiled) | [`../common-image-director/Sources/CommonImageDirector/ESRGAN.swift`](../common-image-director/Sources/CommonImageDirector/ESRGAN.swift) |
| self-gating | noise/blank/NaN check | [`../common-image-director/Sources/CommonImageDirector/ImageGate.swift`](../common-image-director/Sources/CommonImageDirector/ImageGate.swift) |
| SAM3 segmentation bridge | text-prompted segmentation (mlx-vlm) | `python/mlx-movie-director/app/sam3_segment_bridge.py` |

---

## 3. Key technologies

### 3.1 Multi-reference conditioning (`scene` / `style` / `swap`)
Each reference is VAE-encoded → patchified (32→128ch, 2× down) → BatchNorm-normalized
→ packed to sequence tokens, given a distinct RoPE *time* coordinate `t_coord = 10+10·i`
so the transformer can tell refs apart. Refs are concatenated to the noise each
step and attended globally; the output is sliced back to noise tokens.
`--ref-strength` (per-ref) and `--ref-gate-steps` (early-step injection fraction)
are the identity-weighting levers (WS3).
**→ [`Sources/Flux2Director/Flux2ReferenceConditioning.swift`](Sources/Flux2Director/Flux2ReferenceConditioning.swift)**
(deep dive: [`docs/multi-reference-architecture.md`](docs/multi-reference-architecture.md))

### 3.2 LoRA rank-stacking (`--lora`)
Multiple LoRAs are merged into ONE runtime adapter by rank-stacking:
`A = hstack(√sᵢ·Aᵢ)`, `B = vstack(√sᵢ·Bᵢ)` so `(x@A)@B = Σᵢ sᵢ·(x@Aᵢ)@Bᵢ`.
A single `--lora` is numerically identical to a direct load. All three Flux2
LoRA key conventions (BFL / WebUI-ComfyUI / diffusers) load; WebUI is remapped
to BFL at int8-convert time.
**→ [`Sources/Flux2Director/Flux2LoRA.swift`](Sources/Flux2Director/Flux2LoRA.swift)` → merge()`**

### 3.3 Latent-mask re-injection (outpaint / inpaint / regional / swap-seamless)
Flux2 Klein has **no Fill/inpaint variant**, so masking is done by re-injection:
each denoise step forces the *kept* region's latent back to its VAE-encoded init
value (`current = mask·step + (1-mask)·init`), so the locked region survives
bit-perfect while the masked region regenerates from the prompt. A final pixel
composite locks the kept region exact.
**→ [`Sources/Flux2Director/Flux2Outpaint.swift`](Sources/Flux2Director/Flux2Outpaint.swift) + re-inject in [`Flux2T2IPipeline.swift`](Sources/Flux2Director/Flux2T2IPipeline.swift)**

### 3.4 SDEdit partial denoise (`--bg`, `--regional`, `--hand-repair`)
Start from a VAE-encoded init latent and mix `(1-σ)·init + σ·noise`; `denoiseStrength`
σ controls how much of the source survives (lower = more fidelity). This is the
`--bg` background-canvas path, the `--regional` strip-refine (default σ=0.45 —
nudges identity without re-rolling hands), and `--hand-repair`.
**→ `Flux2EditPipeline.generate(initLatent:denoiseStrength:)` in [`Flux2T2IPipeline.swift`](Sources/Flux2Director/Flux2T2IPipeline.swift)**

### 3.5 SAM3 text-prompted segmentation
mlx-vlm Sam3Predictor segments an object by text prompt ("hands", "person") —
used by `swap` (target object), `--hand-repair` (hand region), `--regional`.
Native MLX on Apple Silicon.
**→ `python/mlx-movie-director/app/sam3_segment_bridge.py`**

### 3.6 RealPLKSR 4× super-resolution (`upscale`)
Native Swift/MLX port of `4xNomosWebPhoto_RealPLKSR` — pure convolutional (no
diffusion), channels-last NHWC, torch NCHW weights permuted at load. Bit-accurate
vs the torch reference (PSNR 37.7 dB). Auto overlap-tile inference for large
inputs (256px tiles, verified PSNR 41.4 dB tiled vs whole).
**→ [`../common-image-director/Sources/CommonImageDirector/ESRGAN.swift`](../common-image-director/Sources/CommonImageDirector/ESRGAN.swift)**

### 3.7 Multi-seed auto-select + VLM verification
Refs are global → placement is prompt-driven & reliable-but-probabilistic; the
engineering-efficient fix is **seed selection**: run N seeds, verify each with the
local caption VLM (placement + hand quality), keep the verified-correct best.
**→ [`scripts/multi-seed-autoselect.sh`](scripts/multi-seed-autoselect.sh), [`scripts/scene-verify.ts`](scripts/scene-verify.ts), [`scripts/autoselect-rank.py`](scripts/autoselect-rank.py)**

### 3.8 Self-gating (ImageGate)
Every output is checked for noise / blank / NaN; `--strict-gate` aborts (exit 1)
on FAIL. Shared across all image-director CLIs.
**→ [`../common-image-director/Sources/CommonImageDirector/ImageGate.swift`](../common-image-director/Sources/CommonImageDirector/ImageGate.swift)**

---

## 4. The 12-LoRA "卡通转真人工场" stack

The source ComfyUI workflow stacks 12 Flux2 Klein 9B LoRAs; `Flux2LoRALoader.merge`
rank-stacks them into one adapter so a single `flux2 scene` call applies the full
stack (one `--lora` + `--lora-scale` per entry). The reproducible invocation is in
[`README.md § The 12-LoRA stack`](README.md#the-12-lora-卡通转真人工场-stack).

| # | scale | installed name | source | fmt |
|---|---|---|---|---|
| 1 | 0.5 | `anything2real-a` | civitai | diffusers |
| 2 | 0.8 | `anything2real-characters` | civitai | BFL |
| 3 | 1.0 | `chest-9b` | civitai | BFL |
| 4 | 1.0 | `skin-tone` | civitai | BFL |
| 5 | 1.0 | `lips-9b` | civitai | BFL |
| 6 | 0.5 | `eye-9b` | civitai | BFL |
| 7 | 0.8 | `details-9b` | civitai | BFL |
| 8 | 0.5 | `longface-9b` | HF NO8D/FaceControl | BFL |
| 9 | 0.5 | `colorful` | civitai 2425555 | BFL |
| 10 | 0.8 | `qualitya` | civitai 2425555 | BFL |
| 11 | 0.25 | `darkklein-v2bfs-r256` | civitai 964312 | WebUI |
| 12 | 0.8 | `nexblend-asian` | civitai 2535707 | WebUI |

All 12 int8-converted + externalized to `../video_generation__models/<md5>.safetensors`.

---

## 5. Empirical findings (local-LLM verified, 2026-06/07)

- **Prompt-driven placement is reliable** — a 2-girl classroom scene with distinct
  looks + **different poses + different activities** (left: sitting + writing math;
  right: standing + reading) landed correctly on **3/3 seeds** (qwen3-vl-4b
  structured check). With unambiguous visual cues the prompt routes position AND
  action — no region-binding needed.
  Reproduce: [`scripts/scene-classroom-demo.sh`](scripts/scene-classroom-demo.sh) +
  verify: [`scripts/scene-verify.ts`](scripts/scene-verify.ts).
- **`--regional` (post-pass) is net-negative** at full regen (ghosting + fused
  fingers, 2.5× slower); the SDEdit path (σ=0.45) is the gentler default. Prefer
  seed-select.
- **Ref-side region binding is inert on the distilled Klein** — both
  `--region-attention` (OOD attention mask) and `--ref-region-mask` (in-distribution
  latent mask) failed a mask-vs-prompt conflict 3/3; root cause = distillation
  (refs carry identity, not position). Both work on full (non-distilled) Klein.
  Full analysis: [`docs/multi-reference-architecture.md`](docs/multi-reference-architecture.md) §6.

---

## 6. Known limitations (architectural, not bugs)

1. **Hands** are the platform ceiling (fused/extra fingers) — `--hand-repair` is
   best-effort, not a fix.
2. **Skin plastickness** is a platform artifact (both z-image & flux2-klein bases);
   no generation-side lever fixes it.
3. **No identity→region binding** in Flux2KleinEdit conditioning (refs are global);
   true region-bound identity needs IP-Adapter Regional (separate arch, not ported).

---

## 6a. Build: the mlx-swift metallib gotcha (READ on a fresh checkout)

`swift build -c release` produces a flux2 binary that **crashes on every MLX
compute call** (t2i / scene / gate-on-image / segment / verify-* — anything that
touches the GPU) with:

```
MLX error: Failed to load the default metallib. library not found …
```

**Root cause.** mlx-swift 0.31.4's SwiftPM target (`Cmlx`) does **not** compile
the Metal shader library — that step lives only in mlx-swift's **Xcode** project
("PrepareMetalShaders" phase, see
`Source/Cmlx/mlx/cmake/extension.cmake::mlx_build_metallib`). A plain
`swift build` therefore ships a binary with **no metallib**, and MLX's
`device.cpp::load_default_library()` cannot find one.

At runtime MLX searches for the metallib in this order (first hit wins):

1. `<binary_dir>/mlx.metallib` ← **what we supply**
2. `<binary_dir>/Resources/mlx.metallib`
3. SwiftPM-bundle `default.metallib` (not wired for a raw SPM executable)
4. `<binary_dir>/Resources/default.metallib`
5. the compiled-in `METAL_PATH` (`"default.metallib"`)

**The fix — `scripts/build-metallib.sh`.** It compiles every mlx Metal kernel
into `<binary_dir>/mlx.metallib` with the same flags mlx's CMake uses
(`xcrun -sdk macosx metal -I<mlx-root> kernels/*.metal`), and is idempotent
(skips when the metallib is newer than the kernel sources). The mlx-swift
checkout it reads from (`.build/checkouts/mlx-swift`) is regenerated by
`swift build`, so this always works after a build.

**Fresh-checkout build sequence:**

```bash
swift build -c release --package-path swift/flux2-image-director
bash        swift/flux2-image-director/scripts/build-metallib.sh   # ← don't skip
```

`bun-apps/s2-agent-ext-flux2/src/binary.ts` runs `build-metallib.sh` automatically
after a fresh `swift build` (and heals a pre-existing binary that lacks the
metallib), so the agent tool gets a working binary with no manual step. If you
build flux2 by hand (outside the agent), you must run the script yourself —
otherwise only the no-MLX commands (`--help`, `models`, top-level `gate` on a
path MLX never initializes) work.

> Symptom cross-check: `models` works but `t2i`/`gate <image>` crash = missing
> metallib. `models` doesn't init MLX compute, so it hides the problem.

---

## 6b. s2-agent-ext-flux2 — agent tool wrapper

`bun-apps/s2-agent-ext-flux2/` (a sibling Bun workspace package) exposes flux2 as a
single s2-agent dispatcher tool with typed per-command parameters, structured
`.manifest.json` parsing, progress streaming, abort, and path-safety guards.
Two result-parsing facts it depends on (relevant if you change the manifest
schema):

- `output_files[].path` is a **bare basename** (not absolute) — resolve it
  against `--output-dir` before returning/chaining.
- generation time is in `timings.generation` (e.g. `9.16`s); `elapsed_seconds`
  is only the manifest-write overhead (~`0.002`s) and must NOT be used as the
  run time. The `perf` block is absent for `t2i` (present only where per-step
  timing is captured).

Drift guard: `bun run check:flags` (in that package) asserts every
`flux2 <cmd> --help` flag is modeled in `src/commands.ts`. Run it after editing
any `*Command.swift`.

---

## 6c. Build: the ESRGAN `.pth` → `.safetensors` conversion (`upscale`)

`flux2 upscale` loads the RealPLKSR weights via a **native Swift safetensors
reader** (`common-image-director/ESRGAN.swift::ESRGANLoader.loadRealPLKSR`), NOT
torch/spandrel. So the model dir must contain a `.safetensors` whose keys are the
raw torch state_dict keys (`feats.0.weight`, `feats.<i>.channel_mixer.*`, …).
Without it:

```
Error: no .safetensors in …/models/upscale/4x-nomos-webphoto-realplksr —
convert the .pth via spandrel (see README)
```

(The python `run.py upscale` path is different — it loads the `.pth` directly via
spandrel — so the `.pth` being present is not enough for the flux2 path.)

**The fix — `scripts/convert-esrgan.py`.** It dumps the `.pth` state_dict to
`.safetensors` (float32, keys unchanged) and is self-sufficient on a fresh
checkout: pass the model **instance directory** and it auto-discovers the `.pth`
(an in-dir symlink, or a scan of the external content store
`../video_generation__models`), links it into the dir, and writes the converted
`.safetensors` beside it. Idempotent.

```bash
# from repo root, using the mlx venv (has torch + safetensors)
<venv>/python swift/flux2-image-director/scripts/convert-esrgan.py \
    mlx-models/upscale/4x-nomos-webphoto-realplksr
```

`<venv>` is the worktree-shared `../video_generation__venv/bin/python` (has torch
2.12 + safetensors). After this, `flux2 upscale` works (2048×2048 from a 512²
source, ~0.7s, gate PASS).

**Result-parsing note** (why the agent tool special-cases upscale): `upscale`
writes only a `.run.json` (with `width`/`height`), **not** a `.manifest.json`.
`bun-apps/s2-agent-ext-flux2/src/result.ts` therefore takes the output path from
flux2's stdout (every single-image command prints the absolute PNG path on its
own line) and matches sidecars by the output's basename — not "newest manifest in
dir", which would collide with a prior run's manifest.

---

## 7. Provenance

`flux2 scene` is ported from the ComfyUI community workflow
**"Klein+完全体 | 三參考圖全能王"**
([workflow graph on RunningHub](https://www.runninghub.ai/zh-cn/post/2064189691808804865?inviteCode=mx929qer)).
The conditioning math mirrors mflux's
`flux2_klein_edit_helpers.prepare_reference_image_conditioning`. Recorded in code
at the headers of [`Flux2ReferenceConditioning.swift`](Sources/Flux2Director/Flux2ReferenceConditioning.swift)
and [`SceneCommand.swift`](Sources/Flux2DirectorCLI/SceneCommand.swift).
