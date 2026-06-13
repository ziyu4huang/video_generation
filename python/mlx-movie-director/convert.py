#!/usr/bin/env python3
"""One-time model conversion CLI for mlx-movie-director.

Usage:
    ./python/venv/bin/python python/mlx-movie-director/convert.py --all
    ./python/venv/bin/python python/mlx-movie-director/convert.py --transformer
    ./python/venv/bin/python python/mlx-movie-director/convert.py --text-encoder
    ./python/venv/bin/python python/mlx-movie-director/convert.py --tokenizer
    ./python/venv/bin/python python/mlx-movie-director/convert.py --vae
"""

import argparse
import gc
import json
import os
import shutil
import sys
import tempfile

# Ensure local `app` package is importable regardless of CWD.
# Must precede third-party and local imports that depend on it.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import numpy as np
import torch

import mlx.core as mx
import mlx.nn as nn
from mlx import nn as _nn
from mlx.utils import tree_flatten
from safetensors.torch import load_file as load_pt_file
from tqdm import tqdm

from app import config as cfg
from app.seedvr2.transformer import SeedVR2Transformer
from app.seedvr2.vae import SeedVR2VAE
from app.seedvr2.weight_mapping import get_transformer_remapping, get_conv3d_weight_keys
from app.text_encoder import TextEncoderMLX
from app.transformer import ZImageTransformerMLX


# === Transformer key remapping (from convert_comfy.py) ===

_replace_keys = {
    "final_layer.": "all_final_layer.2-1.",
    "x_embedder.": "all_x_embedder.2-1.",
    ".attention.out.bias": ".attention.to_out.0.bias",
    ".attention.k_norm.weight": ".attention.norm_k.weight",
    ".attention.q_norm.weight": ".attention.norm_q.weight",
    ".attention.out.weight": ".attention.to_out.0.weight",
}


def _remap_qkv(key, state_dict):
    weight = state_dict.pop(key)
    to_q, to_k, to_v = weight.chunk(3, dim=0)
    state_dict[key.replace(".qkv.", ".to_q.")] = to_q
    state_dict[key.replace(".qkv.", ".to_k.")] = to_k
    state_dict[key.replace(".qkv.", ".to_v.")] = to_v


def _remap_keys(key, state_dict):
    new_key = key
    for r, rr in _replace_keys.items():
        new_key = new_key.replace(r, rr)
    state_dict[new_key] = state_dict.pop(key)


def _map_key_and_convert(key, tensor):
    if isinstance(tensor, torch.Tensor):
        val = tensor.detach().cpu().float().numpy()
    else:
        val = tensor

    new_key = key

    if "t_embedder.mlp.0" in key:
        new_key = key.replace("t_embedder.mlp.0", "t_embedder.linear1")
    elif "t_embedder.mlp.2" in key:
        new_key = key.replace("t_embedder.mlp.2", "t_embedder.linear2")
    elif "all_x_embedder.2-1" in key:
        new_key = key.replace("all_x_embedder.2-1", "x_embedder")
    elif "cap_embedder.0" in key:
        new_key = key.replace("cap_embedder.0", "cap_embedder.layers.0")
    elif "cap_embedder.1" in key:
        new_key = key.replace("cap_embedder.1", "cap_embedder.layers.1")
    elif "all_final_layer.2-1" in key:
        new_key = key.replace("all_final_layer.2-1", "final_layer")

    if "adaLN_modulation.1" in new_key:
        new_key = new_key.replace("adaLN_modulation.1", "adaLN_modulation.layers.1")
    elif "attention.to_out.0" in key:
        new_key = key.replace("attention.to_out.0", "attention.to_out")
    elif "adaLN_modulation.0" in key and "final" not in key:
        new_key = key.replace("adaLN_modulation.0", "adaLN_modulation")
    elif "adaLN_modulation.1" in key and "final" not in key:
        new_key = key.replace("adaLN_modulation.1", "adaLN_modulation")

    return (
        new_key.replace("model.diffusion_model.", ""),
        mx.array(val).astype(mx.bfloat16),
    )


# === Conversion functions ===

def convert_transformer() -> bool:
    src = cfg.SRC_TRANSFORMER
    dst_dir = cfg.TRANSFORMER_DIR

    if not os.path.exists(src):
        print(f"[transformer] ERROR: Source not found: {src}")
        return False

    os.makedirs(dst_dir, exist_ok=True)
    print(f"[transformer] Loading {os.path.basename(src)} (~11GB, this will take a while)...")
    pt_weights = load_pt_file(src)

    if "model.diffusion_model.norm_final.weight" in pt_weights:
        del pt_weights["model.diffusion_model.norm_final.weight"]

    print("[transformer] Remapping ComfyUI keys...")
    keys = list(pt_weights.keys())
    for k in tqdm(keys):
        if ".qkv." in k:
            _remap_qkv(k, pt_weights)
        else:
            _remap_keys(k, pt_weights)

    print("[transformer] Converting to MLX BF16...")
    mlx_weights = [_map_key_and_convert(k, v) for k, v in tqdm(pt_weights.items())]
    del pt_weights
    gc.collect()

    print("[transformer] Initializing model and loading weights...")
    model = ZImageTransformerMLX(cfg.TRANSFORMER_CONFIG)
    model.load_weights(mlx_weights)
    del mlx_weights
    mx.eval(model.parameters())

    print("[transformer] Quantizing to 4-bit (group_size=32)...")
    nn.quantize(model, bits=4, group_size=32)

    out_weights = os.path.join(dst_dir, "model.safetensors")
    out_config = os.path.join(dst_dir, "config.json")

    print(f"[transformer] Saving to {dst_dir}...")
    model.save_weights(out_weights)
    with open(out_config, "w") as f:
        json.dump(cfg.TRANSFORMER_CONFIG, f, indent=2)

    print(f"[transformer] Done. Saved to {dst_dir}")
    return True


def convert_text_encoder() -> bool:
    src = cfg.SRC_TEXT_ENCODER
    dst_dir = cfg.TEXT_ENCODER_DIR

    if not os.path.exists(src):
        print(f"[text_encoder] ERROR: Source not found: {src}")
        return False

    os.makedirs(dst_dir, exist_ok=True)
    te_config = cfg.TEXT_ENCODER_CONFIG
    model = TextEncoderMLX(te_config)

    print(f"[text_encoder] Loading {os.path.basename(src)} (~7.5GB)...")
    pt_weights = load_pt_file(src)

    collected = {}
    for k, v in tqdm(pt_weights.items()):
        val_np = v.float().numpy() if isinstance(v, torch.Tensor) else v
        collected[k] = mx.array(val_np).astype(mx.bfloat16)
    del pt_weights
    gc.collect()

    print("[text_encoder] Loading weights into model...")
    model.load_weights(list(collected.items()))
    del collected
    mx.eval(model.parameters())

    print("[text_encoder] Quantizing to 4-bit (group_size=32)...")
    nn.quantize(model, bits=4, group_size=32)

    out_weights = os.path.join(dst_dir, "model.safetensors")
    out_config = os.path.join(dst_dir, "config.json")

    print(f"[text_encoder] Saving to {dst_dir}...")
    model.save_weights(out_weights)
    with open(out_config, "w") as f:
        json.dump(te_config, f, indent=2)

    print(f"[text_encoder] Done. Saved to {dst_dir}")
    return True


def download_tokenizer():
    from huggingface_hub import snapshot_download

    dst_dir = cfg.TOKENIZER_DIR
    os.makedirs(dst_dir, exist_ok=True)

    print(f"[tokenizer] Downloading from Tongyi-MAI/Z-Image-Turbo...")
    snapshot_download(
        repo_id="Tongyi-MAI/Z-Image-Turbo",
        allow_patterns=["tokenizer/*"],
        local_dir=cfg.MODELS_DIR,
        ignore_patterns=["*.bin", "*.safetensors", "*.gguf", "*.pt"],
    )
    print(f"[tokenizer] Done. Saved to {dst_dir}")
    return True


def download_vae():
    from huggingface_hub import snapshot_download

    dst_dir = cfg.VAE_DIR
    os.makedirs(dst_dir, exist_ok=True)

    print(f"[vae] Downloading from Tongyi-MAI/Z-Image-Turbo (~160MB)...")
    snapshot_download(
        repo_id="Tongyi-MAI/Z-Image-Turbo",
        allow_patterns=["vae/*"],
        local_dir=cfg.MODELS_DIR,
        ignore_patterns=["*.bin"],
    )
    print(f"[vae] Done. Saved to {dst_dir}")
    return True


# === SeedVR2 conversion ===

def _quantize_predicate(path: str, module) -> bool:
    """Skip quantization for Conv layers and small Linear layers (last dim not divisible by 64)."""
    if isinstance(module, (_nn.Conv2d, _nn.Conv3d)):
        return False
    if not hasattr(module, "to_quantized"):
        return False
    if isinstance(module, _nn.Linear):
        if hasattr(module, "weight") and module.weight.shape[-1] % 64 != 0:
            return False
    return True


