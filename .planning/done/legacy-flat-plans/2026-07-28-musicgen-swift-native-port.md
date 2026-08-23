# MusicGen Swift-Native Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port `music_generation` (currently `run.py music` shelling to Python's `mlx_audiocraft.MusicGen`) to a pure-Swift/MLX `swift/musicgen-director` package, verified numerically against the Python reference, and wire it into the TS bridge so `musicgen_music`'s `backend: "native_swift"` label becomes true.

**Architecture:** New standalone SwiftPM package following the `flux2-image-director`/`ltx-video-director` convention. Three ported components: (1) `MusicGenT5Encoder` — adapt the existing `KontextT5Encoder.swift` (T5 relative-position-bias attention + RMSNorm reused, new plain-relu FFN + parameterized head count for t5-base vs T5-XXL); (2) `MusicGenEncodecAdapter` — thin wrapper around `Blaizzy/mlx-audio-swift`'s already-verified-data-driven `Encodec` (decode-only, configured with `facebook/encodec_32khz`'s real numbers); (3) `MusicGenDecoder` + `MusicGenGenerator` — a genuine from-scratch 24-layer causal+cross-attention transformer with classifier-free guidance and MusicGen's delay-pattern codebook interleaving, structurally modeled on this repo's existing `WhisperDecoder.swift` (causal self-attn + cross-attn to encoder output) but with MusicGen's own per-codebook embeddings/heads and sinusoidal (non-learned) position embeddings. v1 has **no KV cache** (full-prefix recompute every step, matching the `WhisperDecoder` precedent) — correctness-first; a follow-up perf task is explicitly out of scope.

**Tech Stack:** Swift 6 / MLX-Swift 0.31.4 / `Blaizzy/mlx-audio-swift` 0.1.3 (`MLXAudioCodecs` product) / swift-argument-parser / Bun + TypeScript (bridge integration) / Python (checkpoint import + numeric-parity reference scripts, dev-only).

---

## Real numbers pinned from `facebook/musicgen-small`'s actual `config.json` (fetched this session — see Task references below for how to re-fetch)

**Decoder** (`decoder` sub-config): `hidden_size=1024, num_hidden_layers=24, num_attention_heads=16, ffn_dim=4096, num_codebooks=4, vocab_size=2048, bos_token_id=2048, pad_token_id=2048, max_position_embeddings=2048, activation_function="gelu", tie_word_embeddings=false, scale_embedding=false`. Attention: standard scaled dot-product (`scale = head_dim^-0.5 = 64^-0.5`), **bias=False** on every q/k/v/out/fc1/fc2 projection. Layer norm: standard `LayerNorm` (mean+var, weight+bias, PyTorch default eps=1e-5) — **not** T5's RMSNorm. Block structure (pre-norm, confirmed from HF `modeling_musicgen.py` `MusicgenDecoderLayer.forward`):
```
residual = h; h = self_attn_layer_norm(h); h = self_attn(h, causal_mask); h = residual + h
residual = h; h = encoder_attn_layer_norm(h); h = cross_attn(h, encoder_hidden_states); h = residual + h
residual = h; h = final_layer_norm(h); h = fc2(gelu(fc1(h))); h = residual + h
```

**Text encoder** (`text_encoder` sub-config, t5-base): `d_model=768, num_layers=12, num_heads=12, d_kv=64, d_ff=3072, dense_act_fn="relu", vocab_size=32128, relative_attention_num_buckets=32, relative_attention_max_distance=128, layer_norm_epsilon=1e-6`.

**Audio codec** (`audio_encoder` sub-config, encodec_32khz): `hidden_size=128, codebook_size=2048, codebook_dim=128, num_filters=64, num_lstm_layers=2, num_residual_layers=1, upsampling_ratios=[8,5,4,4], target_bandwidths=[2.2], norm_type="weight_norm", sampling_rate=32000, dilation_growth_rate=2, kernel_size=7, residual_kernel_size=3, last_kernel_size=7, compress=2, trim_right_ratio=1.0, normalize=false, pad_mode="reflect", audio_channels=1, chunk_length_s=null, overlap=null`. **`use_causal_conv=false` and `use_conv_shortcut=false`** — both differ from `mlx-audio-swift`'s `EncodecConfig` defaults (`true`/`true`), so they must be set explicitly, not left at default.

