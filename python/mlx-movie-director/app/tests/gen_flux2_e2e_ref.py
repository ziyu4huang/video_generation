#!/usr/bin/env python3
"""Generate Flux2 end-to-end reference: final denoised packed latent + pixels.
Isolates whether Swift divergence is in the denoise loop or VAE decode."""
import sys
from pathlib import Path
REPO = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(REPO / "python" / "mlx-movie-director" / "vendor" / "mflux" / "src"))

import mlx.core as mx
from mlx import nn
from mlx.utils import tree_unflatten

from mflux.models.flux2.model.flux2_transformer.transformer import Flux2Transformer
from mflux.models.flux2.model.flux2_text_encoder.qwen3_text_encoder import Qwen3TextEncoder
from mflux.models.flux2.latent_creator.flux2_latent_creator import Flux2LatentCreator
from mflux.models.flux2.model.flux2_text_encoder.prompt_encoder import Flux2PromptEncoder
from mflux.models.common.tokenizer.tokenizer_loader import TokenizerLoader
from mflux.models.common.schedulers.flow_match_euler_discrete_scheduler import FlowMatchEulerDiscreteScheduler

TF_DIR = REPO / "python" / "mlx-movie-director" / "models" / "transformer" / "klein-9b"
TE_DIR = REPO / "python" / "mlx-movie-director" / "models" / "text_encoder" / "qwen3-8b"
TOK_DIR = REPO / "python" / "mlx-movie-director" / "models" / "tokenizer" / "qwen3-klein"
OUT_DIR = REPO / "swift" / "flux2-image-director" / "verify_refs"

def load_module(mod, dir_):
    w = {}
    for s in sorted(dir_.glob("*.safetensors")):
        if not s.name.startswith("._"):
            w.update(mx.load(str(s)))
    nn.quantize(mod, class_predicate=lambda p, m: hasattr(m, "to_quantized"), bits=8)
    mod.update(tree_unflatten(list(w.items())), strict=False)
    mx.eval(mod.parameters())
    return mod

tf = load_module(Flux2Transformer(
    patch_size=1, in_channels=128, num_layers=8, num_single_layers=24,
    attention_head_dim=128, num_attention_heads=32, joint_attention_dim=12288,
    timestep_guidance_channels=256, axes_dims_rope=(32,32,32,32), rope_theta=2000,
    guidance_embeds=False), TF_DIR)
te = load_module(Qwen3TextEncoder(hidden_size=4096, num_hidden_layers=36,
    num_attention_heads=32, num_key_value_heads=8, intermediate_size=12288,
    head_dim=128), TE_DIR)
print("models loaded")

PROMPT = "a woman in a garden, professional photo"
SEED, H, W, STEPS = 777, 512, 512, 4

from transformers import AutoTokenizer
hf_tok = AutoTokenizer.from_pretrained(str(TOK_DIR))
formatted = hf_tok.apply_chat_template(
    [{"role": "user", "content": PROMPT}], tokenize=False,
    add_generation_prompt=True, enable_thinking=False)
tokens = hf_tok([formatted], padding="max_length", max_length=512,
    truncation=True, add_special_tokens=True, return_tensors="np")
input_ids = mx.array(tokens["input_ids"])
attention_mask = mx.array(tokens["attention_mask"])
prompt_embeds = te.get_prompt_embeds(input_ids=input_ids, attention_mask=attention_mask,
    hidden_state_layers=(9,18,27)).astype(mx.bfloat16)
seq = prompt_embeds.shape[1]
_token_ids = mx.arange(seq, dtype=mx.int32)
_zeros = mx.zeros((seq,), dtype=mx.int32)
text_ids = mx.stack([_zeros, _zeros, _zeros, _token_ids], axis=1)[None, :, :]

# Latents.
latents, latent_ids, latent_h, latent_w = Flux2LatentCreator.prepare_packed_latents(
    seed=SEED, height=H, width=W, batch_size=1)

# Scheduler.
sched = FlowMatchEulerDiscreteScheduler.__new__(FlowMatchEulerDiscreteScheduler)
sched.num_train_timesteps = 1000
sched.shift_terminal = 0.02
sched._timesteps, sched._sigmas = FlowMatchEulerDiscreteScheduler.get_timesteps_and_sigmas(
    image_seq_len=(H//16)*(W//16), num_inference_steps=STEPS)
print("timesteps:", sched._timesteps.tolist())
print("sigmas:", sched._sigmas.tolist())

# Denoise.
for t in range(STEPS):
    noise = tf(hidden_states=latents, encoder_hidden_states=prompt_embeds,
        timestep=sched._timesteps[t], img_ids=latent_ids, txt_ids=text_ids, guidance=None)
    latents = sched.step(noise=noise, timestep=t, latents=latents, sigmas=sched._sigmas)
    mx.eval(latents)
    print(f"step {t}: latent sum={float(latents.sum()):.3f} mean={float(latents.mean()):.5f}")

mx.save_safetensors(str(OUT_DIR / "flux2_e2e_latent_ref.safetensors"), {
    "final_latent": latents.astype(mx.float32),
    "prompt_embeds": prompt_embeds.astype(mx.float32),
    "text_ids": text_ids.astype(mx.int32),
    "latent_ids": latent_ids.astype(mx.int32),
})
print("saved flux2_e2e_latent_ref.safetensors")