def convert_seedvr2_dit() -> bool:
    """Convert SeedVR2 7B DiT from fp16 safetensors → 4-bit MLX."""
    src = cfg.SRC_SEEDVR2_DIT_7B
    dst_dir = cfg.SEEDVR2_DIT_DIR

    if not os.path.exists(src):
        print(f"[seedvr2-dit] ERROR: Source not found: {src}")
        return False

    os.makedirs(dst_dir, exist_ok=True)

    # Build model config for 7B
    num_layers = 36
    mm_layers = 36  # ALL blocks are shared for 7B
    transformer_config = dict(
        vid_dim=3072, txt_in_dim=5120, txt_dim=3072, emb_dim=18432,
        heads=24, num_layers=num_layers, mm_layers=mm_layers,
        rope_dim=64, rope_on_text=False, rope_freqs_for="pixel",
        use_output_ada=False, last_layer_vid_only=False,
        window=(4, 3, 3),
        mlp_type="normal",  # 7B uses GELU MLP (proj_in + proj_out only, no gate)
    )

    # 1. Initialize model to get expected parameter tree
    print("[seedvr2-dit] Initializing model structure...")
    model = SeedVR2Transformer(**transformer_config)
    model_keys = set(dict(tree_flatten(model.parameters())).keys())
    print(f"[seedvr2-dit] Model expects {len(model_keys)} parameters")

    # 2. Load source weights
    print(f"[seedvr2-dit] Loading {os.path.basename(src)} (~15GB, this will take a while)...")
    pt_weights = load_pt_file(src)

    # 3. Build dynamic key mapping based on model structure
    print("[seedvr2-dit] Remapping keys...")
    mlx_weights = {}
    unmapped = []
    mapped_count = 0

    for k, v in tqdm(pt_weights.items()):
        val_np = v.detach().cpu().float().numpy() if isinstance(v, torch.Tensor) else v
        mlx_val = mx.array(val_np).astype(mx.bfloat16)

        new_key = _remap_seedvr2_key(k, num_layers, mm_layers)
        if new_key and new_key in model_keys:
            mlx_weights[new_key] = mlx_val
            mapped_count += 1
        else:
            unmapped.append(k)

    del pt_weights
    gc.collect()

    if unmapped:
        print(f"[seedvr2-dit] Warning: {len(unmapped)} unmapped source keys (sample): {unmapped[:5]}")

    # 4. Merge with model's initialized params for any missing keys
    model_params = dict(tree_flatten(model.parameters()))
    model_params.update(mlx_weights)
    del mlx_weights
    gc.collect()
    print(f"[seedvr2-dit] Final params: {mapped_count} from source + {len(model_params) - mapped_count} initialized defaults")

    # 5. Load merged weights and quantize
    model.load_weights(list(model_params.items()))
    del model_params
    mx.eval(model.parameters())

    print("[seedvr2-dit] Quantizing to 4-bit (group_size=32, skipping small dims)...")
    nn.quantize(model, bits=4, group_size=32, class_predicate=_quantize_predicate)

    out_weights = os.path.join(dst_dir, "model.safetensors")
    print(f"[seedvr2-dit] Saving to {dst_dir}...")
    model.save_weights(out_weights)

    print(f"[seedvr2-dit] Done. Saved to {dst_dir}")
    return True


def _remap_seedvr2_key(src_key: str, num_layers: int, mm_layers: int) -> str | None:
    """Remap a source (ComfyUI) key to a target MLX model key.

    Rules:
    - Top-level keys pass through unchanged
    - For shared blocks (i >= mm_layers): vid/txt → all
    - For non-shared blocks: vid → vid, txt → txt
    - Last layer vid-only: skip txt keys
    """
    # Top-level keys
    if not src_key.startswith("blocks."):
        # Identity mapping for non-block keys
        return src_key

    # Parse block index
    parts = src_key.split(".", 2)  # ["blocks", "N", "rest..."]
    if len(parts) < 3:
        return None
    block_idx = int(parts[1])
    rest = parts[2]

    is_shared = block_idx >= mm_layers
    is_last = block_idx == num_layers - 1

    # MLP keys
    if rest.startswith("mlp.vid."):
        suffix = rest[len("mlp.vid."):]
        if is_shared:
            return f"blocks.{block_idx}.mlp.all.{suffix}"
        else:
            return f"blocks.{block_idx}.mlp.vid.{suffix}"
    elif rest.startswith("mlp.txt."):
        suffix = rest[len("mlp.txt."):]
        if is_shared:
            return None  # Already loaded via vid→all; skip duplicate
        elif is_last:
            return None  # Last layer vid-only: no txt MLP
        else:
            return f"blocks.{block_idx}.mlp.txt.{suffix}"
    elif rest.startswith("mlp.all."):
        suffix = rest[len("mlp.all."):]
        if is_shared:
            return f"blocks.{block_idx}.mlp.all.{suffix}"
        else:
            return None  # Non-shared blocks shouldn't have 'all' keys

    # AdaModulation keys
    elif rest.startswith("ada.vid."):
        suffix = rest[len("ada.vid."):]
        if is_shared:
            return f"blocks.{block_idx}.ada.params_all.{suffix}"
        else:
            return f"blocks.{block_idx}.ada.params_vid.{suffix}"
    elif rest.startswith("ada.txt."):
        suffix = rest[len("ada.txt."):]
        if is_shared:
            return None  # Already loaded via vid→all
        elif is_last:
            return None  # Last layer vid-only
        else:
            return f"blocks.{block_idx}.ada.params_txt.{suffix}"
    elif rest.startswith("ada.all."):
        suffix = rest[len("ada.all."):]
        if is_shared:
            return f"blocks.{block_idx}.ada.params_all.{suffix}"
        else:
            return None

    # Attention keys — for shared blocks, model has both vid and txt as aliases
    elif rest.startswith("attn.proj_qkv.vid."):
        suffix = rest[len("attn.proj_qkv.vid."):]
        return f"blocks.{block_idx}.attn.proj_qkv_vid.{suffix}"
    elif rest.startswith("attn.proj_qkv.txt."):
        suffix = rest[len("attn.proj_qkv.txt."):]
        return f"blocks.{block_idx}.attn.proj_qkv_txt.{suffix}"
    elif rest.startswith("attn.proj_out.vid."):
        suffix = rest[len("attn.proj_out.vid."):]
        return f"blocks.{block_idx}.attn.proj_out_vid.{suffix}"
    elif rest.startswith("attn.proj_out.txt."):
        suffix = rest[len("attn.proj_out.txt."):]
        return f"blocks.{block_idx}.attn.proj_out_txt.{suffix}"
    elif rest.startswith("attn.norm_q.vid."):
        suffix = rest[len("attn.norm_q.vid."):]
        return f"blocks.{block_idx}.attn.norm_q_vid.{suffix}"
    elif rest.startswith("attn.norm_q.txt."):
        suffix = rest[len("attn.norm_q.txt."):]
        return f"blocks.{block_idx}.attn.norm_q_txt.{suffix}"
    elif rest.startswith("attn.norm_k.vid."):
        suffix = rest[len("attn.norm_k.vid."):]
        return f"blocks.{block_idx}.attn.norm_k_vid.{suffix}"
    elif rest.startswith("attn.norm_k.txt."):
        suffix = rest[len("attn.norm_k.txt."):]
        return f"blocks.{block_idx}.attn.norm_k_txt.{suffix}"
    elif rest.startswith("attn.rope.rope.freqs"):
        return f"blocks.{block_idx}.attn.rope.freqs"

    return None


def convert_seedvr2_vae() -> bool:
    """Convert SeedVR2 VAE from fp16 safetensors → bf16 MLX (no quantization)."""
    src = cfg.SRC_SEEDVR2_VAE
    dst_dir = cfg.SEEDVR2_VAE_DIR

    if not os.path.exists(src):
        print(f"[seedvr2-vae] ERROR: Source not found: {src}")
        return False

    os.makedirs(dst_dir, exist_ok=True)
    print(f"[seedvr2-vae] Loading {os.path.basename(src)} (~500MB)...")
    pt_weights = load_pt_file(src)

    conv3d_keys = get_conv3d_weight_keys()

    print("[seedvr2-vae] Converting weights (transposing Conv3d)...")
    mlx_weights = {}
    for k, v in tqdm(pt_weights.items()):
        val_np = v.detach().cpu().float().numpy() if isinstance(v, torch.Tensor) else v
        if k in conv3d_keys:
            # Conv3d weights: PyTorch (O, I, kT, kH, kW) → MLX (O, kT, kH, kW, I)
            arr = mx.array(val_np).astype(mx.bfloat16)
            arr = arr.transpose(0, 2, 3, 4, 1)
            mlx_weights[k] = arr
        else:
            mlx_weights[k] = mx.array(val_np).astype(mx.bfloat16)

    del pt_weights
    gc.collect()

    print("[seedvr2-vae] Initializing model and loading weights...")
    model = SeedVR2VAE()
    model.load_weights(list(mlx_weights.items()))
    del mlx_weights
    mx.eval(model.parameters())

    out_weights = os.path.join(dst_dir, "model.safetensors")
    print(f"[seedvr2-vae] Saving to {dst_dir}...")
    model.save_weights(out_weights)

    print(f"[seedvr2-vae] Done. Saved to {dst_dir}")
    return True


