#!/usr/bin/env python3
"""Generate Flux2 transformer reference tensors for Swift port verification.

Loads the Flux2 Klein 9B transformer via mflux, runs ONE denoise step on a fixed
input, and saves all inputs + the output noise for Swift comparison (cos > 0.99).

Run from repo root:
    python/venv/bin/python python/mlx-movie-director/app/tests/gen_flux2_transformer_ref.py
"""
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(REPO / "python" / "mlx-movie-director" / "vendor" / "mflux" / "src"))

import mlx.core as mx
from mlx import nn
from mlx.utils import tree_unflatten

from mflux.models.flux2.model.flux2_transformer.transformer import Flux2Transformer
from mflux.models.flux2.latent_creator.flux2_latent_creator import Flux2LatentCreator

TF_DIR = REPO / "python" / "mlx-movie-director" / "models" / "transformer" / "klein-9b"
TE_DIR = REPO / "python" / "mlx-movie-director" / "models" / "text_encoder" / "qwen3-8b"
OUT_DIR = REPO / "swift" / "flux2-image-director" / "verify_refs"
OUT_DIR.mkdir(parents=True, exist_ok=True)

# 1. Build + load transformer (8-bit quantized linears, like the text encoder).
import json
cfg = json.loads((TF_DIR / "config.json").read_text())
tf = Flux2Transformer(
    patch_size=cfg.get("patch_size", 1),
    in_channels=cfg["in_channels"],
    out_channels=cfg.get("out_channels"),
    num_layers=cfg["num_layers"],
    num_single_layers=cfg["num_single_layers"],
    attention_head_dim=cfg["attention_head_dim"],
    num_attention_heads=cfg["num_attention_heads"],
    joint_attention_dim=cfg["joint_attention_dim"],
    timestep_guidance_channels=cfg["timestep_guidance_channels"],
    mlp_ratio=cfg.get("mlp_ratio", 3.0),
    axes_dims_rope=tuple(cfg.get("axes_dims_rope", [32, 32, 32, 32])),
    rope_theta=cfg.get("rope_theta", 2000),
    guidance_embeds=cfg.get("guidance_embeds", False),
)
all_w = {}
for shard in sorted(TF_DIR.glob("*.safetensors")):
    if shard.name.startswith("._"):
        continue
    all_w.update(mx.load(str(shard)))
nn.quantize(tf, class_predicate=lambda path, m: hasattr(m, "to_quantized"), bits=8)
tf.update(tree_unflatten(list(all_w.items())), strict=False)
mx.eval(tf.parameters())
print(f"Loaded {len(all_w)} transformer weights (klein-9b, 8-bit)")

# 2. Build deterministic inputs (fixed seed).
SEED = 777
H, W = 512, 512
mx.random.seed(SEED)

# Packed latents (1, latent_H*latent_W, 128) + latent_ids.
latents, latent_ids, latent_h, latent_w = Flux2LatentCreator.prepare_packed_latents(
    seed=SEED, height=H, width=W, batch_size=1
)
print(f"latents: {latents.shape}, latent_ids: {latent_ids.shape}, latent_h={latent_h} latent_w={latent_w}")

# Fake prompt embeds (deterministic random) — we only verify the transformer
# forward, not the text encoder coupling. Shape (1, 512, 12288).
prompt_embeds = mx.random.normal(shape=(1, 512, 12288), key=mx.random.key(SEED + 1))
# text_ids: (1, 512, 4) = [t=0, h=0, w=0, token_idx]
seq = prompt_embeds.shape[1]
token_ids = mx.arange(seq, dtype=mx.int32)
t = mx.zeros((seq,), dtype=mx.int32)
h0 = mx.zeros((seq,), dtype=mx.int32)
w0 = mx.zeros((seq,), dtype=mx.int32)
text_ids = mx.stack([t, h0, w0, token_ids], axis=1)[None, :, :]
print(f"prompt_embeds: {prompt_embeds.shape}, text_ids: {text_ids.shape}")

# Timestep: use a small value (0.5) which the transformer scales to 500.
timestep = mx.array([0.5], dtype=latents.dtype)
print(f"timestep: {timestep}")

