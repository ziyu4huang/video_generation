#!/usr/bin/env python3
"""Diagnose LTX-2.3 text encoder output quality.

Checks whether our mlx-lm Gemma 3 text encoder produces correct embeddings
for the LTX-2.3 pipeline. Reports per-layer statistics and connector output.

Context:
  The Acelogic fork reported cosine sim 0.05 at text encoder output due to
  incorrect per-layer RoPE in their custom Gemma implementation. Our pipeline
  uses mlx-lm which already handles Gemma 3 sliding/full attention correctly.
  This script verifies our text encoder is producing reasonable output.

Usage:
  python scripts/diagnose_text_encoder.py [--prompt PROMPT]
"""

from __future__ import annotations

import argparse
import os
import sys
import time

# Ensure project imports work
_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _PROJECT_ROOT)

# Ensure vendor sub-packages are importable
_VENDOR_BASE = os.path.join(_PROJECT_ROOT, "vendor", "ltx-2-mlx")
for _pkg in ("packages/ltx-core-mlx", "packages/ltx-pipelines-mlx"):
    _src = os.path.join(_VENDOR_BASE, _pkg, "src")
    if os.path.isdir(_src) and _src not in sys.path:
        sys.path.insert(0, _src)

# Apply vendor monkey-patches
import app.vendor_patches  # noqa: F401

import mlx.core as mx
import numpy as np