# === Flux2 Klein 9B conversion ===

def convert_vae_to_mlx() -> bool:
    """Convert flux-ae VAE from PyTorch FP32 to MLX BF16.

    Uses the mflux ZImageWeightMapping to handle Conv2d transpose and key renaming.
    Saves to models/vae/flux-ae/model.safetensors alongside the old PyTorch file.
    """
    _mflux_src = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                              "vendor", "mflux", "src")
    if os.path.isdir(_mflux_src) and _mflux_src not in sys.path:
        sys.path.insert(0, _mflux_src)

    from mflux.models.z_image.model.z_image_vae import VAE as ZImageVAE
    from mflux.models.z_image.weights.z_image_weight_mapping import ZImageWeightMapping
    from mflux.models.common.weights.mapping.weight_transforms import WeightTransforms
    from mlx.utils import tree_flatten

    src = os.path.join(cfg.VAE_DIR, "diffusion_pytorch_model.safetensors")
    dst_dir = cfg.VAE_DIR

    if not os.path.exists(src):
        print(f"[vae-mlx] ERROR: PyTorch VAE not found: {src}")
        return False

    # 1. Load PyTorch weights
    print(f"[vae-mlx] Loading PyTorch VAE ({os.path.basename(src)})...")
    pt_weights = load_pt_file(src)

    # 2. Build the mapping from mflux ZImageWeightMapping
    #    The mapping uses placeholders: {block}, {res}, {i}
    #    Encoder: down_blocks 0-3, resnets 0-1 per block
    #    Encoder: mid_block resnets 0-1
    #    Decoder: up_blocks 0-3, resnets 0-2 per block
    #    Decoder: mid_block resnets 0-1
    mappings = ZImageWeightMapping.get_vae_mapping()

    # Expand placeholder patterns into concrete key mappings
    def _expand_pattern(pattern, expansion_ranges):
        """Expand a pattern like 'encoder.down_blocks.{block}.resnets.{res}.conv1.weight'
        into all concrete keys given the ranges for each placeholder."""
        import re
        placeholders = re.findall(r'\{(\w+)\}', pattern)
        if not placeholders:
            return [pattern]

        results = [pattern]
        for ph in placeholders:
            new_results = []
            for r in results:
                for val in expansion_ranges.get(ph, [0]):
                    new_results.append(r.replace(f'{{{ph}}}', str(val)))
            results = new_results
        return results

    expansion_ranges = {
        # Encoder: down_blocks 0-3 with 2 resnets each
        'block': [0, 1, 2, 3],
        'res': [0, 1],
        # Mid-block resnets and attention indices
        'i': [0, 1],
    }

    # Also need decoder-specific ranges: up_blocks 0-3 with 3 resnets each
    decoder_expansion = dict(expansion_ranges, res=[0, 1, 2])

    # 3. Build a dict: pytorch_key → (mlx_key, transform_fn)
    key_map = {}
    for m in mappings:
        to_pat = m.to_pattern
        from_pats = m.from_pattern

        for from_pat in from_pats:
            # Determine which expansion to use based on whether it's decoder up_blocks
            is_decoder_upblock = 'decoder.up_blocks.{block}' in from_pat
            exp = decoder_expansion if is_decoder_upblock else expansion_ranges

            from_keys = _expand_pattern(from_pat, exp)
            to_keys = _expand_pattern(to_pat, exp)

            for fk, tk in zip(from_keys, to_keys):
                key_map[fk] = (tk, m.transform)

    # 4. Convert weights
    print("[vae-mlx] Converting weights (transposing Conv2d)...")
    mlx_weights = {}
    mapped = 0
    for k, v in tqdm(pt_weights.items()):
        if k in key_map:
            new_key, transform = key_map[k]
            val_np = v.detach().cpu().float().numpy() if isinstance(v, torch.Tensor) else v
            arr = mx.array(val_np).astype(mx.bfloat16)
            if transform is not None:
                arr = transform(arr)
            mlx_weights[new_key] = arr
            mapped += 1
        else:
            # Pass through unmapped keys (shouldn't happen if mapping is complete)
            print(f"[vae-mlx] Warning: unmapped key: {k}")

    del pt_weights
    gc.collect()

    print(f"[vae-mlx] Mapped {mapped} weights")

    # 5. Initialize MLX VAE and load weights
    print("[vae-mlx] Initializing MLX VAE...")
    vae = ZImageVAE()
    model_keys = set(dict(tree_flatten(vae.parameters())).keys())
    print(f"[vae-mlx] Model expects {len(model_keys)} parameters, got {len(mlx_weights)}")

    # Check for missing keys
    missing = model_keys - set(mlx_weights.keys())
    if missing:
        print(f"[vae-mlx] Warning: {len(missing)} missing keys: {sorted(missing)[:5]}...")

    vae.load_weights(list(mlx_weights.items()))
    del mlx_weights
    mx.eval(vae.parameters())

    # 6. Save
    out_path = os.path.join(dst_dir, "model.safetensors")
    print(f"[vae-mlx] Saving to {out_path}...")
    vae.save_weights(out_path)

    size_mb = os.path.getsize(out_path) / (1024 * 1024)
    print(f"[vae-mlx] Done. MLX VAE saved: {size_mb:.0f} MB")
    print(f"[vae-mlx] Old PyTorch file still at: {os.path.basename(src)}")
    return True


def quantize_seedvr2_vae_int8():
    """Quantize SeedVR2 VAE from MLX BF16 to INT8.

    Overwrites models/vae/seedvr2-vae/model.safetensors with quantized version.
    """
    vae_dir = cfg.SEEDVR2_VAE_DIR
    src = os.path.join(vae_dir, "model.safetensors")

    if not os.path.exists(src):
        print(f"[seedvr2-vae-int8] ERROR: Model not found: {src}")
        return False

    print(f"[seedvr2-vae-int8] Loading {src}...")
    model = SeedVR2VAE()
    model.load_weights(src)
    mx.eval(model.parameters())

    print("[seedvr2-vae-int8] Quantizing to INT8 (group_size=64, skipping Conv3d/small Linear)...")
    nn.quantize(model, bits=8, group_size=64, class_predicate=_quantize_predicate)
    mx.eval(model.parameters())

    # Backup old file
    backup = src + ".bf16.bak"
    if not os.path.exists(backup):
        print(f"[seedvr2-vae-int8] Backing up old BF16 weights...")
        shutil.copy2(src, backup)

    print(f"[seedvr2-vae-int8] Saving quantized weights...")
    model.save_weights(src)

    old_mb = os.path.getsize(backup) / (1024 * 1024)
    new_mb = os.path.getsize(src) / (1024 * 1024)
    print(f"[seedvr2-vae-int8] Done. {old_mb:.0f} MB (BF16) → {new_mb:.0f} MB (INT8)")
    print(f"[seedvr2-vae-int8] Backup at: {os.path.basename(backup)}")
    return True

def convert_klein_9b() -> bool:
    """Convert Flux2 Klein 9B from HF cache to pre-quantized INT8, stored in category dirs.

    Uses mflux ModelSaver to save pre-quantized shards, then moves each component
    (transformer, text_encoder, vae, tokenizer) to its own category directory
    following the existing models/{category}/{instance}/ pattern.
    """
    # Ensure mflux is importable
    _mflux_src = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                              "vendor", "mflux", "src")
    if os.path.isdir(_mflux_src) and _mflux_src not in sys.path:
        sys.path.insert(0, _mflux_src)

    from mflux.models.flux2.variants.edit.flux2_klein_edit import Flux2KleinEdit
    from mflux.models.common.config.model_config import ModelConfig
    from mflux.models.common.weights.saving.model_saver import ModelSaver
    from mflux.models.flux2.weights.flux2_weight_definition import Flux2KleinWeightDefinition

    model_config = ModelConfig.flux2_klein_9b()

    # 1. Load from HF cache with on-the-fly INT8 quantization (~32 GB peak RAM)
    print("[klein-9b] Loading from HF cache + quantizing to INT8...")
    print("[klein-9b] (This requires ~32 GB RAM for BF16 → INT8 conversion)")
    model = Flux2KleinEdit(
        model_config=model_config,
        quantize=8,
    )

    # 2. Save pre-quantized to temp dir (mflux writes transformer/, text_encoder/, vae/, tokenizer/)
    tmp = tempfile.mkdtemp(prefix="klein9b_convert_")
    print(f"[klein-9b] Saving pre-quantized INT8 to temp dir...")
    try:
        ModelSaver.save_model(
            model=model,
            bits=model.bits,
            base_path=tmp,
            weight_definition=Flux2KleinWeightDefinition,
        )

        # 3. Move each component to its category dir
        moves = [
            (os.path.join(tmp, "transformer"),    cfg.KLEIN_9B_TRANSFORMER_DIR),
            (os.path.join(tmp, "text_encoder"),   cfg.KLEIN_9B_TEXT_ENCODER_DIR),
            (os.path.join(tmp, "vae"),            cfg.KLEIN_9B_VAE_DIR),
            (os.path.join(tmp, "tokenizer"),      cfg.KLEIN_9B_TOKENIZER_DIR),
        ]
        for src, dst in moves:
            if os.path.exists(dst):
                print(f"[klein-9b] Removing existing {dst}...")
                shutil.rmtree(dst)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.move(src, dst)
            size_mb = sum(
                os.path.getsize(os.path.join(dp, f))
                for dp, _, fns in os.walk(dst)
                for f in fns
            ) / (1024 * 1024)
            print(f"[klein-9b]   {os.path.relpath(dst, cfg.MODELS_DIR)}: {size_mb:.0f} MB")

    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print(f"[klein-9b] Done. ~16 GB saved across category dirs under {cfg.MODELS_DIR}")
    print(f"[klein-9b] Next: run 'check-manifests -v' after adding manifest.json + README.md")
    return True


