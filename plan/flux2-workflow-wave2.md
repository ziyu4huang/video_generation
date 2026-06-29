# Wave 2 — flux2-image-director open decisions

> Branch `flux2-workflow-wave2`, tracking PR TBD. Wave 1 (PR #128, merged
> `db4ce00`) shipped all 5 ComfyUI workflow functions in native Swift flux2:
> `scene` (+v2 `--bg`), `style`/multi-LoRA stack, `upscale` (RealPLKSR),
> `expand` (outpaint), `swap --inpaint` (seamless). This wave = the three
> decision-pending items documented in `swift/flux2-image-director/README.md`
> "Known limitations". Each is independent and individually mergeable.

## Scope (decision-gated — pick any subset)

### 1. Complete the 12-LoRA "卡通转真人工厂" stack (5 remaining)
7/12 downloaded. The 5 missing and their most likely resolution:
- **LongFace_9B** (scale 0.5) — NO8D face-slider series has no "longface" version.
  Need the original source URL or a sanctioned substitute.
- **Colorful** (0.5) — only public match (`civitai 2637760`) is Flux.2 Klein
  **4B**-base / SDXL. Confirm 4B-on-9B compatibility, or find the 9B original.
- **qualitya** (0.8) — generic name, no confident CivitAI match. Need source URL.
- **DarkKlein9b_v2BFS_extracted_lora_r256** (0.25) — rank-256 custom extract,
  not public. Possibly re-derivable by LoRA-extracting the installed
  `bfs-head-v1-klein-9b` checkpoint (BFS already present).
- **Kook_Flux_klein_亚洲人像** (0.8) — not found; likely private. Need source URL.

Add one: `run.py import-lora '<url>' --arch flux2-klein-9b --name <slug>` +
`convert_lora_mlx.py --name <slug>`. No code change — only model files + README
table status.

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
