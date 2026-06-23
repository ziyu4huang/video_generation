"""Ideogram 4 text-to-image pipeline — fork-free MLX port (poster/slide optimized).

Orchestrates the reference ``generate.py`` flow with a memory-efficient multi-seed
path:

  1. Qwen3-VL text encoding — extract hidden states from 13 layers, concat to the
     53248-dim ``llm_features`` the DiT consumes. The 8.8B text encoder is freed
     (``del; gc.collect()``) BEFORE the diffusion transformers load, bounding peak
     memory (mirrors generate.py:209).
  2. Dual Ideogram4Transformer (conditional + unconditional) asymmetric-CFG
     flow-matching sampling. Both stay resident across all seeds (amortizes the
     ~9 GB load); ``z`` is kept float32 across Euler steps (cast to bf16 only for
     the transformer call) to avoid bf16 accumulation drift.
  3. Flux2 KL-VAE decode with the vendored 128-dim LATENT_SHIFT/LATENT_SCALE.

NF4 weights are dequantized at load by ``app.ideogram4_nf4`` (stock mlx — no
custom fork). Text-rendering strength comes free from the architecture: deep
13-layer Qwen3-VL features + the per-step asymmetric guidance schedule (low early,
high late — see PRESETS).
"""

from __future__ import annotations

import dataclasses
import gc
import os
import time

import mlx.core as mx
import numpy as np
from PIL import Image

from app import config as cfg
from app.pipeline_types import GenerationResult
from app.ideogram4_pipeline_helpers import (
    LATENT_SCALE,
    LATENT_SHIFT,
    QWEN3_VL_ACTIVATION_LAYERS as ACTIVATION_LAYERS,
    build_inputs,
)
from app.ideogram4_scheduler import get_schedule_for_resolution, make_step_intervals

# Asymmetric CFG presets — ported verbatim from generate.py:81-88. The guidance is
# a per-step tuple: low (3.0) early, high (7.0) later. This schedule (not a scalar)
# is what sharpens rendered text — do not collapse it.
PRESETS: dict[str, dict] = {
    "V4_QUALITY_48": {"steps": 48, "mu": 0.0, "std": 1.5, "guidance": (3.0,) * 3 + (7.0,) * 45},
    "V4_DEFAULT_20": {"steps": 20, "mu": 0.0, "std": 1.75, "guidance": (3.0,) * 2 + (7.0,) * 18},
    "V4_TURBO_12": {"steps": 12, "mu": 0.5, "std": 1.75, "guidance": (3.0,) * 1 + (7.0,) * 11},
}


def _resolve_guidance(num_steps: int, preset: dict) -> tuple[float, ...]:
    """Pad/trim the preset guidance schedule to ``num_steps`` (generate.py:111-116)."""
    guidance = preset["guidance"]
    if len(guidance) == num_steps:
        return tuple(guidance)
    if num_steps > len(guidance):
        return (7.0,) * (num_steps - 3) + (3.0,) * 3
    return tuple(guidance[:num_steps])


def _build_qwen3vl_config(config_path: str):
    """Build the mlx-vlm Qwen3VL ModelConfig from the text_encoder config.json.

    Ports generate.py:166-183: drop ``quantization_config`` (we dequant ourselves),
    split text_config/vision_config, map ``rope_parameters`` -> ``rope_scaling``
    (mrope_section), and filter to the dataclass's actual fields.
    """
    import json

    from mlx_vlm.models.qwen3_vl.config import ModelConfig, TextConfig, VisionConfig

    with open(config_path) as fp:
        raw = json.load(fp)
    raw.pop("quantization_config", None)
    tr = dict(raw["text_config"])
    rp = tr.pop("rope_parameters", {})
    tr["rope_scaling"] = {
        "type": rp.get("rope_type", "default"),
        "mrope_section": rp.get("mrope_section", [24, 20, 20]),
    }
    tr.setdefault("rope_theta", rp.get("rope_theta", 5000000))
    tcf = {f.name for f in dataclasses.fields(TextConfig)}
    vcf = {f.name for f in dataclasses.fields(VisionConfig)}
    tc = TextConfig(**{k: v for k, v in tr.items() if k in tcf})
    vr = dict(raw["vision_config"])
    vr["model_type"] = "qwen3_vl"
    vc = VisionConfig(**{k: v for k, v in vr.items() if k in vcf})
    return ModelConfig(
        text_config=tc,
        vision_config=vc,
        model_type="qwen3_vl",
        image_token_id=raw.get("image_token_id", 151655),
    )