def convert_klein_9b_checkpoint(checkpoint_path: str, output_name: str = "klein-9b-dark-beast-bfs"):
    """Convert a third-party Klein 9B checkpoint (Civitai .safetensors) to pre-quantized INT8.

    Handles ComfyUI-native format safetensors (FP8 or BF16) by:
    1. Loading the checkpoint and extracting transformer weights
    2. Remapping ComfyUI keys (double_blocks/single_blocks) to HF diffusers format
    3. Splitting fused QKV tensors into separate Q/K/V
    4. Loading via mflux WeightLoader (applies Flux2WeightMapping) into Flux2Transformer
    5. Quantizing with mlx.nn.quantize and saving sharded output

    Usage:
        convert.py --klein-9b-checkpoint /path/to/checkpoint.safetensors
        convert.py --klein-9b-checkpoint checkpoint.safetensors --name my-variant
    """
    _mflux_src = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                              "vendor", "mflux", "src")
    if os.path.isdir(_mflux_src) and _mflux_src not in sys.path:
        sys.path.insert(0, _mflux_src)

    from mflux.models.flux2.model.flux2_transformer.transformer import Flux2Transformer
    from mflux.models.flux2.weights.flux2_weight_mapping import Flux2WeightMapping
    from mflux.models.common.weights.mapping.weight_mapper import WeightMapper
    from mflux.models.common.weights.loading.weight_definition import ComponentDefinition
    from mflux.models.common.config.model_config import ModelConfig

    checkpoint_path = os.path.abspath(checkpoint_path)
    if not os.path.exists(checkpoint_path):
        print(f"[klein-9b-checkpoint] ERROR: file not found: {checkpoint_path}", file=sys.stderr)
        return False

    # ── Step 1: Load checkpoint ────────────────────────────────────
    print(f"[klein-9b-checkpoint] Loading {os.path.basename(checkpoint_path)}...")
    print(f"[klein-9b-checkpoint] (Requires ~20 GB RAM for FP8 -> BF16 -> INT8)")
    raw_weights = load_pt_file(checkpoint_path)
    print(f"[klein-9b-checkpoint] Loaded {len(raw_weights)} tensors")

    # ── Step 2: Remap ComfyUI keys to HF diffusers format ──────────
    print("[klein-9b-checkpoint] Remapping ComfyUI keys to HF diffusers format...")
    converted = {}

    for src_key, tensor in tqdm(raw_weights.items()):
        key = src_key
        if key.startswith("model.diffusion_model."):
            key = key[len("model.diffusion_model."):]

        # Dequantize FP8 -> BF16
        if isinstance(tensor, torch.Tensor):
            if tensor.dtype in (torch.float8_e4m3fn, torch.float8_e5m2):
                tensor = tensor.to(torch.bfloat16)
            elif tensor.dtype == torch.float16:
                tensor = tensor.to(torch.bfloat16)
            elif tensor.dtype == torch.float32:
                tensor = tensor.to(torch.bfloat16)
        else:
            continue

        # ── Core embeddings and projections ────────────────────────
        if key == "img_in.weight":
            converted["x_embedder.weight"] = tensor
        elif key == "txt_in.weight":
            converted["context_embedder.weight"] = tensor
        elif key == "time_in.in_layer.weight":
            converted["time_guidance_embed.timestep_embedder.linear_1.weight"] = tensor
        elif key == "time_in.out_layer.weight":
            converted["time_guidance_embed.timestep_embedder.linear_2.weight"] = tensor
        elif key == "single_stream_modulation.lin.weight":
            converted["single_stream_modulation.linear.weight"] = tensor
        elif key == "double_stream_modulation_img.lin.weight":
            converted["double_stream_modulation_img.linear.weight"] = tensor
        elif key == "double_stream_modulation_txt.lin.weight":
            converted["double_stream_modulation_txt.linear.weight"] = tensor
        elif key == "final_layer.linear.weight":
            converted["proj_out.weight"] = tensor
        elif key.startswith("final_layer.adaLN_modulation."):
            converted["norm_out.linear.weight"] = tensor

        # ── Double blocks -> Transformer blocks ────────────────────
        elif key.startswith("double_blocks."):
            parts = key.split(".", 2)
            block_idx = parts[1]
            rest = parts[2]

            if rest == "img_attn.qkv.weight":
                to_q, to_k, to_v = tensor.chunk(3, dim=0)
                converted[f"transformer_blocks.{block_idx}.attn.to_q.weight"] = to_q
                converted[f"transformer_blocks.{block_idx}.attn.to_k.weight"] = to_k
                converted[f"transformer_blocks.{block_idx}.attn.to_v.weight"] = to_v
            elif rest == "img_attn.proj.weight":
                converted[f"transformer_blocks.{block_idx}.attn.to_out.0.weight"] = tensor
            elif rest == "img_attn.norm.query_norm.scale":
                converted[f"transformer_blocks.{block_idx}.attn.norm_q.weight"] = tensor
            elif rest == "img_attn.norm.key_norm.scale":
                converted[f"transformer_blocks.{block_idx}.attn.norm_k.weight"] = tensor
            elif rest == "txt_attn.qkv.weight":
                to_q, to_k, to_v = tensor.chunk(3, dim=0)
                converted[f"transformer_blocks.{block_idx}.attn.add_q_proj.weight"] = to_q
                converted[f"transformer_blocks.{block_idx}.attn.add_k_proj.weight"] = to_k
                converted[f"transformer_blocks.{block_idx}.attn.add_v_proj.weight"] = to_v
            elif rest == "txt_attn.proj.weight":
                converted[f"transformer_blocks.{block_idx}.attn.to_add_out.weight"] = tensor
            elif rest == "txt_attn.norm.query_norm.scale":
                converted[f"transformer_blocks.{block_idx}.attn.norm_added_q.weight"] = tensor
            elif rest == "txt_attn.norm.key_norm.scale":
                converted[f"transformer_blocks.{block_idx}.attn.norm_added_k.weight"] = tensor
            elif rest == "img_mlp.0.weight":
                converted[f"transformer_blocks.{block_idx}.ff.linear_in.weight"] = tensor
            elif rest == "img_mlp.2.weight":
                converted[f"transformer_blocks.{block_idx}.ff.linear_out.weight"] = tensor
            elif rest == "txt_mlp.0.weight":
                converted[f"transformer_blocks.{block_idx}.ff_context.linear_in.weight"] = tensor
            elif rest == "txt_mlp.2.weight":
                converted[f"transformer_blocks.{block_idx}.ff_context.linear_out.weight"] = tensor

        # ── Single blocks -> Single transformer blocks ─────────────
        elif key.startswith("single_blocks."):
            parts = key.split(".", 2)
            block_idx = parts[1]
            rest = parts[2]

            if rest == "linear1.weight":
                converted[f"single_transformer_blocks.{block_idx}.attn.to_qkv_mlp_proj.weight"] = tensor
            elif rest == "linear2.weight":
                converted[f"single_transformer_blocks.{block_idx}.attn.to_out.weight"] = tensor
            elif rest == "norm.query_norm.scale":
                converted[f"single_transformer_blocks.{block_idx}.attn.norm_q.weight"] = tensor
            elif rest == "norm.key_norm.scale":
                converted[f"single_transformer_blocks.{block_idx}.attn.norm_k.weight"] = tensor

    del raw_weights
    gc.collect()
    print(f"[klein-9b-checkpoint] Remapped to {len(converted)} HF-format tensors")

    # ── Step 3: Convert HF BF16 tensors to MLX + apply weight mapping
    print("[klein-9b-checkpoint] Converting to MLX and applying Flux2WeightMapping...")
    # Build raw HF weights dict as MLX arrays
    hf_mlx = {}
    for k, v in tqdm(converted.items()):
        if isinstance(v, torch.Tensor):
            hf_mlx[k] = mx.array(v.detach().cpu().float().numpy()).astype(mx.bfloat16)

    del converted
    gc.collect()

    # Apply the Flux2 weight mapping (HF key names -> mflux MLX key names)
    mapped = WeightMapper.apply_mapping(
        hf_weights=hf_mlx,
        mapping=Flux2WeightMapping.get_transformer_mapping(),
    )
    del hf_mlx
    gc.collect()
    print(f"[klein-9b-checkpoint] Mapped to {len(mapped) if isinstance(mapped, dict) else 'tree'} MLX weights")

    # ── Step 4: Initialize model and load weights ──────────────────
    print("[klein-9b-checkpoint] Initializing Flux2Transformer...")
    model = Flux2Transformer(
        patch_size=1,
        in_channels=128,
        out_channels=None,
        num_layers=8,
        num_single_layers=24,
        attention_head_dim=128,
        num_attention_heads=32,
        joint_attention_dim=12288,
        timestep_guidance_channels=256,
        mlp_ratio=3.0,
        axes_dims_rope=(32, 32, 32, 32),
        rope_theta=2000,
        guidance_embeds=False,
    )

    from mlx.utils import tree_flatten
    flat = tree_flatten(mapped) if not isinstance(mapped, list) else mapped
    print(f"[klein-9b-checkpoint] Loading {len(flat)} weights into model...")
    model.load_weights(flat)
    del mapped, flat
    mx.eval(model.parameters())

    # ── Step 5: Quantize to INT8 ───────────────────────────────────
    print("[klein-9b-checkpoint] Quantizing to INT8 (group_size=64)...")
    nn.quantize(model, bits=8, group_size=64)
    mx.eval(model.parameters())

    # ── Step 6: Save sharded output ────────────────────────────────
    dst_dir = os.path.join(cfg.MODELS_DIR, "transformer", output_name)
    if os.path.exists(dst_dir):
        print(f"[klein-9b-checkpoint] Removing existing {dst_dir}...")
        shutil.rmtree(dst_dir)

    # Save to a temp dir, then move the transformer/ subdirectory up
    save_tmp = tempfile.mkdtemp(prefix="klein9b_save_")
    try:
        from mflux.models.common.weights.saving.model_saver import ModelSaver

        # Create a minimal wrapper with .transformer and .bits for ModelSaver
        class _TransformerOnly(nn.Module):
            def __init__(self, transformer, bits):
                super().__init__()
                self.transformer = transformer
                self.bits = bits

        wrapper = _TransformerOnly(model, 8)

        # Minimal weight definition with just the transformer
        from mflux.models.common.weights.loading.weight_definition import ComponentDefinition
        class _TransformerOnlyDef:
            @staticmethod
            def get_components():
                return [ComponentDefinition(
                    name="transformer",
                    hf_subdir="transformer",
                    precision=None,
                    mapping_getter=None,  # weights are already in MLX format
                )]
            @staticmethod
            def get_tokenizers():
                return []
            @staticmethod
            def quantization_predicate(path, module):
                return hasattr(module, "to_quantized")

        ModelSaver.save_model(
            model=wrapper,
            bits=8,
            base_path=save_tmp,
            weight_definition=_TransformerOnlyDef,
        )

        # Move transformer/ contents to dst_dir
        src_transformer = os.path.join(save_tmp, "transformer")
        shutil.move(src_transformer, dst_dir)

    finally:
        shutil.rmtree(save_tmp, ignore_errors=True)

    total_size = sum(
        os.path.getsize(os.path.join(dp, f))
        for dp, _, fns in os.walk(dst_dir)
        for f in fns
    ) / (1024 * 1024)
    print(f"[klein-9b-checkpoint] Transformer saved: {total_size:.0f} MB")

    # Write config.json
    klein_config = {
        "_class_name": "Flux2Transformer2DModel",
        "_diffusers_version": "0.37.0.dev0",
        "attention_head_dim": 128,
        "axes_dims_rope": [32, 32, 32, 32],
        "eps": 1e-06,
        "guidance_embeds": False,
        "in_channels": 128,
        "joint_attention_dim": 12288,
        "mlp_ratio": 3.0,
        "num_attention_heads": 32,
        "num_layers": 8,
        "num_single_layers": 24,
        "out_channels": None,
        "patch_size": 1,
        "rope_theta": 2000,
        "timestep_guidance_channels": 256,
    }
    with open(os.path.join(dst_dir, "config.json"), "w") as f:
        json.dump(klein_config, f, indent=2)

    print(f"[klein-9b-checkpoint] Done. Saved to {dst_dir}")
    print(f"[klein-9b-checkpoint] Next: add manifest.json + README.md, then run check-manifests")
    return True