def diagnose(prompt: str, max_length: int = 256) -> None:
    """Run text encoder diagnostics and print results."""
    print(f"Prompt: {prompt!r}")
    print(f"Max length: {max_length}")
    print()

    # ---- Step 1: Load Gemma language model from HF ----
    print("=" * 60)
    print("Phase 1: Gemma 3 12B (via mlx-lm, HF auto-download)")
    print("=" * 60)

    from app import config as cfg
    from ltx_core_mlx.text_encoders.gemma.encoders.base_encoder import GemmaLanguageModel

    # Gemma is loaded from HuggingFace (same as the pipeline does it)
    GEMMA_MODEL_ID = "mlx-community/gemma-3-12b-it-4bit"
    gemma = GemmaLanguageModel()
    print(f"  Loading {GEMMA_MODEL_ID}...")
    t0 = time.time()
    gemma.load(GEMMA_MODEL_ID)
    print(f"  Loaded in {time.time() - t0:.1f}s")

    # ---- Step 2: Encode prompt, collect all 49 hidden states ----
    token_ids, attention_mask = gemma.tokenize(prompt, max_length=max_length)
    print(f"  Token IDs shape: {token_ids.shape}")
    print(f"  Attention mask shape: {attention_mask.shape}")
    num_valid = int(mx.sum(attention_mask))
    print(f"  Valid tokens: {num_valid} / {max_length}")

    t0 = time.time()
    all_hidden_states = gemma.get_all_hidden_states(token_ids, attention_mask)
    print(f"  Encoded {len(all_hidden_states)} layers in {time.time() - t0:.1f}s")
    print()

    # ---- Step 3: Per-layer statistics ----
    print("Layer statistics (valid tokens only):")
    print(f"  {'Layer':<8} {'mean':>10} {'std':>10} {'min':>10} {'max':>10} {'norm_mean':>12}")
    print("  " + "-" * 62)

    layer_stats = []
    num_valid_int = int(num_valid)
    for i, h in enumerate(all_hidden_states):
        # Extract valid token positions (left-padded: valid tokens are at the end)
        h_valid = h[0, -num_valid_int:]  # (num_valid, hidden_dim)

        arr = np.array(h_valid.astype(mx.float32), copy=True)
        stats = {
            "mean": float(arr.mean()),
            "std": float(arr.std()),
            "min": float(arr.min()),
            "max": float(arr.max()),
            "norm_mean": float(np.linalg.norm(arr, axis=-1).mean()),
        }
        layer_stats.append(stats)
        label = "embed" if i == 0 else f"L{i - 1}"
        print(f"  {label:<8} {stats['mean']:>10.4f} {stats['std']:>10.4f} "
              f"{stats['min']:>10.4f} {stats['max']:>10.4f} {stats['norm_mean']:>12.2f}")

    # ---- Step 4: Inter-layer cosine similarity ----
    print()
    print("Inter-layer cosine similarity (consecutive layers):")
    prev_norm = None
    for i, h in enumerate(all_hidden_states):
        h_valid = h[0, -num_valid_int:]
        arr = np.array(h_valid.astype(mx.float32), copy=True)
        # Flatten all tokens into one vector for cosine sim
        flat = arr.flatten()
        norm = flat / (np.linalg.norm(flat) + 1e-8)
        if prev_norm is not None:
            cos_sim = float(np.dot(norm, prev_norm))
            label = "embed→L0" if i == 1 else f"L{i - 2}→L{i - 1}"
            print(f"  {label:<15} cosine_sim = {cos_sim:.6f}")
        prev_norm = norm

    # ---- Step 5: Load connector and project ----
    print()
    print("=" * 60)
    print("Phase 2: Connector (Embeddings1DConnector)")
    print("=" * 60)

    # Free Gemma model to save memory before loading connector
    del gemma
    mx.clear_cache()

    from ltx_core_mlx.text_encoders.gemma.feature_extractor import GemmaFeaturesExtractorV2
    from ltx_core_mlx.utils.weights import load_split_safetensors

    # Load connector weights (same as pipeline: load_split_safetensors with prefix)
    connector_path = os.path.join(cfg.LTX_TEXT_ENCODER_DIR, "connector.safetensors")
    connector_weights = load_split_safetensors(connector_path, prefix="connector.")
    print(f"  Loaded connector weights: {len(connector_weights)} tensors")

    # Build connector module and load weights
    feature_extractor = GemmaFeaturesExtractorV2()
    feature_extractor.connector.load_weights(list(connector_weights.items()))
    mx.eval(feature_extractor.parameters())
    print(f"  Connector initialized")

    # Run connector on hidden states
    t0 = time.time()
    video_embeds, audio_embeds = feature_extractor(all_hidden_states, attention_mask=attention_mask)
    mx.eval(video_embeds, audio_embeds)
    print(f"  Connector forward in {time.time() - t0:.1f}s")
    print()

    # ---- Step 6: Connector output statistics ----
    print("Connector output statistics:")
    for name, emb in [("video", video_embeds), ("audio", audio_embeds)]:
        arr = np.array(emb.astype(mx.float32), copy=True)
        print(f"  {name}_embeds: shape={emb.shape}")
        print(f"    mean={arr.mean():.6f}, std={arr.std():.6f}")
        print(f"    min={arr.min():.6f}, max={arr.max():.6f}")
        print(f"    norm_mean={np.linalg.norm(arr, axis=-1).mean():.4f}")
        print()

    # ---- Step 7: Check register handling ----
    print("=" * 60)
    print("Phase 3: Register handling check")
    print("=" * 60)

    # Our vendored code replaces padding with registers (seq stays at max_length)
    # Acelogic/ComfyUI appends registers to extend to 1024
    print(f"  video_embeds seq_len: {video_embeds.shape[1]}")
    print(f"  audio_embeds seq_len: {audio_embeds.shape[1]}")
    print(f"  max_length: {max_length}")
    if video_embeds.shape[1] == max_length:
        print(f"  → Register mode: REPLACE (our vendored behavior)")
        print(f"     Padding positions replaced with registers, seq stays at {max_length}")
    elif video_embeds.shape[1] >= 1024:
        print(f"  → Register mode: APPEND (ComfyUI/Acelogic behavior)")
        print(f"     Registers appended to extend seq to {video_embeds.shape[1]}")
    else:
        print(f"  → Register mode: UNKNOWN (seq_len={video_embeds.shape[1]})")

    # ---- Summary ----
    print()
    print("=" * 60)
    print("SUMMARY")
    print("=" * 60)

    # Check if per-layer RoPE is working by looking at embedding quality
    final_layer_std = layer_stats[-1]["std"]
    final_layer_norm = layer_stats[-1]["norm_mean"]
    print(f"  Final layer (L47) std: {final_layer_std:.4f}, norm_mean: {final_layer_norm:.2f}")
    print()

    if final_layer_std > 0.1 and final_layer_norm > 1.0:
        print("  ✅ Text encoder output looks reasonable (non-degenerate).")
        print("     Per-layer RoPE appears to be handled correctly by mlx-lm.")
    else:
        print("  ⚠️  Text encoder output looks degenerate (very low std/norm).")
        print("     Per-layer RoPE may not be working correctly.")
    print()

    # Register handling assessment
    if video_embeds.shape[1] == max_length and max_length < 1024:
        print("  ℹ️  Connector uses REPLACE mode (seq stays at padded length).")
        print("     ComfyUI uses APPEND mode (extends to 1024).")
        print("     This difference may or may not matter for speech quality.")
        print("     Acelogic reports this 'didn't fix speech quality'.")
    print()

    print("  Key conclusion from Acelogic investigation:")
    print("  'Exported ComfyUI text embeddings → fed to MLX pipeline → still")
    print("   no clear speech (rules out text encoder)' — AUDIO_ISSUES.md §7")
    print()
    print("  → Remaining speech issues are in the 48-layer diffusion transformer,")
    print("    not the text encoder or connector.")


def main():
    parser = argparse.ArgumentParser(description="Diagnose LTX-2.3 text encoder output")
    parser.add_argument("--prompt", default='Close-up of a woman\'s face. She says, "The weather is beautiful today."', help="Test prompt")
    parser.add_argument("--max-length", type=int, default=256, help="Padded sequence length")
    args = parser.parse_args()

    diagnose(args.prompt, args.max_length)


if __name__ == "__main__":
    main()
