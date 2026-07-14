#!/usr/bin/env python3
"""Generate FLUX.1-Kontext-dev base transformer reference tensors for Swift
port verification (kontext epic phase 2, see
output/next-goal-20260714_063909.md).

Loads the REAL base-FLUX.1-dev transformer (mflux's `Transformer`, used
directly by `flux_kontext.py`'s `Flux1Kontext`) with the REAL HF checkpoint
weights already cached locally (black-forest-labs/FLUX.1-Kontext-dev), runs
ONE forward pass on a fixed small input (no reference-image conditioning —
that is KontextConditioning.swift's job, tested separately), and saves all
inputs + the output for Swift comparison (cos > 0.99).

Deliberately isolated from CLIP/T5: `prompt_embeds`/`pooled_prompt_embeds`
are fixed random tensors, not real text-encoder output — this only verifies
the TRANSFORMER's own math (RoPE, AdaLN, attention, block wiring), which is
this session's flagged risk (see the epic doc's self-reflection section).

Run from repo root:
    python/venv/bin/python python/mlx-movie-director/app/tests/gen_kontext_transformer_ref.py
"""
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(REPO / "python" / "mlx-movie-director" / "vendor" / "mflux" / "src"))
# Fallback: sibling-fork mflux (this repo's actual convention per CLAUDE.md).
sys.path.insert(0, str(REPO.parent / "mflux" / "src"))

import mlx.core as mx
from mlx.utils import tree_unflatten, tree_flatten
from huggingface_hub import snapshot_download

from mflux.models.flux.model.flux_transformer.transformer import Transformer
from mflux.models.common.config.config import Config
from mflux.models.common.config.model_config import ModelConfig

OUT_DIR = REPO / "swift" / "flux2-image-director" / "verify_refs"
OUT_DIR.mkdir(parents=True, exist_ok=True)

MODEL_ID = "black-forest-labs/FLUX.1-Kontext-dev"

# 1. Build the transformer (unquantized — Kontext-dev ships bf16, and
#    KontextTransformer.swift's Linear/RMSNorm are unquantized to match).
model_config = ModelConfig.dev_kontext()
# float32 throughout this reference (see note below at weight-cast site) —
# ModelConfig.precision is a class attribute read by Transformer internals
# (time_text_embed casts, etc.), not just this script's own local casts.
ModelConfig.precision = mx.float32
tf = Transformer(model_config=model_config, num_transformer_blocks=19, num_single_transformer_blocks=38)

# 2. Load the real HF checkpoint. FluxWeightMapping.get_transformer_mapping()
#    is an IDENTITY key mapping for every transformer key (no rename/transform,
#    confirmed by reading flux_weight_mapping.py) — so plain mx.load + update
#    is equivalent to going through mflux's WeightLoader/WeightMapper.
root = Path(snapshot_download(repo_id=MODEL_ID, allow_patterns=["transformer/*.safetensors", "transformer/*.json"]))
tf_dir = root / "transformer"
all_w = {}
for shard in sorted(tf_dir.glob("*.safetensors")):
    if shard.name.startswith("._"):
        continue
    all_w.update(mx.load(str(shard)))
print(f"Loaded {len(all_w)} raw HF transformer weights from {tf_dir}")

# FluxWeightMapping.get_transformer_mapping() is identity for almost every
# key EXCEPT the feed-forward layers, which rename `ff.net.0.proj`->
# `ff.linear1`, `ff.net.2`->`ff.linear2` (same for `ff_context`) — the
# model's own nn.Module attribute names don't match the raw HF checkpoint's
# `nn.Sequential`-style names. An earlier version of this script called
# `tf.update(..., strict=False)` on the RAW keys directly: since
# `ff.net.0.proj.weight` never matches any real parameter path
# (`ff.linear1.weight`), `strict=False` SILENTLY skipped every FF weight in
# all 19+38 blocks, leaving them at random init — the model "loaded" with no
# error but was producing near-garbage FF output. Found 2026-07-14 by
# bisecting per-block cosine similarity down to a single Linear call and
# manually recomputing `x @ W.T + b` in plain mlx, which did NOT match
# `tf.transformer_blocks[0].ff.linear1(x)` either — proving the loaded
# model's own weight, not just the Swift port, was wrong for this key.
import re
renamed_w = {}
for k, v in all_w.items():
    k2 = re.sub(r"\.ff(_context)?\.net\.0\.proj\.", r".ff\1.linear1.", k)
    k2 = re.sub(r"\.ff(_context)?\.net\.2\.", r".ff\1.linear2.", k2)
    renamed_w[k2] = v