def convert_ltx_checkpoint(checkpoint_path: str, output_name: str = "ltx-2.3-dasiwa-golden-lace-v3-q8"):
    """Convert a third-party LTX-2.3 transformer checkpoint (Civitai .safetensors) to MLX int8.

    Produces the same on-disk format as models/transformer/ltx-2.3-dev-q8/
    (keys prefixed ``transformer.``, transformer_blocks linears int8-quantized
    with group_size=64, everything else bf16) so it drops into the existing
    LTX-2.3 pipeline as an alternative transformer.

    Much simpler than the Klein checkpoint converter because LTX-2.3 uses
    separate to_q/to_k/to_v projections (no fused QKV to split) and the MLX
    model keys are reached by pure string substitution from the ComfyUI names.
    The key remap reuses the vendor's parity-tested
    ``LTXV_LORA_COMFY_RENAMING_MAP`` (ltx_core_mlx.loader.sd_ops).

    Source may be a full ComfyUI export (transformer + VAE + audio + vocoder) —
    only the ``model.diffusion_model.*`` transformer keys are extracted. FP8
    linears (ComfyUI ``float8_e4m3fn`` per-tensor: weight + ``weight_scale``
    scalar + ``comfy_quant`` JSON) are dequantized as ``weight.float() * scale``;
    BF16/F32 tensors pass through. Everything is stored as bf16 before MLX
    int8 quantization.

    Usage:
        convert.py --ltx-checkpoint DasiwaLTX23_goldenLaceV3.safetensors
        convert.py --ltx-checkpoint ckpt.safetensors --name my-ltx-variant-q8
    """
    import safetensors
    from mlx.utils import tree_flatten

    # Make vendored packages importable and apply runtime patches (mirrors
    # ltx_pipeline.py — vendor_patches needs mflux on path before import).
    _app_dir = os.path.dirname(os.path.abspath(__file__))
    _vendor = os.path.join(_app_dir, "vendor")
    for _pkg in (
        "ltx-2-mlx/packages/ltx-core-mlx/src",
        "ltx-2-mlx/packages/ltx-pipelines-mlx/src",
        "mflux/src",
    ):
        _src = os.path.join(_vendor, _pkg)
        if os.path.isdir(_src) and _src not in sys.path:
            sys.path.insert(0, _src)
    import app.vendor_patches  # noqa: F401
    from ltx_core_mlx.loader.sd_ops import LTXV_LORA_COMFY_RENAMING_MAP
    from ltx_core_mlx.model.transformer.model import LTXModel, LTXModelConfig

    checkpoint_path = os.path.abspath(checkpoint_path)
    if not os.path.exists(checkpoint_path):
        print(f"[ltx-checkpoint] ERROR: file not found: {checkpoint_path}", file=sys.stderr)
        return False

    dst_dir = os.path.join(cfg.MODELS_DIR, "transformer", output_name)

    # Instantiate the target model once — its parameter tree defines which
    # source keys to keep. This drops ComfyUI's bundled connector weights
    # (audio/video_embeddings_connector.*) and any non-transformer tensors,
    # which are separate components in the MLX app.
    print("[ltx-checkpoint] Initializing LTXModel (48L, 4096/2048)…")
    model = LTXModel(LTXModelConfig())  # defaults match LTX-2.3 22B
    model_keys = set(dict(tree_flatten(model.parameters())).keys())
    print(f"[ltx-checkpoint] Model expects {len(model_keys)} parameters")

    # ── Step 1: stream source, remap ComfyUI→MLX keys, dequant → bf16 MLX ──
    # The DaSiWa checkpoint is the FULL model (transformer + vae + audio_vae +
    # vocoder + text_embedding_projection); keep only the transformer
    # (model.diffusion_model.*) AND only keys present in the LTXModel tree.
    # ComfyUI FP8 stores each quantized linear as <key>.weight (float8_e4m3fn)
    # + <key>.weight_scale (per-tensor scalar) + <key>.comfy_quant (JSON blob).
    # Dequant = weight.float() * scale.
    remap = LTXV_LORA_COMFY_RENAMING_MAP
    mlx_weights: list = []
    dropped_extra = 0
    _FP8 = (torch.float8_e4m3fn, torch.float8_e5m2)
    print(f"[ltx-checkpoint] Streaming {os.path.basename(checkpoint_path)} "
          f"(~29GB, requires ~40GB free RAM)…")
    with safetensors.safe_open(checkpoint_path, framework="pt") as f:
        all_keys = set(f.keys())
        for src_key in tqdm(list(f.keys()), desc="[ltx-checkpoint] remap+dequant"):
            if not src_key.startswith("model.diffusion_model."):
                continue  # skip vae/audio_vae/vocoder/text_embedding_projection
            if src_key.endswith(".comfy_quant") or src_key.endswith(".weight_scale"):
                continue  # ComfyUI FP8 metadata siblings, not model params
            new_key = remap.apply_to_key(src_key.removeprefix("model.diffusion_model."))
            if new_key is None or new_key not in model_keys:
                dropped_extra += 1  # connector weights, etc. — separate component
                continue
            tensor = f.get_tensor(src_key)
            if not isinstance(tensor, torch.Tensor):
                continue
            if tensor.dtype in _FP8:
                scale_key = src_key + "_scale"
                if scale_key in all_keys:
                    scale = f.get_tensor(scale_key)
                    tensor = (tensor.to(torch.float32) * scale).to(torch.bfloat16)
                else:
                    print(f"[ltx-checkpoint] WARNING: FP8 tensor {src_key} has no "
                          f"scale sibling; using raw fp8 values")
                    tensor = tensor.to(torch.float32)
            arr = mx.array(tensor.detach().cpu().float().numpy()).astype(mx.bfloat16)
            mlx_weights.append((new_key, arr))
    print(f"[ltx-checkpoint] Kept {len(mlx_weights)} tensors "
          f"(dropped {dropped_extra} non-model keys: connector / FP8 metadata)")

    # ── Step 2: completeness check (key parity) ───────────────────────────
    mapped_keys = {k for k, _ in mlx_weights}
    missing = model_keys - mapped_keys  # model needs, source lacks
    if missing:
        print(f"[ltx-checkpoint] WARNING: {len(missing)} model keys missing from source "
              f"(sample: {sorted(missing)[:5]}) — generation may be wrong")
    else:
        print(f"[ltx-checkpoint] Key parity OK ({len(model_keys)}/{len(model_keys)} "
              f"keys present)")

    # ── Step 3: load weights + quantize transformer_blocks linears ────────
    print("[ltx-checkpoint] Loading weights into LTXModel…")
    model.load_weights(mlx_weights, strict=False)
    del mlx_weights
    gc.collect()
    mx.eval(model.parameters())

    print("[ltx-checkpoint] Quantizing transformer_blocks linears to int8 (group_size=64)…")
    nn.quantize(
        model,
        group_size=64,
        bits=8,
        class_predicate=lambda path, mod: isinstance(mod, nn.Linear) and "transformer_blocks" in path,
    )
    mx.eval(model.parameters())

    # ── Step 4: save with `transformer.` prefix (matches transformer-dev.safetensors)
    if os.path.exists(dst_dir):
        print(f"[ltx-checkpoint] Removing existing {dst_dir}…")
        shutil.rmtree(dst_dir)
    os.makedirs(dst_dir, exist_ok=True)

    save_tmp = tempfile.mkdtemp(prefix="ltx_save_")
    try:
        flat = {f"transformer.{k}": v for k, v in tree_flatten(model.parameters())}
        del model
        gc.collect()
        # Named transformer-dev.safetensors because DaSiWa is a dev-architecture
        # finetune and the two-stage pipelines resolve the transformer by that
        # slot name. The directory name (ltx-2.3-dasiwa-…-q8) identifies it.
        out_file = os.path.join(save_tmp, "transformer-dev.safetensors")
        print(f"[ltx-checkpoint] Saving {len(flat)} tensors to transformer-dev.safetensors…")
        mx.save_safetensors(out_file, flat)
        del flat
        gc.collect()
        shutil.move(out_file, os.path.join(dst_dir, "transformer-dev.safetensors"))

        # Copy quantize_config.json + split_model.json verbatim from the dev dir
        # (same quantization scheme + same component layout).
        for aux in ("quantize_config.json", "split_model.json"):
            src_aux = os.path.join(cfg.LTX_TRANSFORMER_DIR, aux)
            if os.path.exists(src_aux):
                shutil.copy2(src_aux, os.path.join(dst_dir, aux))

        # config.json — corrected audio dims (2048/32/64), see
        # text_encoder/ltx-2.3-connector/embedded_config.json (the dev dir's
        # config.json has stale 1536/16 audio dims).
        ltx_config = {
            "_comment": "Architecture config created by mlx-movie-director (not from HuggingFace). Safe to edit. Used by MLX model loading code.",
            "model_type": "ltx-transformer",
            "num_layers": 48,
            "video_dim": 4096,
            "video_num_heads": 32,
            "video_head_dim": 128,
            "audio_dim": 2048,
            "audio_num_heads": 32,
            "audio_head_dim": 64,
            "quantization": "int8",
        }
        with open(os.path.join(dst_dir, "config.json"), "w") as fp:
            json.dump(ltx_config, fp, indent=2)

        # manifest.json + README.md (auto-generated so check-model passes
        # without manual edits). Schema mirrors models/transformer/ltx-2.3-dev-q8.
        weight_path = os.path.join(dst_dir, "transformer-dev.safetensors")
        size_bytes = os.path.getsize(weight_path)
        from datetime import datetime, timezone
        manifest = {
            "_comment": "Private metadata for mlx-movie-director model registry. Created by convert.py --ltx-checkpoint. Validated by `run.py check-manifests`. See docs/models.md for schema docs.",
            "name": output_name,
            "type": "transformer",
            "arch": "ltx-2.3",
            "format": "mlx-int8",
            "description": (f"DaSiWa LTX-2.3 finetune, int8 MLX. Converted from "
                           f"{os.path.basename(checkpoint_path)} via convert.py --ltx-checkpoint."),
            "source": "civitai:2543443@2967331",
            "weight_file": "transformer-dev.safetensors",
            "pipeline": ["ltx-2.3"],
            "compatible_with": [
                "text_encoder/ltx-2.3-connector",
                "vae/ltx-2.3-vae",
                "lora/ltx-2.3-distilled",
                "audio/ltx-2.3-audio",
            ],
            "size_bytes": size_bytes,
            "created_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT00:00:00Z"),
        }
        with open(os.path.join(dst_dir, "manifest.json"), "w") as fp:
            json.dump(manifest, fp, indent=2)
        with open(os.path.join(dst_dir, "README.md"), "w") as fp:
            fp.write(
                f"# {output_name}\n\n"
                f"DaSiWa LTX-2.3 'Golden Lace v3' transformer, MLX int8.\n\n"
                f"- **Source**: Civitai [2543443/2967331](https://civitai.com/models/2543443) "
                f"(baseModel LTXV 2.3, FP8/BF16 safetensors)\n"
                f"- **Converted**: `convert.py --ltx-checkpoint {os.path.basename(checkpoint_path)}`\n"
                f"- **Weight file**: `transformer-dev.safetensors` "
                f"(named for the dev-architecture slot; this dir IS the DaSiWa finetune)\n"
                f"- **Size**: {size_bytes / 1e9:.1f} GB\n"
                f"- **Quantization**: int8, group_size=64, transformer_blocks linears only\n\n"
                f"Use via `run.py video generate --transformer dasiwa`.\n"
            )
    finally:
        shutil.rmtree(save_tmp, ignore_errors=True)

    total_mb = os.path.getsize(os.path.join(dst_dir, "transformer-dev.safetensors")) / (1024 * 1024)
    print(f"[ltx-checkpoint] Done. Saved {total_mb:.0f} MB to {dst_dir}")
    print(f"[ltx-checkpoint] Next: run scripts/setup_ltx_symlinks.py --force, then run.py check-model")
    return True


