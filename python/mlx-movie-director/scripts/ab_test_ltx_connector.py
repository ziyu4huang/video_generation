#!/usr/bin/env python3
"""A/B test: compare BF16 vs 4-bit GS32 LTX-2.3 connector output embeddings.

Loads Gemma 3 12B once, feeds hidden states to both connector variants,
and computes numerical similarity metrics (cosine similarity, PSNR, max diff).

Usage:
    python/venv/bin/python python/mlx-movie-director/scripts/ab_test_ltx_connector.py
    python/venv/bin/python python/mlx-movie-director/scripts/ab_test_ltx_connector.py --prompt "A cat walks on a beach"
"""

from __future__ import annotations

import argparse
import gc
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

import mlx.core as mx
import mlx.nn as nn
import numpy as np
from app import config as cfg


# ── Metrics ──────────────────────────────────────────────────────────────


def cosine_similarity(a: mx.array, b: mx.array) -> float:
    """Cosine similarity between two tensors (mean across batch/seq dims)."""
    a_flat = a.reshape(-1, a.shape[-1])
    b_flat = b.reshape(-1, b.shape[-1])
    a_norm = a_flat / (mx.linalg.norm(a_flat, axis=-1, keepdims=True) + 1e-8)
    b_norm = b_flat / (mx.linalg.norm(b_flat, axis=-1, keepdims=True) + 1e-8)
    cos_sim = (a_norm * b_norm).sum(axis=-1)
    return float(cos_sim.mean())


def psnr_db(a: mx.array, b: mx.array, max_val: float = 1.0) -> float:
    """Peak signal-to-noise ratio in dB."""
    mse = float(((a.astype(mx.float32) - b.astype(mx.float32)) ** 2).mean())
    if mse < 1e-12:
        return float("inf")
    return 20.0 * np.log10(max_val / np.sqrt(mse))


def max_diff(a: mx.array, b: mx.array) -> float:
    """Maximum absolute difference."""
    return float(mx.max(mx.abs(a.astype(mx.float32) - b.astype(mx.float32))))


def mean_diff(a: mx.array, b: mx.array) -> float:
    """Mean absolute difference."""
    return float(mx.mean(mx.abs(a.astype(mx.float32) - b.astype(mx.float32))))


def std_ratio(a: mx.array, b: mx.array) -> float:
    """Ratio of standard deviations (quantized / bf16). Close to 1.0 = good."""
    a_std = float(mx.std(a.astype(mx.float32)))
    b_std = float(mx.std(b.astype(mx.float32)))
    return b_std / a_std if a_std > 0 else 1.0


# ── A/B Test ─────────────────────────────────────────────────────────────


