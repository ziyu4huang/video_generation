"""Lens pipeline — pure MLX text-to-image using Microsoft Lens 3.8B.

Components:
  - Tokenizer:    GPT-OSS Harmony chat template + tokenizers.Tokenizer (from tokenizer.json)
  - Text encoder: LensGptOssEncoder 20B (INT4 quantized, ~13.5 GB)
  - UNet:         LensTransformer 3.8B MMDiT (INT4 quantized, ~2.6 GB)
  - VAE:          Flux2 VAE (mflux, 32-ch latents)
  - Scheduler:    Euler (shift=1.829 per ComfyUI Lens config)

Latent format (Flux2):
    VAE produces 32-ch latents at spatial H//8 × W//8.
    Patchify (2×2 spatial → channel): 32ch × 4 = 128ch at H//16 × W//16.
    UNet input:  [B, 128, H//16, W//16]
    UNet output: [B,  32,  H//8,  W//8]  (depatchified velocity)
    Denoising loop patchifies/depatchifies at each step.
"""

from __future__ import annotations

import math
import os
import sys
import time
from typing import Optional

import mlx.core as mx
import mlx.nn as mnn

from app import config as cfg
from app.pipeline_types import GenerationResult

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

_APP_DIR = os.path.dirname(os.path.abspath(__file__))
_MODELS_DIR = os.path.join(_APP_DIR, "..", "models")

_TE_DIR = os.path.join(_MODELS_DIR, "text_encoder", "gpt-oss-20b")
_UNET_DIR = os.path.join(_MODELS_DIR, "lens-unet-int4")

# Flux2 VAE — same as Klein 9B
_MFLUX_SRC = os.path.join(_APP_DIR, "..", "vendor", "mflux", "src")
if os.path.isdir(_MFLUX_SRC) and _MFLUX_SRC not in sys.path:
    sys.path.insert(0, _MFLUX_SRC)


# ---------------------------------------------------------------------------
# Chat template (mirrors ComfyUI comfy/text_encoders/gpt_oss.py)
# ---------------------------------------------------------------------------

_SYSTEM = (
    "Describe the image by detailing the color, shape, size, texture, "
    "quantity, text, spatial relationships of the objects and background."
)
_ASSISTANT_THINKING = "Need to generate one image according to the description."
_CHAT_DATE = "2026-05-23"
_MAX_TOKENS = 512
_PAD_TOKEN_ID = 199999


def _render_chat(prompt: str) -> str:
    return (
        f"<|start|>system<|message|>"
        f"You are ChatGPT, a large language model trained by OpenAI.\n"
        f"Knowledge cutoff: 2024-06\n"
        f"Current date: {_CHAT_DATE}\n\n"
        f"Reasoning: medium\n\n"
        f"# Valid channels: analysis, commentary, final. "
        f"Channel must be included for every message.<|end|>"
        f"<|start|>developer<|message|># Instructions\n\n"
        f"{_SYSTEM}\n\n<|end|>"
        f"<|start|>user<|message|>{prompt}<|end|>"
        f"<|start|>assistant<|channel|>analysis<|message|>"
        f"{_ASSISTANT_THINKING}<|end|>"
        f"<|start|>assistant<|channel|>final<|message|>"
    )


# ---------------------------------------------------------------------------
# Euler scheduler (Flux-style with log-linear shift)
# ---------------------------------------------------------------------------