def convert_zit_checkpoint(checkpoint_path: str, output_name: str = "ernie-redmix-redzit15"):
    """Convert a third-party ZImage Turbo checkpoint (Civitai .safetensors) to 4-bit MLX.

    Handles ComfyUI-format safetensors (FP8 or BF16) by reusing the existing
    key remapping (_remap_qkv, _remap_keys, _map_key_and_convert) and 4-bit
    quantization pipeline — identical to the built-in convert_transformer().

    Usage:
        convert.py --zit-checkpoint /path/to/redzit15.safetensors
        convert.py --zit-checkpoint checkpoint.safetensors --name my-zit-variant
    """
    checkpoint_path = os.path.abspath(checkpoint_path)
    if not os.path.exists(checkpoint_path):
        print(f"[zit-checkpoint] ERROR: file not found: {checkpoint_path}", file=sys.stderr)
        return False

    dst_dir = os.path.join(cfg.MODELS_DIR, "transformer", output_name)

    # ── Step 1: Load checkpoint ────────────────────────────────────
    print(f"[zit-checkpoint] Loading {os.path.basename(checkpoint_path)}...")
    print(f"[zit-checkpoint] (Requires ~12 GB RAM for BF16 -> 4-bit)")
    pt_weights = load_pt_file(checkpoint_path)
    print(f"[zit-checkpoint] Loaded {len(pt_weights)} tensors")

    # ── Step 2: Dequantize FP8 -> BF16 if needed ──────────────────
    _FP8 = (torch.float8_e4m3fn, torch.float8_e5m2)
    for k in list(pt_weights.keys()):
        t = pt_weights[k]
        if isinstance(t, torch.Tensor):
            if t.dtype in _FP8:
                pt_weights[k] = t.to(torch.bfloat16)
            elif t.dtype in (torch.float16, torch.float32):
                pt_weights[k] = t.to(torch.bfloat16)

    # ── Step 3: Drop unused key ───────────────────────────────────
    if "model.diffusion_model.norm_final.weight" in pt_weights:
        del pt_weights["model.diffusion_model.norm_final.weight"]

    # ── Step 4: Remap ComfyUI keys ─────────────────────────────────
    print("[zit-checkpoint] Remapping ComfyUI keys...")
    keys = list(pt_weights.keys())
    for k in tqdm(keys):
        if ".qkv." in k:
            _remap_qkv(k, pt_weights)
        else:
            _remap_keys(k, pt_weights)

    # ── Step 5: Convert to MLX BF16 ────────────────────────────────
    print("[zit-checkpoint] Converting to MLX BF16...")
    mlx_weights = [_map_key_and_convert(k, v) for k, v in tqdm(pt_weights.items())]
    del pt_weights
    gc.collect()

    # ── Step 6: Initialize model and load weights ──────────────────
    print("[zit-checkpoint] Initializing model and loading weights...")
    model = ZImageTransformerMLX(cfg.TRANSFORMER_CONFIG)
    model.load_weights(mlx_weights)
    del mlx_weights
    mx.eval(model.parameters())

    # ── Step 7: Quantize to 4-bit (group_size=32) ──────────────────
    print("[zit-checkpoint] Quantizing to 4-bit (group_size=32)...")
    nn.quantize(model, bits=4, group_size=32)

    # ── Step 8: Save output ────────────────────────────────────────
    if os.path.exists(dst_dir):
        print(f"[zit-checkpoint] Removing existing {dst_dir}...")
        shutil.rmtree(dst_dir)
    os.makedirs(dst_dir, exist_ok=True)

    out_weights = os.path.join(dst_dir, "model.safetensors")
    out_config = os.path.join(dst_dir, "config.json")

    print(f"[zit-checkpoint] Saving to {dst_dir}...")
    model.save_weights(out_weights)
    with open(out_config, "w") as f:
        json.dump(cfg.TRANSFORMER_CONFIG, f, indent=2)
    del model
    gc.collect()

    # ── Step 9: Auto-generate manifest.json ────────────────────────
    weight_size = os.path.getsize(out_weights)
    from datetime import datetime, timezone
    manifest = {
        "_comment": ("Private metadata for mlx-movie-director model registry. "
                     "Created by convert.py --zit-checkpoint. Validated by "
                     "`run.py check-manifests`. See docs/models.md for schema docs."),
        "name": output_name,
        "type": "transformer",
        "arch": "zimage-turbo",
        "format": "mlx-4bit-gs32",
        "description": (
            f"ZImage Turbo finetune, 4-bit MLX. Converted from "
            f"{os.path.basename(checkpoint_path)} via convert.py --zit-checkpoint."
        ),
        "source": "civitai.com/models/958009",
        "source_url": "https://civitai.com/models/958009?modelVersionId=2462789",
        "weight_file": "model.safetensors",
        "pipeline": ["zimage-turbo"],
        "compatible_with": [
            "text_encoder/qwen3-4b",
            "tokenizer/qwen3",
            "vae/flux-ae",
        ],
        "size_bytes": weight_size,
        "created_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT00:00:00Z"),
    }
    with open(os.path.join(dst_dir, "manifest.json"), "w") as fp:
        json.dump(manifest, fp, indent=2)

    # ── Step 10: Auto-generate README.md ───────────────────────────
    size_gb = weight_size / 1e9
    readme = (
        f"# {output_name}\n\n"
        f"ZImage Turbo finetune, 4-bit MLX.\n\n"
        f"- **Source**: CivitAI [958009/2462789]"
        f"(https://civitai.com/models/958009?modelVersionId=2462789) "
        f"(baseModel ZImageTurbo)\n"
        f"- **Converted**: `convert.py --zit-checkpoint "
        f"{os.path.basename(checkpoint_path)}`\n"
        f"- **Size**: {size_gb:.1f} GB\n"
        f"- **Quantization**: 4-bit, group_size=32\n"
        f"- **Sampler**: EULER/DEIS | Simple | CFG=1 | 10 Steps\n\n"
        f"Shares text encoder (qwen3-4b), tokenizer (qwen3), "
        f"and VAE (flux-ae) with the built-in ZImage models.\n"
    )
    with open(os.path.join(dst_dir, "README.md"), "w") as fp:
        fp.write(readme)

    total_mb = weight_size / (1024 * 1024)
    print(f"[zit-checkpoint] Done. Saved {total_mb:.0f} MB to {dst_dir}")
    return True