def ab_test(prompt: str, max_length: int = 256) -> None:
    """Run A/B test comparing BF16 and 4-bit connectors."""
    print(f"A/B Test: LTX-2.3 Connector — BF16 vs 4-bit GS32")
    print(f"=" * 60)
    print(f"Prompt: {prompt!r}")
    print(f"Max length: {max_length}")
    print()

    # ── Phase 1: Load Gemma and encode prompt ───────────────────────────
    print("=" * 60)
    print("Phase 1: Gemma 3 12B (via mlx-lm)")
    print("=" * 60)

    from ltx_core_mlx.text_encoders.gemma.encoders.base_encoder import GemmaLanguageModel

    GEMMA_MODEL_ID = "mlx-community/gemma-3-12b-it-4bit"
    gemma = GemmaLanguageModel()
    print(f"  Loading {GEMMA_MODEL_ID}...")
    t0 = time.time()
    gemma.load(GEMMA_MODEL_ID)
    print(f"  Loaded in {time.time() - t0:.1f}s")

    token_ids, attention_mask = gemma.tokenize(prompt, max_length=max_length)
    num_valid = int(mx.sum(attention_mask))
    print(f"  Tokens: {num_valid} valid / {max_length} padded")

    t0 = time.time()
    all_hidden_states = gemma.get_all_hidden_states(token_ids, attention_mask)
    print(f"  Encoded {len(all_hidden_states)} hidden layers in {time.time() - t0:.1f}s")
    print(f"  Each hidden state shape: {all_hidden_states[0].shape}")
    print()

    # Free Gemma (keep hidden states in memory)
    del gemma
    gc.collect()
    mx.clear_cache()

    from ltx_core_mlx.text_encoders.gemma.feature_extractor import TextEncoderConnector
    from ltx_core_mlx.utils.weights import load_split_safetensors
    from mlx.utils import tree_flatten

    # ── Phase 2: Load BF16 connector (reference) ────────────────────────
    print("=" * 60)
    print("Phase 2: BF16 connector (reference)")
    print("=" * 60)

    bf16_bak = os.path.join(cfg.LTX_TEXT_ENCODER_DIR, "connector.safetensors.bf16.bak")
    if not os.path.exists(bf16_bak):
        print(f"  ERROR: BF16 backup not found at {bf16_bak}")
        print(f"  Cannot run A/B test without the original weights.")
        return

    # mx.load() requires .safetensors extension; copy backup to temp file
    import tempfile
    import shutil
    bf16_tmp = tempfile.mktemp(suffix=".safetensors")
    shutil.copy2(bf16_bak, bf16_tmp)

    model_a = TextEncoderConnector(
        caption_channels=3840,
        num_gemma_layers=49,
        video_dim=4096,
        audio_dim=2048,
        num_heads=32,
        video_head_dim=128,
        audio_head_dim=64,
        num_layers=8,
        num_registers=128,
    )

    print(f"  Loading BF16 weights from connector.safetensors.bf16.bak...")
    weights_a = load_split_safetensors(bf16_tmp, prefix="connector.")
    os.unlink(bf16_tmp)
    print(f"  Loaded {len(weights_a)} tensors")
    model_a.load_weights(list(weights_a.items()))
    del weights_a
    gc.collect()
    mx.eval(model_a.parameters())

    # Run BF16 connector
    print(f"  Running BF16 connector...")
    from ltx_core_mlx.text_encoders.gemma.feature_extractor import GemmaFeaturesExtractorV2

    # GemmaFeaturesExtractorV2 wraps the connector with hidden state stacking/norm.
    # We bypass it and feed pre-stacked hidden states directly to the connector.
    # Simulate what GemmaFeaturesExtractorV2 does before calling connector():
    #   stacked = stack + rms_norm + reshape → (B, T, D*L)
    encoded = mx.stack(all_hidden_states, axis=-1)  # (B, T, D, L)
    variance = mx.mean(encoded * encoded, axis=2, keepdims=True)
    normed = encoded * mx.rsqrt(variance + 1e-6)
    B, T, D, L = normed.shape
    stacked = normed.reshape(B, T, D * L)

    # Zero out padding positions (left-padded: valid tokens at end)
    mask_3d = attention_mask[:, :, None].astype(stacked.dtype)
    stacked = stacked * mask_3d

    t0 = time.time()
    video_a, audio_a = model_a(stacked, attention_mask=attention_mask)
    mx.eval(video_a, audio_a)
    t_a = time.time() - t0
    print(f"  BF16 connector forward: {t_a:.2f}s")
    print(f"  video_embeds: {video_a.shape}, audio_embeds: {audio_a.shape}")
    print()

    # Free BF16 model
    del model_a
    gc.collect()
    mx.clear_cache()

    # ── Phase 3: Load 4-bit connector (quantized) ───────────────────────
    print("=" * 60)
    print("Phase 3: 4-bit GS32 connector (quantized)")
    print("=" * 60)

    q_path = os.path.join(cfg.LTX_TEXT_ENCODER_DIR, "connector.safetensors")
    if not os.path.exists(q_path):
        print(f"  ERROR: Quantized connector not found at {q_path}")
        return

    model_b = TextEncoderConnector(
        caption_channels=3840,
        num_gemma_layers=49,
        video_dim=4096,
        audio_dim=2048,
        num_heads=32,
        video_head_dim=128,
        audio_head_dim=64,
        num_layers=8,
        num_registers=128,
    )

    # First quantize to create QuantizedLinear structure, then load weights
    print(f"  Quantizing model structure to 4-bit...")
    nn.quantize(model_b, bits=4, group_size=32)
    mx.eval(model_b.parameters())

    print(f"  Loading 4-bit weights from connector.safetensors...")
    weights_b = load_split_safetensors(q_path, prefix="connector.")
    print(f"  Loaded {len(weights_b)} tensors")
    model_b.load_weights(list(weights_b.items()))
    del weights_b
    gc.collect()
    mx.eval(model_b.parameters())

    # Run 4-bit connector
    print(f"  Running 4-bit connector...")
    t0 = time.time()
    video_b, audio_b = model_b(stacked, attention_mask=attention_mask)
    mx.eval(video_b, audio_b)
    t_b = time.time() - t0
    print(f"  4-bit connector forward: {t_b:.2f}s")
    print()

    # Free 4-bit model + stacked input
    del model_b, stacked
    gc.collect()

    # ── Phase 4: Compare ────────────────────────────────────────────────
    print("=" * 60)
    print("Phase 4: Metrics")
    print("=" * 60)
    print()

    for name, emb_a, emb_b in [
        ("video_embeds", video_a, video_b),
        ("audio_embeds", audio_a, audio_b),
    ]:
        print(f"  ── {name} ──")
        print(f"    Shape:                {emb_a.shape}")
        print(f"    Cosine similarity:    {cosine_similarity(emb_a, emb_b):.6f}")
        print(f"    PSNR:                 {psnr_db(emb_a, emb_b):.2f} dB")
        print(f"    Max abs diff:         {max_diff(emb_a, emb_b):.6f}")
        print(f"    Mean abs diff:        {mean_diff(emb_a, emb_b):.6f}")
        print(f"    Std ratio (4bit/BF16): {std_ratio(emb_a, emb_b):.4f}")

        # Per-token stats
        a_np = np.array(emb_a.astype(mx.float32)[0], copy=True)  # (T, D)
        b_np = np.array(emb_b.astype(mx.float32)[0], copy=True)
        diff = np.abs(a_np - b_np)
        print(f"    Per-token max diff:   {diff.max(axis=-1).max():.6f}")
        print(f"    Per-token mean diff:  {diff.mean(axis=-1).mean():.6f}")
        print(f"    Tokens with diff>0.1: {int((diff.mean(axis=-1) > 0.1).sum())} / {diff.shape[0]}")
        print()

    # ── Phase 5: Summary ────────────────────────────────────────────────
    print("=" * 60)
    print("VERDICT")
    print("=" * 60)

    video_cs = cosine_similarity(video_a, video_b)
    audio_cs = cosine_similarity(audio_a, audio_b)
    video_psnr = psnr_db(video_a, video_b)
    audio_psnr = psnr_db(audio_a, audio_b)

    # Thresholds (typical for 4-bit quantization):
    #   cosine_sim > 0.99 = excellent
    #   cosine_sim > 0.95 = good
    #   PSNR > 30 dB = good
    passes = 0
    total = 4

    print(f"  video_embeds cosine similarity: {video_cs:.6f}  ", end="")
    if video_cs > 0.99:
        print("✅ EXCELLENT")
        passes += 1
    elif video_cs > 0.95:
        print("⚠️  GOOD")
        passes += 0.5
    else:
        print("❌ POOR — possible quality regression")

    print(f"  audio_embeds cosine similarity: {audio_cs:.6f}  ", end="")
    if audio_cs > 0.99:
        print("✅ EXCELLENT")
        passes += 1
    elif audio_cs > 0.95:
        print("⚠️  GOOD")
        passes += 0.5
    else:
        print("❌ POOR — possible quality regression")

    print(f"  video_embeds PSNR: {video_psnr:.2f} dB         ", end="")
    if video_psnr > 30:
        print("✅ GOOD")
        passes += 1
    elif video_psnr > 20:
        print("⚠️  ACCEPTABLE")
        passes += 0.5
    else:
        print("❌ POOR")

    print(f"  audio_embeds PSNR: {audio_psnr:.2f} dB         ", end="")
    if audio_psnr > 30:
        print("✅ GOOD")
        passes += 1
    elif audio_psnr > 20:
        print("⚠️  ACCEPTABLE")
        passes += 0.5
    else:
        print("❌ POOR")

    print()
    score = passes / total * 100
    print(f"  Overall score: {score:.0f}% ({passes}/{total} metrics passed)")
    if score >= 75:
        print(f"  ✅ PASS — 4-bit quantization preserves connector output quality.")
    elif score >= 50:
        print(f"  ⚠️  BORDERLINE — review per-token diffs before deploying.")
    else:
        print(f"  ❌ FAIL — 4-bit quantization degrades output too much. Roll back.")

    # Speed comparison
    speedup = t_a / t_b if t_b > 0 else 0
    print()
    print(f"  Speed: BF16={t_a:.2f}s, 4-bit={t_b:.2f}s ({speedup:.1f}x)")


def main():
    parser = argparse.ArgumentParser(description="A/B test LTX-2.3 connector: BF16 vs 4-bit")
    parser.add_argument("--prompt", default='Close-up of a woman\'s face. She says, "The weather is beautiful today."',
                        help="Test prompt")
    parser.add_argument("--max-length", type=int, default=256, help="Padded sequence length")
    args = parser.parse_args()

    ab_test(args.prompt, args.max_length)


if __name__ == "__main__":
    main()
