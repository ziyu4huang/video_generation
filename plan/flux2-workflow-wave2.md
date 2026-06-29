# Wave 2 — flux2-image-director open decisions

> Branch `flux2-workflow-wave2`, tracking draft PR #129. Wave 1 (PR #128, merged
> `db4ce00`) shipped all 5 ComfyUI workflow functions in native Swift flux2:
> `scene` (+v2 `--bg`), `style`/multi-LoRA stack, `upscale` (RealPLKSR),
> `expand` (outpaint), `swap --inpaint` (seamless). This wave = the three
> decision-pending items documented in `swift/flux2-image-director/README.md`
> "Known limitations". Each is independent and individually mergeable.

## Scope (decision-gated — pick any subset)

### 1. Complete the 12-LoRA "卡通转真人工厂" stack (5 remaining)
7/12 downloaded. The 5 missing — **4/5 now have user-supplied sources**
(2026-06-30); only `qualitya` is still unresolved.

| # | workflow name | scale | resolved source | installed name | status |
|---|---|---|---|---|---|
| 8 | LongFace_9B | 0.5 | `https://huggingface.co/NO8D/FaceControl` | `longface-9b` | 🔗 source |
| 9 | Colorful | 0.5 | `https://civitai.com/models/2425555/k-slider-imaging-control` | `colorful` | 🔗 source |
| 10 | qualitya | 0.8 | — (generic name, no match) | — | ❌ open |
| 11 | DarkKlein9b_v2BFS_extracted_lora_r256 | 0.25 | `https://civitai.com/models/964312/redcraft-exported-loras` | `darkklein-v2bfs-r256` | 🔗 source |
| 12 | Kook_Flux_klein_亚洲人像 | 0.8 | `https://civitai.com/models/2535707/nexblend-asian-semi-realistic-flux-2-klein-9b` | `nexblend-asian` | 🔗 source |

**Source notes (verify before import):**
- **LongFace_9B** → NO8D `FaceControl` HF repo. The NO8D face-slider series covers
  many controls; confirm `FaceControl` is the long-face one (or the closest
  available). HF download path differs from CivitAI — import via HF URL form.
- **Colorful** → `k-slider-imaging-control` is a **K-slider** (imaging control),
  not an obvious "colorful" saturation booster. Verify it maps to the workflow's
  `Colorful` node before treating scale 0.5 as correct.
- **DarkKlein9b_v2BFS_extracted_lora_r256** → `redcraft-exported-loras` is a
  pack of LoRA-extracts. The specific r256 BFS file must be located inside it;
  the installed `bfs-head-v1-klein-9b` checkpoint remains the re-extract fallback.
- **亚洲人像** → `nexblend-asian-semi-realistic-flux-2-klein-9b` — a semi-realistic
  Asian-portrait LoRA (good match for the workflow's intent), likely the
  real-world model behind the "Kook 亚洲人像" node.
- **qualitya** — still no source. May be a private/retracted LoRA; the installed
  `details-9b` + the above quality stack may cover its intent. Decide: skip
  (11/12) or keep hunting.

**Add one (CivitAI form):**
```bash
python/venv/bin/python python/mlx-movie-director/run.py import-lora \
  '<civitai-url>?modelVersionId=<VID>' --arch flux2-klein-9b --name <slug> --no-ai
python/venv/bin/python python/mlx-movie-director/scripts/convert_lora_mlx.py --name <slug>
```
HF (`LongFace_9B`) uses the HF URL form directly. No code change — only model
files + README table status.

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