def convert_ltx_connector() -> bool:
    """Convert LTX-2.3 connector from BF16 safetensors to 4-bit MLX (group_size=32).

    The connector bridges Gemma-3-12B text embeddings to the LTX-2.3 transformer.
    Architecture: TextEncoderConnector with 3 sub-modules:
      - text_embedding_projection: 2 Linear layers (188160->4096, 188160->2048)
      - video_embeddings_connector: 8 transformer blocks, 7 Linear each (56 total)
      - audio_embeddings_connector: 8 transformer blocks, 7 Linear each (56 total)
    Total: 114 Linear layers, all quantizable (every in_features divisible by 64).

    Saves quantized weights back as ``connector.safetensors`` (overwrite) so the
    existing pipeline loading code (``load_split_safetensors(prefix='connector.')``)
    works unchanged. The original BF16 file is backed up to
    ``connector.safetensors.bf16.bak``.
    """
    src = os.path.join(cfg.LTX_TEXT_ENCODER_DIR, "connector.safetensors")
    dst_dir = cfg.LTX_TEXT_ENCODER_DIR

    if not os.path.exists(src):
        print(f"[ltx-connector] ERROR: Source not found: {src}")
        print(f"[ltx-connector] Run downloader first: convert.py --ltx-download or setup LTX manually")
        return False

    # Ensure vendor sub-packages are importable
    _vendor_base = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "vendor", "ltx-2-mlx")
    for _pkg in ("packages/ltx-core-mlx",):
        _src = os.path.join(_vendor_base, _pkg, "src")
        if os.path.isdir(_src) and _src not in sys.path:
            sys.path.insert(0, _src)

    try:
        from ltx_core_mlx.text_encoders.gemma.feature_extractor import TextEncoderConnector
        from ltx_core_mlx.utils.weights import load_split_safetensors
    except ImportError as e:
        print(f"[ltx-connector] ERROR: Failed to import vendor module: {e}")
        print(f"[ltx-connector] Ensure vendor/ltx-2-mlx/packages/ltx-core-mlx/src/ is intact")
        return False

    # ── Step 1: Build connector with correct arch config ────────────────
    # From embedded_config.json: connector_num_layers=8, num_heads=32,
    # head_dim=128, num_registers=128, caption_channels=3840 (Gemma 3 12B).
    connector = TextEncoderConnector(
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

    # ── Step 2: Load BF16 weights ───────────────────────────────────────
    # Source keys: connector.text_embedding_projection.video_aggregate_embed.weight, ...
    # load_split_safetensors strips the "connector." prefix, giving keys that
    # match the TextEncoderConnector parameter tree directly.
    print(f"[ltx-connector] Loading {os.path.basename(src)} (~6.3 GB)...")
    weights = load_split_safetensors(src, prefix="connector.")
    print(f"[ltx-connector] Loaded {len(weights)} tensors")

    connector.load_weights(list(weights.items()))
    del weights
    gc.collect()
    mx.eval(connector.parameters())

    # ── Step 3: Quantize to 4-bit GS32 ──────────────────────────────────
    print("[ltx-connector] Quantizing to 4-bit (group_size=32)...")
    nn.quantize(connector, bits=4, group_size=32)
    mx.eval(connector.parameters())

    # ── Step 4: Backup original BF16 file ───────────────────────────────
    backup = src + ".bf16.bak"
    if not os.path.exists(backup):
        print(f"[ltx-connector] Backing up original BF16 weights...")
        shutil.copy2(src, backup)
    else:
        print(f"[ltx-connector] Backup already exists at {os.path.basename(backup)}, skipping")

    # ── Step 5: Save quantized weights (with connector. prefix) ─────────
    # The loading code does load_split_safetensors(path, prefix="connector."),
    # which strips "connector." from keys. We must save WITH the prefix so
    # the stripping works correctly.
    flat = {f"connector.{k}": v for k, v in tree_flatten(connector.parameters())}
    del connector
    gc.collect()

    print(f"[ltx-connector] Saving {len(flat)} tensors to connector.safetensors...")
    mx.save_safetensors(src, flat)
    del flat
    gc.collect()

    old_mb = os.path.getsize(backup) / (1024 * 1024)
    new_mb = os.path.getsize(src) / (1024 * 1024)
    print(f"[ltx-connector] Done. {old_mb:.0f} MB (BF16) -> {new_mb:.0f} MB (4-bit)")
    return True


def convert_ultraflux_vae_to_mlx() -> bool:
    """Convert UltraFlux VAE from PyTorch FP32 to MLX BF16.

    Same architecture as flux-ae (AutoencoderKL), same conversion pipeline.
    Uses the mflux ZImageWeightMapping for key remapping and Conv2d transpose.
    Saves to models/vae/ultraflux-ae/model.safetensors.
    """
    _mflux_src = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                              "vendor", "mflux", "src")
    if os.path.isdir(_mflux_src) and _mflux_src not in sys.path:
        sys.path.insert(0, _mflux_src)

    from mflux.models.z_image.model.z_image_vae import VAE as ZImageVAE
    from mflux.models.z_image.weights.z_image_weight_mapping import ZImageWeightMapping
    from mflux.models.common.weights.mapping.weight_transforms import WeightTransforms
    from mlx.utils import tree_flatten

    vae_dir = cfg.ULTRAFLUX_VAE_DIR
    src = os.path.join(vae_dir, "diffusion_pytorch_model.safetensors")
    if not os.path.exists(src):
        print(f"[ultraflux-vae] ERROR: PyTorch VAE not found: {src}")
        return False

    # 1. Load PyTorch weights
    print(f"[ultraflux-vae] Loading {os.path.basename(src)} (~335 MB)...")
    pt_weights = load_pt_file(src)

    # 2. Build key mapping from mflux ZImageWeightMapping
    mappings = ZImageWeightMapping.get_vae_mapping()

    def _expand_pattern(pattern, expansion_ranges):
        import re
        placeholders = re.findall(r'\{(\w+)\}', pattern)
        if not placeholders:
            return [pattern]
        results = [pattern]
        for ph in placeholders:
            new_results = []
            for r in results:
                for val in expansion_ranges.get(ph, [0]):
                    new_results.append(r.replace(f'{{{ph}}}', str(val)))
            results = new_results
        return results

    expansion_ranges = {'block': [0, 1, 2, 3], 'res': [0, 1], 'i': [0, 1]}
    decoder_expansion = dict(expansion_ranges, res=[0, 1, 2])

    key_map = {}
    for m in mappings:
        to_pat = m.to_pattern
        for from_pat in m.from_pattern:
            is_decoder_upblock = 'decoder.up_blocks.{block}' in from_pat
            exp = decoder_expansion if is_decoder_upblock else expansion_ranges
            for fk, tk in zip(_expand_pattern(from_pat, exp), _expand_pattern(to_pat, exp)):
                key_map[fk] = (tk, m.transform)

    # 3. Convert weights
    print("[ultraflux-vae] Converting weights (transposing Conv2d)...")
    mlx_weights = {}
    for k, v in tqdm(pt_weights.items()):
        if k not in key_map:
            continue
        new_key, transform = key_map[k]
        val_np = v.detach().cpu().float().numpy() if isinstance(v, torch.Tensor) else v
        arr = mx.array(val_np).astype(mx.bfloat16)
        if transform is not None:
            arr = transform(arr)
        mlx_weights[new_key] = arr

    del pt_weights
    gc.collect()
    print(f"[ultraflux-vae] Mapped {len(mlx_weights)} weights")

    # 4. Initialize MLX VAE and load weights
    print("[ultraflux-vae] Initializing MLX VAE...")
    vae = ZImageVAE()
    model_keys = set(dict(tree_flatten(vae.parameters())).keys())
    missing = model_keys - set(mlx_weights.keys())
    if missing:
        print(f"[ultraflux-vae] Warning: {len(missing)} missing keys: {sorted(missing)[:5]}...")

    vae.load_weights(list(mlx_weights.items()))
    del mlx_weights
    mx.eval(vae.parameters())

    # 5. Save
    out_path = os.path.join(vae_dir, "model.safetensors")
    print(f"[ultraflux-vae] Saving to {out_path}...")
    vae.save_weights(out_path)

    size_mb = os.path.getsize(out_path) / (1024 * 1024)
    print(f"[ultraflux-vae] Done. MLX VAE saved: {size_mb:.0f} MB")
    print(f"[ultraflux-vae] Old PyTorch file still at: {os.path.basename(src)}")
    return True


