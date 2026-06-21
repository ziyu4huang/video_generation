# Convert Plan: Upgrade 4-bit Transformers → 8-bit MLX (from FP8/BF16 sources)

> Status: **DONE (2026-06-22)** on `feat/models-8bit`. dark-beast-dbzit9 and
> seedvr2-7b re-derived to 8-bit; zimage-moody-v126 **retired** (its "V12.6 DPO"
> source doesn't exist on CivitAI) and the default switched to the existing
> 8-bit `moody-pro-mix`. ernie-redmix-redzit15 still pending (provenance broken).
> See the "Completion log" section at the bottom.

## Context

Four local transformers are quantized to **4-bit** (`mlx-4bit-gs32`), all derived
from higher-precision upstream checkpoints. The worst case is `dark-beast-dbzit9`,
which was converted from an **fp8** checkpoint (fp8→4bit = double quantization).

Goal: upgrade each to **8-bit** (`bits=8, group_size=64`, manifest format
`mlx-8bit`) by re-deriving from an upstream source. 8-bit roughly halves the
quantization error of 4-bit at ~2× file size and avoids the "plasticky skin"
artifact the 4-bit zimage models exhibit.

Out of scope: the LTX-2.3 **video** transformers — they are already 8-bit
(`mlx-int8`) with a separate loader.

## The four 4-bit models

| Model | arch | Current source | Upstream (re-derive from) | Feasibility |
|---|---|---|---|---|
| `dark-beast-dbzit9` | zimage-turbo | fp8 (`darkBeast_dbzit9DIMRclaw_fp8.safetensors`) | civitai `2242173` v2788849 — offers **bf16 (12 GB)** / fp8 (7 GB) / nf4 | ✅ clean |
| `ernie-redmix-redzit15` | zimage-turbo | bf16 pruned | manifest `source_url` (civitai 958009) is **wrong** — that's RedCraft/ERNIE (Flux), not a ZIT model | ⚠️ provenance broken |
| `zimage-moody-v126` | zimage-turbo | ComfyUI safetensors | civitai 2253524 is a **workflow page**, not a model card; exact checkpoint unknown (catlover1937 moody collection 620406/621441/2384856) | ⚠️ uncertain; GUI default + most-A/B-tested |
| `seedvr2-7b` | seedvr2-dit (upscaler) | remapped ComfyUI | HF `ByteDance-Seed/SeedVR2-7B` (fp16, high precision) | ✅ clean |

`comfyui_data/models/` is empty → original downloads are gone; **sources must be
re-downloaded.** Disk: 1.2 TB free, store 166 GB.

## Converter improvement (done this session)

The conversion crashed on the dark-beast **fp8** source with
`RuntimeError: chunk expects at least a 1-dimensional tensor` at `_remap_qkv`.
Root cause: `import-checkpoint`'s converter was a stale duplicate of
`convert.py`'s and **lacked the FP8 dequant step**, so a 0-dim
`.qkv.weight_scale` scalar reached `weight.chunk(3, dim=0)`.

Fixed by making FP8 → MLX a first-class, shared capability:

- **`convert.py`** — extracted `dequant_comfyui_fp8(pt_weights, log_prefix)` (the
  ComfyUI FP8 dequant: `weight × weight_scale → bf16`, drops `.weight_scale` /
  `.comfy_quant` metadata). `convert_zit_checkpoint` now calls it. Also hardened
  `_remap_qkv` to drop (not crash on) non-chunkable tensors.
- **`import-checkpoint.py`** — `_convert_zimage_checkpoint` now calls
  `dequant_comfyui_fp8` after loading, so the import path supports FP8 sources
  identically to `--zit-checkpoint`. Its `_remap_qkv` got the same guard.
- **Phase 0 (prior commit)** — both converters accept `--bits`/`--group-size`
  (default 4/32 preserved); seedvr2 loader reads bits/gs from the manifest.
- **Tests** — `app/tests/test_convert_fp8.py` (5 cases: fp8+scale, plain fp8,
  fp16/fp32 upcast, bf16 passthrough/no-op, `_remap_qkv` scalar guard).

**Format string rule (critical):** the upgraded zimage/seedvr2 manifests must use
`mlx-8bit` (**not** `mlx-int8`). The zimage loader
`app/pipeline.py:_detect_transformer_quant` maps `mlx-8bit`→(8,64) but falls back
to (4,32) for `mlx-int8` → would apply 4-bit structure to 8-bit weights = crash.
LTX's `mlx-int8` is unaffected (separate loader).

## CivitAI download-precision caveat

CivitAI's version-level download URL (`/api/download/models/<vid>`) serves a
**default** file — when a model ships bf16+fp8 under one version, it returns
**fp8**, not bf16, even though the API marks bf16 `primary`. So
`run.py import-checkpoint` prints "Variant: bf16" but actually downloads fp8.
This is now harmless (the converter handles fp8) and matches a preference for the
smaller fp8 source. To force a specific precision, use the explicit-param URL:

```
https://civitai.com/api/download/models/<VID>?type=Model&format=SafeTensor&fp=bf16   # 12 GB
https://civitai.com/api/download/models/<VID>?type=Model&format=SafeTensor&fp=fp8    # 7 GB
```

## Conversion procedure (per model)

Two equivalent entry points — both now FP8-aware and bits-parameterized:

**A. `import-checkpoint`** (download + convert + externalize + manifest, end-to-end):
```bash
python/venv/bin/python python/mlx-movie-director/run.py import-checkpoint \
  'https://civitai.com/models/2242173?modelVersionId=2788849' \
  --name dark-beast-dbzit9 --no-ai
# → downloads (fp8 by default), dequants, converts to 8-bit, externalizes, writes manifest (mlx-8bit)
```
Note: refuses if the target dir exists — back up + remove the existing model dir first.

**B. `convert.py --zit-checkpoint`** (convert a local source you downloaded yourself):
```bash
# 1. download the source (fp8 or bf16) to a local path
# 2. convert to 8-bit:
python/venv/bin/python python/mlx-movie-director/convert.py \
  --zit-checkpoint /path/to/source.safetensors \
  --name dark-beast-dbzit9 --bits 8 --group-size 64 \
  --source civitai.com/models/2242173 \
  --source-url 'https://civitai.com/models/2242173/dark-beast-or?modelVersionId=2788849'
# 3. externalize the new real model.safetensors into the store:
python/venv/bin/python scripts/externalize_models.py --apply
```

### Externalization ordering (path B)
The existing `model.safetensors` is a symlink to the old 4-bit store blob.
`convert.py --zit-checkpoint` `rmtree`s the target dir first (so the symlink is
gone and a fresh real file is written — safe). After it writes the new 8-bit
file, run `externalize_models.py --apply` to move it to
`../video_generation__models/<new-md5>.safetensors`, create the symlink, and
rewrite `store-manifest.json`. The script does **not** prune orphaned blobs —
delete the old `<old-md5>.safetensors` from the store **after** the new 8-bit
file load-tests OK (first confirm no other symlink references it).

### Manifest curation
`convert.py --zit-checkpoint` writes a basic manifest (`name/type/arch/format/
description/source/source_url/size_bytes/...`). The current dark-beast manifest
has curated fields (`recommended_steps/cfg/resolution/sampler/vae`, `author_notes`)
that the regen **drops** — merge them back from a backup:

```bash
cp models/transformer/dark-beast-dbzit9/manifest.json /tmp/dbzit9.bak.json   # BEFORE re-converting
# ... re-convert ...
# then restore recommended_* + author_notes into the new manifest, keep format=mlx-8bit + new size_bytes
```

## Per-model notes

- **`dark-beast-dbzit9`** — re-derive from **fp8** (7 GB, preferred — smaller) or
  bf16 (12 GB). Either converts cleanly now. Biggest quality win (was fp8→4bit).
- **`seedvr2-7b`** — HF download `ByteDance-Seed/SeedVR2-7B` →
  `convert.py --seedvr2-dit --bits 8 --group-size 64`. The seedvr2 loader is now
  manifest-driven (`app/seedvr2/pipeline.py:_detect_quant_from_manifest`), so set
  the manifest `format: mlx-8bit`. VAE loader already auto-detects quantization.
- **`zimage-moody-v126` / `ernie-redmix-redzit15`** — gated: first identify the
  exact upstream checkpoint. moody is the GUI default + most-A/B-tested (upgrading
  shifts baselines). Skip + note in `author_notes` if the source can't be pinned.

## Verification
- `python/venv/bin/python python/mlx-movie-director/run.py check-model`
  (accepts `mlx-8bit`; checks disk + `size_bytes`).
- Per zimage: `run.py image t2i --transformer <name> --self-test` (or `--steps 2`).
- seedvr2: `run.py image upscale --upscale-method seedvr2 …` +
  `pytest app/tests/test_seedvr2_*.py`.
- `pytest app/tests/test_convert_fp8.py` (FP8 converter regression).
- `bun run check:schema` (GUI↔CLI boundary; model names unchanged).
- Confirm `_detect_transformer_quant` / `_detect_quant_from_manifest` return
  (8,64) for the new `mlx-8bit` manifests.

## Rollback
Keep the old 4-bit store blob until the new 8-bit file load-tests OK. Rollback =
`scripts/externalize_models.py --relink` against the prior manifest, or re-add the
old symlink by hand. Work on `feat/models-8bit`; merge via PR (not direct to main).

## Completion log (2026-06-22)

| Model | Outcome |
|---|---|
| `dark-beast-dbzit9` | ✅ 8-bit via `import-checkpoint` from civitai 2242173 bf16. `mlx-4bit-gs32`→`mlx-8bit`, 3.8→6.5 GB. New blob `300437ff`. Smoke-tested (loads 8-bit GS64, generates). Curated `recommended_*`/`author_notes` + 4-bit A/B history (`kb.jsonl`) preserved; `size_bytes` bug (488) fixed. |
| `seedvr2-7b` | ✅ 8-bit via `convert.py --seedvr2-dit --bits 8 --group-size 64`. Source = **Comfy-Org/SeedVR2** `seedvr2_7b_fp16.safetensors` (16 GB, ComfyUI-repackaged safetensors — NOT the raw HF `.pth`, which is 33 GB fp32 with a container format `load_pt_file` can't read). 5.1→8.8 GB. New blob `96d45077`. Manifest hand-set to `mlx-8bit`. Upscale smoke-tested (1280×1920, 15.8 s). |
| `zimage-moody-v126` | ❌ **retired** — the "V12.6 DPO" source does not exist on CivitAI (Moody Pro Mix jumps V12 DPO→V13), and dequantizing the existing 4-bit file to 8-bit yields no quality gain. Default switched to the **existing 8-bit `moody-pro-mix`** (Moody Pro Mix ZIT V13, already `mlx-8bit`, already the video t2i2v default). 13 `compatible_with` refs renamed; `config.py` + GUI defaults updated; dir deleted. |
| `ernie-redmix-redzit15` | ⏳ **still pending** — provenance broken (`source_url` 958009 is a Flux model, not a ZIT checkpoint). Cannot re-derive correctly. |

**Two corrections to the original plan:** (1) the HF `ByteDance-Seed/SeedVR2-7B`
source is a 33 GB fp32 `.pth` that `convert.py`'s `load_pt_file`
(= `safetensors.torch.load_file`) cannot read — the Comfy-Org fp16 safetensors is
the clean source instead; (2) `convert.py --seedvr2-dit` does **not** `rmtree`
the target dir before saving (unlike the zimage path), so the old store-blob
symlink must be removed first or the save writes *through* it and corrupts the
shared 4-bit blob in place.

Orphaned 4-bit blobs pruned after load-tests passed: `f1198f38`, `0cbb9877`,
`58518e08` (~12.7 GB reclaimed). Store now 64 tracked entries.
