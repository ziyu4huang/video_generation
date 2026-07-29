# Kontext Swift-Native Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `flux2 kontext` (FLUX.1-Kontext-dev in-context generation) a real Swift/MLX generation path and take `image kontext` off the `runpy_image` Python bridge, closing out the last piece of the 2026-07-14 kontext epic (transformer/VAE/CLIP/T5 are already numerically verified — only the denoise loop, CLI, weight import, and TS registry wiring are missing).

**Architecture:** A new `KontextPipeline` class in `swift/flux2-image-director/Sources/Flux2Director/` wires the already-ported `KontextTransformer`/`KontextCLIPEncoder`/`KontextT5Encoder`/reused `ZImageVAEEncoder`/`ZImageVAEDecoder` into a real denoise loop (ported line-for-line from `../mflux`'s `Flux1Kontext.generate_image`), exposed as `flux2 kontext` (same binary/package as `t2i`/`edit`/etc). TS wiring is a **declarative addition**, not new plumbing: `pi-agent-ext-flux2` already has a generic `flux2 <subcommand>` dispatcher (`commands.ts` + `invoke.ts`), so adding Kontext support there and moving `"kontext"` from `runpy_image`'s command list to `flux2_image`'s in `pi-agent-ext-movie-director/src/registry.ts` is sufficient — no new binary-resolution file, no new invoke key.

**Tech Stack:** Swift 6 / MLX-Swift (`swift/flux2-image-director`), Python 3.12 (`import-kontext.py`, dev-tooling only), TypeScript/Bun (`pi-agent-ext-flux2`, `pi-agent-ext-movie-director`).

---

## Design decisions carried from research (do not re-derive — verified against `../mflux` source)

These come from reading `../mflux/src/mflux/models/flux/variants/kontext/flux_kontext.py`, `kontext_util.py`, `.../flux_transformer/transformer.py`, `.../common/schedulers/linear_scheduler.py`, `.../common/config/model_config.py`, `.../common/vae/vae_util.py`, and `.../utils/image_util.py` directly. Cite them; don't reverify from scratch unless a test fails.

- **Sigma schedule** (linear scheduler, `requires_sigma_shift=True` for `dev-kontext`): `sigmas = linspace(1.0, 1/steps, steps) + [0.0]`, then shift: `m = (1.15 - 0.5) / (4096 - 256)`, `b = 0.5 - m*256`, `mu = m*width*height/256 + b`, `shifted = exp(mu) / (exp(mu) + (1/sigmas[:-1] - 1))`, final sigmas `= shifted + [0.0]`. `sigma_shift_terminal` is unset for `dev-kontext` (skip that branch). `num_train_steps = 1000`.
- **Per-step timestep/guidance fed to the transformer**: `time_step = sigmas[t] * 1000`, `guidance_val = guidance * 1000` (both broadcast to shape `[1]`, cast to `.bfloat16`).
- **Scheduler step** (Euler): `dt = sigmas[t+1] - sigmas[t]`; `latents = latents + noise.astype(latents.dtype) * dt`. `scale_model_input` is a no-op (identity) for the linear scheduler.
- **Noise init**: `MLXRandom.normal([1, imgSeqLen, 64], dtype: .float32, key: MLXRandom.key(seed))` where `imgSeqLen = (height/16)*(width/16)` — matches `Flux2LatentCreator.preparePackedLatents`'s exact `MLXRandom.key(seed)` convention for reproducibility.
- **Hero image conditioning**: resize to the exact target `(width, height)` (stretch, not aspect-preserving crop — matches `ImageUtil.scale_to_dimensions`), normalize `[0,1] -> [-1,1]`, VAE-encode, `KontextLatentCreator.packLatents` → `(1, imgSeqLen, 64)` reference tokens + `KontextUtil.createImageIds` → reference RoPE ids (leading `1`).
- **RoPE ids fed to the transformer each step**: `imageIds = concat([KontextUtil.createGenerationImageIds(height, width), kontextReferenceIds], axis: 1)` — generation ids (leading `0`) FIRST, reference ids (leading `1`) SECOND. The transformer's `callAsFunction` internally prepends the text ids; callers must NOT prepend text ids themselves.
- **Per-step hidden states**: `hiddenStates = concat([currentLatents, referenceLatents], axis: 1)` (generation latents first). Transformer output has the SAME combined length; slice `noise = output[:, ..<currentLatents.dim(1), ...]` before the scheduler step — the reference-token portion of the output is discarded every step.
- **No CFG, no img2img blend**: Kontext's `image_strength` is never set by the Python caller, so `init_time_step = 0` — the loop always runs the full `0..<steps` range starting from pure noise (NOT `Flux2EditPipeline`'s SDEdit partial-denoise path). There is also no negative-prompt/dual-transformer-call CFG — `guidance` is the CFG-distilled guidance EMBEDDING value only (single transformer call per step), same mechanism as Klein-9B's `cfgScale` being folded into one pass.
- **Output decode**: `unpack_latents` → `(1, 16, H/8, W/8)` (note: unlike Klein's 128-channel packing, Kontext unpacks to 16 channels directly — reuse `KontextLatentCreator.unpackLatents`, NOT `Flux2LatentCreator`'s Klein-specific unpack) → `ZImageVAEDecoder` → denormalize `clip(x/2+0.5, 0, 1)` (same convention `Flux2T2IPipeline.saveImage` already assumes: `pixels * 0.5 + 0.5` then clip on save).
- **Defaults** (from `image-kontext.py`): `guidance = 2.5`, `steps = 20`, `width = height = 1024`.
- **Dtype convention**: cast the noise latents, reference latents, and combined `hiddenStates` to `.bfloat16` immediately before every `KontextTransformer` call (matches `Flux2T2IPipeline`/`Flux2EditPipeline`'s established convention of feeding bf16 into the bf16-weighted transformer; `KontextTransformer.swift`'s own header comments flag bf16-vs-fp32 precision as measurably significant at t=0, so don't skip this cast).
- **LoRA: explicitly OUT of v1.** `image-kontext.py` supports `--lora-path`/`--lora-scale`, but `Flux2LoRALoaderCLI`/`Flux2LoRAAdapters` are built for `Flux2Transformer` (Klein-9B)'s architecture, not verified compatible with `KontextTransformer`'s different block/key structure. Do not attempt LoRA wiring in this plan.
- **`storyboard --kontext-lock` integration is OUT of scope** — `image-storyboard.py` keeps calling Python's `_run_kontext_generation` in-process; only the standalone `image kontext` / `flux2 kontext` path moves to Swift.

---

## Task 1: Weight import (`import-kontext.py`) — DONE (commit `30551e3f`)

**Post-execution correction (2026-07-29):** the script text below was written before implementation and named the tokenizer output dirs `tokenizer/kontext-dev-clip` / `tokenizer/kontext-dev-t5`. The real implementer hit a `check-model.py` constraint this plan didn't anticipate — the manifest `'name'` field must be unique **globally across every category**, not just within `tokenizer/`, so reusing the `text_encoder/` basenames (`kontext-dev-clip`, `kontext-dev-t5`) collided. The actual, committed output directories are `mlx-models/tokenizer/kontext-dev-clip-tok/` and `mlx-models/tokenizer/kontext-dev-t5-tok/` (`-tok` suffix). All downstream tasks (3 and 4, Swift CLI + TS field defaults) have been updated below to reference the `-tok` names — treat those as authoritative, not the `Step 1` script listing's `clip_tok_dir`/`t5_tok_dir` variable values. `check-model.py` also gained a `WEIGHT_FILENAMES` entry for `vocab.json` (CLIP's legacy tokenizer has no fast `tokenizer.json`) as part of this task's commit.

**Files:**
- Create: `python/mlx-movie-director/app/commands/import-kontext.py`
- Test: manual verification via `run.py check-model` (no pytest — matches `import-musicgen.py`'s precedent, dev-tooling has no automated test suite)

The HF snapshot for `black-forest-labs/FLUX.1-Kontext-dev` is **already cached locally** (used by this session's `verify-kontext-*` commands) at `~/.cache/huggingface/hub/models--black-forest-labs--FLUX.1-Kontext-dev/snapshots/<hash>/`, with `transformer/`, `text_encoder/` (CLIP), `text_encoder_2/` (T5) subdirectories, each already in the standard raw-HF-safetensors format `KontextTransformerWeights.load`/`KontextCLIPWeights.load`/`KontextT5Weights.load` read directly (**identity key mapping — no conversion needed**, unlike MusicGen's merged/prefixed checkpoint). This script copies (not converts) those three subdirectories into `mlx-models/`, following this repo's externalized-weight + manifest convention, plus the CLIP/T5 tokenizer files.

- [ ] **Step 1: Write the script**

```python
"""import-kontext — copy FLUX.1-Kontext-dev's transformer/CLIP/T5 weights and
tokenizer files from the local HF cache into this repo's mlx-models/
external-store convention, for the Swift `flux2 kontext` production path.

Unlike import-musicgen.py, this is a COPY, not a conversion: the raw HF
safetensors for the transformer/CLIP/T5 use an identity key mapping already
(confirmed by KontextTransformerWeights.load / KontextCLIPWeights.load /
KontextT5Weights.load in swift/flux2-image-director, which read these
directories directly) — no mx.load/remap/mx.save round-trip needed. The VAE
is NOT handled here — it was already converted separately (convert.py
--kontext-vae-mlx) and lives at mlx-models/vae/flux-kontext-ae/.

FLUX.1-Kontext-dev is a GATED HF repo — the first `snapshot_download` on a
fresh machine requires `huggingface-cli login` / HF_TOKEN and accepting the
license at https://huggingface.co/black-forest-labs/FLUX.1-Kontext-dev. This
session's snapshot is already cached (used by `flux2 verify-kontext-*`), so
`snapshot_download` here is a cache hit, not a fresh download.

This is dev-tooling only (same standing-rule carve-out as import-checkpoint.py/
import-musicgen.py) — not a production generation code path.

Usage:
  run.py import-kontext
  run.py import-kontext --model black-forest-labs/FLUX.1-Kontext-dev --name kontext-dev
"""

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

from app import config as cfg

PARSER_META = {
    "help": "Copy FLUX.1-Kontext-dev transformer/CLIP/T5 weights for the Swift kontext port",
    "description": (
        "Copies the transformer/text_encoder/text_encoder_2 subdirectories of a\n"
        "locally-cached black-forest-labs/FLUX.1-Kontext-dev snapshot into\n"
        "mlx-models/{transformer,text_encoder,tokenizer}/, externalizing each\n"
        "weights/tokenizer file into the shared video_generation__models/ store.\n\n"
        "Examples:\n"
        "  run.py import-kontext\n"
        "  run.py import-kontext --model black-forest-labs/FLUX.1-Kontext-dev --name kontext-dev\n"
    ),
}


def add_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--model", type=str, default="black-forest-labs/FLUX.1-Kontext-dev",
                        help="HF model id (default: black-forest-labs/FLUX.1-Kontext-dev)")
    parser.add_argument("--name", type=str, default="kontext-dev",
                        help="Base output name (default: kontext-dev)")


def run(args: argparse.Namespace) -> None:
    name = args.name
    transformer_dir = Path(cfg.MODELS_DIR) / "transformer" / name
    clip_dir = Path(cfg.MODELS_DIR) / "text_encoder" / f"{name}-clip"
    t5_dir = Path(cfg.MODELS_DIR) / "text_encoder" / f"{name}-t5"
    clip_tok_dir = Path(cfg.MODELS_DIR) / "tokenizer" / f"{name}-clip"
    t5_tok_dir = Path(cfg.MODELS_DIR) / "tokenizer" / f"{name}-t5"

    for d in (transformer_dir, clip_dir, t5_dir, clip_tok_dir, t5_tok_dir):
        if d.exists():
            print(f"ERROR: target already exists: {d}", file=sys.stderr)
            sys.exit(1)

    made = []
    try:
        snap_dir = _resolve_snapshot(args.model)

        made.append(_copy_component(
            src=snap_dir / "transformer", dst=transformer_dir,
            category="transformer",
            description=f"FLUX.1-Kontext-dev transformer (19 joint + 38 single blocks, "
                        f"unquantized bf16) for the swift/flux2-image-director kontext port.",
            cli={"binary": "flux2", "action": "kontext", "flag": "--transformer"},
        ))
        made.append(_copy_component(
            src=snap_dir / "text_encoder", dst=clip_dir,
            category="text_encoder",
            description="FLUX.1-Kontext-dev CLIP text encoder (pooled projection, 768-dim).",
            cli={"binary": "flux2", "action": "kontext", "flag": "--clip-encoder"},
        ))
        made.append(_copy_component(
            src=snap_dir / "text_encoder_2", dst=t5_dir,
            category="text_encoder",
            description="FLUX.1-Kontext-dev T5 text encoder (t5-v1_1-xxl-derived, 4096-dim).",
            cli={"binary": "flux2", "action": "kontext", "flag": "--t5-encoder"},
            # Real T5 HF configs use `d_model`, not `hidden_size` — check-model's
            # text_encoder schema requires one of hidden_size/cross_attention_dim.
            # Add a hidden_size alias (copy, not rename) so check-model passes
            # without touching check-model.py's shared schema.
            config_aliases={"hidden_size": "d_model"},
        ))
        made.append(_copy_tokenizer_clip(snap_dir / "tokenizer", clip_tok_dir))
        made.append(_copy_tokenizer_t5(snap_dir / "tokenizer_2", t5_tok_dir))
    except BaseException:
        for d in made:
            shutil.rmtree(d, ignore_errors=True)
        raise

    print(f"\n[import-kontext] done:")
    print(f"  transformer -> {transformer_dir}")
    print(f"  clip        -> {clip_dir}")
    print(f"  t5          -> {t5_dir}")
    print(f"  clip tok    -> {clip_tok_dir}")
    print(f"  t5 tok      -> {t5_tok_dir}")
    print("Validate: python/venv/bin/python python/mlx-movie-director/run.py check-model")


def _resolve_snapshot(model: str) -> Path:
    from huggingface_hub import snapshot_download
    try:
        return Path(snapshot_download(repo_id=model))
    except Exception as exc:
        msg = str(exc).lower()
        if "gated" in msg or "401" in msg or "unauthorized" in msg or "access" in msg:
            print(
                f"[import-kontext] {model} is a GATED HF repo. Accept the license at\n"
                f"          https://huggingface.co/{model}\n"
                "          and set HF_TOKEN (huggingface-cli login) before retrying.",
                file=sys.stderr,
            )
        raise


def _copy_component(*, src: Path, dst: Path, category: str, description: str,
                    cli: dict, config_aliases: dict | None = None) -> Path:
    if not src.exists():
        print(f"ERROR: expected source dir not found: {src}", file=sys.stderr)
        sys.exit(1)
    dst.mkdir(parents=True, exist_ok=True)

    shard_count = 0
    for f in sorted(src.glob("*.safetensors")):
        out = dst / f.name
        shutil.copy(f, out)
        _externalize_weights(str(out))
        shard_count += 1
    if shard_count == 0:
        print(f"ERROR: no .safetensors shards found in {src}", file=sys.stderr)
        sys.exit(1)
    print(f"  [{dst.name}] copied {shard_count} safetensors shard(s)")

    config_src = src / "config.json"
    if config_src.exists():
        config = json.loads(config_src.read_text())
        for alias_key, source_key in (config_aliases or {}).items():
            if alias_key not in config and source_key in config:
                config[alias_key] = config[source_key]
        (dst / "config.json").write_text(json.dumps(config, indent=2) + "\n")
    else:
        print(f"  WARNING: no config.json at {config_src} — check-model's "
              f"{category} schema check will fail without one", file=sys.stderr)

    manifest = {
        "name": dst.name,
        "type": category,
        "arch": "flux1-kontext-dev",
        "format": "mlx-bf16",
        "description": description,
        "source": "https://huggingface.co/black-forest-labs/FLUX.1-Kontext-dev",
        "cli": cli,
        "compatible_with": [],
        "size_bytes": _dir_size(str(dst)),
        "created_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    (dst / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    (dst / "README.md").write_text(
        f"# {dst.name}\n\n{description}\n\n"
        f"Source: [black-forest-labs/FLUX.1-Kontext-dev]"
        f"(https://huggingface.co/black-forest-labs/FLUX.1-Kontext-dev)\n\n"
        f"Imported via `run.py import-kontext`.\n"
    )
    return dst


def _copy_tokenizer_clip(src: Path, dst: Path) -> Path:
    if not src.exists():
        print(f"ERROR: expected CLIP tokenizer dir not found: {src}", file=sys.stderr)
        sys.exit(1)
    dst.mkdir(parents=True, exist_ok=True)
    for fname in ("vocab.json", "merges.txt"):
        f = src / fname
        if not f.exists():
            print(f"ERROR: expected {fname} not found at {f}", file=sys.stderr)
            sys.exit(1)
        shutil.copy(f, dst / fname)
    (dst / "manifest.json").write_text(json.dumps({
        "name": dst.name, "type": "tokenizer", "arch": "clip-vit-l",
        "format": "raw", "description": "FLUX.1-Kontext-dev CLIP tokenizer (vocab.json + merges.txt).",
        "source": "https://huggingface.co/black-forest-labs/FLUX.1-Kontext-dev",
        "compatible_with": [], "size_bytes": _dir_size(str(dst)),
        "created_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }, indent=2) + "\n")
    (dst / "README.md").write_text(f"# {dst.name}\n\nCLIP tokenizer (vocab.json + merges.txt) "
                                   "for the Swift kontext port. Imported via `run.py import-kontext`.\n")
    print(f"  [{dst.name}] copied vocab.json + merges.txt")
    return dst


def _copy_tokenizer_t5(src: Path, dst: Path) -> Path:
    if not src.exists():
        print(f"ERROR: expected T5 tokenizer dir not found: {src}", file=sys.stderr)
        sys.exit(1)
    dst.mkdir(parents=True, exist_ok=True)
    f = src / "tokenizer.json"
    if not f.exists():
        print(f"ERROR: expected tokenizer.json not found at {f}", file=sys.stderr)
        sys.exit(1)
    out = dst / "tokenizer.json"
    shutil.copy(f, out)
    _externalize_weights(str(out))   # T5's tokenizer.json is typically >2MB
    (dst / "manifest.json").write_text(json.dumps({
        "name": dst.name, "type": "tokenizer", "arch": "t5-v1_1-xxl",
        "format": "raw", "description": "FLUX.1-Kontext-dev T5 tokenizer (SentencePiece Unigram, tokenizer.json).",
        "source": "https://huggingface.co/black-forest-labs/FLUX.1-Kontext-dev",
        "compatible_with": [], "size_bytes": _dir_size(str(dst)),
        "created_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }, indent=2) + "\n")
    (dst / "README.md").write_text(f"# {dst.name}\n\nT5 tokenizer (tokenizer.json) "
                                   "for the Swift kontext port. Imported via `run.py import-kontext`.\n")
    print(f"  [{dst.name}] copied + externalized tokenizer.json")
    return dst


# ---------------------------------------------------------------------------
# External model store (duplicated from import-musicgen.py's convention —
# see that file's matching section for the authoritative comments)
# ---------------------------------------------------------------------------

def _dir_size(path: str) -> int:
    total = 0
    for dirpath, _, filenames in os.walk(path):
        for fn in filenames:
            fp = os.path.join(dirpath, fn)
            real = os.path.realpath(fp)
            if os.path.isfile(real):
                total += os.path.getsize(real)
    return total


def _md5_file(path: str, chunk: int = 1 << 20) -> str:
    h = hashlib.md5()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(chunk), b""):
            h.update(block)
    return h.hexdigest()


def _external_store_dir() -> str:
    manifest_file = os.path.join(cfg.MODELS_DIR, "store-manifest.json")
    if os.path.exists(manifest_file):
        with open(manifest_file) as f:
            rel = json.load(f).get("store_relative_to_repo_root", "../video_generation__models")
    else:
        rel = "../video_generation__models"
    return os.path.normpath(os.path.join(cfg.REPO_DIR, rel))


def _externalize_weights(weights_path: str) -> None:
    store_dir = _external_store_dir()
    os.makedirs(store_dir, exist_ok=True)

    md5 = _md5_file(weights_path)
    ext = os.path.splitext(weights_path)[1] or ".safetensors"
    store_path = os.path.join(store_dir, f"{md5}{ext}")
    file_size = os.path.getsize(weights_path)

    if os.path.exists(store_path):
        os.remove(weights_path)
    else:
        shutil.move(weights_path, store_path)
        if _md5_file(store_path) != md5:
            raise RuntimeError(f"MD5 mismatch after move to external store: {store_path}")

    rel = os.path.relpath(store_path, os.path.dirname(weights_path))
    os.symlink(rel, weights_path)

    manifest_file = os.path.join(cfg.MODELS_DIR, "store-manifest.json")
    if os.path.exists(manifest_file):
        with open(manifest_file) as f:
            doc = json.load(f)
    else:
        doc = {"version": 1, "store_relative_to_repo_root": "../video_generation__models",
               "count": 0, "files": {}}
    key = os.path.relpath(weights_path, cfg.MODELS_DIR)
    doc["files"][key] = {"md5": md5, "size": file_size}
    doc["count"] = len(doc["files"])
    with open(manifest_file, "w") as f:
        json.dump(doc, f, indent=2, ensure_ascii=False)
        f.write("\n")

    _git_add_force(weights_path)


def _git_add_force(path: str) -> None:
    try:
        result = subprocess.run(["git", "add", "-f", "--", path],
                                capture_output=True, text=True, timeout=30)
    except (FileNotFoundError, subprocess.SubprocessError, OSError) as e:
        print(f"    WARNING: could not run git add -f ({e}) — stage the symlink manually")
        return
    if result.returncode != 0:
        print(f"    WARNING: git add -f failed (rc={result.returncode}): {result.stderr.strip()}")
```

- [ ] **Step 2: Register the command**

Find how `import-musicgen.py` gets registered as a `run.py` subcommand (grep `import-musicgen` in `python/mlx-movie-director/run.py` or its command-discovery module) and add `import-kontext` the same way. This repo auto-discovers hyphenated `app/commands/*.py` files by convention (confirmed by `image-kontext.py`'s own `_kontext_module()` using `importlib.import_module("app.commands.image-kontext")`) — if discovery is truly automatic, this step may be a no-op; verify by running `python/venv/bin/python python/mlx-movie-director/run.py --help` and confirming `import-kontext` is listed before moving on.

- [ ] **Step 3: Run it**

```bash
python/venv/bin/python python/mlx-movie-director/run.py import-kontext
```

Expected: five directories created under `mlx-models/{transformer,text_encoder,tokenizer}/`, no errors. If `_resolve_snapshot` fails with a gated-repo error, the snapshot isn't cached on this machine — stop and report (do not attempt to work around auth).

- [ ] **Step 4: Validate against check-model**

```bash
python/venv/bin/python python/mlx-movie-director/run.py check-model
```

Expected: no errors for `transformer/kontext-dev`, `text_encoder/kontext-dev-clip`, `text_encoder/kontext-dev-t5`, `tokenizer/kontext-dev-clip`, `tokenizer/kontext-dev-t5`. If the T5 component fails the dimension `any_of` check, inspect `mlx-models/text_encoder/kontext-dev-t5/config.json` — confirm whether the real field is `d_model` (the `config_aliases={"hidden_size": "d_model"}` in Step 1 should have handled it; if the real HF config uses some other field name, adjust the alias mapping and re-run `import-kontext` after deleting the five target directories).

- [ ] **Step 5: Commit**

```bash
git add python/mlx-movie-director/app/commands/import-kontext.py \
        mlx-models/transformer/kontext-dev \
        mlx-models/text_encoder/kontext-dev-clip mlx-models/text_encoder/kontext-dev-t5 \
        mlx-models/tokenizer/kontext-dev-clip mlx-models/tokenizer/kontext-dev-t5
git commit -m "feat(kontext): import FLUX.1-Kontext-dev weights into mlx-models/ (Task 1)"
```

---

## Task 2: `KontextPipeline` (the denoise loop)

**Files:**
- Create: `swift/flux2-image-director/Sources/Flux2Director/KontextPipeline.swift`
- Test: manual verification via a throwaway CLI driver in Task 3 (this package has no XCTest target — matches `KontextTransformer.shapeSelfTest()`'s existing precedent of structural-only verification without a formal test target)

- [ ] **Step 1: Write `KontextPipeline.swift`**

```swift
//
//  KontextPipeline.swift
//  Flux2Director
//
//  End-to-end Kontext (FLUX.1-Kontext-dev) in-context generation. Wires the
//  already-verified KontextTransformer/KontextCLIPEncoder/KontextT5Encoder +
//  reused ZImageVAEEncoder/ZImageVAEDecoder into a real denoise loop, ported
//  line-for-line from ../mflux's Flux1Kontext.generate_image /
//  KontextUtil.create_image_conditioning_latents / Transformer.__call__ /
//  LinearScheduler (dev-kontext: requires_sigma_shift=true, num_train_steps=
//  1000, sigma_base_shift=0.5, sigma_max_shift=1.15, sigma_base_seq_len=256,
//  sigma_max_seq_len=4096, no sigma_shift_terminal). See the design plan's
//  "Design decisions carried from research" section for citations.
//
//  Distinct from Flux2EditPipeline: no CFG (guidance is a distilled embedding,
//  one transformer call per step), no img2img partial-denoise (Kontext's
//  image_strength is never set — always full noise-to-image), single hero
//  image only (no multi-ref).
//

import CommonImageDirector
import Foundation
import MLX
import MLXRandom
import ZImageDirector

public struct KontextPipeline {
    public let transformer: KontextTransformer
    public let clipEncoder: KontextCLIPEncoder
    public let t5Encoder: KontextT5Encoder
    public let vaeEncoder: ZImageVAEEncoder
    public let vaeDecoder: ZImageVAEDecoder
    public var clipTokenizer: KontextCLIPTokenizer
    public let t5Tokenizer: KontextT5Tokenizer

    public init(transformer: KontextTransformer, clipEncoder: KontextCLIPEncoder,
                t5Encoder: KontextT5Encoder, vaeEncoder: ZImageVAEEncoder,
                vaeDecoder: ZImageVAEDecoder, clipTokenizer: KontextCLIPTokenizer,
                t5Tokenizer: KontextT5Tokenizer) {
        self.transformer = transformer
        self.clipEncoder = clipEncoder
        self.t5Encoder = t5Encoder
        self.vaeEncoder = vaeEncoder
        self.vaeDecoder = vaeDecoder
        self.clipTokenizer = clipTokenizer
        self.t5Tokenizer = t5Tokenizer
    }

    /// Generate an in-context render. `heroImagePath` is the identity anchor
    /// (single reference image — NOT multi-ref). Returns (pixels (1,3,H,W)
    /// float32 in [0,1], elapsed seconds).
    public func generate(prompt: String, heroImagePath: URL, seed: UInt64,
                         width: Int, height: Int, steps: Int, guidance: Float)
        -> (MLXArray, Double)
    {
        let start = DispatchTime.now()

        // 1. Text encode (T5 prompt_embeds + CLIP pooled_prompt_embeds).
        //    max_sequence_length=512 for T5 (dev-kontext's ModelConfig), 77 for
        //    CLIP (KontextCLIPTokenizer.maxLength, fixed).
        let t5Ids = t5Tokenizer.tokenize(prompt, maxLength: 512)
        let promptEmbeds = t5Encoder(MLXArray(t5Ids.map { Int32($0) }).reshaped([1, -1]))
            .asType(.bfloat16)
        var clipTok = clipTokenizer
        let clipIds = clipTok.tokenize(prompt)
        let pooledPromptEmbeds = clipEncoder(MLXArray(clipIds.map { Int32($0) }).reshaped([1, -1]))
            .asType(.bfloat16)

        // 2. Hero image conditioning: resize to (width,height) [stretch, matches
        //    ImageUtil.scale_to_dimensions], normalize [-1,1], VAE-encode, pack.
        let heroPixels = try! Flux2ImageLoad.loadArray(from: heroImagePath, targetSize: (width: width, height: height))
        let heroNormalized = Flux2ImageLoad.normalizeForVAE(heroPixels).asType(.bfloat16)
        let heroLatent = vaeEncoder(heroNormalized).asType(.float32)
        let referenceLatents = KontextLatentCreator.packLatents(heroLatent, height: height, width: width)
            .asType(.bfloat16)
        let referenceIds = KontextUtil.createImageIds(height: height, width: width)
        let generationIds = KontextUtil.createGenerationImageIds(height: height, width: width)
        let imageIds = MLX.concatenated([generationIds, referenceIds], axis: 1)

        // 3. Noise latents. Matches Flux2LatentCreator.preparePackedLatents's
        //    MLXRandom.key(seed) convention for reproducibility.
        let imgSeqLen = (height / 16) * (width / 16)
        let key = MLXRandom.key(seed)
        var current = MLXRandom.normal([1, imgSeqLen, 64], dtype: .float32, key: key).asType(.bfloat16)

        // 4. Sigma schedule (linear + sigma-shift, dev-kontext constants).
        let sigmas = KontextPipeline.sigmaSchedule(steps: steps, width: width, height: height)
        MLX.eval(sigmas)

        // 5. Denoise loop. No CFG (single transformer call/step, guidance is a
        //    distilled embedding), no img2img blend (Kontext always starts
        //    from pure noise — init_time_step is always 0 in the Python ref).
        for t in 0..<steps {
            let sigmaT = sigmas[t].item(Float.self)
            let timeStep = MLXArray([sigmaT * 1000]).asType(.bfloat16)
            let guidanceVal = MLXArray([guidance * 1000]).asType(.bfloat16)

            let hiddenStates = MLX.concatenated([current, referenceLatents], axis: 1)
            var noise = transformer(
                timeStep: timeStep, guidance: guidanceVal, hiddenStates: hiddenStates,
                promptEmbeds: promptEmbeds, pooledPromptEmbeds: pooledPromptEmbeds,
                imageIds: imageIds)
            noise = noise[0..., 0..<imgSeqLen, 0...]

            let dt = (sigmas[t + 1] - sigmas[t]).asType(current.dtype)
            current = (current + noise.asType(current.dtype) * dt).asType(.bfloat16)
            MLX.eval(current)
        }

        // 6. Unpack (16ch, NOT Klein's 128ch) + VAE decode + denormalize.
        let unpacked = KontextLatentCreator.unpackLatents(current, height: height, width: width)
        let decoded = vaeDecoder(unpacked).asType(.float32)
        let pixels = MLX.clip(decoded * 0.5 + 0.5, min: 0.0, max: 1.0)
        MLX.eval(pixels)

        let elapsed = Double(DispatchTime.now().uptimeNanoseconds - start.uptimeNanoseconds) / 1e9
        return (pixels, elapsed)
    }

    /// Linear scheduler sigma schedule with dev-kontext's sigma-shift applied.
    /// Matches ../mflux's LinearScheduler._get_sigmas exactly (requires_sigma_shift
    /// =true, sigma_base_shift=0.5, sigma_max_shift=1.15, sigma_base_seq_len=256,
    /// sigma_max_seq_len=4096, sigma_shift_terminal unset for dev-kontext).
    static func sigmaSchedule(steps: Int, width: Int, height: Int) -> MLXArray {
        let base = MLX.linspace(1.0, 1.0 / Float(steps), count: steps).asType(.float32)
        let sigmasNoTerm = MLX.concatenated([base, MLX.zeros([1])], axis: 0)

        let sigmaBaseShift: Float = 0.5
        let sigmaMaxShift: Float = 1.15
        let sigmaBaseSeqLen: Float = 256
        let sigmaMaxSeqLen: Float = 4096
        let m = (sigmaMaxShift - sigmaBaseShift) / (sigmaMaxSeqLen - sigmaBaseSeqLen)
        let b = sigmaBaseShift - m * sigmaBaseSeqLen
        let mu = m * Float(width) * Float(height) / 256 + b

        let leading = sigmasNoTerm[0..<steps]
        let shifted = MLX.exp(MLXArray(mu)) / (MLX.exp(MLXArray(mu)) + (1.0 / leading - 1.0))
        return MLX.concatenated([shifted, MLX.zeros([1])], axis: 0)
    }

    /// Clamp pixels to [0,1] and save as PNG (mirrors Flux2T2IPipeline.saveImage).
    public static func saveImage(_ pixels: MLXArray, to url: URL) throws {
        let clamped = MLX.clip(pixels, min: 0.0, max: 1.0)
        try ImageSave.savePNG(clamped, to: url)
    }
}
```

- [ ] **Step 2: Build**

```bash
swift build --package-path swift/flux2-image-director -c release 2>&1 | tail -50
```

Expected: clean build. If `MLX.linspace` doesn't exist with that exact signature, check `Flux2Scheduler.swift`'s own sigma computation for the actual API MLX-Swift exposes and adjust (search `grep -rn "linspace" swift/flux2-image-director/Sources/`).

- [ ] **Step 3: Commit**

```bash
git add swift/flux2-image-director/Sources/Flux2Director/KontextPipeline.swift
git commit -m "feat(kontext): KontextPipeline denoise loop (Task 2)"
```

---

## Task 3: `KontextCommand.swift` CLI + `Flux2CLI` registration

**Files:**
- Create: `swift/flux2-image-director/Sources/Flux2DirectorCLI/KontextCommand.swift`
- Modify: `swift/flux2-image-director/Sources/Flux2DirectorCLI/Flux2CLI.swift` (add `Kontext.self` to `subcommands`)

- [ ] **Step 1: Write `KontextCommand.swift`**

Mirrors `T2ICommand.swift`'s full pattern (loads models, generates, saves PNG, writes `run.json` + `manifest.json`). Model directory names default to what Task 1's `import-kontext` produces.

```swift
//
//  KontextCommand.swift
//  Flux2DirectorCLI
//
//  `flux2 kontext` — in-context generation via FLUX.1-Kontext-dev (identity-
//  anchored single hero image + prompt). Distinct model family from Flux2
//  Klein — own transformer/CLIP/T5, shared VAE loader (ZImageVAEEncoder/
//  Decoder, converted separately via convert.py --kontext-vae-mlx).
//

import ArgumentParser
import CommonImageDirector
import Flux2Director
import Foundation
import MLX
import ZImageDirector

extension Flux2CLI {
    struct Kontext: ParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "kontext",
            abstract: "In-context generation via FLUX.1-Kontext-dev (identity-anchored hero image + prompt)."
        )

        @OptionGroup var globals: GlobalOptions

        @Option(help: "Hero / identity-anchor image path.")
        var input: String

        @Option(help: "In-context instruction prompt.")
        var prompt: String

        @Option(help: "Transformer directory under models/transformer/.")
        var transformer: String = "kontext-dev"

        @Option(help: "CLIP text-encoder directory under models/text_encoder/.")
        var clipEncoder: String = "kontext-dev-clip"

        @Option(help: "T5 text-encoder directory under models/text_encoder/.")
        var t5Encoder: String = "kontext-dev-t5"

        @Option(help: "VAE weights directory under models/vae/.")
        var vae: String = "flux-kontext-ae"

        @Option(help: "CLIP tokenizer directory under models/tokenizer/.")
        var clipTokenizerDir: String = "kontext-dev-clip-tok"

        @Option(help: "T5 tokenizer directory under models/tokenizer/.")
        var t5TokenizerDir: String = "kontext-dev-t5-tok"

        @Option(help: "Random seed.")
        var seed: UInt64 = 42

        @Option(help: "Output image width (px).")
        var width: Int = 1024

        @Option(help: "Output image height (px).")
        var height: Int = 1024

        @Option(help: "Number of denoising steps.")
        var steps: Int = 20

        @Option(help: "CFG-distilled guidance embedding value.")
        var guidance: Float = 2.5

        @Option(help: "Output PNG path. Empty = auto timestamped name in output dir.")
        var output: String = ""

        @Option(help: "Output directory (default: ../video_generation__output, or MLX_OUTPUT_DIR).")
        var outputDir: String?

        @Option(help: "Custom base name (default: output_YYYYMMDD_HHMMSS).")
        var name: String?

        @Flag(help: "Skip writing run.json + manifest.json sidecars.")
        var noArtifacts: Bool = false

        func run() throws {
            setbuf(stdout, nil)
            globals.apply()
            print("flux2 kontext — FLUX.1-Kontext-dev (native Swift MLX)")
            print("  hero        : \(input)")
            print("  prompt      : \(prompt)")
            print("  size        : \(width)×\(height), steps: \(steps), guidance: \(guidance), seed: \(seed)")

            print("  loading models...")
            let tfWeights = try KontextTransformerWeights.load(
                dir: ModelPaths.transformerRoot.appendingPathComponent(transformer))
            let transformerModel = KontextTransformer.build(weights: tfWeights)

            let clipWeights = try KontextCLIPWeights.load(
                dir: ModelPaths.textEncoderRoot.appendingPathComponent(clipEncoder))
            let clipModel = KontextCLIPEncoder.build(weights: clipWeights)

            let t5Weights = try KontextT5Weights.load(
                dir: ModelPaths.textEncoderRoot.appendingPathComponent(t5Encoder))
            let t5Model = KontextT5Encoder.build(weights: t5Weights)

            let vaeURL = ModelPaths.vaeRoot.appendingPathComponent(vae).appendingPathComponent("model.safetensors")
            let vaeWeights = try loadArrays(url: vaeURL)
            let vaeEnc = ZImageVAEEncoder(weights: vaeWeights)
            let vaeDec = ZImageVAEDecoder(weights: vaeWeights)

            guard let clipTok = KontextCLIPTokenizer(
                vocabURL: ModelPaths.tokenizerRoot.appendingPathComponent(clipTokenizerDir).appendingPathComponent("vocab.json"),
                mergesURL: ModelPaths.tokenizerRoot.appendingPathComponent(clipTokenizerDir).appendingPathComponent("merges.txt")
            ) else {
                throw ValidationError("could not load CLIP tokenizer from \(clipTokenizerDir)")
            }
            guard let t5Tok = KontextT5Tokenizer(
                tokenizerJSONURL: ModelPaths.tokenizerRoot.appendingPathComponent(t5TokenizerDir).appendingPathComponent("tokenizer.json")
            ) else {
                throw ValidationError("could not load T5 tokenizer from \(t5TokenizerDir)")
            }

            let pipeline = KontextPipeline(
                transformer: transformerModel, clipEncoder: clipModel, t5Encoder: t5Model,
                vaeEncoder: vaeEnc, vaeDecoder: vaeDec, clipTokenizer: clipTok, t5Tokenizer: t5Tok)

            print("  generating...")
            let (pixels, elapsed) = pipeline.generate(
                prompt: prompt, heroImagePath: URL(fileURLWithPath: input), seed: seed,
                width: width, height: height, steps: steps, guidance: guidance)

            let paths = try OutputPathResolver.makePaths(
                explicitOutput: output.isEmpty ? nil : output,
                outputDir: outputDir, customName: name)
            let imagePath = URL(fileURLWithPath: paths.png)
            try KontextPipeline.saveImage(pixels, to: imagePath)
            print("")
            print("✅ generated \(imagePath.lastPathComponent)  (\(String(format: "%.1f", elapsed))s)")
            print("   \(imagePath.path)")

            if !noArtifacts {
                try writeArtifacts(paths: paths, elapsed: elapsed)
            }
        }

        private func writeArtifacts(paths: OutputPaths, elapsed: Double) throws {
            let startTime = Manifest.nowISO()
            let runConfig = RunConfig(
                transformer: transformer, prompt: prompt,
                width: width, height: height, steps: steps, seed: seed, cfgScale: guidance,
                loraPaths: nil, loraScale: 1.0,
                textEncoder: t5Encoder, tokenizer: t5TokenizerDir, vae: vae,
                quantBits: 16, quantGroupSize: 64, command: "kontext", pipeline: "kontext"
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
    }
}
```

- [ ] **Step 2: Register in `Flux2CLI.swift`**

In `swift/flux2-image-director/Sources/Flux2DirectorCLI/Flux2CLI.swift`, add `Kontext.self` to the `subcommands` array (any position — e.g. right after `Story.self,`):

```swift
        subcommands: [
            T2I.self, Edit.self, Angle.self, Segment.self, Swap.self, Style.self,
            Story.self, Kontext.self, Scene.self, Expand.self, Inpaint.self, FaceSwap.self, Upscale.self, Gate.self, Models.self, VerifyVAE.self, VerifyEncoder.self,
            VerifyTokenizer.self, VerifyTransformer.self, VerifyE2E.self,
            VerifyEdit.self, KVStyleTransfer.self, VerifyKontextTransformerShape.self,
            VerifyKontextTransformer.self, VerifyKontextVAE.self,
            VerifyKontextCLIP.self, VerifyKontextT5.self,
            VerifyKontextCLIPTokenizer.self, VerifyKontextT5Tokenizer.self,
        ]
```

- [ ] **Step 3: Build**

```bash
swift build --package-path swift/flux2-image-director -c release 2>&1 | tail -50
```

Expected: clean build, `.build/release/flux2` produced.

- [ ] **Step 4: Real-checkpoint smoke test**

Requires Task 1 done (weights present at `mlx-models/transformer/kontext-dev/` etc.) and a real hero image (any PNG/JPG on disk — a headshot or portrait works best given Kontext's identity-anchoring purpose).

```bash
.build/release/flux2 kontext \
  --input <path-to-a-real-portrait.png> \
  --prompt "the same person, now wearing a red jacket, studio lighting" \
  --steps 20 --seed 42
```

(Run from `swift/flux2-image-director/` or pass `--models-root` per `GlobalOptions` if needed — check `flux2 kontext --help` for the exact global-options flag name if the default `mlx-models/` resolution doesn't find the repo root.)

Expected: a PNG is written, `run.json`/`manifest.json` sidecars exist, no crash. Visually inspect the output — it should look like a plausible edited photo of the hero, not noise or a blank frame. If it crashes with a shape mismatch, re-check the RoPE-id concatenation order in `KontextPipeline.generate` (generation ids MUST come before reference ids — see Task 2's design-decisions note) and the dtype casts before each `transformer(...)` call.

- [ ] **Step 5: Commit**

```bash
git add swift/flux2-image-director/Sources/Flux2DirectorCLI/KontextCommand.swift \
        swift/flux2-image-director/Sources/Flux2DirectorCLI/Flux2CLI.swift
git commit -m "feat(kontext): flux2 kontext CLI command (Task 3)"
```

---

## Task 4: `pi-agent-ext-flux2` TS command registration

**Files:**
- Modify: `bun-apps/pi-agent-ext-flux2/src/commands.ts`
- Modify: `bun-apps/pi-agent-ext-flux2/src/commands.test.ts`

`pi-agent-ext-flux2`'s `invoke.ts`/`index.ts` generically spawn any `COMMANDS`-registered subcommand against the compiled `flux2` binary — adding Kontext support here is a **pure data addition**, no new spawn/binary-resolution code.

- [ ] **Step 1: Add the `kontext` entry to `COMMANDS`**

In `bun-apps/pi-agent-ext-flux2/src/commands.ts`, add a new entry to the `COMMANDS` object (e.g. right after the `edit` entry, before `style`):

```typescript
  kontext: {
    name: "kontext",
    writesImage: true,
    acceptsGlobals: true,
    when: "In-context generation via FLUX.1-Kontext-dev — identity-anchored single hero image + prompt (e.g. \"same person, different outfit/pose/setting\").",
    fields: {
      input: { flag: "--input", type: "string", isPath: true, description: "Hero / identity-anchor image path." },
      prompt: { flag: "--prompt", type: "string", description: "In-context instruction prompt." },
      transformer: { flag: "--transformer", type: "string", isPathComponent: true, description: "Transformer directory under models/transformer/. Default kontext-dev." },
      clipEncoder: { flag: "--clip-encoder", type: "string", isPathComponent: true, description: "CLIP text-encoder directory under models/text_encoder/. Default kontext-dev-clip." },
      t5Encoder: { flag: "--t5-encoder", type: "string", isPathComponent: true, description: "T5 text-encoder directory under models/text_encoder/. Default kontext-dev-t5." },
      vae: { flag: "--vae", type: "string", isPathComponent: true, description: "VAE directory under models/vae/. Default flux-kontext-ae." },
      clipTokenizerDir: { flag: "--clip-tokenizer-dir", type: "string", isPathComponent: true, description: "CLIP tokenizer directory under models/tokenizer/. Default kontext-dev-clip-tok." },
      t5TokenizerDir: { flag: "--t5-tokenizer-dir", type: "string", isPathComponent: true, description: "T5 tokenizer directory under models/tokenizer/. Default kontext-dev-t5-tok." },
      seed: { flag: "--seed", type: "int", description: "Random seed (uint64). Default 42." },
      width: { flag: "--width", type: "int", description: "Output image width (px). Default 1024." },
      height: { flag: "--height", type: "int", description: "Output image height (px). Default 1024." },
      steps: { flag: "--steps", type: "int", description: "Number of denoising steps. Default 20." },
      guidance: { flag: "--guidance", type: "number", description: "CFG-distilled guidance embedding value. Default 2.5." },
      output: { flag: "--output", type: "string", isPath: true, description: "Output PNG path. Empty/omit = auto timestamped name in the output dir." },
      outputDir: { flag: "--output-dir", type: "string", isPath: true, description: "Output directory (default: $MLX_OUTPUT_DIR or ../video_generation__output)." },
      name: { flag: "--name", type: "string", description: "Custom base name (default: output_YYYYMMDD_HHMMSS)." },
      noArtifacts: { flag: "--no-artifacts", type: "boolean", description: "Skip writing .run.json + .manifest.json sidecars (not recommended — the tool parses the manifest)." },
    },
  },
```

This mirrors `GEN_FIELDS`' shape but is written out explicitly (not spread from `GEN_FIELDS`) because Kontext's field set diverges enough (own transformer/CLIP/T5/tokenizer dirs instead of the shared `encoder`/`tokenizerDir`, `guidance` instead of `cfgScale`, no `strictGate`) that reusing the shared block would need as many overrides as it saves — matches how `story`/`expand`/`inpaint` above already inline their field lists rather than force-fitting `GEN_FIELDS`.

- [ ] **Step 2: Fix `commands.test.ts`'s hardcoded command count**

In `bun-apps/pi-agent-ext-flux2/src/commands.test.ts`, find the test `"has exactly the 21 documented flux2 subcommands"` (around line 116) and update both the title and the array:

```typescript
  test("has exactly the 22 documented flux2 subcommands", () => {
    expect(Object.keys(COMMANDS).sort()).toEqual(
      [
        "angle", "edit", "expand", "faceswap", "gate", "inpaint", "kontext", "kv-style-transfer", "models", "scene", "segment",
        "story", "style", "swap", "t2i", "upscale",
        "verify-e2e", "verify-edit", "verify-encoder", "verify-tokenizer",
        "verify-transformer", "verify-vae",
      ].sort(),
    );
  });
```

- [ ] **Step 3: Run tests**

```bash
( cd bun-apps/pi-agent-ext-flux2 && bun test )
```

Expected: all pass, including the updated count test and the existing `"every command's fields build to a valid args array without throwing"` / `"every command's name matches its registry key"` tests (which iterate `COMMAND_LIST` generically and will automatically cover the new `kontext` entry with no further changes needed).

- [ ] **Step 4: Commit**

```bash
git add bun-apps/pi-agent-ext-flux2/src/commands.ts bun-apps/pi-agent-ext-flux2/src/commands.test.ts
git commit -m "feat(kontext): register kontext subcommand in pi-agent-ext-flux2 (Task 4)"
```

---

## Task 5: `pi-agent-ext-movie-director` registry wiring

**Files:**
- Modify: `bun-apps/pi-agent-ext-movie-director/src/registry.ts`

- [ ] **Step 1: Add `"kontext"` to `flux2_image`'s `commands[]`**

In `bun-apps/pi-agent-ext-movie-director/src/registry.ts`, find the `flux2_image` entry (`name: "flux2_image"`, around line 107) and add `"kontext"` to its `commands` array:

```typescript
    commands: [
      "t2i", "scene", "edit", "style", "kv-style-transfer", "angle", "swap",
      "expand", "upscale", "gate", "segment", "story", "inpaint", "faceswap",
      "kontext",
      "anime2real", "expansion", // legacy run.py aliases — see notes above
    ],
```

Append one sentence to that entry's `notes` string documenting the move (matching the existing style of "`X` moved here (date, session N) from runpy_image — ..."):

```
`kontext` moved here (2026-07-29) from runpy_image — the 2026-07-14 kontext epic already numerically verified KontextTransformer/CLIP/T5/VAE; this port adds the missing denoise loop (KontextPipeline.swift) + CLI (KontextCommand.swift), see docs/superpowers/plans/2026-07-29-kontext-swift-native-port.md. `storyboard --kontext-lock` stays on runpy_image — image-storyboard.py still calls Python's _run_kontext_generation in-process, a deliberately separate follow-up.
```

- [ ] **Step 2: Remove `"kontext"` from `runpy_image`'s `commands[]`**

In the same file, find the `runpy_image` entry (around line 133-146) and remove `"kontext"` from its `commands` array:

```typescript
    commands: [
      "purify", "multicouple",
      "storyboard",
      "cutout", "styletransfer",
    ],
```

Update the notes string's `command-routed` sentence to drop `kontext` from the enumerated list (find `"command is one of purify/multicouple/storyboard/kontext/cutout/styletransfer"` and change to `"command is one of purify/multicouple/storyboard/cutout/styletransfer"`). Leave the rest of that long notes string (the `storyboard`/`--kontext-lock` sentence) as-is — it's still accurate: `storyboard --kontext-lock` still routes recurring-character shots through Python's Kontext generation, just via `_run_kontext_generation` directly, not via this `command: "kontext"` registry entry anymore.

- [ ] **Step 3: Run tests**

```bash
( cd bun-apps/pi-agent-ext-movie-director && bun test )
```

Expected: all pass. If any existing test hardcodes `runpy_image`'s or `flux2_image`'s `commands` array contents (grep `bridge.test.ts`/`selector.test.ts`/`registry.test.ts` for `"kontext"` or a full-array comparison against these two entries), update that test's expected array the same way Task 4's Step 2 did.

- [ ] **Step 4: Schema check**

```bash
bun run --cwd bun-apps/gui-movie-director check:schema
```

Expected: passes (confirms the registry change didn't break schema validation against `run.py`'s own command surface).

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-movie-director/src/registry.ts
git commit -m "feat(kontext): route image kontext to flux2_image (Swift-native), off runpy_image (Task 5)"
```

---

## Task 6: End-to-end sanity check + final verification

**Files:**
- Create: `python/mlx-movie-director/app/tests/compare_kontext_e2e.py`

Unlike MusicGen (autoregressive sampling with its own RNG, not expected to bit-match across languages), Kontext's denoise loop is otherwise deterministic given a fixed seed — but full multi-step generation still accumulates floating-point divergence between two independent implementations (Swift MLX vs Python MLX-via-mflux) even when every component was individually verified at cos≥0.99. Per the design spec, this is a **sanity check** (both outputs are real, plausible images), not a bit-exact numeric-parity gate — mirrors `compare_musicgen_e2e.py`'s "non-degenerate" bar, plus a diagnostic (not gating) cosine-similarity log so a human can judge convergence quality.

- [ ] **Step 1: Write the script**

```python
#!/usr/bin/env python3
"""compare_kontext_e2e.py — sanity comparison between the Swift `flux2 kontext`
port and the Python `run.py image kontext` reference (Task 6 of
docs/superpowers/plans/2026-07-29-kontext-swift-native-port.md).

NOT a bit-exact numeric-parity gate: KontextTransformer/CLIP/T5/VAE are each
independently verified at cos>=0.99 (see swift/flux2-image-director's
verify-kontext-* commands), but a full 20-step denoise loop compounds
floating-point divergence between two independent implementations even when
every component matches. This checks both outputs are real, non-degenerate
images (not blank/noise) and LOGS (does not gate on) their pixel cosine
similarity as a diagnostic for a human to judge convergence quality.

Run from repo root (requires a built flux2 Swift binary, a working Python
mflux install, and Task 1's imported Kontext weights):
    python/venv/bin/python python/mlx-movie-director/app/tests/compare_kontext_e2e.py
"""
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image

REPO = Path(__file__).resolve().parents[4]
PROMPT = "the same person, now wearing a red jacket, studio lighting"
SEED = 42
STEPS = 20
SIZE = 1024


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


def main() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        hero_path = tmp_path / "hero.png"
        swift_out = tmp_path / "swift.png"
        python_out = tmp_path / "python.png"

        # Synthesize a deterministic hero portrait via the existing ZImage T2I
        # self-test path (matches image-kontext.py's own _synth_hero pattern —
        # a plain solid-color placeholder is NOT representative of a real
        # identity-anchor use case, but is sufficient for a structural sanity
        # check; a fixed seed keeps it reproducible run-to-run).
        print("[compare_kontext_e2e] synthesizing a hero portrait...")
        subprocess.run(
            [sys.executable, str(REPO / "python" / "mlx-movie-director" / "run.py"),
             "image", "t2i", "--prompt", "portrait photo of a young woman, neutral background, studio lighting",
             "--seed", "7", "--steps", "8", "--output", str(hero_path)],
            check=True, cwd=REPO,
        )

        print("[compare_kontext_e2e] running Swift flux2 kontext...")
        flux2_bin = REPO / "swift" / "flux2-image-director" / ".build" / "release" / "flux2"
        if not flux2_bin.exists():
            print(f"ERROR: {flux2_bin} not built — run: "
                  f"swift build -c release --package-path swift/flux2-image-director", file=sys.stderr)
            sys.exit(1)
        subprocess.run(
            [str(flux2_bin), "kontext", "--input", str(hero_path), "--prompt", PROMPT,
             "--seed", str(SEED), "--steps", str(STEPS), "--width", str(SIZE), "--height", str(SIZE),
             "--output", str(swift_out), "--no-artifacts"],
            check=True, cwd=REPO,
        )

        print("[compare_kontext_e2e] running run.py image kontext (Python reference)...")
        subprocess.run(
            [sys.executable, str(REPO / "python" / "mlx-movie-director" / "run.py"),
             "image", "kontext", "--input", str(hero_path), "--prompt", PROMPT,
             "--seed", str(SEED), "--steps", str(STEPS), "--width", str(SIZE), "--height", str(SIZE),
             "--output", str(python_out)],
            check=True, cwd=REPO,
        )

        swift_arr = analyze(swift_out, "swift")
        python_arr = analyze(python_out, "python")

        flat_s, flat_p = swift_arr.flatten(), python_arr.flatten()
        cos = float(np.dot(flat_s, flat_p) / (np.linalg.norm(flat_s) * np.linalg.norm(flat_p) + 1e-12))
        print(f"\n[compare_kontext_e2e] pixel cosine similarity (diagnostic, not gated): {cos:.4f}")

    print("\n✅ both outputs are real, non-degenerate images")


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Run it**

```bash
python/venv/bin/python python/mlx-movie-director/app/tests/compare_kontext_e2e.py
```

Expected: both PASS (non-degenerate), a cosine similarity value printed. Note whatever value prints in the commit message or task notes for future reference — do not treat a low value as an automatic failure (per this task's preamble), but DO investigate if it's surprisingly low (e.g. <0.3) since that could indicate a real bug (wrong RoPE-id order, wrong sigma schedule, wrong dtype) rather than expected floating-point drift.

- [ ] **Step 3: Full verification pass**

```bash
( cd bun-apps/pi-agent-ext-flux2 && bun test )
( cd bun-apps/pi-agent-ext-movie-director && bun test )
bun run --cwd bun-apps/gui-movie-director check:schema
swift build --package-path swift/flux2-image-director -c release
python/venv/bin/python python/mlx-movie-director/run.py check-model
```

Expected: everything green.

- [ ] **Step 4: Commit**

```bash
git add python/mlx-movie-director/app/tests/compare_kontext_e2e.py
git commit -m "test(kontext): e2e sanity comparison vs Python reference (Task 6)"
```

---

## Out of scope (reaffirmed from the design spec — do not add mid-implementation)

- `storyboard --kontext-lock` integration (Task 5, Step 2's notes update documents this explicitly).
- LoRA support for `flux2 kontext`.
- `purify`/`cutout`/`styletransfer`/`multicouple` — separate decisions, not this port.