**Sampling defaults** (from `facebookresearch/audiocraft`'s `MusicGen.set_generation_params`, which `run.py music` never overrides except `duration`): `use_sampling=true, top_k=250, top_p=0.0 (unused — top_k path), temperature=1.0, cfg_coef=3.0, duration=30.0s`.

**Delay pattern** (confirmed against HF's `build_delay_pattern_mask` docstring example, `num_codebooks=4`): for codebook `c` (0-indexed) in a `max_length`-step raw sequence — BOS-pad region `t <= c`, EOS-pad region `t >= max_length - 4 + 1 + c`, valid/predict region `c < t < max_length - 3 + c`. **Valid length per codebook = `max_length - 4`** (constant across codebooks). So: `max_length = total_gen_len + 4` where `total_gen_len = round(duration_seconds * 50)` (50Hz frame rate = `32000 / (8*5*4*4)`). De-interleave: codebook `c`'s clean tokens = `raw[c][(c+1)..<(c+1+total_gen_len)]`.

**Classifier-free guidance null conditioning** (confirmed from `audiocraft/modules/conditioners.py`'s `T5Conditioner`): the null-text branch tokenizes `""` through the real T5 tokenizer, runs it through the real T5 encoder, then **multiplies the output by an all-zero mask** (`embeds * mask.unsqueeze(-1)` where `mask` was forced to 0 for empty-string entries) — i.e. the null conditioning embeds are always exactly zero, but produced via the literal T5 forward pass on `""`, not skipped. Implement it literally (encode `""`, then zero it) for bit-exact reference parity. CFG blend (from `lm.py`'s default `two_step_cfg=False` path, a single batch-2 forward): `logits = uncond_logits + cfg_coef * (cond_logits - uncond_logits)`.

---

## Task 1: Scaffold `swift/musicgen-director`

**Files:**
- Create: `swift/musicgen-director/Package.swift`
- Create: `swift/musicgen-director/Sources/MusicGenDirector/.gitkeep` (placeholder until Task 3)
- Create: `swift/musicgen-director/Sources/MusicGenDirectorCLI/MusicGenCLI.swift`
- Create: `swift/musicgen-director/scripts/build-metallib.sh` (copy of `flux2-image-director`'s, paths adjusted)
- Create: `swift/musicgen-director/Tests/MusicGenDirectorTests/.gitkeep`

- [ ] **Step 1: Write `Package.swift`**

```swift
// swift-tools-version: 6.0
//
// musicgen-director — Pure-Swift MLX port of Meta's MusicGen (facebook/
// musicgen-small: T5-base text encoder + 24-layer causal/cross-attention LM
// decoder + EnCodec 32kHz audio codec, decode-only). Replaces the
// `run.py music` -> mlx_audiocraft Python bridge (musicgen_music provider,
// registry.ts:352) — see docs/superpowers/specs/2026-07-28-musicgen-swift-
// native-port-design.md.
//
// Text encoder reuses flux2-image-director's KontextT5Encoder skeleton
// (relative-position-bias attention + RMSNorm), re-parameterized for
// t5-base's smaller config and plain (non-gated) FFN. Also reuses
// flux2-image-director's KontextT5Tokenizer (a generic, data-driven T5
// SentencePiece Unigram tokenizer — despite the "Kontext" name it loads any
// T5 tokenizer.json, no Kontext-specific coupling). The LM decoder is a
// genuine from-scratch port (no prior MLX-Swift implementation exists
// anywhere) modeled structurally on ltx-video-director's WhisperDecoder.swift
// (causal self-attn + cross-attn to encoder output).

import PackageDescription

let package = Package(
    name: "musicgen-director",
    platforms: [
        .macOS(.v15),
    ],
    products: [
        .executable(name: "musicgen", targets: ["MusicGenDirectorCLI"]),
        .library(name: "MusicGenDirector", targets: ["MusicGenDirector"]),
    ],
    dependencies: [
        .package(url: "https://github.com/ml-explore/mlx-swift.git", exact: "0.31.4"),
        .package(url: "https://github.com/apple/swift-argument-parser.git", from: "1.5.0"),
        // MLXAudioCodecs product only (not the TTS/STT/VAD products) — its
        // Encodec implementation is fully config-driven (verified by reading
        // EncodecConfig.swift/Encodec.swift/EncodecQuantization.swift, not
        // just its README), and its residual-vector-quantizer math derives
        // numQuantizers=4 automatically from our real config numbers
        // (targetBandwidths=[2.2], frameRate=50 -> floor(2200/(50*10))=4).
        .package(url: "https://github.com/Blaizzy/mlx-audio-swift.git", exact: "0.1.3"),
        // KontextT5Encoder + KontextT5Tokenizer reuse (see header comment).
        .package(path: "../flux2-image-director"),
    ],
    targets: [
        .target(
            name: "MusicGenDirector",
            dependencies: [
                .product(name: "MLX", package: "mlx-swift"),
                .product(name: "MLXNN", package: "mlx-swift"),
                .product(name: "MLXFast", package: "mlx-swift"),
                .product(name: "MLXRandom", package: "mlx-swift"),
                .product(name: "MLXAudioCodecs", package: "mlx-audio-swift"),
                .product(name: "Flux2Director", package: "flux2-image-director"),
            ],
            path: "Sources/MusicGenDirector"
        ),
        .executableTarget(
            name: "MusicGenDirectorCLI",
            dependencies: [
                "MusicGenDirector",
                .product(name: "MLX", package: "mlx-swift"),
                .product(name: "ArgumentParser", package: "swift-argument-parser"),
            ],
            path: "Sources/MusicGenDirectorCLI"
        ),
        .testTarget(
            name: "MusicGenDirectorTests",
            dependencies: ["MusicGenDirector"],
            path: "Tests/MusicGenDirectorTests"
        ),
    ]
)
```

- [ ] **Step 2: Write the CLI entry stub**

```swift
//
//  MusicGenCLI.swift
//  MusicGenDirectorCLI
//
//  `musicgen` — pure-Swift MLX port of Meta's MusicGen (facebook/musicgen-small).
//  Subcommands land incrementally as each port task completes:
//    verify-t5            — Task 3 (T5 text encoder numeric parity)
//    verify-encodec        — Task 5 (EnCodec decoder numeric parity)
//    verify-decoder-step   — Task 7 (LM decoder single-step logits parity)
//    generate              — Task 8 (full text-to-music generation)
//

import ArgumentParser

@main
struct MusicGenCLI: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "musicgen",
        abstract: "Text-to-music via MusicGen-small (pure Swift MLX).",
        version: "0.1.0",
        subcommands: []
    )
}
```

- [ ] **Step 3: Create empty placeholder files so the targets have content**

```bash
mkdir -p "swift/musicgen-director/Sources/MusicGenDirector"
mkdir -p "swift/musicgen-director/Tests/MusicGenDirectorTests"
touch "swift/musicgen-director/Sources/MusicGenDirector/.gitkeep"
touch "swift/musicgen-director/Tests/MusicGenDirectorTests/.gitkeep"
```

- [ ] **Step 4: Copy + adapt the metallib build script**

```bash
cp swift/flux2-image-director/scripts/build-metallib.sh swift/musicgen-director/scripts/build-metallib.sh
```

Then edit the copied file: replace every occurrence of `flux2` (binary/package name) with `musicgen`, and `flux2-image-director` with `musicgen-director` in the header comment. The kernel-compile logic itself (locating `.build/checkouts/mlx-swift/...`, `xcrun -sdk macosx metal ...`) is package-agnostic and needs no other changes.

- [ ] **Step 5: Build and verify**

Run: `swift build -c release --package-path swift/musicgen-director`
Expected: builds successfully (empty library + a CLI binary with zero subcommands). Requires a Swift 6.2+ toolchain (mlx-audio-swift declares `swift-tools-version:6.2`) — if the build fails with a tools-version error, note the installed `swift --version` in the task's completion notes; this is an environment prerequisite, not a code bug.

Then: `bash swift/musicgen-director/scripts/build-metallib.sh release`
Expected: `mlx.metallib` created at `swift/musicgen-director/.build/release/mlx.metallib`.

- [ ] **Step 6: Commit**

```bash
git add swift/musicgen-director
git commit -m "feat(musicgen): scaffold swift/musicgen-director package"
```

---

## Task 2: Checkpoint import (`run.py import-musicgen`)

**Files:**
- Create: `python/mlx-movie-director/app/commands/import-musicgen.py`

- [ ] **Step 1: Write the import command**

```python
"""import-musicgen — download facebook/musicgen-small and split it into this
repo's mlx-models/ external-store convention for the Swift port.

HF's facebook/musicgen-small is a merged checkpoint with three sub-models
(text_encoder/, decoder/, audio_encoder/), each with its own config.json and
safetensors. This splits them into flat files + config JSONs under
mlx-models/musicgen/musicgen-small/, externalizing each safetensors into the
shared video_generation__models/ store (same convention as import-checkpoint.py
and import-lora-image.py — each import-*.py file independently duplicates the
small md5/externalize/git-add-force helper set, per that established pattern,
rather than sharing a module).

This is dev-tooling only (same standing-rule carve-out as import-checkpoint.py/
import-lora-image.py) — not a production generation code path.

Usage:
  run.py import-musicgen
  run.py import-musicgen --model facebook/musicgen-small --name musicgen-small
"""

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

from app import config as cfg

PARSER_META = {
    "help": "Download + split facebook/musicgen-small for the Swift musicgen-director port",
    "description": (
        "Downloads a MusicGen checkpoint from HuggingFace and splits its three\n"
        "sub-models (text_encoder/decoder/audio_encoder) into flat safetensors +\n"
        "config JSON files under mlx-models/musicgen/<name>/, externalizing each\n"
        "weights file into the shared video_generation__models/ store.\n\n"
        "Examples:\n"
        "  run.py import-musicgen\n"
        "  run.py import-musicgen --model facebook/musicgen-small --name musicgen-small\n"
    ),
}


def add_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--model", type=str, default="facebook/musicgen-small",
                        help="HF model id (default: facebook/musicgen-small)")
    parser.add_argument("--name", type=str, default=None,
                        help="Output dir name under mlx-models/musicgen/ (default: derived from --model)")


def run(args: argparse.Namespace) -> None:
    from huggingface_hub import snapshot_download
    import mlx.core as mx

    name = args.name or args.model.split("/")[-1]
    target_dir = Path(cfg.MODELS_DIR) / "musicgen" / name
    if target_dir.exists():
        print(f"ERROR: target already exists: {target_dir}", file=sys.stderr)
        sys.exit(1)
    target_dir.mkdir(parents=True, exist_ok=True)

    print(f"[import-musicgen] downloading {args.model}...")
    snap_dir = Path(snapshot_download(repo_id=args.model))

    top_config = json.loads((snap_dir / "config.json").read_text())

    for sub in ("text_encoder", "decoder", "audio_encoder"):
        sub_dir = snap_dir / sub
        src_weights = sub_dir / "model.safetensors"
        if not src_weights.exists():
            print(f"ERROR: expected weights not found: {src_weights}", file=sys.stderr)
            sys.exit(1)

        # Strip a leading "<sub>." key prefix if HF packaged this sub-model's
        # weights with a top-level qualifier (rather than encoder./decoder./
        # shared.-rooted keys as a standalone checkpoint would have) — cheap
        # defensive normalization, verified against real keys below either way.
        weights = mx.load(str(src_weights))
        prefix = f"{sub}."
        if all(k.startswith(prefix) for k in weights):
            weights = {k[len(prefix):]: v for k, v in weights.items()}
            print(f"  [{sub}] stripped '{prefix}' key prefix ({len(weights)} keys)")
        else:
            print(f"  [{sub}] {len(weights)} keys, no prefix stripped")

        out_weights = target_dir / f"{sub}.safetensors"
        mx.save_safetensors(str(out_weights), weights)
        _externalize_weights(str(out_weights))

        out_config = target_dir / f"{sub}_config.json"
        out_config.write_text(json.dumps(top_config[sub], indent=2) + "\n")
        print(f"  [{sub}] wrote {out_config.name}")

    manifest = {
        "name": name,
        "type": "musicgen",
        "arch": "musicgen-small",
        "source": f"https://huggingface.co/{args.model}",
        "components": ["text_encoder", "decoder", "audio_encoder"],
        "cli": {"binary": "musicgen", "action": "generate"},
    }
    (target_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")

    print(f"\n[import-musicgen] done -> {target_dir}")
    print("Validate: python/venv/bin/python python/mlx-movie-director/app/tests/gen_musicgen_t5_ref.py")


# ---------------------------------------------------------------------------
# External model store (duplicated from import-checkpoint.py's convention —
# see that file's matching section for the authoritative comments)
# ---------------------------------------------------------------------------

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
    store_path = os.path.join(store_dir, f"{md5}.safetensors")
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

- [ ] **Step 2: Run it and verify the checkpoint layout**

Run: `python/venv/bin/python python/mlx-movie-director/run.py import-musicgen`
Expected: `mlx-models/musicgen/musicgen-small/` contains `text_encoder.safetensors` (symlink), `text_encoder_config.json`, `decoder.safetensors` (symlink), `decoder_config.json`, `audio_encoder.safetensors` (symlink), `audio_encoder_config.json`, `manifest.json`. Confirm `audio_encoder_config.json` shows `"use_causal_conv": false` and `"upsampling_ratios": [8, 5, 4, 4]` (sanity-check against the real numbers pinned at the top of this plan).

- [ ] **Step 3: Commit**

```bash
git add python/mlx-movie-director/app/commands/import-musicgen.py
git commit -m "feat(musicgen): add run.py import-musicgen checkpoint splitter"
```

(The `mlx-models/musicgen/musicgen-small/` output itself is *.safetensors-gitignored symlinks + small JSON — commit those from a real run separately, matching how other model imports land: `git add -f` handles the symlinks automatically as this script runs.)

---

## Task 3: `MusicGenT5Encoder` (T5-base text encoder port)

**Files:**
- Create: `swift/musicgen-director/Sources/MusicGenDirector/MusicGenT5Encoder.swift`
- Create: `swift/musicgen-director/Sources/MusicGenDirectorCLI/VerifyT5Command.swift`
- Modify: `swift/musicgen-director/Sources/MusicGenDirectorCLI/MusicGenCLI.swift` (register subcommand)
- Create: `python/mlx-movie-director/app/tests/gen_musicgen_t5_ref.py`

- [ ] **Step 1: Write `MusicGenT5Encoder.swift`**

Adapted from `swift/flux2-image-director/Sources/Flux2Director/KontextT5Encoder.swift`: identical relative-position-bias attention math and RMSNorm-style layer norm (unchanged — both T5 variants share this), but `numHeads`/`headDim` become constructor params instead of hardcoded `static let`s, and the FFN is a NEW plain single-matrix-relu struct (`t5-base` uses `feed_forward_proj="relu"`, not T5-XXL's gated-gelu).

```swift
//
//  MusicGenT5Encoder.swift
//  MusicGenDirector
//
//  T5-base text encoder for MusicGen's text conditioning. Adapted from
//  flux2-image-director's KontextT5Encoder.swift (relative-position-bias
//  attention + RMSNorm-style layer norm reused unchanged — same T5
//  architecture family) with two real differences confirmed by reading both
//  the Kontext port and t5-base's actual config.json (num_heads=12, d_kv=64,
//  d_model=768, num_layers=12, dense_act_fn="relu", layer_norm_epsilon=1e-6):
//    1. numHeads/headDim are constructor params, not hardcoded statics
//       (KontextT5Encoder hardcodes 64/64 for T5-XXL; t5-base needs 12/64).
//    2. FFN is the ORIGINAL T5 single-matrix-relu variant (`wi.weight` +
//       plain relu), NOT T5-v1.1/XXL's gated-gelu `wi_0`/`wi_1` variant.
//
//  Weight keys: identity mapping vs the raw HF text_encoder/ checkpoint
//  (post-prefix-strip, see import-musicgen.py) EXCEPT relative_attention_bias,
//  which real T5 stores once (block 0) and shares across all blocks — same
//  broadcast-at-load-time handling as KontextT5Weights.
//
//  Numerically verified via `musicgen verify-t5` against gen_musicgen_t5_ref.py.
//

import Foundation
import MLX
import MLXNN
import MLXFast

// MARK: - Layer norm (RMS-style, shared with KontextT5Encoder's math)

struct MGT5LayerNorm {
    let weight: MLXArray
    let eps: Float = 1e-6   // t5-base's layer_norm_epsilon (confirmed from config.json)

    func callAsFunction(_ x: MLXArray) -> MLXArray {
        let xf = x.asType(.float32)
        let variance = MLX.mean(xf * xf, axis: -1, keepDims: true)
        let normed = xf * MLX.rsqrt(variance + eps)
        return weight * normed.asType(x.dtype)
    }
}

// MARK: - Relative position bias (32 buckets, bidirectional, max_distance=128 — same as Kontext T5)

enum MGT5RelativePositionBias {
    static let numBuckets = 32
    static let maxDistance = 128

    static func computeBuckets(seqLen: Int, bidirectional: Bool = true) -> MLXArray {
        let contextPos = MLX.arange(0, seqLen).reshaped([seqLen, 1])
        let memoryPos = MLX.arange(0, seqLen).reshaped([1, seqLen])
        let relativePosition = memoryPos - contextPos

        var numBucketsLocal = numBuckets
        var relativeBuckets = MLX.zeros(like: relativePosition)
        var relPos = relativePosition
        if bidirectional {
            numBucketsLocal /= 2
            relativeBuckets = relativeBuckets + MLX.where(relPos .> 0,
                                                          MLXArray(Int32(numBucketsLocal)),
                                                          MLXArray(Int32(0)))
            relPos = MLX.abs(relPos)
        } else {
            relPos = -MLX.minimum(relPos, MLX.zeros(like: relPos))
        }

        let maxExact = numBucketsLocal / 2
        let isSmall = relPos .< maxExact

        let relPosF = relPos.asType(.float32)
        let relativePositionIfLarge = (Float(maxExact) + MLX.floor(
            MLX.log(relPosF / Float(maxExact)) / Float(logf(Float(maxDistance) / Float(maxExact)))
            * Float(numBucketsLocal - maxExact)
        )).asType(.int32)
        let clipped = MLX.minimum(relativePositionIfLarge,
                                  MLXArray(Int32(numBucketsLocal - 1)))

        relativeBuckets = relativeBuckets + MLX.where(isSmall, relPos, clipped)
        return relativeBuckets
    }
}

// MARK: - Self attention (numHeads/headDim are now instance config, not statics)

struct MGT5SelfAttention {
    let q: MLXNN.Linear
    let k: MLXNN.Linear
    let v: MLXNN.Linear
    let o: MLXNN.Linear
    let relativeAttentionBias: MLXNN.Embedding
    let numHeads: Int
    let headDim: Int

    func callAsFunction(_ x: MLXArray) -> MLXArray {
        let seqLen = x.dim(1)
        func shape(_ t: MLXArray) -> MLXArray {
            t.reshaped([1, -1, numHeads, headDim]).transposed(0, 2, 1, 3)
        }
        let qs = shape(q(x))
        let ks = shape(k(x))
        let vs = shape(v(x))

        var scores = MLX.matmul(qs, ks.transposed(0, 1, 3, 2))   // no scale division — real T5 quirk
        let buckets = MGT5RelativePositionBias.computeBuckets(seqLen: seqLen)
        var bias = relativeAttentionBias(buckets)
        bias = bias.transposed(2, 0, 1).expandedDimensions(axis: 0)
        scores = scores + bias.asType(scores.dtype)

        let attnWeights = MLX.softmax(scores, axis: -1)
        let attnOut = MLX.matmul(attnWeights, vs)
        let unshaped = attnOut.transposed(0, 2, 1, 3).reshaped([1, -1, numHeads * headDim])
        return o(unshaped)
    }
}

// MARK: - Feed forward — plain single-matrix relu (t5-base's real variant, NOT gated-gelu)

struct MGT5DenseReluDense {
    let wi: MLXNN.Linear
    let wo: MLXNN.Linear

    func callAsFunction(_ x: MLXArray) -> MLXArray {
        let hidden = MLX.maximum(wi(x), MLXArray(Float(0)))   // plain relu
        return wo(hidden)
    }
}

// MARK: - Block

struct MGT5Block {
    let attnLayerNorm: MGT5LayerNorm
    let selfAttn: MGT5SelfAttention
    let ffLayerNorm: MGT5LayerNorm
    let ff: MGT5DenseReluDense

    func callAsFunction(_ x: MLXArray) -> MLXArray {
        var h = x
        h = h + selfAttn(attnLayerNorm(h))
        h = h + ff(ffLayerNorm(h))
        return h
    }
}

// MARK: - Full encoder

public final class MusicGenT5Encoder {
    let shared: MLXNN.Embedding
    let blocks: [MGT5Block]
    let finalLayerNorm: MGT5LayerNorm

    init(shared: MLXNN.Embedding, blocks: [MGT5Block], finalLayerNorm: MGT5LayerNorm) {
        self.shared = shared
        self.blocks = blocks
        self.finalLayerNorm = finalLayerNorm
    }

    /// `inputIds`: (1, L) int32. Returns `hidden_states`: (1, L, 768).
    public func callAsFunction(_ inputIds: MLXArray) -> MLXArray {
        var hidden = shared(inputIds)
        for block in blocks {
            hidden = block(hidden)
        }
        return finalLayerNorm(hidden)
    }
}

// MARK: - Weight loader

public struct MusicGenT5Weights {
    public let arrays: [String: MLXArray]
    public let numBlocks: Int
    public let numHeads: Int
    public let headDim: Int

    /// `path` — the flat `text_encoder.safetensors` produced by
    /// `run.py import-musicgen` (see Task 2). Keys are already prefix-stripped
    /// (identity vs a standalone HF T5EncoderModel checkpoint: `shared.weight`,
    /// `encoder.block.N.layer.{0,1}...`, `encoder.final_layer_norm.weight`).
    public static func load(path: URL, numHeads: Int = 12, headDim: Int = 64) throws -> MusicGenT5Weights {
        let weights = try loadArrays(url: path)
        // t5-base's checkpoint may carry decoder.* keys too (T5ForConditionalGeneration
        // config, see MusicGenT5Encoder.swift header) — ignore anything outside
        // encoder./shared., defensive against either checkpoint shape.
        let filtered = weights.filter { $0.key.hasPrefix("encoder.") || $0.key == "shared.weight" }
        var numBlocks = 0
        while filtered["encoder.block.\(numBlocks).layer.0.SelfAttention.q.weight"] != nil { numBlocks += 1 }
        return MusicGenT5Weights(arrays: filtered, numBlocks: numBlocks, numHeads: numHeads, headDim: headDim)
    }
}

public extension MusicGenT5Encoder {
    static func build(weights: MusicGenT5Weights, precision: DType = .float32) -> MusicGenT5Encoder {
        let w = weights.arrays
        func linNoBias(_ key: String) -> MLXNN.Linear {
            Linear(weight: w["\(key).weight"]!.asType(precision), bias: nil)
        }
        let sharedBias = w["encoder.block.0.layer.0.SelfAttention.relative_attention_bias.weight"]!
            .asType(.float32)

        let blocks = (0..<weights.numBlocks).map { i -> MGT5Block in
            let attnP = "encoder.block.\(i).layer.0"
            let ffP = "encoder.block.\(i).layer.1"
            return MGT5Block(
                attnLayerNorm: MGT5LayerNorm(weight: w["\(attnP).layer_norm.weight"]!.asType(.float32)),
                selfAttn: MGT5SelfAttention(
                    q: linNoBias("\(attnP).SelfAttention.q"),
                    k: linNoBias("\(attnP).SelfAttention.k"),
                    v: linNoBias("\(attnP).SelfAttention.v"),
                    o: linNoBias("\(attnP).SelfAttention.o"),
                    relativeAttentionBias: Embedding(weight: sharedBias),
                    numHeads: weights.numHeads, headDim: weights.headDim),
                ffLayerNorm: MGT5LayerNorm(weight: w["\(ffP).layer_norm.weight"]!.asType(.float32)),
                ff: MGT5DenseReluDense(
                    wi: linNoBias("\(ffP).DenseReluDense.wi"),
                    wo: linNoBias("\(ffP).DenseReluDense.wo")))
        }

        return MusicGenT5Encoder(
            shared: Embedding(weight: w["shared.weight"]!.asType(precision)),
            blocks: blocks,
            finalLayerNorm: MGT5LayerNorm(weight: w["encoder.final_layer_norm.weight"]!.asType(.float32)))
    }
}
```

- [ ] **Step 2: Write the Python reference generator**

```python
#!/usr/bin/env python3
"""Generate MusicGen T5-base text-encoder reference tensors for Swift port
verification (Task 3 of docs/superpowers/plans/2026-07-28-musicgen-swift-
native-port.md).

Loads the real HF `T5EncoderModel` from facebook/musicgen-small's
text_encoder/ subtree, tokenizes a fixed prompt with the real HF
T5TokenizerFast, runs the real forward pass, and saves input_ids +
prompt_embeds. The Swift port loads the split flat checkpoint from
run.py import-musicgen and compares (cos > 0.99).

Run from repo root:
    python/venv/bin/python python/mlx-movie-director/app/tests/gen_musicgen_t5_ref.py
"""
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[4]

from huggingface_hub import snapshot_download
from transformers import T5TokenizerFast, T5EncoderModel
import torch

OUT_DIR = REPO / "swift" / "musicgen-director" / "verify_refs"
OUT_DIR.mkdir(parents=True, exist_ok=True)

MODEL_ID = "facebook/musicgen-small"
PROMPT = "warm acoustic guitar, gentle, 90bpm"
MAX_LENGTH = 64

snap_dir = Path(snapshot_download(repo_id=MODEL_ID))

tokenizer = T5TokenizerFast.from_pretrained(str(snap_dir), subfolder="text_encoder")
model = T5EncoderModel.from_pretrained(str(snap_dir), subfolder="text_encoder")
model.eval()

enc = tokenizer(PROMPT, padding="max_length", max_length=MAX_LENGTH, truncation=True, return_tensors="pt")
with torch.no_grad():
    out = model(**enc).last_hidden_state

import mlx.core as mx
ref = {
    "input_ids": mx.array(enc["input_ids"].numpy()).astype(mx.int32),
    "prompt_embeds": mx.array(out.numpy()).astype(mx.float32),
}
out_path = OUT_DIR / "musicgen_t5_ref.safetensors"
mx.save_safetensors(str(out_path), ref)
print(f"Saved reference tensors to: {out_path}")
for k, v in ref.items():
    print(f"  {k}: {v.shape} {v.dtype}")
```

- [ ] **Step 3: Write `VerifyT5Command.swift`**

```swift
//
//  VerifyT5Command.swift
//  MusicGenDirectorCLI
//
//  `musicgen verify-t5` — numeric parity of MusicGenT5Encoder (loaded from
//  the flat checkpoint produced by run.py import-musicgen) against
//  gen_musicgen_t5_ref.py's real-weight, real-tokenizer Python output.
//

import ArgumentParser
import MusicGenDirector
import Foundation
import MLX

extension MusicGenCLI {
    struct VerifyT5: ParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "verify-t5",
            abstract: "Compare Swift MusicGenT5Encoder against the real-weight Python reference (numeric parity)."
        )

        @Option(help: "text_encoder.safetensors from run.py import-musicgen.")
        var weights: String = "mlx-models/musicgen/musicgen-small/text_encoder.safetensors"

        @Option(help: "Reference safetensors from gen_musicgen_t5_ref.py.")
        var ref: String = "swift/musicgen-director/verify_refs/musicgen_t5_ref.safetensors"

        @Option(help: "Cosine similarity pass threshold.")
        var threshold: Float = 0.99

        func run() throws {
            setbuf(stdout, nil)
            print("musicgen verify-t5 — T5-base text encoder numeric-parity checkpoint")

            let weightsURL = URL(fileURLWithPath: weights)
            guard FileManager.default.fileExists(atPath: weightsURL.path) else {
                print("ERROR: weights not found at \(weightsURL.path)")
                print("Run: python/venv/bin/python python/mlx-movie-director/run.py import-musicgen")
                throw ExitCode.failure
            }
            let t5Weights = try MusicGenT5Weights.load(path: weightsURL)
            print("loaded \(t5Weights.arrays.count) T5 weights, \(t5Weights.numBlocks) blocks")

            let refURL = URL(fileURLWithPath: ref)
            guard FileManager.default.fileExists(atPath: refURL.path) else {
                print("ERROR: reference file not found at \(refURL.path)")
                print("Generate it: python/venv/bin/python python/mlx-movie-director/app/tests/gen_musicgen_t5_ref.py")
                throw ExitCode.failure
            }
            let refTensors = try loadArrays(url: refURL)

            let encoder = MusicGenT5Encoder.build(weights: t5Weights, precision: .float32)

            let inputIds = refTensors["input_ids"]!.asType(.int32)
            let refEmbeds = refTensors["prompt_embeds"]!.asType(.float32)
            MLX.eval(inputIds, refEmbeds)

            let embeds = encoder(inputIds).asType(.float32)
            MLX.eval(embeds)
            print("swift hidden_states: \(embeds.shape)   ref: \(refEmbeds.shape)")
            let cos = cosine(embeds, refEmbeds)
            print("[hidden_states cos]  \(String(format: "%.5f", cos))")

            if cos >= threshold {
                print("\n✅ MUSICGEN T5 MATCHES PYTHON (threshold=\(threshold))")
            } else {
                print("\n❌ MusicGen T5 diverges (cos=\(String(format: "%.5f", cos)), threshold=\(threshold))")
                throw ExitCode.failure
            }
        }

        private func cosine(_ a: MLXArray, _ b: MLXArray) -> Float {
            let dot = (a * b).sum()
            let na = MLX.sqrt((a * a).sum())
            let nb = MLX.sqrt((b * b).sum())
            return (dot / (na * nb + 1e-12)).item(Float.self)
        }
    }
}
```

- [ ] **Step 4: Register the subcommand**

In `MusicGenCLI.swift`, change `subcommands: []` to `subcommands: [VerifyT5.self]`.

- [ ] **Step 5: Generate the reference and run verification**

Run: `python/venv/bin/python python/mlx-movie-director/app/tests/gen_musicgen_t5_ref.py`
Expected: `Saved reference tensors to: swift/musicgen-director/verify_refs/musicgen_t5_ref.safetensors`

Run: `swift run --package-path swift/musicgen-director musicgen verify-t5`
Expected: `✅ MUSICGEN T5 MATCHES PYTHON` with cos ≥ 0.99. If it fails, the most likely culprits (in order) are: FFN key name mismatch (`wi` vs `wi_0`/`wi_1` — confirm the checkpoint really uses the plain variant), the `encoder.`/`shared.` key-prefix strip in Task 2 not matching this checkpoint's real layout, or `numHeads`/`headDim` swapped.

- [ ] **Step 6: Commit**

```bash
git add swift/musicgen-director/Sources swift/musicgen-director/verify_refs python/mlx-movie-director/app/tests/gen_musicgen_t5_ref.py
git commit -m "feat(musicgen): port T5-base text encoder, verified cos>=0.99 vs Python"
```

---

## Task 4: `DelayPattern` (codebook interleaving)

**Files:**
- Create: `swift/musicgen-director/Sources/MusicGenDirector/DelayPattern.swift`
- Create: `swift/musicgen-director/Tests/MusicGenDirectorTests/DelayPatternTests.swift`

This is pure deterministic logic (no model weights involved) — real XCTest unit tests are the right verification tool here, not a Python numeric-parity script, matching how the skill's TDD default applies whenever the logic under test doesn't require a real checkpoint.

- [ ] **Step 1: Write the failing test**

```swift
//
//  DelayPatternTests.swift
//  MusicGenDirectorTests
//
//  Verifies DelayPattern against the exact worked example in HF's
//  modeling_musicgen.py build_delay_pattern_mask docstring (num_codebooks=4,
//  max_length=8):
//    [P, -1, -1, -1, -1, P, P, P]
//    [P, P, -1, -1, -1, -1, P, P]
//    [P, P, P, -1, -1, -1, -1, P]
//    [P, P, P, P, -1, -1, -1, -1]
//

import XCTest
@testable import MusicGenDirector

final class DelayPatternTests: XCTestCase {
    func testBuildMaskMatchesHFDocstringExample() {
        let mask = DelayPattern.buildMask(numCodebooks: 4, maxLength: 8)
        let p = DelayPattern.padTokenId
        XCTAssertEqual(mask[0], [p, -1, -1, -1, -1, p, p, p])
        XCTAssertEqual(mask[1], [p, p, -1, -1, -1, -1, p, p])
        XCTAssertEqual(mask[2], [p, p, p, -1, -1, -1, -1, p])
        XCTAssertEqual(mask[3], [p, p, p, p, -1, -1, -1, -1])
    }

    func testApplyOverwritesOnlyForcedPositions() {
        let mask = DelayPattern.buildMask(numCodebooks: 4, maxLength: 8)
        var raw: [[Int32]] = (0..<4).map { _ in [10, 11, 12, 13, 14, 15, 16, 17] }
        DelayPattern.apply(&raw, mask: mask)
        // codebook 0: forced at t=0 and t=5,6,7; real values kept at t=1..4
        XCTAssertEqual(raw[0], [DelayPattern.padTokenId, 11, 12, 13, 14,
                                 DelayPattern.padTokenId, DelayPattern.padTokenId, DelayPattern.padTokenId])
        // codebook 3: forced at t=0..3; real values kept at t=4..7
        XCTAssertEqual(raw[3], [DelayPattern.padTokenId, DelayPattern.padTokenId,
                                 DelayPattern.padTokenId, DelayPattern.padTokenId, 14, 15, 16, 17])
    }

    func testDeinterleaveRecoversCleanFrames() {
        // maxLength=8, numCodebooks=4 -> total_gen_len = 8-4 = 4.
        var raw: [[Int32]] = (0..<4).map { c in (0..<8).map { Int32($0 * 10 + c) } }
        let mask = DelayPattern.buildMask(numCodebooks: 4, maxLength: 8)
        DelayPattern.apply(&raw, mask: mask)
        let clean = DelayPattern.deinterleave(raw, frameCount: 4)
        XCTAssertEqual(clean.count, 4)
        for c in 0..<4 { XCTAssertEqual(clean[c].count, 4) }
        // codebook 0's clean frames are raw[0][1..<5] (pre-overwrite values, positions 1-4 are never forced)
        XCTAssertEqual(clean[0], [10, 20, 30, 40])
        // codebook 3's clean frames are raw[3][4..<8]
        XCTAssertEqual(clean[3], [43, 53, 63, 73])
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `swift test --package-path swift/musicgen-director --filter DelayPatternTests`
Expected: FAIL — `DelayPattern` does not exist.

- [ ] **Step 3: Write `DelayPattern.swift`**

```swift
//
//  DelayPattern.swift
//  MusicGenDirector
//
//  MusicGen's codebook-interleaving "delay pattern" — codebook c is offset
//  by c positions so autoregressive generation can predict all 4 codebooks'
//  next frame in lockstep. Ported from HF's modeling_musicgen.py
//  build_delay_pattern_mask/apply_delay_pattern_mask, specialized to the
//  mono (audio_channels=1) case (MusicGen-small has no stereo variant — see
//  the port spec's "Out of scope" section).
//
//  Derivation (confirmed against the exact worked example in HF's docstring,
//  num_codebooks=4, max_length=8 — see DelayPatternTests):
//    BOS-pad region:  t <= c
//    EOS-pad region:  t >= max_length - numCodebooks + 1 + c
//    valid (predict): c < t < max_length - numCodebooks + 1 + c
//    valid length per codebook = max_length - numCodebooks (constant)
//    => max_length = total_gen_len + numCodebooks
//    De-interleave: codebook c's clean frames = raw[c][(c+1)..<(c+1+total_gen_len)]
//

import Foundation

public enum DelayPattern {
    /// MusicGen-small's pad/bos token id (config.decoder.pad_token_id ==
    /// bos_token_id == 2048, one past the real vocab_size=2048 range).
    public static let padTokenId: Int32 = 2048

    /// Build the pattern mask for `numCodebooks` codebooks over `maxLength`
    /// raw steps. `mask[c][t] == -1` means "predict here"; any other value is
    /// the forced pad/bos token for that position.
    public static func buildMask(numCodebooks: Int, maxLength: Int) -> [[Int32]] {
        var mask = [[Int32]](repeating: [Int32](repeating: -1, count: maxLength), count: numCodebooks)
        for c in 0..<numCodebooks {
            for t in 0..<maxLength {
                let isBOSRegion = t <= c
                let isEOSRegion = t >= maxLength - numCodebooks + 1 + c
                if isBOSRegion || isEOSRegion {
                    mask[c][t] = padTokenId
                }
            }
        }
        return mask
    }

    /// Overwrite `raw[c][t]` with the pattern's forced value wherever the
    /// mask says so (mask != -1); leaves the model's real prediction in place
    /// at every "-1" position. Call after appending each new generated step.
    public static func apply(_ raw: inout [[Int32]], mask: [[Int32]]) {
        for c in 0..<raw.count {
            for t in 0..<raw[c].count {
                if mask[c][t] != -1 { raw[c][t] = mask[c][t] }
            }
        }
    }

    /// Strip the delay offset to recover clean, codebook-aligned frames ready
    /// for EnCodec decode. `frameCount` is `maxLength - numCodebooks`.
    public static func deinterleave(_ raw: [[Int32]], frameCount: Int) -> [[Int32]] {
        (0..<raw.count).map { c in Array(raw[c][(c + 1)..<(c + 1 + frameCount)]) }
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `swift test --package-path swift/musicgen-director --filter DelayPatternTests`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add swift/musicgen-director/Sources/MusicGenDirector/DelayPattern.swift swift/musicgen-director/Tests
git commit -m "feat(musicgen): port delay-pattern codebook interleaving, unit tested vs HF docstring example"
```

---

## Task 5: `MusicGenEncodecAdapter` (EnCodec 32kHz decode)

**Files:**
- Create: `swift/musicgen-director/Sources/MusicGenDirector/MusicGenEncodecAdapter.swift`
- Create: `swift/musicgen-director/Sources/MusicGenDirectorCLI/VerifyEncodecCommand.swift`
- Modify: `swift/musicgen-director/Sources/MusicGenDirectorCLI/MusicGenCLI.swift`
- Create: `python/mlx-movie-director/app/tests/gen_musicgen_encodec_ref.py`

- [ ] **Step 1: Write `MusicGenEncodecAdapter.swift`**

```swift
//
//  MusicGenEncodecAdapter.swift
//  MusicGenDirector
//
//  Thin wrapper around Blaizzy/mlx-audio-swift's Encodec (MLXAudioCodecs),
//  configured with facebook/encodec_32khz's real numbers (see this plan's
//  "Real numbers" section) — decode-only, since MusicGen T2A never encodes
//  audio. EncodecConfig.swift is fully Codable/data-driven so our
//  audio_encoder_config.json (written verbatim by run.py import-musicgen
//  from the real HF config, see Task 2) decodes directly with zero manual
//  field mapping.
//
//  IMPORTANT: two of our real config values differ from EncodecConfig's
//  defaults (useCausalConv=false, useConvShortcut=false vs defaults true/
//  true) — decoding our real audio_encoder_config.json handles this
//  correctly since EncodecConfig reads every field from the supplied JSON,
//  but this is called out because getting it wrong silently would NOT throw
//  (it would just produce wrong-shaped padding).
//

import Foundation
import MLX
import MLXAudioCodecs

public struct MusicGenEncodecAdapter {
    public let codec: Encodec
    public let frameRate: Int   // 50 for encodec_32khz (32000 / (8*5*4*4))
    public let sampleRate: Int  // 32000

    /// `configPath`/`weightsPath` — audio_encoder_config.json / .safetensors
    /// from run.py import-musicgen.
    public init(configPath: URL, weightsPath: URL) throws {
        let configData = try Data(contentsOf: configPath)
        let config = try JSONDecoder().decode(EncodecConfig.self, from: configData)
        let model = Encodec(config: config)
        let weights = try loadArrays(url: weightsPath)
        try model.update(parameters: ModuleParameters.unflattened(weights), verify: .noUnusedKeys)
        self.codec = model
        self.frameRate = model.samplingRate / config.upsamplingRatios.reduce(1, *)
        self.sampleRate = model.samplingRate
    }

    /// `codes`: (numCodebooks, frames) int32 clean (de-interleaved) codebook
    /// indices. Returns the decoded waveform, shape (1, samples, 1).
    public func decode(codes: MLXArray) -> MLXArray {
        // Encodec.decode expects (num_chunks=1, batch=1, num_codebooks, frames)
        // since we have no chunking (chunkLengthS=nil in our config).
        let shaped = codes.expandedDimensions(axis: 0).expandedDimensions(axis: 0)
        let waveform = codec.decode(shaped, [nil])
        MLX.eval(waveform)
        return waveform
    }
}
```

- [ ] **Step 2: Write the Python reference generator**

```python
#!/usr/bin/env python3
"""Generate EnCodec 32kHz decode reference for Swift port verification
(Task 5 of docs/superpowers/plans/2026-07-28-musicgen-swift-native-port.md).

Decodes a fixed set of known codebook indices through the real HF
EncodecModel (facebook/encodec_32khz) and saves the resulting waveform. The
Swift port decodes the SAME indices via MusicGenEncodecAdapter and compares
(cosine/correlation on the waveform).

Run from repo root:
    python/venv/bin/python python/mlx-movie-director/app/tests/gen_musicgen_encodec_ref.py
"""
from pathlib import Path

import numpy as np
import torch
from transformers import EncodecModel

REPO = Path(__file__).resolve().parents[4]
OUT_DIR = REPO / "swift" / "musicgen-director" / "verify_refs"
OUT_DIR.mkdir(parents=True, exist_ok=True)

model = EncodecModel.from_pretrained("facebook/encodec_32khz")
model.eval()

# Fixed, deterministic codebook indices — 4 codebooks, 100 frames (2s @ 50Hz),
# derived from a simple seeded PRNG so the Swift side can reproduce them
# exactly without needing numpy (see VerifyEncodecCommand.swift).
rng = np.random.default_rng(1234)
codes_np = rng.integers(0, 2048, size=(1, 1, 4, 100)).astype(np.int64)
codes = torch.from_numpy(codes_np)

with torch.no_grad():
    audio = model.decode(codes, [None])[0]   # (1, 1, samples)

import mlx.core as mx
ref = {
    "codes": mx.array(codes_np.squeeze(0).squeeze(0)).astype(mx.int32),   # (4, 100)
    "waveform": mx.array(audio.numpy().squeeze(0).squeeze(0)).astype(mx.float32),  # (samples,)
}
out_path = OUT_DIR / "musicgen_encodec_ref.safetensors"
mx.save_safetensors(str(out_path), ref)
print(f"Saved reference tensors to: {out_path}")
for k, v in ref.items():
    print(f"  {k}: {v.shape} {v.dtype}")
```

- [ ] **Step 3: Write `VerifyEncodecCommand.swift`**

```swift
//
//  VerifyEncodecCommand.swift
//  MusicGenDirectorCLI
//
//  `musicgen verify-encodec` — decode the SAME fixed codebook indices
//  gen_musicgen_encodec_ref.py used and compare waveforms (cosine).
//

import ArgumentParser
import MusicGenDirector
import Foundation
import MLX

extension MusicGenCLI {
    struct VerifyEncodec: ParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "verify-encodec",
            abstract: "Compare Swift MusicGenEncodecAdapter decode against the real HF EncodecModel reference."
        )

        @Option(help: "audio_encoder_config.json from run.py import-musicgen.")
        var config: String = "mlx-models/musicgen/musicgen-small/audio_encoder_config.json"

        @Option(help: "audio_encoder.safetensors from run.py import-musicgen.")
        var weights: String = "mlx-models/musicgen/musicgen-small/audio_encoder.safetensors"

        @Option(help: "Reference safetensors from gen_musicgen_encodec_ref.py.")
        var ref: String = "swift/musicgen-director/verify_refs/musicgen_encodec_ref.safetensors"

        @Option(help: "Cosine similarity pass threshold.")
        var threshold: Float = 0.99

        func run() throws {
            setbuf(stdout, nil)
            print("musicgen verify-encodec — EnCodec 32kHz decode numeric-parity checkpoint")

            let refURL = URL(fileURLWithPath: ref)
            guard FileManager.default.fileExists(atPath: refURL.path) else {
                print("ERROR: reference file not found at \(refURL.path)")
                print("Generate it: python/venv/bin/python python/mlx-movie-director/app/tests/gen_musicgen_encodec_ref.py")
                throw ExitCode.failure
            }
            let refTensors = try loadArrays(url: refURL)
            let codes = refTensors["codes"]!.asType(.int32)     // (4, 100) — SAME indices Python decoded
            let refWaveform = refTensors["waveform"]!.asType(.float32)
            MLX.eval(codes, refWaveform)

            let adapter = try MusicGenEncodecAdapter(
                configPath: URL(fileURLWithPath: config),
                weightsPath: URL(fileURLWithPath: weights))
            print("frameRate=\(adapter.frameRate) sampleRate=\(adapter.sampleRate)")

            let waveform = adapter.decode(codes: codes).reshaped([-1]).asType(.float32)
            print("swift waveform: \(waveform.shape)   ref: \(refWaveform.shape)")

            let n = min(waveform.dim(0), refWaveform.dim(0))
            let a = waveform[0..<n]
            let b = refWaveform[0..<n]
            let cos = cosine(a, b)
            print("[waveform cos]  \(String(format: "%.5f", cos))")

            if cos >= threshold {
                print("\n✅ MUSICGEN ENCODEC MATCHES PYTHON (threshold=\(threshold))")
            } else {
                print("\n❌ MusicGen EnCodec diverges (cos=\(String(format: "%.5f", cos)), threshold=\(threshold))")
                throw ExitCode.failure
            }
        }

        private func cosine(_ a: MLXArray, _ b: MLXArray) -> Float {
            let dot = (a * b).sum()
            let na = MLX.sqrt((a * a).sum())
            let nb = MLX.sqrt((b * b).sum())
            return (dot / (na * nb + 1e-12)).item(Float.self)
        }
    }
}
```

- [ ] **Step 4: Register the subcommand**

In `MusicGenCLI.swift`, change `subcommands: [VerifyT5.self]` to `subcommands: [VerifyT5.self, VerifyEncodec.self]`.

- [ ] **Step 5: Generate the reference and run verification**

Run: `python/venv/bin/python python/mlx-movie-director/app/tests/gen_musicgen_encodec_ref.py`
Expected: saved reference with `codes: (4, 100)`, `waveform: (32000,)` roughly (100 frames * 640 hop / … actually 100 frames @ 50Hz = 2.0s * 32000Hz = 64000 samples — confirm the printed shape, don't assume).

Run: `swift run --package-path swift/musicgen-director musicgen verify-encodec`
Expected: `✅ MUSICGEN ENCODEC MATCHES PYTHON` with cos ≥ 0.99. If it fails: first check whether `audio_encoder.safetensors`'s keys actually match `Encodec`'s expected `encoder.layers.N...`/`decoder.layers.N...`/`quantizer.layers.N.codebook.embed` layout (the `.noUnusedKeys` verify in the adapter's `update()` call will throw with the exact mismatched keys if so — read that error, don't guess).

- [ ] **Step 6: Commit**

```bash
git add swift/musicgen-director/Sources swift/musicgen-director/verify_refs python/mlx-movie-director/app/tests/gen_musicgen_encodec_ref.py
git commit -m "feat(musicgen): wire mlx-audio-swift EnCodec decode, verified cos>=0.99 vs Python"
```

---

## Task 6: `MusicGenDecoder` (24-layer LM decoder)

**Files:**
- Create: `swift/musicgen-director/Sources/MusicGenDirector/MusicGenDecoder.swift`
- Create: `swift/musicgen-director/Sources/MusicGenDirector/MusicGenWeights.swift`

This is the genuine from-scratch component. Structurally modeled on `swift/ltx-video-director/Sources/LTXVideoDirector/WhisperDecoder.swift` (causal self-attn + cross-attn to encoder output, pre-norm blocks) but with MusicGen's own numbers/differences: standard `LayerNorm` (not RMSNorm), `bias=False` everywhere, per-codebook embedding tables (summed) instead of one token table, sinusoidal (non-learned, recomputed) position embeddings instead of a learned table, and **un-tied per-codebook output heads** (4 separate `Linear(1024, 2048, bias: false)`, not tied to the embedding weight — confirmed from `modeling_musicgen.py`'s `MusicgenForCausalLM.__init__`: `self.lm_heads = nn.ModuleList([nn.Linear(...) for _ in range(config.num_codebooks)])`, and `tie_word_embeddings=false` in the real config).

- [ ] **Step 1: Write `MusicGenDecoder.swift`**

```swift
//
//  MusicGenDecoder.swift
//  MusicGenDirector
//
//  MusicGen's own LM decoder — a genuine from-scratch Swift/MLX port (no
//  prior implementation found anywhere on GitHub, see the port spec's Phase
//  0 research). 24 pre-norm transformer blocks, causal self-attention +
//  cross-attention to T5 hidden states, structurally modeled on
//  ltx-video-director's WhisperDecoder.swift (same causal+cross-attn shape)
//  but with MusicGen's real numbers/differences, confirmed by reading HF's
//  modeling_musicgen.py directly:
//    - standard LayerNorm (mean+var, weight+bias), NOT T5's RMSNorm
//    - bias=False on every q/k/v/out/fc1/fc2 projection
//    - 4 separate per-codebook embedding tables, summed (not one table)
//    - sinusoidal (non-learned, recomputed per length) position embeddings —
//      NOT a learned table, added once after summing codebook embeddings
//    - 4 separate UNTIED per-codebook lm_heads (tie_word_embeddings=false)
//    - activation: gelu (config.decoder.activation_function)
//
//  v1 has NO KV cache (matches WhisperDecoder's precedent for a first
//  correctness-verified pass) — every forward call recomputes attention over
//  the full prefix. This makes long-duration generation slow; a KV-cache
//  follow-up is explicitly out of scope for this plan (see MusicGenGenerator).
//
//  Numerically verified via `musicgen verify-decoder-step` (Task 7).
//

import Foundation
import MLX
import MLXNN

// MARK: - Standard scaled-dot-product attention (self OR cross, selected by whether keyValueStates is passed)

struct MGDecoderAttention {
    let q: MLXNN.Linear
    let k: MLXNN.Linear
    let v: MLXNN.Linear
    let o: MLXNN.Linear
    let numHeads: Int
    let headDim: Int

    /// - Parameters:
    ///   - x: query input (1, qLen, 1024)
    ///   - keyValueStates: if non-nil, cross-attention input (1, kvLen, 1024); else self-attention on `x`
    ///   - causalMask: additive mask (qLen, kvLen) for self-attention; nil for cross-attention (no masking — MusicGen's cross-attn attends to the FULL T5 sequence, no padding mask needed here since we always encode a fixed-length prompt)
    func callAsFunction(_ x: MLXArray, keyValueStates: MLXArray? = nil, causalMask: MLXArray? = nil) -> MLXArray {
        let kv = keyValueStates ?? x
        let qLen = x.dim(1)
        let kvLen = kv.dim(1)
        func shapeQ(_ t: MLXArray) -> MLXArray { t.reshaped([1, qLen, numHeads, headDim]).transposed(0, 2, 1, 3) }
        func shapeKV(_ t: MLXArray) -> MLXArray { t.reshaped([1, kvLen, numHeads, headDim]).transposed(0, 2, 1, 3) }

        let qs = shapeQ(q(x))
        let ks = shapeKV(k(kv))
        let vs = shapeKV(v(kv))

        let scale: Float = 1.0 / Float(headDim).squareRoot()
        var scores = MLX.matmul(qs, ks.transposed(0, 1, 3, 2)) * scale
        if let mask = causalMask {
            scores = scores + mask.expandedDimensions(axis: 0).expandedDimensions(axis: 0)
        }
        let attnWeights = MLX.softmax(scores, axis: -1)
        let attnOut = MLX.matmul(attnWeights, vs)
        let unshaped = attnOut.transposed(0, 2, 1, 3).reshaped([1, qLen, numHeads * headDim])
        return o(unshaped)
    }
}

// MARK: - Decoder block (pre-norm: self-attn -> cross-attn -> FFN, each with its own residual)

struct MGDecoderLayer {
    let selfAttnLayerNorm: MLXNN.LayerNorm
    let selfAttn: MGDecoderAttention
    let crossAttnLayerNorm: MLXNN.LayerNorm
    let crossAttn: MGDecoderAttention
    let finalLayerNorm: MLXNN.LayerNorm
    let fc1: MLXNN.Linear
    let fc2: MLXNN.Linear

    func callAsFunction(_ x: MLXArray, encoderHiddenStates: MLXArray, causalMask: MLXArray) -> MLXArray {
        var h = x
        h = h + selfAttn(selfAttnLayerNorm(h), causalMask: causalMask)
        h = h + crossAttn(crossAttnLayerNorm(h), keyValueStates: encoderHiddenStates)
        let residual = h
        var ff = finalLayerNorm(h)
        ff = MLXNN.gelu(fc1(ff))
        ff = fc2(ff)
        return residual + ff
    }
}

// MARK: - Sinusoidal positional embedding (non-learned, recomputed — NOT a learned table)

enum MusicGenSinusoidalPositionalEmbedding {
    /// Matches HF's MusicgenSinusoidalPositionalEmbedding.get_embedding exactly
    /// (the "tensor2tensor" variant: cos-then-sin concatenation, NOT sin-then-cos).
    static func embedding(numPositions: Int, embeddingDim: Int) -> MLXArray {
        let halfDim = embeddingDim / 2
        let logBase = Foundation.log(10000.0) / Double(halfDim - 1)
        let freqs = (0..<halfDim).map { Float(Foundation.exp(-Double($0) * logBase)) }
        var rows: [[Float]] = []
        rows.reserveCapacity(numPositions)
        for pos in 0..<numPositions {
            let angles = freqs.map { Float(pos) * $0 }
            let cosPart = angles.map { Foundation.cos($0) }
            let sinPart = angles.map { Foundation.sin($0) }
            rows.append(cosPart + sinPart)
        }
        let flat = rows.flatMap { $0 }
        return MLXArray(flat, [numPositions, embeddingDim])
    }
}

// MARK: - Full decoder

public final class MusicGenDecoder {
    public static let hiddenSize = 1024
    public static let numLayers = 24
    public static let numHeads = 16
    public static let headDim = 64   // 1024 / 16
    public static let ffnDim = 4096
    public static let numCodebooks = 4
    public static let vocabSize = 2048

    let embedTokens: [MLXNN.Embedding]   // one per codebook, summed
    let layers: [MGDecoderLayer]
    let layerNorm: MLXNN.LayerNorm
    let lmHeads: [MLXNN.Linear]          // one per codebook, UNTIED (tie_word_embeddings=false)

    init(embedTokens: [MLXNN.Embedding], layers: [MGDecoderLayer], layerNorm: MLXNN.LayerNorm, lmHeads: [MLXNN.Linear]) {
        self.embedTokens = embedTokens
        self.layers = layers
        self.layerNorm = layerNorm
        self.lmHeads = lmHeads
    }

    static func causalMask(length: Int) -> MLXArray {
        var values = [Float](repeating: 0, count: length * length)
        for row in 0..<length {
            for col in (row + 1)..<length {
                values[row * length + col] = -Float.infinity
            }
        }
        return MLXArray(values, [length, length])
    }

    /// - Parameters:
    ///   - inputIds: (numCodebooks, seqLen) int32 — the raw delay-pattern sequence so far.
    ///   - encoderHiddenStates: (1, tLen, 768) T5 output.
    /// - Returns: logits, shape (numCodebooks, seqLen, vocabSize).
    public func callAsFunction(inputIds: MLXArray, encoderHiddenStates: MLXArray) -> MLXArray {
        let seqLen = inputIds.dim(1)
        var hidden: MLXArray? = nil
        for cb in 0..<Self.numCodebooks {
            let ids = inputIds[cb].expandedDimensions(axis: 0)   // (1, seqLen)
            let e = embedTokens[cb](ids)
            hidden = hidden == nil ? e : (hidden! + e)
        }
        var h = hidden! + MusicGenSinusoidalPositionalEmbedding.embedding(numPositions: seqLen, embeddingDim: Self.hiddenSize)
            .expandedDimensions(axis: 0)

        let mask = Self.causalMask(length: seqLen)
        for layer in layers {
            h = layer(h, encoderHiddenStates: encoderHiddenStates, causalMask: mask)
        }
        h = layerNorm(h)

        let logitsPerCodebook = lmHeads.map { $0(h) }   // each (1, seqLen, vocabSize)
        return MLX.stacked(logitsPerCodebook.map { $0.squeezed(axis: 0) }, axis: 0)   // (numCodebooks, seqLen, vocabSize)
    }
}
```

- [ ] **Step 2: Write `MusicGenWeights.swift`**

```swift
//
//  MusicGenWeights.swift
//  MusicGenDirector
//
//  Loads decoder.safetensors (from run.py import-musicgen) into
//  MusicGenDecoder. Key layout confirmed from HF's real MusicgenDecoder /
//  MusicgenForCausalLM module names: `model.decoder.embed_tokens.{cb}.weight`,
//  `model.decoder.layers.{i}.self_attn.{q,k,v,out}_proj.weight`,
//  `model.decoder.layers.{i}.self_attn_layer_norm.{weight,bias}`,
//  `model.decoder.layers.{i}.encoder_attn.{q,k,v,out}_proj.weight`,
//  `model.decoder.layers.{i}.encoder_attn_layer_norm.{weight,bias}`,
//  `model.decoder.layers.{i}.fc1.weight`, `.fc2.weight`,
//  `model.decoder.layers.{i}.final_layer_norm.{weight,bias}`,
//  `model.decoder.layer_norm.{weight,bias}`, `lm_heads.{cb}.weight`.
//  If the real checkpoint's prefix differs (e.g. no leading `model.`), the
//  loader's key-existence probe below will fail loudly with the exact key it
//  looked for — adjust the `decoderPrefix` constant, don't silently guess.
//

import Foundation
import MLX
import MLXNN

public struct MusicGenWeights {
    public let arrays: [String: MLXArray]

    public static func load(path: URL) throws -> MusicGenWeights {
        MusicGenWeights(arrays: try loadArrays(url: path))
    }
}

public extension MusicGenDecoder {
    static func build(weights: MusicGenWeights, precision: DType = .float32) throws -> MusicGenDecoder {
        let w = weights.arrays
        // Probe for the real prefix — try "model.decoder." first (matches
        // MusicgenForCausalLM's `model.decoder.*` submodule naming), fall
        // back to bare "decoder." if that's what the checkpoint actually has.
        let decoderPrefix: String
        if w["model.decoder.embed_tokens.0.weight"] != nil {
            decoderPrefix = "model.decoder."
        } else if w["decoder.embed_tokens.0.weight"] != nil {
            decoderPrefix = "decoder."
        } else {
            throw NSError(domain: "MusicGenWeights", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "could not find embed_tokens.0.weight under either "
                    + "'model.decoder.' or 'decoder.' — inspect the real checkpoint's key names "
                    + "(w.keys.filter { $0.contains(\"embed_tokens\") }) and fix decoderPrefix."])
        }

        func lin(_ key: String) -> MLXNN.Linear {
            Linear(weight: w["\(key).weight"]!.asType(precision), bias: nil)
        }
        func ln(_ key: String) -> MLXNN.LayerNorm {
            LayerNorm(dimensions: MusicGenDecoder.hiddenSize,
                      weight: w["\(key).weight"]!.asType(.float32),
                      bias: w["\(key).bias"]!.asType(.float32))
        }

        let embedTokens = (0..<MusicGenDecoder.numCodebooks).map { cb in
            Embedding(weight: w["\(decoderPrefix)embed_tokens.\(cb).weight"]!.asType(precision))
        }

        var numLayers = 0
        while w["\(decoderPrefix)layers.\(numLayers).self_attn.q_proj.weight"] != nil { numLayers += 1 }
        guard numLayers == MusicGenDecoder.numLayers else {
            throw NSError(domain: "MusicGenWeights", code: 2, userInfo: [
                NSLocalizedDescriptionKey: "expected \(MusicGenDecoder.numLayers) decoder layers, found \(numLayers)"])
        }

        let layers = (0..<numLayers).map { i -> MGDecoderLayer in
            let p = "\(decoderPrefix)layers.\(i)"
            return MGDecoderLayer(
                selfAttnLayerNorm: ln("\(p).self_attn_layer_norm"),
                selfAttn: MGDecoderAttention(
                    q: lin("\(p).self_attn.q_proj"), k: lin("\(p).self_attn.k_proj"),
                    v: lin("\(p).self_attn.v_proj"), o: lin("\(p).self_attn.out_proj"),
                    numHeads: MusicGenDecoder.numHeads, headDim: MusicGenDecoder.headDim),
                crossAttnLayerNorm: ln("\(p).encoder_attn_layer_norm"),
                crossAttn: MGDecoderAttention(
                    q: lin("\(p).encoder_attn.q_proj"), k: lin("\(p).encoder_attn.k_proj"),
                    v: lin("\(p).encoder_attn.v_proj"), o: lin("\(p).encoder_attn.out_proj"),
                    numHeads: MusicGenDecoder.numHeads, headDim: MusicGenDecoder.headDim),
                finalLayerNorm: ln("\(p).final_layer_norm"),
                fc1: lin("\(p).fc1"), fc2: lin("\(p).fc2"))
        }

        let layerNorm = ln("\(decoderPrefix)layer_norm")
        let lmHeads = (0..<MusicGenDecoder.numCodebooks).map { cb in lin("lm_heads.\(cb)") }

        return MusicGenDecoder(embedTokens: embedTokens, layers: layers, layerNorm: layerNorm, lmHeads: lmHeads)
    }
}
```

- [ ] **Step 3: Build**

Run: `swift build --package-path swift/musicgen-director`
Expected: builds cleanly (no CLI command wired yet — that's Task 7/8). Fix any MLXNN API mismatches now (e.g. confirm `MLXNN.LayerNorm`'s exact initializer signature — `LayerNorm(dimensions:weight:bias:)` vs a different label — against the installed mlx-swift package's actual header if the compiler flags it).

- [ ] **Step 4: Commit**

```bash
git add swift/musicgen-director/Sources/MusicGenDirector/MusicGenDecoder.swift swift/musicgen-director/Sources/MusicGenDirector/MusicGenWeights.swift
git commit -m "feat(musicgen): port 24-layer LM decoder (causal self-attn + cross-attn to T5)"
```

---

## Task 7: `verify-decoder-step` (single-step logits parity)

**Files:**
- Create: `swift/musicgen-director/Sources/MusicGenDirectorCLI/VerifyDecoderStepCommand.swift`
- Modify: `swift/musicgen-director/Sources/MusicGenDirectorCLI/MusicGenCLI.swift`
- Create: `python/mlx-movie-director/app/tests/gen_musicgen_decoder_step_ref.py`

Deliberately NOT a full multi-step generation comparison (sampling randomness would make that meaningless, per the spec) — one deterministic greedy forward pass on a fixed partial codebook history.

- [ ] **Step 1: Write the Python reference generator**

```python
#!/usr/bin/env python3
"""Generate MusicGen LM-decoder single-step logits reference (Task 7 of
docs/superpowers/plans/2026-07-28-musicgen-swift-native-port.md).

Feeds a fixed, deterministic partial codebook history + real T5 text
conditioning through one forward pass of the real HF MusicgenForCausalLM and
saves the logits at the LAST position for each codebook. The Swift port runs
the SAME inputs through MusicGenDecoder and compares (cosine on the flattened
logits).

Run from repo root:
    python/venv/bin/python python/mlx-movie-director/app/tests/gen_musicgen_decoder_step_ref.py
"""
from pathlib import Path

import numpy as np
import torch
from transformers import MusicgenForCausalLM, T5EncoderModel, T5TokenizerFast
from huggingface_hub import snapshot_download

REPO = Path(__file__).resolve().parents[4]
OUT_DIR = REPO / "swift" / "musicgen-director" / "verify_refs"
OUT_DIR.mkdir(parents=True, exist_ok=True)

MODEL_ID = "facebook/musicgen-small"
PROMPT = "warm acoustic guitar, gentle, 90bpm"

snap_dir = Path(snapshot_download(repo_id=MODEL_ID))

tokenizer = T5TokenizerFast.from_pretrained(str(snap_dir), subfolder="text_encoder")
t5 = T5EncoderModel.from_pretrained(str(snap_dir), subfolder="text_encoder").eval()
enc = tokenizer(PROMPT, return_tensors="pt")
with torch.no_grad():
    encoder_hidden_states = t5(**enc).last_hidden_state   # (1, tLen, 768)

decoder = MusicgenForCausalLM.from_pretrained(str(snap_dir), subfolder="decoder").eval()

# Fixed deterministic partial history: 5 raw steps (< max_length), seeded PRNG
# over the real vocab range [0, 2048) for the 4 codebooks — this is a
# single-step-logits test, not a real generation, so the history's exact
# values don't need to obey the delay-pattern mask.
rng = np.random.default_rng(42)
raw_ids = rng.integers(0, 2048, size=(1, 4, 5)).astype(np.int64)
input_ids = torch.from_numpy(raw_ids).reshape(4, 5)  # (num_codebooks, seq_len) per MusicgenDecoder's forward

with torch.no_grad():
    out = decoder(
        input_ids=input_ids.reshape(1 * 4, 5),
        encoder_hidden_states=encoder_hidden_states,
        use_cache=False,
    )
    logits = out.logits   # (1, num_codebooks, seq_len, vocab_size)

last_logits = logits[0, :, -1, :]   # (num_codebooks, vocab_size)

import mlx.core as mx
ref = {
    "input_ids": mx.array(raw_ids.squeeze(0)).astype(mx.int32),                       # (4, 5)
    "encoder_hidden_states": mx.array(encoder_hidden_states.numpy()).astype(mx.float32),  # (1, tLen, 768)
    "last_logits": mx.array(last_logits.numpy()).astype(mx.float32),                  # (4, 2048)
}
out_path = OUT_DIR / "musicgen_decoder_step_ref.safetensors"
mx.save_safetensors(str(out_path), ref)
print(f"Saved reference tensors to: {out_path}")
for k, v in ref.items():
    print(f"  {k}: {v.shape} {v.dtype}")
```

Note: `MusicgenForCausalLM.forward`'s exact `input_ids` shape convention (whether it wants `(batch*num_codebooks, seq_len)` flattened, matching `MusicgenDecoder.forward`'s documented reshape) must be double-checked against the installed `transformers` version when this step is actually run — read the real signature (`transformers.models.musicgen.modeling_musicgen.MusicgenForCausalLM.forward`) rather than trusting this draft blindly if the call raises a shape error.

- [ ] **Step 2: Write `VerifyDecoderStepCommand.swift`**

```swift
//
//  VerifyDecoderStepCommand.swift
//  MusicGenDirectorCLI
//
//  `musicgen verify-decoder-step` — single deterministic greedy forward pass
//  (no sampling) through MusicGenDecoder vs the real Python reference.
//

import ArgumentParser
import MusicGenDirector
import Foundation
import MLX

extension MusicGenCLI {
    struct VerifyDecoderStep: ParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "verify-decoder-step",
            abstract: "Compare Swift MusicGenDecoder's single-step logits against the real Python reference."
        )

        @Option(help: "decoder.safetensors from run.py import-musicgen.")
        var weights: String = "mlx-models/musicgen/musicgen-small/decoder.safetensors"

        @Option(help: "Reference safetensors from gen_musicgen_decoder_step_ref.py.")
        var ref: String = "swift/musicgen-director/verify_refs/musicgen_decoder_step_ref.safetensors"

        @Option(help: "Cosine similarity pass threshold.")
        var threshold: Float = 0.99

        func run() throws {
            setbuf(stdout, nil)
            print("musicgen verify-decoder-step — LM decoder single-step logits numeric-parity checkpoint")

            let refURL = URL(fileURLWithPath: ref)
            guard FileManager.default.fileExists(atPath: refURL.path) else {
                print("ERROR: reference file not found at \(refURL.path)")
                print("Generate it: python/venv/bin/python python/mlx-movie-director/app/tests/gen_musicgen_decoder_step_ref.py")
                throw ExitCode.failure
            }
            let refTensors = try loadArrays(url: refURL)
            let inputIds = refTensors["input_ids"]!.asType(.int32)
            let encoderHidden = refTensors["encoder_hidden_states"]!.asType(.float32)
            let refLastLogits = refTensors["last_logits"]!.asType(.float32)
            MLX.eval(inputIds, encoderHidden, refLastLogits)

            let mgWeights = try MusicGenWeights.load(path: URL(fileURLWithPath: weights))
            let decoder = try MusicGenDecoder.build(weights: mgWeights, precision: .float32)

            let logits = decoder(inputIds: inputIds, encoderHiddenStates: encoderHidden)  // (4, seqLen, 2048)
            let lastLogits = logits[0..., logits.dim(1) - 1, 0...]   // (4, 2048)
            MLX.eval(lastLogits)
            print("swift last_logits: \(lastLogits.shape)   ref: \(refLastLogits.shape)")

            let cos = cosine(lastLogits, refLastLogits)
            print("[last_logits cos]  \(String(format: "%.5f", cos))")

            if cos >= threshold {
                print("\n✅ MUSICGEN DECODER STEP MATCHES PYTHON (threshold=\(threshold))")
            } else {
                print("\n❌ MusicGen decoder step diverges (cos=\(String(format: "%.5f", cos)), threshold=\(threshold))")
                throw ExitCode.failure
            }
        }

        private func cosine(_ a: MLXArray, _ b: MLXArray) -> Float {
            let dot = (a * b).sum()
            let na = MLX.sqrt((a * a).sum())
            let nb = MLX.sqrt((b * b).sum())
            return (dot / (na * nb + 1e-12)).item(Float.self)
        }
    }
}
```

- [ ] **Step 3: Register the subcommand**

In `MusicGenCLI.swift`: `subcommands: [VerifyT5.self, VerifyEncodec.self, VerifyDecoderStep.self]`.

- [ ] **Step 4: Generate the reference and run verification**

Run: `python/venv/bin/python python/mlx-movie-director/app/tests/gen_musicgen_decoder_step_ref.py`
Expected: saved reference; if `MusicgenForCausalLM.forward`'s real signature differs from this draft's assumed call shape, fix the script against the actual installed `transformers` API before proceeding (read the error, don't guess).

Run: `swift run --package-path swift/musicgen-director musicgen verify-decoder-step`
Expected: `✅ MUSICGEN DECODER STEP MATCHES PYTHON` with cos ≥ 0.99. Per this plan's acceptance gate, **this must clear before Task 8** — a divergence here means a real bug in `MusicGenDecoder` (wrong attention scale, wrong LayerNorm eps, wrong activation, or a key-mapping mistake in `MusicGenWeights`), not something to paper over by tuning the generator.

- [ ] **Step 5: Commit**

```bash
git add swift/musicgen-director/Sources/MusicGenDirectorCLI/VerifyDecoderStepCommand.swift swift/musicgen-director/verify_refs python/mlx-movie-director/app/tests/gen_musicgen_decoder_step_ref.py
git commit -m "test(musicgen): verify LM decoder single-step logits, cos>=0.99 vs Python"
```

---

## Task 8: `MusicGenGenerator` (CFG + sampling + delay-pattern loop)

**Files:**
- Create: `swift/musicgen-director/Sources/MusicGenDirector/MusicGenGenerator.swift`
- Create: `swift/musicgen-director/Sources/MusicGenDirectorCLI/GenerateCommand.swift`
- Modify: `swift/musicgen-director/Sources/MusicGenDirectorCLI/MusicGenCLI.swift`

**Prerequisite:** Task 7's `verify-decoder-step` must be green before starting this task — the generator composes the already-verified T5 encoder + decoder + delay pattern + EnCodec adapter, so a bug found here should first be suspected in the NEW code (CFG blend, top-k sampling, pattern-mask bookkeeping), not the already-verified pieces.

- [ ] **Step 1: Write `MusicGenGenerator.swift`**

```swift
//
//  MusicGenGenerator.swift
//  MusicGenDirector
//
//  The autoregressive generation loop: classifier-free guidance (real +
//  null text conditioning, batch-2 forward per step — matches audiocraft's
//  default two_step_cfg=False path, confirmed by reading lm.py), top-k
//  sampling, delay-pattern bookkeeping (Task 4), EnCodec decode (Task 5).
//
//  v1 has NO KV cache (see MusicGenDecoder's header) — every step recomputes
//  the full prefix's attention. This is O(maxLength^3)-ish and genuinely
//  slow for long durations; callers should default to short durations for
//  quick self-tests and expect multi-minute runs at 30s (this tradeoff was
//  confirmed acceptable for v1 — see this plan's Task 8 preamble / the
//  KV-cache-deferred decision made before writing this plan).
//

import Foundation
import MLX
import MLXRandom
import Flux2Director   // KontextT5Tokenizer reuse — see Package.swift header

public struct MusicGenGenerationConfig {
    public var duration: Float = 30.0
    public var cfgCoef: Float = 3.0
    public var topK: Int = 250
    public var temperature: Float = 1.0
    public var seed: UInt64? = nil

    public init(duration: Float = 30.0, cfgCoef: Float = 3.0, topK: Int = 250,
                temperature: Float = 1.0, seed: UInt64? = nil) {
        self.duration = duration; self.cfgCoef = cfgCoef; self.topK = topK
        self.temperature = temperature; self.seed = seed
    }
}

public final class MusicGenGenerator {
    let tokenizer: KontextT5Tokenizer
    let t5: MusicGenT5Encoder
    let decoder: MusicGenDecoder
    let encodec: MusicGenEncodecAdapter
    static let t5MaxLength = 64   // matches gen_musicgen_t5_ref.py's fixed prompt length

    public init(tokenizer: KontextT5Tokenizer, t5: MusicGenT5Encoder, decoder: MusicGenDecoder, encodec: MusicGenEncodecAdapter) {
        self.tokenizer = tokenizer
        self.t5 = t5
        self.decoder = decoder
        self.encodec = encodec
    }

    /// Full text-to-music generation. Returns the decoded waveform,
    /// shape (samples,), at `encodec.sampleRate`.
    public func generate(prompt: String, config: MusicGenGenerationConfig) -> MLXArray {
        if let seed = config.seed { MLXRandom.seed(seed) }

        // Real conditioning.
        let realIds = tokenizer.tokenize(prompt, maxLength: Self.t5MaxLength)
        let realIdsArr = MLXArray(realIds.map { Int32($0) }, [1, Self.t5MaxLength])
        let realEmbeds = t5(realIdsArr)   // (1, t5MaxLength, 768)

        // Null conditioning: literally encode "" through the same T5, then
        // zero it (matches audiocraft's T5Conditioner exactly — see this
        // plan's "Real numbers" section for why this is bit-exact, not an
        // approximation).
        let nullIds = tokenizer.tokenize("", maxLength: Self.t5MaxLength)
        let nullIdsArr = MLXArray(nullIds.map { Int32($0) }, [1, Self.t5MaxLength])
        let nullEmbeds = t5(nullIdsArr) * MLXArray(Float(0))

        let encoderHiddenStates = MLX.concatenated([realEmbeds, nullEmbeds], axis: 0)  // (2, t5MaxLength, 768)

        let totalGenLen = Int((config.duration * Float(encodec.frameRate)).rounded())
        let maxLength = totalGenLen + MusicGenDecoder.numCodebooks
        let patternMask = DelayPattern.buildMask(numCodebooks: MusicGenDecoder.numCodebooks, maxLength: maxLength)

        // raw[batch][codebook][t] — batch 0 = cond, batch 1 = uncond, sharing
        // the same sampled tokens once CFG-blended (both branches must see
        // the SAME generated history, per audiocraft's shared decoder_input_ids).
        var raw = [[Int32]](repeating: [Int32](repeating: DelayPattern.padTokenId, count: maxLength),
                            count: MusicGenDecoder.numCodebooks)
        DelayPattern.apply(&raw, mask: patternMask)   // t=0 forced for every codebook

        for t in 1..<maxLength {
            let prefixLen = t
            // Build (numCodebooks, prefixLen) input ids for this step, then
            // duplicate on the batch axis inside MusicGenDecoder's forward by
            // calling it TWICE (once per encoderHiddenStates batch entry) —
            // simpler than threading a batch dim through MusicGenDecoder for
            // v1; cost is already dominated by the O(prefixLen^2) attention
            // term, not by this 2x call overhead.
            let prefixArr = MLXArray(raw.flatMap { Array($0[0..<prefixLen]) }, [MusicGenDecoder.numCodebooks, prefixLen])

            let condHidden = encoderHiddenStates[0].expandedDimensions(axis: 0)
            let uncondHidden = encoderHiddenStates[1].expandedDimensions(axis: 0)
            let condLogits = decoder(inputIds: prefixArr, encoderHiddenStates: condHidden)
            let uncondLogits = decoder(inputIds: prefixArr, encoderHiddenStates: uncondHidden)

            let condLast = condLogits[0..., prefixLen - 1, 0...]     // (numCodebooks, vocab)
            let uncondLast = uncondLogits[0..., prefixLen - 1, 0...]
            let blended = uncondLast + config.cfgCoef * (condLast - uncondLast)

            let sampled = Self.topKSample(logits: blended, topK: config.topK, temperature: config.temperature)
            let sampledInts: [Int32] = sampled.asArray(Int32.self)
            for c in 0..<MusicGenDecoder.numCodebooks { raw[c][t] = sampledInts[c] }
            DelayPattern.apply(&raw, mask: patternMask)
        }

        let clean = DelayPattern.deinterleave(raw, frameCount: totalGenLen)
        let cleanArr = MLXArray(clean.flatMap { $0 }, [MusicGenDecoder.numCodebooks, totalGenLen])
        let waveform = encodec.decode(codes: cleanArr)
        return waveform.reshaped([-1])
    }

    /// Top-k + temperature categorical sampling, per codebook row.
    /// `logits`: (numCodebooks, vocab). Returns (numCodebooks,) int32 token ids.
    static func topKSample(logits: MLXArray, topK: Int, temperature: Float) -> MLXArray {
        let topValues = MLX.top(logits, k: topK, axis: -1)          // (numCodebooks, topK), ascending within top-k
        let threshold = topValues[0..., 0].expandedDimensions(axis: -1)  // smallest of the top-k, per row
        let masked = MLX.where(logits .>= threshold, logits, MLXArray(-Float.infinity))
        let scaled = masked / temperature
        return MLX.categorical(scaled, axis: -1).asType(.int32)
    }
}
```

- [ ] **Step 2: Write `GenerateCommand.swift`**

```swift
//
//  GenerateCommand.swift
//  MusicGenDirectorCLI
//
//  `musicgen generate` — full text-to-music generation, mirrors run.py
//  music's --prompt/--output/--duration flags for the TS bridge (Task 10).
//

import ArgumentParser
import MusicGenDirector
import Flux2Director
import Foundation
import MLX

extension MusicGenCLI {
    struct Generate: ParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "generate",
            abstract: "Generate music from a text prompt (pure Swift MLX MusicGen-small)."
        )

        @Option(help: "Music description prompt.")
        var prompt: String

        @Option(help: "Output .wav path.")
        var output: String

        @Option(help: "Target duration in seconds.")
        var duration: Float = 30.0

        @Option(help: "Random seed for sampling (default: nondeterministic).")
        var seed: UInt64?

        @Option(help: "musicgen-small checkpoint directory.")
        var modelDir: String = "mlx-models/musicgen/musicgen-small"

        func run() throws {
            setbuf(stdout, nil)
            let dir = URL(fileURLWithPath: modelDir)

            print("[musicgen generate] loading T5 text encoder...")
            let t5Weights = try MusicGenT5Weights.load(path: dir.appendingPathComponent("text_encoder.safetensors"))
            let t5 = MusicGenT5Encoder.build(weights: t5Weights, precision: .float32)

            print("[musicgen generate] loading LM decoder...")
            let decoderWeights = try MusicGenWeights.load(path: dir.appendingPathComponent("decoder.safetensors"))
            let decoder = try MusicGenDecoder.build(weights: decoderWeights, precision: .float32)

            print("[musicgen generate] loading EnCodec...")
            let encodec = try MusicGenEncodecAdapter(
                configPath: dir.appendingPathComponent("audio_encoder_config.json"),
                weightsPath: dir.appendingPathComponent("audio_encoder.safetensors"))

            guard let tokenizer = KontextT5Tokenizer(tokenizerJSONURL: dir.appendingPathComponent("tokenizer.json")) else {
                print("ERROR: could not load tokenizer.json from \(dir.path)")
                throw ExitCode.failure
            }

            let generator = MusicGenGenerator(tokenizer: tokenizer, t5: t5, decoder: decoder, encodec: encodec)
            let config = MusicGenGenerationConfig(duration: duration, seed: seed)

            print("[musicgen generate] generating \(duration)s of audio for: \"\(prompt)\"")
            let t0 = Date()
            let waveform = generator.generate(prompt: prompt, config: config)
            let elapsed = Date().timeIntervalSince(t0)

            try writeWav(waveform: waveform, sampleRate: encodec.sampleRate, to: output)
            let size = (try? FileManager.default.attributesOfItem(atPath: output)[.size] as? Int) ?? nil
            print("[musicgen generate] done in \(String(format: "%.1f", elapsed))s -> \(output) (\(size ?? 0) bytes)")
        }

        private func writeWav(waveform: MLXArray, sampleRate: Int, to path: String) throws {
            let samples: [Float] = waveform.asArray(Float.self)
            var data = Data()
            func appendLE(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { data.append(contentsOf: $0) } }
            func appendLE16(_ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { data.append(contentsOf: $0) } }

            let numSamples = samples.count
            let byteRate = sampleRate * 2
            data.append(contentsOf: "RIFF".utf8)
            appendLE(UInt32(36 + numSamples * 2))
            data.append(contentsOf: "WAVE".utf8)
            data.append(contentsOf: "fmt ".utf8)
            appendLE(16)
            appendLE16(1)          // PCM
            appendLE16(1)          // mono
            appendLE(UInt32(sampleRate))
            appendLE(UInt32(byteRate))
            appendLE16(2)          // block align
            appendLE16(16)         // bits per sample
            data.append(contentsOf: "data".utf8)
            appendLE(UInt32(numSamples * 2))
            for s in samples {
                let clamped = max(-1.0, min(1.0, s))
                appendLE16(UInt16(bitPattern: Int16(clamped * 32767.0)))
            }
            try FileManager.default.createDirectory(
                atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
            try data.write(to: URL(fileURLWithPath: path))
        }
    }
}
```

- [ ] **Step 3: Register the subcommand + add tokenizer.json to the import script**

In `MusicGenCLI.swift`: `subcommands: [Generate.self, VerifyT5.self, VerifyEncodec.self, VerifyDecoderStep.self]`.

Go back to `python/mlx-movie-director/app/commands/import-musicgen.py` (Task 2) and add, right after the `snapshot_download` call:

```python
    tok_dir = Path(snapshot_download(repo_id=args.model, allow_patterns=["text_encoder/tokenizer.json"]))
    tok_src = tok_dir / "text_encoder" / "tokenizer.json"
    if tok_src.exists():
        shutil.copy(tok_src, target_dir / "tokenizer.json")
        print(f"  copied tokenizer.json")
    else:
        print(f"  WARNING: tokenizer.json not found at {tok_src} — check the real HF layout", file=sys.stderr)
```

(Insert this right before the manifest-writing block, using the already-imported `shutil`/`Path`.)

- [ ] **Step 4: Re-run the import and generate a short self-test clip**

Run: `python/venv/bin/python python/mlx-movie-director/run.py import-musicgen --name musicgen-small-v2` (fresh dir so the tokenizer.json addition lands; or delete and re-run against the same name)
Expected: `mlx-models/musicgen/musicgen-small/tokenizer.json` now present.

Run: `swift run --package-path swift/musicgen-director musicgen generate --prompt "warm acoustic guitar, gentle, 90bpm" --output /tmp/musicgen_test.wav --duration 4 --seed 42`
Expected: completes (a 4s clip at ~50Hz/4 codebooks = ~200 raw steps should be fast enough for a quick manual check even without a KV cache) and writes a non-empty, non-silent `.wav`. Sanity-check with `afplay /tmp/musicgen_test.wav` or inspect via `ffprobe`/`afinfo` — confirm it's actual audio, not silence or NaN noise, before moving to Task 9's more rigorous comparison.

- [ ] **Step 5: Commit**

```bash
git add swift/musicgen-director/Sources python/mlx-movie-director/app/commands/import-musicgen.py
git commit -m "feat(musicgen): add CFG + top-k generation loop and musicgen generate CLI"
```

---

## Task 9: End-to-end comparison against `run.py music` (Layer 4)

**Files:**
- Create: `python/mlx-movie-director/app/tests/compare_musicgen_e2e.py`

Per the spec: no hard cosine/pass-fail gate here (real sampling randomness on both sides makes bit-exact comparison meaningless) — the acceptance criterion is "real, non-silent, spectrally-plausible audio," checked via RMS / frequency-band energy / frame-to-frame variance, the same methodology already used for the `ambient_sound` capability-matrix row.

- [ ] **Step 1: Write the comparison script**

```python
#!/usr/bin/env python3
"""compare_musicgen_e2e.py — spectral/energy sanity comparison between the
Swift musicgen-director port and the Python run.py music reference (Task 9 of
docs/superpowers/plans/2026-07-28-musicgen-swift-native-port.md).

NOT a numeric-parity gate (both sides sample randomly, so bit-exact or even
high-cosine match isn't the right bar — see the plan's Task 9 preamble).
Checks: both outputs are real, non-silent, spectrally-plausible audio (RMS
in a sane range, energy spread across frequency bands, non-trivial
frame-to-frame variance — i.e. not silence and not pure noise).

Run from repo root (requires both a built musicgen Swift binary AND a
working mlx_audiocraft Python install):
    python/venv/bin/python python/mlx-movie-director/app/tests/compare_musicgen_e2e.py
"""
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
import soundfile as sf

REPO = Path(__file__).resolve().parents[4]
PROMPT = "warm acoustic guitar, gentle, 90bpm"   # same example prompt run.py music's own docstring uses
DURATION = 6.0


def analyze(path: Path, label: str) -> None:
    audio, sr = sf.read(str(path))
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    rms = float(np.sqrt(np.mean(audio.astype(np.float64) ** 2)))
    spectrum = np.abs(np.fft.rfft(audio.astype(np.float64)))
    freqs = np.fft.rfftfreq(len(audio), d=1.0 / sr)
    bands = [(0, 500), (500, 2000), (2000, 8000), (8000, sr / 2)]
    band_energy = [float(spectrum[(freqs >= lo) & (freqs < hi)].sum()) for lo, hi in bands]
    frame_len = max(1, sr // 20)
    frames = [audio[i:i + frame_len] for i in range(0, len(audio) - frame_len, frame_len)]
    frame_rms = [float(np.sqrt(np.mean(f.astype(np.float64) ** 2))) for f in frames]
    variance = float(np.var(frame_rms)) if frame_rms else 0.0

    print(f"\n[{label}] {path}")
    print(f"  sample_rate={sr}  duration={len(audio) / sr:.2f}s  rms={rms:.4f}")
    print(f"  band_energy(0-500,500-2k,2k-8k,8k+)={[round(b, 1) for b in band_energy]}")
    print(f"  frame_rms_variance={variance:.6f}")

    ok = rms > 1e-4 and sum(band_energy) > 0 and variance > 1e-8
    print(f"  {'PASS' if ok else 'FAIL'}: non-silent and spectrally-plausible" if ok
          else "  FAIL: looks silent or degenerate")
    if not ok:
        sys.exit(1)


def main() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        swift_out = tmp_path / "swift.wav"
        python_out = tmp_path / "python.wav"

        print("[compare_musicgen_e2e] running Swift musicgen generate...")
        swift_bin = REPO / "swift" / "musicgen-director" / ".build" / "release" / "musicgen"
        if not swift_bin.exists():
            print(f"ERROR: {swift_bin} not built — run: "
                  f"swift build -c release --package-path swift/musicgen-director", file=sys.stderr)
            sys.exit(1)
        subprocess.run([str(swift_bin), "generate", "--prompt", PROMPT,
                        "--output", str(swift_out), "--duration", str(DURATION), "--seed", "42"],
                       check=True, cwd=REPO)

        print("[compare_musicgen_e2e] running run.py music (Python reference)...")
        subprocess.run([sys.executable, str(REPO / "python" / "mlx-movie-director" / "run.py"),
                        "music", "--prompt", PROMPT, "--output", str(python_out),
                        "--duration", str(DURATION)],
                       check=True, cwd=REPO)

        analyze(swift_out, "swift")
        analyze(python_out, "python")

    print("\n✅ both outputs are real, non-silent, spectrally-plausible audio")


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Run it**

Run: `swift build -c release --package-path swift/musicgen-director && python/venv/bin/python python/mlx-movie-director/app/tests/compare_musicgen_e2e.py`
Expected: both `[swift] ... PASS` and `[python] ... PASS`, ending `✅ both outputs are real, non-silent, spectrally-plausible audio`. This requires `mlx_audiocraft`/`soundfile` installed in the venv (`run.py music`'s own documented one-time setup) — if that install is missing, note it in the task's completion notes rather than skipping the comparison silently.

- [ ] **Step 3: Commit**

```bash
git add python/mlx-movie-director/app/tests/compare_musicgen_e2e.py
git commit -m "test(musicgen): add Layer 4 spectral sanity comparison vs run.py music"
```

---

## Task 10: TS integration (replace the Python bridge)

**Files:**
- Create: `bun-apps/pi-agent-ext-movie-director/src/musicgen_binary.ts`
- Create: `bun-apps/pi-agent-ext-movie-director/src/music_native.ts`
- Create: `bun-apps/pi-agent-ext-movie-director/src/music_native.test.ts`
- Modify: `bun-apps/pi-agent-ext-movie-director/src/bridge.ts`
- Modify: `bun-apps/pi-agent-ext-movie-director/src/registry.ts`

Mirrors TTS's 2026-07-13 migration (`mlx:runpy-tts` → `bun:tts-native`) exactly, per the spec — except MusicGen's native path spawns a compiled Swift binary (via `ensureBinary()`, same pattern as `pi-agent-ext-flux2`/`pi-agent-ext-ltx`'s `binary.ts`), not a pure-JS library call like `tts_native.ts`.

- [ ] **Step 1: Write `musicgen_binary.ts`**

Copy `bun-apps/pi-agent-ext-flux2/src/binary.ts` to `bun-apps/pi-agent-ext-movie-director/src/musicgen_binary.ts`, then apply these substitutions throughout:
- `flux2` → `musicgen` (binary name, env var prefix `FLUX2_` → `MUSICGEN_`)
- `flux2-image-director` → `musicgen-director` (package dir name)
- header comment's package path references updated to match

```typescript
/**
 * musicgen_binary.ts — resolve + auto-build the `musicgen` Swift CLI.
 *
 * The binary lives at <repoRoot>/swift/musicgen-director/.build/release/musicgen.
 * It is a pure-Swift/MLX executable (NOT a python subprocess). If it is missing
 * we stream `swift build -c release` to the caller's onUpdate hook (it takes
 * minutes the first time) and cache the result in-memory for the session.
 *
 * Resolution order:
 *   1. $MUSICGEN_BIN              (explicit override, e.g. a prebuilt binary)
 *   2. <repoRoot>/swift/musicgen-director/.build/release/musicgen
 * where repoRoot =
 *   1. $MUSICGEN_REPO_ROOT        (explicit override — needed in bundle mode)
 *   2. walk up from this module to the dir containing swift/musicgen-director
 */
import { dirname, join, resolve as pResolve } from "node:path";
import { existsSync, readdirSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { isFile } from "./paths.ts";

export interface ProgressFn {
  (update: { kind: "progress"; text: string }): void;
}

let _cachedBin: string | null = null;

function findRepoRoot(start: string): string | null {
  let dir = start;
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, "swift", "musicgen-director", "Package.swift"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function resolveRepoRoot(): string {
  if (process.env.MUSICGEN_REPO_ROOT) return pResolve(process.env.MUSICGEN_REPO_ROOT);
  const here: string =
    (import.meta as any).dir ?? (typeof __dirname === "string" ? __dirname : process.cwd());
  const found = findRepoRoot(here);
  if (!found) {
    throw new Error(
      "pi-agent-ext-movie-director: cannot locate repo root (swift/musicgen-director not found).\n" +
        "Set MUSICGEN_REPO_ROOT to the repo root, or MUSICGEN_BIN to the musicgen binary.",
    );
  }
  return found;
}

export function defaultBinaryPath(repoRoot: string): string {
  return join(repoRoot, "swift", "musicgen-director", ".build", "release", "musicgen");
}

export async function buildBinary(repoRoot: string, onProgress?: ProgressFn): Promise<void> {
  const pkgPath = join(repoRoot, "swift", "musicgen-director");
  onProgress?.({ kind: "progress", text: "musicgen binary missing — building (swift build -c release, ~minutes)…" });
  await new Promise<void>((resolveP, rejectP) => {
    const proc = spawn("swift", ["build", "-c", "release", "--package-path", pkgPath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const lineBuf = { out: "", err: "" };
    const handle = (stream: NodeJS.ReadableStream, key: "out" | "err") => {
      stream.on("data", (chunk: Buffer) => {
        lineBuf[key] += chunk.toString();
        let nl: number;
        while ((nl = lineBuf[key].indexOf("\n")) >= 0) {
          const line = lineBuf[key].slice(0, nl).trim();
          lineBuf[key] = lineBuf[key].slice(nl + 1);
          if (line) onProgress?.({ kind: "progress", text: line });
        }
      });
    };
    handle(proc.stdout!, "out");
    handle(proc.stderr!, "err");
    proc.on("error", (err) => rejectP(new Error(`swift build failed to spawn: ${err.message}`)));
    proc.on("close", (code) => {
      if (code === 0) {
        onProgress?.({ kind: "progress", text: "musicgen build complete." });
        resolveP();
      } else {
        const tail = (lineBuf.out + lineBuf.err).slice(-2000);
        rejectP(new Error(`swift build exited ${code}\n${tail}`));
      }
    });
  });
  await buildMetallib(repoRoot, onProgress);
}

export async function buildMetallib(repoRoot: string, onProgress?: ProgressFn): Promise<void> {
  const script = join(repoRoot, "swift", "musicgen-director", "scripts", "build-metallib.sh");
  if (!existsSync(script)) return;
  onProgress?.({ kind: "progress", text: "building mlx.metallib (Metal shaders)…" });
  await new Promise<void>((resolveP) => {
    const proc = spawn("bash", [script, "release"], { stdio: ["ignore", "pipe", "pipe"] });
    proc.on("error", () => resolveP());
    proc.on("close", () => resolveP());
  });
}

function newestSourceMtimeMs(repoRoot: string): number {
  const sourcesDir = join(repoRoot, "swift", "musicgen-director", "Sources");
  let newest = 0;
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) walk(full);
      else if (entry.endsWith(".swift") && stat.mtimeMs > newest) newest = stat.mtimeMs;
    }
  };
  walk(sourcesDir);
  return newest;
}

export function isBinaryStale(repoRoot: string, bin: string): boolean {
  if (!isFile(bin)) return true;
  const binMtime = statSync(bin).mtimeMs;
  return newestSourceMtimeMs(repoRoot) > binMtime;
}

export async function ensureBinary(onProgress?: ProgressFn): Promise<string> {
  if (_cachedBin && isFile(_cachedBin)) return _cachedBin;

  const explicit = process.env.MUSICGEN_BIN;
  if (explicit && existsSync(explicit)) {
    _cachedBin = pResolve(explicit);
    return _cachedBin;
  }

  const repoRoot = resolveRepoRoot();
  const bin = defaultBinaryPath(repoRoot);
  if (isFile(bin)) {
    const metallib = join(dirname(bin), "mlx.metallib");
    if (!isFile(metallib)) {
      try {
        await buildMetallib(repoRoot, onProgress);
      } catch {
        /* best-effort */
      }
    }
    _cachedBin = bin;
    return bin;
  }
  await buildBinary(repoRoot, onProgress);
  if (!isFile(bin)) {
    throw new Error(
      `musicgen build reported success but binary not found at ${bin}. ` +
        "Check swift build output; set MUSICGEN_BIN to override.",
    );
  }
  _cachedBin = bin;
  return bin;
}
```

- [ ] **Step 2: Write `music_native.ts`**

Same input/output shape as `runpy_music.ts`'s `RunPyMusicOptions`/`RunPyMusicDetails` (per the spec, so `bridge.ts`'s existing `adaptRunPyMusic` can be reused as-is) — only the spawn target changes (compiled binary via `ensureBinary()`, not `python run.py music`).

```typescript
/**
 * music_native.ts — the Bun-native musicgen adapter, calling the compiled
 * `musicgen` Swift binary (swift/musicgen-director) instead of shelling
 * `run.py music` (a Python wrapper around mlx_audiocraft.MusicGen). Same
 * migration shape as tts_native.ts's 2026-07-13 edge-tts move, except the
 * "native" side here is a real compiled MLX binary (ensureBinary(), same
 * pattern as pi-agent-ext-flux2/pi-agent-ext-ltx), not a pure-JS library.
 *
 * Same RunPyMusicOptions/RunPyMusicDetails shape as runpy_music.ts so
 * bridge.ts's existing adaptRunPyMusic ToolResult adapter is reused as-is —
 * see bridge.ts's realMusicNative.
 */
import { existsSync, statSync } from "node:fs";
import { ensureBinary } from "./musicgen_binary.ts";
import type { RunPyMusicOptions, RunPyMusicDetails, RunPyMusicOutput } from "./runpy_music.ts";

export interface MusicNativeInput {
  options: RunPyMusicOptions;
  output: string;
  signal?: AbortSignal;
  /** Test seam: inject a canned spawn result so unit tests don't need a built binary. */
  _spawnImpl?: (args: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

/** Build the argv tail for `musicgen generate` from RunPyMusicOptions. */
export function buildMusicNativeArgs(opts: RunPyMusicOptions, output: string): string[] {
  const args: string[] = ["generate", "--prompt", opts.prompt, "--output", output];
  if (opts.duration != null) args.push("--duration", String(opts.duration));
  // opts.model (a HF model id like facebook/musicgen-medium) has no v1 Swift
  // equivalent — musicgen-director only ships musicgen-small (see the port
  // spec's Scope section) — intentionally not passed through.
  return args;
}

async function defaultSpawn(
  args: string[],
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const bin = await ensureBinary();
  const proc = Bun.spawn({
    cmd: [bin, ...args],
    stdout: "pipe",
    stderr: "pipe",
    signal,
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

/** Run `musicgen generate` and normalize into the SAME details/summary shape runpy_music.ts produces. */
export async function runMusicNative(input: MusicNativeInput): Promise<RunPyMusicOutput> {
  const args = buildMusicNativeArgs(input.options, input.output);
  const spawnFn = input._spawnImpl ?? ((a: string[]) => defaultSpawn(a, input.signal));

  let res: { stdout: string; stderr: string; exitCode: number };
  try {
    res = await spawnFn(args);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const details: RunPyMusicDetails = {
      ok: false, command: "music", exitCode: 1, aborted: false,
      output: null, sizeBytes: null, model: null, duration: null, stdout: "",
    };
    return { details, summary: `music spawn failed: ${msg}`, stderrTail: msg };
  }

  const exists = existsSync(input.output);
  const sizeBytes = exists ? statSync(input.output).size : 0;
  const ok = res.exitCode === 0 && exists && sizeBytes > 0;
  const details: RunPyMusicDetails = {
    ok,
    command: "music",
    exitCode: res.exitCode,
    aborted: false,
    output: exists ? input.output : null,
    sizeBytes: exists ? sizeBytes : null,
    model: "musicgen-small",
    duration: input.options.duration ?? null,
    stdout: res.stdout,
  };
  const summary = ok
    ? `music ✓ MusicGen-small (Swift native) → ${input.output}`
    : `music FAILED (exit ${res.exitCode})`;
  const stderrTail = res.stderr.split("\n").filter((l) => l.trim()).slice(-5).join("\n");
  return { details, summary, stderrTail };
}
```

- [ ] **Step 3: Write `music_native.test.ts`**

```typescript
import { describe, expect, test } from "bun:test";
import { buildMusicNativeArgs, runMusicNative } from "./music_native.ts";

describe("buildMusicNativeArgs", () => {
  test("includes prompt and output", () => {
    const args = buildMusicNativeArgs({ prompt: "gentle piano" }, "/tmp/out.wav");
    expect(args).toEqual(["generate", "--prompt", "gentle piano", "--output", "/tmp/out.wav"]);
  });

  test("includes duration when set", () => {
    const args = buildMusicNativeArgs({ prompt: "p", duration: 20 }, "/tmp/out.wav");
    expect(args).toContain("--duration");
    expect(args).toContain("20");
  });
});

describe("runMusicNative", () => {
  test("ok=false when the binary exits nonzero", async () => {
    const out = await runMusicNative({
      options: { prompt: "p" },
      output: "/tmp/does-not-exist-musicgen-test.wav",
      _spawnImpl: async () => ({ stdout: "", stderr: "boom", exitCode: 1 }),
    });
    expect(out.details.ok).toBe(false);
    expect(out.summary).toContain("FAILED");
  });

  test("ok=false on a 0-exit that wrote nothing (mirrors runpy_music's stance)", async () => {
    const out = await runMusicNative({
      options: { prompt: "p" },
      output: "/tmp/does-not-exist-musicgen-test-2.wav",
      _spawnImpl: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    });
    expect(out.details.ok).toBe(false);
  });
});
```

- [ ] **Step 4: Run the new tests**

Run: `( cd bun-apps/pi-agent-ext-movie-director && bun test src/music_native.test.ts )`
Expected: PASS (all tests use `_spawnImpl`, no real binary needed).

- [ ] **Step 5: Wire `bridge.ts`**

In `bun-apps/pi-agent-ext-movie-director/src/bridge.ts`, right after the existing `realTtsNative` function (around line 940, before `realTwosubjectNative`), add:

```typescript
/**
 * realMusicNative — musicgen-director's compiled Swift binary
 * (music_native.ts, via ensureBinary()), NOT a run.py subprocess (this
 * port). Reuses adaptRunPyMusic as-is since RunPyMusicOptions/Details are
 * structurally identical between the old runpy_music.ts and the new
 * music_native.ts (see music_native.ts's header).
 */
async function realMusicNative(req: GenerateRequest, env?: Record<string, string | undefined>): Promise<ToolResult> {
  const opts = (req.options ?? {}) as unknown as RunPyMusicOptions & { output?: string };
  const outputDir = req.outputDir ?? process.cwd();
  const output = opts.output ?? join(outputDir, "music.wav");
  const { runMusicNative } = await import("./music_native.ts");
  const out = await runMusicNative({ options: opts, output });
  return adaptRunPyMusic(req, out.details, out.summary, out.stderrTail, env);
}
```

Then add `"bun:musicgen-native"` to the `invoke` union type in `registry.ts` (Step 6 below first, since bridge.ts's `Adapter`/`InvokeKey` types are derived from `ProviderEntry`'s `invoke` field per `registry.ts:35`'s import) — after that, wire it into `realAdapters` (around line 1147, right after the existing `"mlx:runpy-music"` line):

```typescript
    "mlx:runpy-music": (req) => realRunPyMusic(req, env),
    "bun:musicgen-native": (req) => realMusicNative(req, env),
```

- [ ] **Step 6: Update `registry.ts`**

Add `"bun:musicgen-native"` to the `invoke` union type (right after the existing `"mlx:runpy-music"` entry, around line 48):

```typescript
    | "mlx:runpy-music"
    | "bun:musicgen-native"
```

Change the `musicgen_music` entry (line 352) from:

```typescript
  { name: "musicgen_music", capability: "music_generation", provider: "musicgen", backend: "native_swift", invoke: "mlx:runpy-music", configured: true, notes: "run.py music adapter (src/runpy_music.ts) — Meta's MusicGen via the mlx-audiocraft MLX port (Apple Silicon, no CUDA). Requires a one-time `uv pip install mlx-audiocraft soundfile --python python/venv/bin/python`; run.py music itself gives a clear ERROR if the package is missing. Local MLX, never a cloud GAI API." },
```

to:

```typescript
  // 2026-07-28: invoke moved off `mlx:runpy-music` (a Python subprocess
  // wrapping mlx_audiocraft) onto `bun:musicgen-native` (music_native.ts,
  // spawning the compiled swift/musicgen-director binary via ensureBinary())
  // — this FIXES the backend:"native_swift" label, which was aspirational
  // before this port (see docs/superpowers/specs/2026-07-28-musicgen-swift-
  // native-port-design.md). run.py music / runpy_music.ts / mlx:runpy-music
  // stay in the codebase as the dev-time numeric-parity reference (Task 9's
  // compare_musicgen_e2e.py compares against them) — not deleted.
  { name: "musicgen_music", capability: "music_generation", provider: "musicgen", backend: "native_swift", invoke: "bun:musicgen-native", configured: true, notes: "Native Swift/MLX MusicGen-small (swift/musicgen-director, src/music_native.ts) — T5-base text encoder + 24-layer LM decoder + EnCodec 32kHz, verified numerically against the Python reference (musicgen verify-t5/verify-encodec/verify-decoder-step, all cos>=0.99). Local MLX, no Python venv dependency, never a cloud GAI API." },
```

- [ ] **Step 7: Run the movie-director test suite**

Run: `( cd bun-apps/pi-agent-ext-movie-director && bun test )`
Expected: all existing tests still pass (in particular anything asserting on `REGISTRY`'s `musicgen_music` entry shape or `bridge.ts`'s `realAdapters` key set — grep for `musicgen_music`/`mlx:runpy-music` in existing `*.test.ts` files first and update any literal expectations to match the new `invoke` value).

Run: `bun run --cwd bun-apps/gui-movie-director check:schema`
Expected: passes (registry shape change shouldn't affect the run.py schema contract, but this is the standing verification command per CLAUDE.md).

- [ ] **Step 8: Commit**

```bash
git add bun-apps/pi-agent-ext-movie-director/src/musicgen_binary.ts bun-apps/pi-agent-ext-movie-director/src/music_native.ts bun-apps/pi-agent-ext-movie-director/src/music_native.test.ts bun-apps/pi-agent-ext-movie-director/src/bridge.ts bun-apps/pi-agent-ext-movie-director/src/registry.ts
git commit -m "feat(musicgen): wire native Swift MusicGen into the TS bridge, replacing the Python subprocess"
```

---

## Self-review notes (from applying writing-plans' self-review checklist to this plan)

- **Spec coverage:** Section 1 (new package) → Tasks 1/3/4/5/6/8. Section 2 (checkpoint import) → Task 2. Section 3 (TS integration) → Task 10. Section 4 (verification plan, all 4 layers) → Tasks 3/5/7/9. The "Out of scope" section (medium/large/stereo/melody variants, deleting `run.py music`, `compose-motion` changes, vendoring mlx-audio-swift) is respected throughout — no task touches any of those.
- **Open items carried from spec review, now resolved or explicitly deferred:** `top_k`/`temperature` defaults (resolved: 250/1.0, pinned in this plan's "Real numbers" section from real `audiocraft` source). EnCodec 24kHz-hardcoding risk (resolved: read `Encodec.swift`/`EncodecQuantization.swift` directly this session — fully config-driven, confirmed `numQuantizers` derives to 4 from our real config). `mlx-audio-swift` SPM pin (resolved: `exact: "0.1.3"`, the latest tag, verified to match what was read). Build-system registration (resolved: Task 1 follows the exact `flux2-image-director`/`ltx-video-director` scaffold, including the metallib script every other MLX-Swift package needs).
- **New risk surfaced during planning, addressed via explicit user decision:** KV cache scope for `MusicGenGenerator` — user chose v1-without-cache (matches the `WhisperDecoder` precedent), documented in Task 6/8's preambles rather than silently assumed.