# Upcast to float32 for this reference: at t=0 (sigma=1.0, the first
# denoising step) conditioning magnitudes are large enough that bf16
# rounding differences between two INDEPENDENT bf16 implementations (this
# Python one and the Swift port) diverge catastrophically through the FF
# block's nonlinear GELU. float32 isolates algorithm correctness from that
# rounding noise, which is what this reference is actually for. (Real
# production bf16 numerical stability at t=0 is a separate, NOT investigated
# question.)
renamed_w = {k: v.astype(mx.float32) for k, v in renamed_w.items()}
model_keys = {k for k, _ in tree_flatten(tf.parameters())}
missing = model_keys - set(renamed_w.keys())
assert not missing, f"weight loading would leave {len(missing)} params unset: {sorted(missing)[:5]}"
tf.update(tree_unflatten(list(renamed_w.items())), strict=False)
mx.eval(tf.parameters())

# 3. Build deterministic fixed inputs (fixed seed, small dims — matches
#    KontextTransformer.swift's shapeSelfTest: 64x64 "image" -> 16 tokens,
#    8 text tokens).
SEED = 4242
H, W = 64, 64
mx.random.seed(SEED)

# Cast to ModelConfig.precision (bf16) BEFORE the forward pass — matches
# what real CLIP/T5/VAE output actually looks like in production (mflux
# casts prompt/pooled embeds and VAE latents to bf16 upstream of the
# transformer). Feeding raw float32 here (as an earlier version of this
# script did) silently forces most of the network into float32 activations
# via MLX's mixed-dtype promotion — a real correctness difference Swift
# can't cheaply replicate (bf16-weight-only) and shouldn't have to: it's not
# what the real pipeline does.
hidden_states = mx.random.normal(shape=(1, 16, 64), key=mx.random.key(SEED)).astype(model_config.precision)
prompt_embeds = mx.random.normal(shape=(1, 8, 4096), key=mx.random.key(SEED + 1)).astype(model_config.precision)
pooled_prompt_embeds = mx.random.normal(shape=(1, 768), key=mx.random.key(SEED + 2)).astype(model_config.precision)
mx.eval(hidden_states, prompt_embeds, pooled_prompt_embeds)
print(f"hidden_states: {hidden_states.shape}, prompt_embeds: {prompt_embeds.shape}, "
      f"pooled_prompt_embeds: {pooled_prompt_embeds.shape}")

# 4. Config + real forward pass. t=0 (first scheduler step), no reference
#    image (kontext_image_ids=None) — isolates the base transformer.
config = Config(model_config=model_config, num_inference_steps=20, height=H, width=W, guidance=2.5)
t = 0
timestep_value = config.scheduler.sigmas[t] * config.num_train_steps
guidance_value = config.guidance * config.num_train_steps
print(f"t={t}  sigma={config.scheduler.sigmas[t]}  timestep_value={timestep_value}  "
      f"guidance_value={guidance_value}")

out = tf(
    t=t,
    config=config,
    hidden_states=hidden_states,
    prompt_embeds=prompt_embeds,
    pooled_prompt_embeds=pooled_prompt_embeds,
    kontext_image_ids=None,
)
mx.eval(out)
print(f"output: {out.shape}, dtype: {out.dtype}")

