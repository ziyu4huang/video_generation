"""Lens pipeline — pure MLX text-to-image using Microsoft Lens 3.8B.

Components:
  - Tokenizer:    GPT-OSS Harmony chat template + tokenizers.Tokenizer (from tokenizer.json)
  - Text encoder: LensGptOssEncoder 20B (INT4 quantized, ~13.5 GB)
  - UNet:         LensTransformer 3.8B MMDiT (INT4 quantized, ~2.6 GB)
  - VAE:          Flux2 VAE (mflux, 32-ch latents)
  - Scheduler:    Euler flow-matching; dynamic mu (compute_empirical_mu, per
                  microsoft/Lens) — NOT fixed 1.829 (that's only ~1440²)

Latent format (Flux2):
    VAE produces 32-ch latents at spatial H//8 × W//8.
    Patchify (2×2 spatial → channel): 32ch × 4 = 128ch at H//16 × W//16.
    UNet input AND output: [B, 128, H//16, W//16]  (patchified velocity)
    The model never unpatchifies internally; the Euler step runs in patchified
    space and the pipeline depatchifies once for the final VAE decode.
"""

from __future__ import annotations

import math
import os
import sys
import time

import mlx.core as mx

from app.pipeline_types import GenerationResult

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

_APP_DIR = os.path.dirname(os.path.abspath(__file__))
from app import config as _cfg  # noqa: E402 — follow the runtime models root
_MODELS_DIR = _cfg.MODELS_DIR

_TE_DIR = os.path.join(_MODELS_DIR, "text_encoder", "gpt-oss-20b")
_UNET_DIR = os.path.join(_MODELS_DIR, "lens-unet-int4")

# Flux2 VAE (ComfyUI format) — lives in the MLX-owned model tree (self-contained),
# so Lens T2I is self-contained and survives a ComfyUI-clean.
_LENS_VAE = os.path.join(_MODELS_DIR, "vae", "flux2-vae", "flux2-vae.safetensors")
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
    """Denoising sigmas, matching ComfyUI ``ModelSamplingFlux``.

    ComfyUI: ``sigma(t) = flux_time_shift(mu, 1.0, t)
    = exp(mu) / (exp(mu) + (1/t - 1))`` where ``mu == shift`` DIRECTLY — the value
    from the model's ``sampling_settings`` (1.829 for Lens) is ``mu``, NOT
    ``exp(mu)``. Sampled at ``t = linspace(1/steps, 1, steps)`` and returned in
    descending order (highest noise first). The caller appends the final 0 via
    ``sigmas_next``.

    A previous version used ``shift * t / (1 + (shift-1)*t)``, which treats
    ``shift`` as ``exp(mu)`` (so mu≈0.60 instead of 1.829, exp≈1.83 instead of
    6.23). That compresses the low-noise tail (lowest sigma 0.088 vs the correct
    0.247 at 20 steps) — the last ~5 steps over-refine near-zero noise and the
    output reads as soft / over-smoothed. Verified equivalent to the ComfyUI
    formula numerically.
    """
    mu = shift
    a = math.exp(mu)
    t = mx.linspace(1.0 / num_steps, 1.0, num_steps)   # ascending
    sigmas = a / (a + (1.0 / t - 1.0))                  # flux_time_shift(mu, 1.0, t)
    return sigmas[::-1]                                  # descending (sigma_max first)


def _compute_empirical_mu(image_seq_len: int, num_steps: int) -> float:
    """Empirical mu for the Lens flow-matching schedule (dynamic shift).

    Matches microsoft/Lens ``lens/pipeline.py::compute_empirical_mu``. The
    flow-matching shift depends on BOTH latent sequence length (resolution) and
    the step count — a fixed ``shift=1.829`` is only correct near 1440×1440.
    Examples: 512×512/20steps → 1.916; 1024×1024/20steps → 2.198;
    1440×1440/50steps → 1.828.
    """
    a1, b1 = 8.73809524e-05, 1.89833333
    a2, b2 = 0.00016927, 0.45666666
    if image_seq_len > 4300:
        return float(a2 * image_seq_len + b2)
    m_200 = a2 * image_seq_len + b2
    m_10 = a1 * image_seq_len + b1
    a = (m_200 - m_10) / 190.0
    b = m_200 - 200.0 * a
    return float(a * num_steps + b)