def main() -> None:
    parser = argparse.ArgumentParser(
        description="mlx-movie-director: one-time model conversion and download",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  First time setup (recommended order):
    convert.py --tokenizer --vae
    convert.py --text-encoder
    convert.py --transformer

  SeedVR2 upscale model:
    convert.py --seedvr2-dit
    convert.py --seedvr2-vae

  Flux2 Klein 9B (profile generation):
    convert.py --klein-9b

  Flux2 Klein 9B from third-party checkpoint (Civitai):
    convert.py --klein-9b-checkpoint ~/Downloads/checkpoint.safetensors
    convert.py --klein-9b-checkpoint checkpoint.safetensors --name my-variant

  LTX-2.3 transformer from third-party checkpoint (Civitai DaSiWa, etc.):
    convert.py --ltx-checkpoint DasiwaLTX23_goldenLaceV3.safetensors
    convert.py --ltx-checkpoint ckpt.safetensors --name my-ltx-variant-q8

  Z-Image Turbo from third-party checkpoint (Civitai):
    convert.py --zit-checkpoint ~/Downloads/redzit15.safetensors
    convert.py --zit-checkpoint checkpoint.safetensors --name my-zit-variant

  Or all at once (Z-Image only):
    convert.py --all
        """,
    )
    parser.add_argument("--all", action="store_true", help="Run all conversions and downloads")
    parser.add_argument("--transformer", action="store_true", help="Convert moody transformer (~11GB → ~3GB 4-bit)")
    parser.add_argument("--text-encoder", action="store_true", help="Convert Qwen3-4B text encoder (~7.5GB → ~1.3GB 4-bit)")
    parser.add_argument("--tokenizer", action="store_true", help="Download tokenizer from HuggingFace (~7MB)")
    parser.add_argument("--vae", action="store_true", help="Download VAE from HuggingFace (~160MB)")
    parser.add_argument("--seedvr2-dit", action="store_true", help="Convert SeedVR2 7B DiT (~15GB → ~5GB 4-bit)")
    parser.add_argument("--seedvr2-vae", action="store_true", help="Convert SeedVR2 VAE (~500MB bf16)")
    parser.add_argument("--klein-9b", action="store_true",
                        help="Convert Flux2 Klein 9B from HF cache to pre-quantized INT8 (~32GB BF16 → ~16GB INT8)")
    parser.add_argument("--klein-9b-checkpoint", type=str, metavar="PATH",
                        help="Convert third-party Klein 9B checkpoint (Civitai .safetensors) to MLX INT8")
    parser.add_argument("--ltx-checkpoint", type=str, metavar="PATH",
                        help="Convert third-party LTX-2.3 transformer checkpoint (Civitai .safetensors) "
                             "to MLX int8. Reuses the vendor key-remap; handles FP8/BF16 sources.")
    parser.add_argument("--zit-checkpoint", type=str, metavar="PATH",
                        help="Convert third-party ZImage Turbo checkpoint (Civitai .safetensors) "
                             "to MLX 4-bit (group_size=32). Reuses existing key remapping; "
                             "handles FP8/BF16 sources.")
    parser.add_argument("--name", type=str, default=None,
                        help="Output instance name for --klein-9b-checkpoint / --ltx-checkpoint "
                             "/ --zit-checkpoint "
                             "(defaults: klein-9b-dark-beast-bfs / ltx-2.3-dasiwa-golden-lace-v3-q8 "
                             "/ ernie-redmix-redzit15)")
    parser.add_argument("--vae-mlx", action="store_true",
                        help="Convert flux-ae VAE to MLX BF16 (eliminates PyTorch/diffusers dependency)")
    parser.add_argument("--seedvr2-vae-int8", action="store_true",
                        help="Quantize SeedVR2 VAE from MLX BF16 to INT8 (~478MB → ~240MB)")
    parser.add_argument("--ltx-connector", action="store_true",
                        help="Convert LTX-2.3 connector from BF16 to 4-bit MLX (~6.3GB → ~1.6GB)")
    parser.add_argument("--ultraflux-vae", action="store_true",
                        help="Convert UltraFlux VAE from PyTorch FP32 to MLX BF16 (~335MB → ~168MB)")
    args = parser.parse_args()

    if not any(vars(args).values()):
        parser.print_help()
        return

    if args.all or args.tokenizer:
        download_tokenizer()
    if args.all or args.vae:
        download_vae()
    if args.all or args.text_encoder:
        convert_text_encoder()
    if args.all or args.transformer:
        convert_transformer()
    if args.seedvr2_dit:
        convert_seedvr2_dit()
    if args.seedvr2_vae:
        convert_seedvr2_vae()
    if args.klein_9b:
        convert_klein_9b()
    if args.klein_9b_checkpoint:
        convert_klein_9b_checkpoint(args.klein_9b_checkpoint, args.name or "klein-9b-dark-beast-bfs")
    if args.ltx_checkpoint:
        convert_ltx_checkpoint(args.ltx_checkpoint, args.name or "ltx-2.3-dasiwa-golden-lace-v3-q8")
    if args.zit_checkpoint:
        convert_zit_checkpoint(args.zit_checkpoint, args.name or "ernie-redmix-redzit15")
    if args.vae_mlx:
        convert_vae_to_mlx()
    if args.seedvr2_vae_int8:
        quantize_seedvr2_vae_int8()
    if args.ltx_connector:
        convert_ltx_connector()
    if args.ultraflux_vae:
        convert_ultraflux_vae_to_mlx()


if __name__ == "__main__":
    main()