# 4b. Manual step-by-step replication to capture intermediates for
#     bisecting a parity mismatch (mirrors Transformer.__call__ exactly).
_inter = {}
_hs = tf.x_embedder(hidden_states)
_ehs = tf.context_embedder(prompt_embeds)
_inter["hidden_post_embed"] = _hs
_inter["enc_post_embed"] = _ehs
_temb = Transformer.compute_text_embeddings(t, pooled_prompt_embeds, tf.time_text_embed, config)
_inter["temb"] = _temb
_rope = Transformer.compute_rotary_embeddings(prompt_embeds, tf.pos_embed, config, None)
_inter["rope_c0"] = _rope[..., 0]
# Bisect block 0 internals (attn output BEFORE AdaLN-gated FF residual).
_b0 = tf.transformer_blocks[0]
_nh, _gate_msa, _shift_mlp, _scale_mlp, _gate_mlp = _b0.norm1(hidden_states=_hs, text_embeddings=_temb)
_neh, _cgate_msa, _cshift_mlp, _cscale_mlp, _cgate_mlp = _b0.norm1_context(hidden_states=_ehs, text_embeddings=_temb)
_inter["jb0_norm_hidden"] = _nh
_inter["jb0_norm_enc_hidden"] = _neh
_attn_out, _ctx_attn_out = _b0.attn(hidden_states=_nh, encoder_hidden_states=_neh, image_rotary_emb=_rope)
_inter["jb0_attn_out"] = _attn_out
_inter["jb0_ctx_attn_out"] = _ctx_attn_out
_inter["jb0_gate_msa"] = _gate_msa
_inter["jb0_shift_mlp"] = _shift_mlp
_inter["jb0_scale_mlp"] = _scale_mlp
_inter["jb0_gate_mlp"] = _gate_mlp
_h_post_res = _hs + mx.expand_dims(_gate_msa, axis=1) * _attn_out
_inter["jb0_h_post_res"] = _h_post_res
_normh2 = _b0.norm2(_h_post_res)
_normh2mod = _normh2 * (1 + _scale_mlp[:, None]) + _shift_mlp[:, None]
_inter["jb0_normh2mod"] = _normh2mod
_ff_out = _b0.ff(_normh2mod)
_inter["jb0_ff_out"] = _ff_out
_ff_lin1 = _b0.ff.linear1(_normh2mod)
_inter["jb0_ff_lin1"] = _ff_lin1
_ff_act = _b0.ff.activation_function(_ff_lin1)
_inter["jb0_ff_act"] = _ff_act

for i, block in enumerate(tf.transformer_blocks):
    _ehs, _hs = block(hidden_states=_hs, encoder_hidden_states=_ehs, text_embeddings=_temb, rotary_embeddings=_rope)
    if i == 0:
        _inter["enc_after_jb0"] = _ehs
        _inter["hidden_after_jb0"] = _hs
_inter["enc_after_all_joint"] = _ehs
_inter["hidden_after_all_joint"] = _hs
_combined = mx.concatenate([_ehs, _hs], axis=1)
for i, block in enumerate(tf.single_transformer_blocks):
    _combined = block(hidden_states=_combined, text_embeddings=_temb, rotary_embeddings=_rope)
    if i == 0:
        _inter["combined_after_sb0"] = _combined
_inter["combined_after_all_single"] = _combined
mx.eval(*list(_inter.values()))
print(f"captured intermediates: {list(_inter.keys())}")

# 5. Save inputs + scalar conditioning + output (float32 for stable compare).
ref = {
    "hidden_states": hidden_states.astype(mx.float32),
    "prompt_embeds": prompt_embeds.astype(mx.float32),
    "pooled_prompt_embeds": pooled_prompt_embeds.astype(mx.float32),
    "time_step": mx.broadcast_to(mx.array(timestep_value), (1,)).astype(mx.float32),
    "guidance": mx.broadcast_to(mx.array(guidance_value), (1,)).astype(mx.float32),
    "output": out.astype(mx.float32),
}
ref.update({k: v.astype(mx.float32) for k, v in _inter.items()})
out_path = OUT_DIR / "kontext_transformer_ref.safetensors"
mx.save_safetensors(str(out_path), ref)
print(f"\nSaved reference tensors to: {out_path}")