def _euler_step(
    latents: mx.array,
    pred_v: mx.array,
    sigma: float,
    sigma_next: float,
) -> mx.array:
    """Single Euler step in flow-matching (v-prediction) space.

    Kept as a helper; the generate() loop inlines the same math because it runs
    in patchified space and needs no extra copy.
    """
    return latents + pred_v * (sigma_next - sigma)


# ---------------------------------------------------------------------------
# LensPipeline
# ---------------------------------------------------------------------------

class LensPipeline:
    """Text-to-image pipeline for Microsoft Lens (MLX).

    Loads models lazily on first generate() call.
    """

    def __init__(
        self,
        te_path: str | None = None,
        unet_path: str | None = None,
        vae_path: str | None = None,
        cfg_scale: float = 4.0,
        num_steps: int = 20,
        shift: float = 1.829,
    ):
        self.te_path = te_path or os.path.join(_TE_DIR, "model.safetensors")
        self.unet_path = unet_path or os.path.join(_UNET_DIR, "model.safetensors")
        self.vae_path = vae_path or _LENS_VAE
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
        from mflux.models.flux2.model.flux2_vae.vae import Flux2VAE
        from mlx.utils import tree_flatten
        t0 = time.time()
        print("[Lens] Loading Flux2 VAE...")
        self._vae = Flux2VAE()
        raw, _ = mx.load(self.vae_path, return_metadata=True)
        # ComfyUI uses to_out.0.* (ModuleList), mflux uses to_out.* (plain Linear)
        import re
        model_keys = {n: m for n, m in tree_flatten(self._vae.parameters())}
        weights = []
        for k, v in raw.items():
            k2 = re.sub(r'\.to_out\.0\.', '.to_out.', k)
            if k2 in model_keys:
                # Conv2d: PyTorch [O,I,H,W] → MLX [O,H,W,I]
                if v.ndim == 4 and k2.endswith(".weight"):
                    v = mx.array(v.tolist()).transpose(0, 2, 3, 1)
                weights.append((k2, v))
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
            print(
                f"[Lens] WARNING: prompt is {len(ids)} tokens but the GPT-OSS-20B "
                f"encoder caps at {_MAX_TOKENS}; truncating. The model only sees "
                "the first 512 tokens — condense the prompt (or rewrite it as a "
                "concise image prompt) to retain detail."
            )
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

    def _vae_decode(self, latents_packed: mx.array) -> mx.array:
        """Decode Flux2 packed latents → [B, H, W, 3] uint8 pixels.

        Flux2 trains its diffusion model on BatchNorm-normalized latents. The
        model predicts packed [B, 128, h, w] latents in that NORMALIZED space;
        decoding must first de-normalize (× running_std + running_mean) in the
        128-ch packed space, then unpatchify (128 → 32), then run the VAE
        decoder. This matches mflux ``Flux2VAE.decode_packed_latents``.

        Skipping the BN step feeds the decoder out-of-distribution latents →
        soft, color-graded output (the "AI rendering feel" / low sharpness).
        """
        bn = self._vae.bn
        dt = latents_packed.dtype
        bn_mean = bn.running_mean.reshape(1, -1, 1, 1).astype(dt)
        bn_std = mx.sqrt(bn.running_var.reshape(1, -1, 1, 1).astype(dt) + bn.eps)
        latents = latents_packed * bn_std + bn_mean   # BN de-normalize (packed space)
        z_clean = _depatchify(latents)                 # [B, 32, vae_h, vae_w]
        decoded = self._vae.decode(z_clean)            # mflux returns [B, C, H, W]
        mx.eval(decoded)
        decoded = mx.transpose(decoded, (0, 2, 3, 1))  # BCHW → BHWC
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
        num_steps: int | None = None,
        cfg_scale: float | None = None,
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

        steps = self.num_steps if num_steps is None else num_steps
        cfg = cfg_scale if cfg_scale is not None else self.cfg_scale

        self._ensure_loaded()

        t_total = time.time()
        timings: dict[str, float] = {}

        # ── Encode prompt ────────────────────────────────────────────────
        t0 = time.time()
        features, mask = self._encode_prompt(prompt)
        if cfg > 1.0:
            # Lens uses zero-valued unconditional features + all-False mask for
            # empty negatives (NOT an encoded empty string), matching
            # microsoft/Lens encode_prompt. The all-False mask drops the
            # negative tokens from attention entirely.
            neg_features = mx.zeros_like(features)
            neg_mask = mx.zeros_like(mask)
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
        # Dynamic mu: Lens calibrates the flow-matching shift from latent seq
        # length (resolution) AND num_steps (microsoft/Lens compute_empirical_mu).
        # The constructor shift (1.829) is only the ~1440×1440 value; 512² wants
        # ~1.92, 1024² wants ~2.20.
        seq_len = (vae_h // 2) * (vae_w // 2)   # patchified tokens = height//16
        mu = _compute_empirical_mu(seq_len, steps)
        sigmas = _make_timesteps(steps, shift=mu)
        sigmas_next = mx.concatenate([sigmas[1:], mx.array([0.0])])

        # ── Denoising loop ───────────────────────────────────────────────
        # The UNet operates entirely in PATCHIFIED space [B, 128, h, w]: input is
        # patchified latents, output is a patchified velocity. Euler steps run in
        # patchified space; we depatchify only once at the end for the VAE.
        t0 = time.time()
        for i, (sigma, sigma_next_val) in enumerate(
            zip(sigmas.tolist(), sigmas_next.tolist())
        ):
            # model_sampling.timestep(sigma)=sigma; *1000 happens inside the
            # timestep sinusoidal embedding (time_factor=1000), so feed sigma*1000.
            t_step = mx.array([sigma * 1000.0], dtype=mx.bfloat16)

            # Classifier-free guidance with Lens norm-rescaling. The combined
            # velocity is rescaled to the cond velocity's per-token L2 norm
            # (over channels), matching microsoft/Lens __call__. This prevents
            # CFG from inflating velocity magnitude (which otherwise
            # over-exposes / over-contrasts the output).
            if cfg > 1.0:
                v_cond = self._unet(latents, t_step, features, mask)
                v_uncond = self._unet(latents, t_step, neg_features, neg_mask)
                mx.eval(v_cond, v_uncond)
                comb = v_uncond + cfg * (v_cond - v_uncond)
                comb_f = comb.astype(mx.float32)
                cond_norm = mx.sqrt((v_cond.astype(mx.float32) ** 2).sum(axis=1, keepdims=True) + 1e-12)
                comb_norm = mx.sqrt((comb_f ** 2).sum(axis=1, keepdims=True) + 1e-12)
                scale = mx.where(comb_norm > 0, cond_norm / mx.maximum(comb_norm, 1e-12), mx.ones_like(comb_norm))
                pred_v = (comb_f * scale).astype(comb.dtype)
            else:
                pred_v = self._unet(latents, t_step, features, mask)
                mx.eval(pred_v)

            # Euler step in patchified space (velocity matching):
            #   x_{t-dt} = x_t + v * (sigma_next - sigma)
            latents = latents + pred_v * (sigma_next_val - sigma)
            mx.eval(latents)
            pct = int((i + 1) / steps * 100)
            print(f"[Lens] step {i+1}/{steps}  {pct}%  σ={sigma:.3f}", flush=True)
        timings["denoise"] = time.time() - t0
        print(f"[Lens] Denoised in {timings['denoise']:.1f}s")

        # ── VAE decode ───────────────────────────────────────────────────
        t0 = time.time()
        # latents is patchified [1, 128, h, w] in BN-normalized space.
        # _vae_decode applies the Flux2 BN de-normalization + unpatchify
        # before decoding.
        pixels = self._vae_decode(latents)  # [1, H, W, 3]
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