# 3. Run ONE forward pass + capture intermediates by replicating the forward
# (we use the transformer's submodules directly, no monkey-patching).
import mlx.core as mx
from mflux.models.common.config.model_config import ModelConfig
from mflux.models.flux.model.flux_transformer.ada_layer_norm_continuous import AdaLayerNormContinuous

_intermediates = {}

def _forward_capture(hidden_states, encoder_hidden_states, timestep, img_ids, txt_ids):
    if not isinstance(timestep, mx.array):
        timestep = mx.array(timestep, dtype=hidden_states.dtype)
    if timestep.ndim == 0:
        timestep = mx.full((hidden_states.shape[0],), timestep, dtype=hidden_states.dtype)
    timestep = timestep.astype(hidden_states.dtype)
    timestep_scale = mx.where(mx.max(timestep) <= 1.0, 1000.0, 1.0).astype(hidden_states.dtype)
    timestep = timestep * timestep_scale
    temb = tf.time_guidance_embed(timestep, None).astype(ModelConfig.precision)
    _intermediates["temb"] = temb.astype(mx.float32)
    from mflux.models.flux2.model.flux2_transformer.timestep_guidance_embeddings import Flux2TimestepGuidanceEmbeddings
    _intermediates["te_raw"] = Flux2TimestepGuidanceEmbeddings._timestep_embedding(timestep.astype(mx.float32), 256).astype(mx.float32)
    hidden_states = tf.x_embedder(hidden_states)
    encoder_hidden_states = tf.context_embedder(encoder_hidden_states)
    _intermediates["hidden_post_embed"] = hidden_states.astype(mx.float32)
    _intermediates["enc_post_embed"] = encoder_hidden_states.astype(mx.float32)
    if img_ids.ndim == 3:
        img_ids = img_ids[0]
    if txt_ids.ndim == 3:
        txt_ids = txt_ids[0]
    image_rotary_emb = tf.pos_embed(img_ids)
    text_rotary_emb = tf.pos_embed(txt_ids)
    concat_rotary_emb = (
        mx.concatenate([text_rotary_emb[0], image_rotary_emb[0]], axis=0),
        mx.concatenate([text_rotary_emb[1], image_rotary_emb[1]], axis=0),
    )
    _intermediates["rope_cos"] = concat_rotary_emb[0].astype(mx.float32)
    temb_mod_params_img = tf.double_stream_modulation_img(temb)
    temb_mod_params_txt = tf.double_stream_modulation_txt(temb)
    enc0, hid0 = tf.transformer_blocks[0](
        hidden_states=hidden_states,
        encoder_hidden_states=encoder_hidden_states,
        temb_mod_params_img=temb_mod_params_img,
        temb_mod_params_txt=temb_mod_params_txt,
        image_rotary_emb=concat_rotary_emb,
    )
    _intermediates["enc_after_db0"] = enc0.astype(mx.float32)
    _intermediates["hidden_after_db0"] = hid0.astype(mx.float32)

_forward_capture(latents, prompt_embeds, timestep, latent_ids, text_ids)

# Full noise via the real transformer.
noise = tf(
    hidden_states=latents,
    encoder_hidden_states=prompt_embeds,
    timestep=timestep,
    img_ids=latent_ids,
    txt_ids=text_ids,
    guidance=None,
)
mx.eval(noise, *list(_intermediates.values()))
print(f"noise output: {noise.shape}, dtype: {noise.dtype}")
print(f"captured intermediates: {list(_intermediates.keys())}")

# 4. Save inputs + output (cast to float32 for stable comparison).
ref = {
    "latents": latents.astype(mx.float32),
    "latent_ids": latent_ids.astype(mx.int32),
    "prompt_embeds": prompt_embeds.astype(mx.float32),
    "text_ids": text_ids.astype(mx.int32),
    "timestep": timestep.astype(mx.float32),
    "noise": noise.astype(mx.float32),
}
ref.update({k: v.astype(mx.float32) for k, v in _intermediates.items()})
out_path = OUT_DIR / "flux2_transformer_ref.safetensors"
mx.save_safetensors(str(out_path), ref)
print(f"\nSaved reference tensors to: {out_path}")
