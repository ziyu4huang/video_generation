#!/usr/bin/env python3
"""One-time model conversion CLI for mlx-movie-director.

Usage:
    ./python/venv/bin/python python/mlx-movie-director/convert.py --all
    ./python/venv/bin/python python/mlx-movie-director/convert.py --transformer
    ./python/venv/bin/python python/mlx-movie-director/convert.py --text-encoder
    ./python/venv/bin/python python/mlx-movie-director/convert.py --tokenizer
    ./python/venv/bin/python python/mlx-movie-director/convert.py --vae
"""

import sys
import os
import json
import argparse
import gc

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import torch
import numpy as np
import mlx.core as mx
import mlx.nn as nn
from safetensors.torch import load_file as load_pt_file
from tqdm import tqdm

from mlx import nn as _nn
from mlx.utils import tree_flatten

from app.transformer import ZImageTransformerMLX
from app.text_encoder import TextEncoderMLX
from app.seedvr2.transformer import SeedVR2Transformer
from app.seedvr2.vae import SeedVR2VAE
from app.seedvr2.weight_mapping import get_transformer_remapping, get_conv3d_weight_keys
from app import config as cfg


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

def convert_transformer():
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


def convert_text_encoder():
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


def convert_seedvr2_dit():
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


def convert_seedvr2_vae():
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


def main():
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

  Or all at once:
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


if __name__ == "__main__":
    main()