class Ideogram4Pipeline:
    """Ideogram 4 t2i (poster/slide optimized). Loads models lazily inside generate()."""

    def __init__(
        self,
        te_dir: str | None = None,
        tok_dir: str | None = None,
        cond_dir: str | None = None,
        uncond_dir: str | None = None,
        vae_dir: str | None = None,
    ):
        self.te_dir = te_dir or cfg.IDEOGRAM4_TEXT_ENCODER_DIR
        self.tok_dir = tok_dir or cfg.IDEOGRAM4_TOKENIZER_DIR
        self.cond_dir = cond_dir or cfg.IDEOGRAM4_COND_TRANSFORMER_DIR
        self.uncond_dir = uncond_dir or cfg.IDEOGRAM4_UNCOND_TRANSFORMER_DIR
        self.vae_dir = vae_dir or cfg.IDEOGRAM4_VAE_DIR
        self.te_weight_file = os.path.join(self.te_dir, "model.safetensors")
        self.te_config_file = os.path.join(self.te_dir, "config.json")
        self.cond_weight_file = os.path.join(self.cond_dir, "diffusion_pytorch_model.safetensors")
        self.uncond_weight_file = os.path.join(self.uncond_dir, "diffusion_pytorch_model.safetensors")
        self.vae_weight_file = os.path.join(self.vae_dir, "diffusion_pytorch_model.safetensors")
        self._events: list[dict] = []

    # ------------------------------------------------------------------
    # Text encoding (TE loaded, used, freed)
    # ------------------------------------------------------------------
    def _encode_text_features(self, prompt: str) -> tuple[mx.array, int]:
        """Return (features [1, L, 53248] bf16, num_text_tokens). Frees the TE."""
        from transformers import AutoTokenizer
        from mlx_vlm.models.qwen3_vl.qwen3_vl import Model as Qwen3VLModel

        from app.ideogram4_nf4 import load_nf4_weights

        t0 = time.time()
        tokenizer = AutoTokenizer.from_pretrained(self.tok_dir)
        messages = [{"role": "user", "content": [{"type": "text", "text": prompt}]}]
        text = tokenizer.apply_chat_template(messages, add_generation_prompt=True, tokenize=False)
        ids_np = tokenizer(text, return_tensors="np", add_special_tokens=False)["input_ids"][0]
        num_text_tokens = len(ids_np)

        tm = Qwen3VLModel(_build_qwen3vl_config(self.te_config_file))
        load_nf4_weights(self.te_weight_file, tm, sanitize_key=True, verbose=True)
        print(f"[ideogram4] text encoder loaded ({num_text_tokens} tokens)", flush=True)

        # Inline 13-layer hidden-state extraction (generate.py:192-208) — NOT the
        # dead text_encoder.py monkey-patch. Cache activation-layer outputs, concat.
        ids = mx.array(ids_np[None, :])
        B, L = ids.shape
        pos = mx.broadcast_to(mx.arange(L).reshape(1, 1, -1), (3, B, L))
        ln = tm.language_model.model
        h = ln.embed_tokens(ids)
        cm = mx.where(
            mx.tril(mx.ones((L, L))),
            mx.array(0.0, dtype=mx.bfloat16),
            mx.array(-1e9, dtype=mx.bfloat16),
        )[None, None]
        cap = {}
        act = set(ACTIVATION_LAYERS)
        for i, layer in enumerate(ln.layers):
            h = layer(h, cm, None, pos)
            if i in act:
                cap[i] = h
            if i % 9 == 0:
                mx.eval(h)
        mx.eval(h)
        fs = [cap[i] for i in ACTIVATION_LAYERS]
        st = mx.transpose(mx.stack(fs, axis=0), (1, 2, 3, 0))
        features = mx.reshape(st, (B, L, -1)).astype(mx.bfloat16)
        mx.eval(features)
        del tm, ln, cap, fs, st, h
        gc.collect()
        print(
            f"[ideogram4] text features {features.shape} ({time.time() - t0:.1f}s)",
            flush=True,
        )
        return features, num_text_tokens

    # ------------------------------------------------------------------
    # Diffusion transformers
    # ------------------------------------------------------------------
    def _load_transformers(self):
        from app.ideogram4_transformer import Ideogram4Transformer
        from app.ideogram4_nf4 import load_nf4_weights

        t0 = time.time()
        cond = Ideogram4Transformer()
        load_nf4_weights(self.cond_weight_file, cond, sanitize_key=False, verbose=True)
        uncond = Ideogram4Transformer()
        load_nf4_weights(self.uncond_weight_file, uncond, sanitize_key=False, verbose=True)
        print(
            f"[ideogram4] cond + uncond transformers loaded ({time.time() - t0:.1f}s)",
            flush=True,
        )
        return cond, uncond

    # ------------------------------------------------------------------
    # Generate (multi-seed; amortizes TE/transformer/VAE loads)
    # ------------------------------------------------------------------
    def generate(
        self,
        prompt: str,
        seeds: list[int],
        width: int = 1024,
        height: int = 1024,
        preset: str = "V4_DEFAULT_20",
        num_steps: int | None = None,
    ) -> list[GenerationResult]:
        """Generate one image per seed. Prompt encoded once; transformers/VAE loaded once."""
        preset_cfg = PRESETS[preset]
        num_steps = num_steps or preset_cfg["steps"]
        guidance = _resolve_guidance(num_steps, preset_cfg)
        # Resolution-adaptive logit-normal mean (auto for non-square posters/slides).
        schedule = get_schedule_for_resolution(
            (height, width),
            known_resolution=(512, 512),
            known_mean=preset_cfg["mu"],
            std=preset_cfg["std"],
        )
        steps_grid = make_step_intervals(num_steps)

        print(
            f"[ideogram4] {width}x{height} | {num_steps} steps | preset {preset} | "
            f"seeds={seeds}",
            flush=True,
        )

        t_total = time.time()

        # ── 1. Encode prompt once ───────────────────────────────────────
        t0 = time.time()
        features, num_text_tokens = self._encode_text_features(prompt)
        t_encode = time.time() - t0

        inputs = build_inputs(num_text_tokens, height, width)
        ni = inputs["num_image_tokens"]

        # Per-seed-invariant tensors (built once, reused across the seed loop).
        lf = mx.zeros((1, num_text_tokens + ni, 53248), dtype=mx.bfloat16)
        lf = lf.at[:, :num_text_tokens, :].add(features)
        mx.eval(lf)
        del features
        gc.collect()
        nl = mx.zeros((1, ni, 53248), dtype=mx.bfloat16)
        tp = mx.zeros((1, num_text_tokens, 128))
        pos_full = inputs["position_ids"]
        seg_full = inputs["segment_ids"]
        ind_full = inputs["indicator"]
        np_ = pos_full[:, num_text_tokens:]
        ns = seg_full[:, num_text_tokens:]
        nind = ind_full[:, num_text_tokens:]

        # ── 2. Load transformers once, sample every seed ────────────────
        t0 = time.time()
        cond, uncond = self._load_transformers()
        t_load_t = time.time() - t0

        latents_by_seed: dict[int, mx.array] = {}
        sample_times: dict[int, float] = {}
        for sd in seeds:
            t0 = time.time()
            mx.random.seed(sd)
            z = mx.random.normal((1, ni, 128))  # float32 across steps (bf16 only inside the call)
            for i in range(num_steps - 1, -1, -1):
                tv = schedule(steps_grid[i + 1 : i + 2]).item()
                sv = schedule(steps_grid[i : i + 1]).item()
                t = mx.array([tv])
                gw = guidance[i]
                pz = mx.concatenate([tp, z], axis=1)  # float32
                pv = cond(
                    llm_features=lf,
                    x=pz.astype(mx.bfloat16),
                    t=t,
                    position_ids=pos_full,
                    segment_ids=seg_full,
                    indicator=ind_full,
                )[:, num_text_tokens:]
                nv = uncond(
                    llm_features=nl,
                    x=z.astype(mx.bfloat16),
                    t=t,
                    position_ids=np_,
                    segment_ids=ns,
                    indicator=nind,
                )
                v = gw * pv + (1.0 - gw) * nv  # fp32 (transformer returns fp32)
                z = z + v * (sv - tv)
                mx.eval(z)
            latents_by_seed[sd] = z
            sample_times[sd] = time.time() - t0
            print(f"[ideogram4] seed {sd}: {num_steps} steps ({sample_times[sd]:.1f}s)", flush=True)

        del cond, uncond, lf, nl, tp
        gc.collect()

        # ── 3. Load VAE once, decode every seed ─────────────────────────
        from app.ideogram4_vae import Decoder, decode_latents, remap_vae_weights

        t0 = time.time()
        vw = mx.load(self.vae_weight_file)
        dec = Decoder()
        dec.load_weights(remap_vae_weights(vw), strict=False)
        t_load_v = time.time() - t0
        grid_h, grid_w = inputs["grid_h"], inputs["grid_w"]

        results: list[GenerationResult] = []
        for sd in seeds:
            t0 = time.time()
            pixels = decode_latents(dec, latents_by_seed[sd], grid_h, grid_w, LATENT_SHIFT, LATENT_SCALE)
            mx.eval(pixels)
            t_decode = time.time() - t0
            arr = np.array(pixels[0]).transpose(1, 2, 0)  # (3,H,W) uint8 -> (H,W,3)
            img = Image.fromarray(arr, mode="RGB")
            total = t_encode + t_load_t + sample_times[sd] + t_load_v + t_decode
            self._events.append(
                {
                    "event": "generate",
                    "detail": {
                        "prompt": prompt[:100],
                        "preset": preset,
                        "steps": num_steps,
                        "width": width,
                        "height": height,
                        "seed": sd,
                    },
                    "seconds": total,
                }
            )
            results.append(
                GenerationResult(
                    image=img,
                    timings={
                        "encode": t_encode,
                        "load_transformers": t_load_t,
                        "denoise": sample_times[sd],
                        "load_vae": t_load_v,
                        "decode": t_decode,
                        "total": total,
                    },
                    events=list(self._events),
                )
            )
            print(f"[ideogram4] seed {sd} decoded ({t_decode:.1f}s)", flush=True)

        del dec
        gc.collect()
        print(f"[ideogram4] done: {len(results)} image(s) in {time.time() - t_total:.1f}s", flush=True)
        return results
