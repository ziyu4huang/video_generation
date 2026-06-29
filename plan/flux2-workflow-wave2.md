# Wave 2 — flux2-image-director open decisions

> Branch `flux2-workflow-wave2`, tracking draft PR #129. Wave 1 (PR #128, merged
> `db4ce00`) shipped all 5 ComfyUI workflow functions in native Swift flux2:
> `scene` (+v2 `--bg`), `style`/multi-LoRA stack, `upscale` (RealPLKSR),
> `expand` (outpaint), `swap --inpaint` (seamless). This wave = the three
> decision-pending items documented in `swift/flux2-image-director/README.md`
> "Known limitations". Each is independent and individually mergeable.

> **Status (2026-06-30): Item 1 DONE — 12/12 LoRAs installed.** Only items 2
> (ESRGAN tiling) and 3 (WS3) remain open (decision-gated, not needed for the
> current workflow).

## Scope (decision-gated — pick any subset)

### 1. ✅ DONE — Complete the 12-LoRA "卡通转真人工场" stack

**12/12 downloaded + int8-converted + externalized** (2026-06-30). The final 5
resolved sources (user-supplied 2026-06-30):

| # | workflow name | scale | resolved source | installed name |
|---|---|---|---|---|
| 8 | LongFace_9B | 0.5 | `huggingface.co/NO8D/FaceControl` (`LongFace_9B.safetensors`) | `longface-9b` |
| 9 | Colorful | 0.5 | civitai 2425555 v2779689 (`Colorful.safetensors`, K-Slider pack) | `colorful` |
| 10 | qualitya | 0.8 | civitai 2425555 v2727111 (`quality.safetensors`, K-Slider pack) | `qualitya` |
| 11 | DarkKlein9b_v2BFS_extracted_lora_r256 | 0.25 | civitai 964312 v2742432 (redcraft pack, 632 MB int8) | `darkklein-v2bfs-r256` |
| 12 | Kook_Flux_klein_亚洲人像 | 0.8 | civitai 2535707 v2849806 (NexBlend Asian Semi-Realistic) | `nexblend-asian` |

Resolution notes (what the deep-dig found):
- **LongFace_9B** — found in NO8D `FaceControl` HF repo (exact filename match);
  the repo also has Ear/Head/Eye/Lips/Nose/eyebrows/freckles/hair siblings.
- **Colorful + qualitya** — both are files inside the **same** K-Slider
  "imaging control" pack (civitai 2425555): `Colorful.safetensors` (v2779689,
  79 MB) and `quality.safetensors` (v2727111, 39 MB). The generic-name "misses"
  were never separate models.
- **DarkKlein9b r256** — exact file in the `redcraft-exported-loras` pack; no
  BFS re-extraction needed. Largest of the 5 (632 MB int8).
- **亚洲人像** — NexBlend Asian Semi-Realistic; the real-world model behind the
  workflow's "Kook 亚洲人像" node.

All 5 int8 files externalized to `../video_generation__models/<md5>.safetensors`
(store-manifest count 91→96). Reproducible full-stack invocation is in
`swift/flux2-image-director/README.md`.

**Verified end-to-end (2026-06-30):** the full 12-LoRA stack runs in pure Swift
via `scripts/flux2-full-lora-stack.sh`. Each LoRA logs `adapters=N>0`; output
VLM-scored overall 9 / prompt_adherence 10 / artifacts 10. **Required two code
fixes** beyond download (all 3 Flux2 LoRA key conventions now load):

- **`convert_lora_mlx.py`** — added `remap_lora_keys()`: WebUI/ComfyUI keys
  (`lora_unet_*_lora_down/up.weight`) → BFL at int8 time. Fixed **nexblend-asian**
  + **darkklein-v2bfs-r256** (both shipped WebUI; were silently loading 0 adapters).
- **`Flux2LoRALoader.load`** (Swift) — now also accepts diffusers-format keys
  (`transformer.<runtime_path>.lora_A/B.weight`), using the path directly with no
  QKV split. Fixed **anything2real-a** (shipped diffusers; partial 88-adapter
  LoRA — was silently 0 adapters in the original 7).
- **`Flux2LoRALoaderCLI.loadMerged`** — logs `adapters=N` per LoRA + warns on 0
  (the silent no-op that hid all three).

Lesson: the BFL-only loader silently dropped every adapter for non-BFL LoRAs —
"downloaded" ≠ "works". The adapter-count log is now the smoke test.

### 2. ESRGAN tiled inference (`flux2 upscale`)
RealPLKSR currently runs whole-image. Verified for 1024²→4096², but the
`(1,H,W,64)` intermediates across 28 blocks risk OOM on 4K+ sources. Add
overlap-tile inference (e.g. 256-tile, 16px overlap, feather-blend) in
`ESRGAN.swift`, parity-checked against the whole-image path. No arch change.

### 3. WS3 — per-reference strength + timestep gating (`flux2 scene`)
Still deferred from the v2 plan: `--ref-strength [Float]` (per-`--ref` token
weight in `Flux2ReferenceConditioning.prepare`) + `--ref-gate-steps Float`
(inject ref tokens only in the early fraction of steps). Not needed for the
current workflow; port ComfyUI `ReferenceLatentPlus` semantics only if finer
ref control is wanted.

## Out of scope (confirmed deferred)
- Regional/per-character mask placement in `scene` (true "圖一 left / 圖二 right").
- Native Swift SeedVR2 (the workflow's AI-diffusion upscale alternative) — python-only.
