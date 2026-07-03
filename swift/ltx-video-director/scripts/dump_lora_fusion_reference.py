"""Dump LoRA fusion reference for Swift parity testing.

Uses the REAL vendor pipeline pieces this package's LoRAWeights/LoRAFusion
port against: `ltx_core_mlx.loader.sd_ops.LTXV_LORA_COMFY_RENAMING_MAP`
(key remap) and `ltx_core_mlx.loader.fuse_loras.apply_loras`/`_prepare_deltas`
(delta = strength * B @ A, summed across multiple LoRAs). The int8 dequant
step (`int8_value * scale`) is NOT part of the vendor's stock fuse_loras.py
— it's `app/vendor_patches.py`'s `_patch_int8_lora` (Patch 10), reproduced
inline here since importing the full app package requires its whole
dependency tree (same convention as dump_hannsincresampler_reference.py's
inlined `_patch_upsample1d`).

Uses the REAL production distilled LoRA
(mlx-models/lora/ltx-2.3-distilled/ltx-2.3-22b-distilled-lora-384-1.1.int8.safetensors)
as the ONLY real LTX LoRA file present in mlx-models (confirmed by
inventory — every other *.int8.safetensors under mlx-models/lora/ is
either this same file under a different transformer-variant directory, or
a z-image/Klein9B image LoRA, not an LTX one). To exercise multi-LoRA
summing without a second real style LoRA, this same file is fused TWICE
at different strengths (1.0 and 0.6) — `_prepare_deltas` sums per-source
contributions regardless of whether the sources are the same file, so
this is a faithful test of the actual summing code path.

Run from repo root:
    python/venv/bin/python swift/ltx-video-director/scripts/dump_lora_fusion_reference.py
"""
import json
import os
import sys

import mlx.core as mx

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
VENDORED = os.path.join(REPO_ROOT, "python/mlx-movie-director/vendor/ltx-2-mlx/packages/ltx-core-mlx/src")
SIBLING = os.path.expanduser("~/proj/ltx-2-mlx/packages/ltx-core-mlx/src")
sys.path.insert(0, VENDORED if os.path.isdir(VENDORED) else SIBLING)

from ltx_core_mlx.loader.sd_ops import LTXV_LORA_COMFY_RENAMING_MAP  # noqa: E402
from ltx_core_mlx.loader.fuse_loras import apply_loras  # noqa: E402
from ltx_core_mlx.loader.primitives import LoraStateDictWithStrength, StateDict  # noqa: E402

LORA_PATH = os.path.join(
    REPO_ROOT, "mlx-models/lora/ltx-2.3-distilled/ltx-2.3-22b-distilled-lora-384-1.1.int8.safetensors")

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "test_refs", "lora_fusion")
os.makedirs(OUT_DIR, exist_ok=True)


def dequantize_int8_lora(raw: dict) -> dict:
    """int8 * scale -> float32. Mirrors app/vendor_patches.py's _patch_int8_lora."""
    scale_keys = {k for k in raw if k.endswith(".scale")}
    if not scale_keys:
        return {k: v.astype(mx.float32) for k, v in raw.items()}
    out = {}
    for k, v in raw.items():
        if k.endswith(".scale"):
            continue
        sk = f"{k}.scale"
        if sk in scale_keys:
            out[k] = (v.astype(mx.float32) * raw[sk].astype(mx.float32))
        else:
            out[k] = v.astype(mx.float32)
    return out


raw = dict(mx.load(LORA_PATH))
dequantized = dequantize_int8_lora(raw)

remapped: dict[str, mx.array] = {}
for k, v in dequantized.items():
    mk = LTXV_LORA_COMFY_RENAMING_MAP.apply_to_key(k)
    if mk is not None:
        remapped[mk] = v

lora_sd = StateDict(sd=remapped, size=0, dtype=set())

# Representative keys covering every rename rule + a plain (no-rename)
# case, chosen to exercise: to_out.0->to_out, ff.net.0.proj->ff.proj_in,
# ff.net.2->ff.proj_out, audio_ff.* variants, linear_1/2->linear1/2
# (top-level AdaLN), and a plain attn to_q (no rename needed).
KEYS = [
    "transformer_blocks.0.attn1.to_q.weight",
    "transformer_blocks.0.attn1.to_out.weight",
    "transformer_blocks.0.ff.proj_in.weight",
    "transformer_blocks.0.ff.proj_out.weight",
    "transformer_blocks.0.audio_ff.proj_in.weight",
    "transformer_blocks.5.attn2.to_v.weight",
    "adaln_single.linear.weight",
    "adaln_single.emb.timestep_embedder.linear1.weight",
    "audio_patchify_proj.weight",
]

arrays = {}
scalars = {}

mx.random.seed(0)
model_sd_dict = {}
shapes = {}
for key in KEYS:
    a_key = f"{key[:-len('.weight')]}.lora_A.weight"
    b_key = f"{key[:-len('.weight')]}.lora_B.weight"
    assert a_key in remapped, f"missing {a_key} in remapped lora sd (rename map or key list bug)"
    assert b_key in remapped, f"missing {b_key} in remapped lora sd"
    out_features = remapped[b_key].shape[0]
    in_features = remapped[a_key].shape[1]
    shapes[key] = [out_features, in_features]
    w = mx.random.normal((out_features, in_features)) * 0.02
    model_sd_dict[key] = w
    arrays[f"base__{key}"] = w

model_sd = StateDict(sd=model_sd_dict, size=0, dtype=set())

# Single-LoRA fusion (strength 1.0).
single = apply_loras(model_sd, [LoraStateDictWithStrength(lora_sd, 1.0)])
for key in KEYS:
    arrays[f"fused_single__{key}"] = single.sd[key]

# Multi-LoRA fusion: same file applied twice at different strengths
# (1.0 and 0.6) — exercises _prepare_deltas' summing branch for real.
multi = apply_loras(model_sd, [
    LoraStateDictWithStrength(lora_sd, 1.0),
    LoraStateDictWithStrength(lora_sd, 0.6),
])
for key in KEYS:
    arrays[f"fused_multi__{key}"] = multi.sd[key]

scalars["keys"] = KEYS
scalars["shapes"] = shapes
scalars["single_strength"] = 1.0
scalars["multi_strengths"] = [1.0, 0.6]

mx.eval(list(arrays.values()))
mx.save_safetensors(os.path.join(OUT_DIR, "lora_fusion.safetensors"), arrays)
with open(os.path.join(OUT_DIR, "scalars.json"), "w") as f:
    json.dump(scalars, f, indent=2)

print(f"wrote {len(arrays)} arrays + scalars.json to {OUT_DIR}")
