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

from app.transformer import ZImageTransformerMLX
from app.text_encoder import TextEncoderMLX
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

  Or all at once:
    convert.py --all
        """,
    )
    parser.add_argument("--all", action="store_true", help="Run all conversions and downloads")
    parser.add_argument("--transformer", action="store_true", help="Convert moody transformer (~11GB → ~3GB 4-bit)")
    parser.add_argument("--text-encoder", action="store_true", help="Convert Qwen3-4B text encoder (~7.5GB → ~1.3GB 4-bit)")
    parser.add_argument("--tokenizer", action="store_true", help="Download tokenizer from HuggingFace (~7MB)")
    parser.add_argument("--vae", action="store_true", help="Download VAE from HuggingFace (~160MB)")
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


if __name__ == "__main__":
    main()