def _patchify(z: mx.array) -> mx.array:
    """[B, C, H, W] → [B, C*4, H//2, W//2] (2×2 spatial tiles into channel dim)."""
    B, C, H, W = z.shape
    z = z.reshape(B, C, H // 2, 2, W // 2, 2)
    z = z.transpose(0, 1, 3, 5, 2, 4)
    return z.reshape(B, C * 4, H // 2, W // 2)


def _depatchify(x: mx.array) -> mx.array:
    """[B, C*4, H//2, W//2] → [B, C, H, W] (inverse of _patchify)."""
    B, Cp4, Hh, Wh = x.shape
    C = Cp4 // 4
    x = x.reshape(B, C, 2, 2, Hh, Wh)
    x = x.transpose(0, 1, 4, 2, 5, 3)
    return x.reshape(B, C, Hh * 2, Wh * 2)


def _make_timesteps(num_steps: int, shift: float = 1.829) -> mx.array:
    """Return num_steps timesteps in [1, 0) (sigma space)."""
    t = mx.linspace(1.0, 0.0, num_steps + 1)[:-1]
    # Apply shift: shift log-linear schedule (matches ModelSamplingFlux)
    t_shifted = shift * t / (1.0 + (shift - 1.0) * t)
    return t_shifted


def _euler_step(
    latents: mx.array,
    pred_v: mx.array,
    sigma: float,
    sigma_next: float,
) -> mx.array:
    """Single Euler step in flow-matching space (v-prediction)."""
    dt = sigma_next - sigma
    return latents + pred_v * dt


# ---------------------------------------------------------------------------
# LensPipeline
# ---------------------------------------------------------------------------

class LensPipeline:
    """Text-to-image pipeline for Microsoft Lens (MLX).

    Loads models lazily on first generate() call.
    """

    def __init__(
        self,
        te_path: Optional[str] = None,
        unet_path: Optional[str] = None,
        vae_path: Optional[str] = None,
        cfg_scale: float = 3.5,
        num_steps: int = 20,
        shift: float = 1.829,
    ):
        self.te_path = te_path or os.path.join(_TE_DIR, "model.safetensors")
        self.unet_path = unet_path or os.path.join(_UNET_DIR, "model.safetensors")
        self.vae_path = vae_path or cfg.KLEIN_9B_VAE_DIR
        self.cfg_scale = cfg_scale
        self.num_steps = num_steps
        self.shift = shift  # 1.829 per ComfyUI Lens sampling_settings

        self._tokenizer = None
        self._te = None
        self._unet = None
        self._vae = None
        self._events: list = []

    # ------------------------------------------------------------------
    # Lazy model loading
    # ------------------------------------------------------------------

    def _load_tokenizer(self):
        from tokenizers import Tokenizer
        tok_path = os.path.join(os.path.dirname(self.te_path), "tokenizer.json")
        self._tokenizer = Tokenizer.from_file(tok_path)

    def _load_te(self):
        from app.lens_text_encoder import LensGptOssEncoder
        t0 = time.time()
        print("[Lens] Loading text encoder (INT4 ~13.5 GB)...")
        self._te = LensGptOssEncoder.from_pretrained(self.te_path)
        print(f"[Lens] TE ready ({time.time() - t0:.1f}s)")

    def _load_unet(self):
        from app.lens_model import LensTransformer
        t0 = time.time()
        print("[Lens] Loading UNet (INT4 ~2.6 GB)...")
        self._unet = LensTransformer.from_pretrained(self.unet_path)
        print(f"[Lens] UNet ready ({time.time() - t0:.1f}s)")

    def _load_vae(self):
        from mflux.models.vae.vae import VAE
        from mflux.models.vae.vae_config import VAEConfig
        t0 = time.time()
        print("[Lens] Loading VAE...")
        self._vae = VAE(VAEConfig())
        weights = list(mx.load(os.path.join(self.vae_path, "model.safetensors")).items())
        self._vae.load_weights(weights)
        mx.eval(self._vae.parameters())
        print(f"[Lens] VAE ready ({time.time() - t0:.1f}s)")

    def _ensure_loaded(self):
        if self._tokenizer is None:
            self._load_tokenizer()
        if self._te is None:
            self._load_te()
        if self._unet is None:
            self._load_unet()
        if self._vae is None:
            self._load_vae()

    # ------------------------------------------------------------------
    # Encode prompt
    # ------------------------------------------------------------------

    def _encode_prompt(self, prompt: str) -> tuple[mx.array, mx.array]:
        """Return (features [1, S, 4*2880], mask [1, S])."""
        rendered = _render_chat(prompt) if prompt.strip() else ""
        if rendered:
            ids = self._tokenizer.encode(rendered, add_special_tokens=False).ids
        else:
            ids = []
        if len(ids) > _MAX_TOKENS:
            ids = ids[:_MAX_TOKENS]

        seq_len = max(len(ids), 1)
        id_arr = mx.array([ids + [_PAD_TOKEN_ID] * (seq_len - len(ids))][:1])
        mask = mx.array([[1] * len(ids) + [0] * (seq_len - len(ids))], dtype=mx.bool_)

        features, trimmed_mask = self._te.encode(id_arr, mask)
        mx.eval(features, trimmed_mask)
        return features, trimmed_mask

    # ------------------------------------------------------------------
    # VAE decode
    # ------------------------------------------------------------------

    def _vae_decode(self, z: mx.array) -> mx.array:
        """Decode [B, 32, H//8, W//8] depatchified latents → [B, H, W, 3] uint8 pixels."""
        # Flux2 VAE: no external scale/shift (the VAE itself handles it)
        # mflux VAE.decode expects [B, C, H, W] with C=32
        decoded = self._vae.decode(z)
        mx.eval(decoded)
        pixels = mx.clip((decoded + 1.0) * 127.5, 0, 255).astype(mx.uint8)
        return pixels

    # ------------------------------------------------------------------
    # Generate
    # ------------------------------------------------------------------

    def generate(
        self,
        prompt: str,
        seed: int = 0,
        width: int = 512,
        height: int = 512,
        num_steps: Optional[int] = None,
        cfg_scale: Optional[float] = None,
    ) -> GenerationResult:
        """Generate one image.

        Args:
            prompt:    Text prompt.
            seed:      RNG seed.
            width:     Output width (must be divisible by 16).
            height:    Output height (must be divisible by 16).
            num_steps: Denoising steps (default: self.num_steps).
            cfg_scale: Guidance scale (default: self.cfg_scale).

        Returns:
            GenerationResult with .image (PIL.Image) and .timings dict.
        """
        from PIL import Image

        steps = num_steps or self.num_steps
        cfg = cfg_scale if cfg_scale is not None else self.cfg_scale

        self._ensure_loaded()

        t_total = time.time()
        timings: dict[str, float] = {}

        # ── Encode prompt ────────────────────────────────────────────────
        t0 = time.time()
        features, mask = self._encode_prompt(prompt)
        if cfg > 1.0:
            neg_features, neg_mask = self._encode_prompt("")
        timings["encode"] = time.time() - t0
        print(f"[Lens] Encoded in {timings['encode']:.1f}s  features={features.shape}")

        # ── Init latents ─────────────────────────────────────────────────
        # Flux2 VAE: 32 channels at H//8 × W//8 (spatial downscale = 8)
        # Patchify 2×2 → 128 channels at H//16 × W//16 (Lens model input)
        vae_h = height // 8
        vae_w = width // 8
        mx.random.seed(seed)
        z = mx.random.normal((1, 32, vae_h, vae_w)).astype(mx.bfloat16)
        latents = _patchify(z)   # [1, 128, vae_h//2, vae_w//2]
        mx.eval(latents)

        # ── Scheduler ────────────────────────────────────────────────────
        sigmas = _make_timesteps(steps, self.shift)
        sigmas_next = mx.concatenate([sigmas[1:], mx.array([0.0])])

        # ── Denoising loop ───────────────────────────────────────────────
        t0 = time.time()
        for i, (sigma, sigma_next_val) in enumerate(
            zip(sigmas.tolist(), sigmas_next.tolist())
        ):
            t_step = mx.array([sigma], dtype=mx.bfloat16)

            # Classifier-free guidance
            # UNet output is depatchified velocity [B, 32, vae_h, vae_w]
            if cfg > 1.0:
                v_cond = self._unet(latents, t_step, features, mask)
                v_uncond = self._unet(latents, t_step, neg_features, neg_mask)
                mx.eval(v_cond, v_uncond)
                pred_v = v_uncond + cfg * (v_cond - v_uncond)  # [B, 32, vae_h, vae_w]
            else:
                pred_v = self._unet(latents, t_step, features, mask)
                mx.eval(pred_v)

            # Euler step in depatchified space, then re-patchify
            z = _depatchify(latents)
            z = _euler_step(z, pred_v, sigma, sigma_next_val)
            latents = _patchify(z)
            mx.eval(latents)
            print(f"[Lens] step {i+1}/{steps}  σ={sigma:.3f}", end="\r")

        print()
        timings["denoise"] = time.time() - t0
        print(f"[Lens] Denoised in {timings['denoise']:.1f}s")

        # ── VAE decode ───────────────────────────────────────────────────
        t0 = time.time()
        z_clean = _depatchify(latents)  # [1, 32, vae_h, vae_w]
        pixels = self._vae_decode(z_clean)  # [1, H, W, 3]
        timings["decode"] = time.time() - t0

        # Convert to PIL
        import numpy as np
        pil_img = Image.fromarray(
            np.array(pixels[0].tolist(), dtype=np.uint8), mode="RGB"
        )
        timings["total"] = time.time() - t_total

        self._events.append({
            "event": "generate",
            "detail": {
                "prompt": prompt[:100],
                "steps": steps,
                "cfg_scale": cfg,
                "width": width,
                "height": height,
                "seed": seed,
            },
            "seconds": timings["total"],
        })
        print(f"[Lens] Done in {timings['total']:.1f}s")
        return GenerationResult(image=pil_img, timings=timings, events=list(self._events))
