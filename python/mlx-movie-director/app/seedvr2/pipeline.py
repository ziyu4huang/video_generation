"""SeedVR2 upscale pipeline — load models, upscale image, return PIL Image."""

import gc
import os
import time

import mlx.core as mx
import mlx.nn as nn
import mlx.utils
import numpy as np
from PIL import Image

from app import config as cfg
from app.seedvr2.transformer import SeedVR2Transformer
from app.seedvr2.vae import SeedVR2VAE
from app.seedvr2.text_embeddings import SeedVR2TextEmbeddings
from app.seedvr2.latent_creator import SeedVR2LatentCreator
from app.seedvr2 import upscaler as sv2_util


def _quantize_predicate(path: str, module) -> bool:
    """Skip quantization for Conv layers and small Linear layers (last dim not divisible by 64)."""
    if isinstance(module, (nn.Conv2d, nn.Conv3d)):
        return False
    if not hasattr(module, "to_quantized"):
        return False
    if isinstance(module, nn.Linear):
        if hasattr(module, "weight") and module.weight.shape[-1] % 64 != 0:
            return False
    return True


class SeedVR2Upscaler:
    """Diffusion-based AI upscaler using SeedVR2 (3B/7B).

    Usage:
        upscaler = SeedVR2Upscaler(model_size="7b")
        result = upscaler.upscale(pil_image, resolution=2160, softness=0.5, seed=42)
        result.save("output_upscaled.png")
    """

    def __init__(self, model_size: str = "7b"):
        self.model_size = model_size
        self.transformer = None
        self.vae = None
        self.txt_pos = None

    def _load_models(self) -> None:
        """Lazy-load models on first use."""
        if self.transformer is not None:
            return

        mx.set_cache_limit(0)

        # --- Transformer ---
        dit_dir = cfg.SEEDVR2_DIT_DIR
        if not os.path.exists(os.path.join(dit_dir, "model.safetensors")):
            raise FileNotFoundError(
                f"SeedVR2 DiT model not found at {dit_dir}.\n"
                f"Run: python/venv/bin/python python/mlx-movie-director/convert.py --seedvr2-dit"
            )

        print("[SeedVR2] Loading transformer (4-bit)...")
        t0 = time.time()
        transformer_config = self._get_transformer_config()
        self.transformer = SeedVR2Transformer(**transformer_config)
        # Quantize model structure to match pre-converted weights (skip small dims)
        nn.quantize(
            self.transformer, bits=4, group_size=32,
            class_predicate=_quantize_predicate,
        )
        # Load weights, ignoring params that don't belong to current config
        # (e.g. out_scale/out_shift/vid_out_norm when use_output_ada=False)
        saved = mx.load(os.path.join(dit_dir, "model.safetensors"))
        model_keys = set(
            k for k, _ in mlx.utils.tree_flatten(self.transformer.parameters())
        )
        filtered = [(k, v) for k, v in saved.items() if k in model_keys]
        self.transformer.load_weights(filtered)
        mx.eval(self.transformer.parameters())
        print(f"[SeedVR2] Transformer loaded ({time.time() - t0:.1f}s)")

        # --- VAE ---
        vae_dir = cfg.SEEDVR2_VAE_DIR
        if not os.path.exists(os.path.join(vae_dir, "model.safetensors")):
            raise FileNotFoundError(
                f"SeedVR2 VAE model not found at {vae_dir}.\n"
                f"Run: python/venv/bin/python python/mlx-movie-director/convert.py --seedvr2-vae"
            )

        print("[SeedVR2] Loading VAE...")
        t0 = time.time()
        self.vae = SeedVR2VAE()
        self.vae.load_weights(os.path.join(vae_dir, "model.safetensors"))
        mx.eval(self.vae.parameters())
        print(f"[SeedVR2] VAE loaded ({time.time() - t0:.1f}s)")

        # --- Text embeddings ---
        print("[SeedVR2] Loading text embeddings...")
        self.txt_pos = SeedVR2TextEmbeddings.load_positive()

    def _get_transformer_config(self) -> dict:
        if self.model_size == "7b":
            return dict(
                vid_dim=3072,
                txt_in_dim=5120,
                txt_dim=3072,
                emb_dim=18432,
                heads=24,
                num_layers=36,
                mm_layers=36,
                rope_dim=64,
                rope_on_text=False,
                rope_freqs_for="pixel",
                use_output_ada=False,
                last_layer_vid_only=True,  # matches converted weights
                window=(4, 3, 3),
                mlp_type="normal",
            )
        else:  # 3b
            return dict(
                vid_dim=2560,
                txt_in_dim=5120,
                txt_dim=2560,
                emb_dim=15360,
                heads=20,
                num_layers=32,
                mm_layers=10,
                rope_dim=128,
                rope_on_text=True,
                window=(4, 3, 3),
            )

    def upscale(
        self,
        image: Image.Image,
        resolution: int | float = 2.0,
        softness: float = 0.5,
        seed: int = 42,
    ) -> Image.Image:
        """Upscale a PIL image using SeedVR2 diffusion.

        Args:
            image: Input PIL image (RGB).
            resolution: Target shortest-side pixels (e.g. 2160) or scale factor (e.g. 2.0, 3.0).
            softness: Input pre-downsampling factor 0.0-1.0 (0 = none, 0.5 = moderate).
            seed: Random seed for reproducibility.

        Returns:
            Upscaled PIL image.
        """
        self._load_models()
        total_start = time.time()

        # 1. Preprocess
        print(f"[SeedVR2] Preprocessing (resolution={resolution}, softness={softness})...")
        processed_image, true_height, true_width = sv2_util.preprocess_image(
            image, resolution, softness,
        )

        # 2. VAE encode
        t0 = time.time()
        print("[SeedVR2] VAE encoding...")
        initial_latent = self.vae.encode(processed_image)
        mx.eval(initial_latent)
        print(f"[SeedVR2] VAE encode done ({time.time() - t0:.1f}s) → latent {list(initial_latent.shape)}")

        # 3. Create conditioning
        static_condition = SeedVR2LatentCreator.create_condition(encoded_latent=initial_latent)

        # 4. Create noise latents
        h_lat = initial_latent.shape[3]
        w_lat = initial_latent.shape[4]
        latents = SeedVR2LatentCreator.create_noise_latents(
            seed=seed, height=h_lat, width=w_lat,
        )

        # 5. Denoise (1 step — SeedVR2 is designed for single-step)
        t0 = time.time()
        print("[SeedVR2] Denoising (1 step)...")
        model_input = mx.concatenate([latents, static_condition], axis=1)

        # Raw timestep from SeedVR2EulerScheduler (num_train_timesteps=1000, 1 inference step)
        # The transformer's TimeEmbedding expects raw values 0–1000, not normalized 0–1.
        timestep = mx.array(1000.0)

        noise_pred = self.transformer(
            vid=model_input,
            txt=self.txt_pos,
            timestep=timestep,
        )

        # Euler step matching mflux SeedVR2EulerScheduler
        # For 1 step: t=1000, s=0 → pred_x_0 = latents - noise_pred
        T = 1000.0
        t_norm = 1000.0 / T  # 1.0
        s_norm = 0.0 / T     # 0.0
        pred_x_0 = latents - t_norm * noise_pred
        # s == 0, so next_sample = pred_x_0 directly
        latents = pred_x_0
        mx.eval(latents)
        print(f"[SeedVR2] Denoising done ({time.time() - t0:.1f}s)")

        # Free transformer memory before VAE decode
        del model_input, static_condition, noise_pred
        mx.clear_cache()
        gc.collect()

        # 6. VAE decode
        t0 = time.time()
        print("[SeedVR2] VAE decoding...")
        decoded = self.vae.decode(latents)
        mx.eval(decoded)
        del latents
        mx.clear_cache()
        gc.collect()
        print(f"[SeedVR2] VAE decode done ({time.time() - t0:.1f}s)")

        # 7. Crop to true dimensions and squeeze temporal dim
        decoded = decoded[:, :, :, :true_height, :true_width]
        # Squeeze temporal dim: (B, C, 1, H, W) → (B, C, H, W)
        decoded = decoded[:, :, 0, :, :]

        # 8. Color correction — match decoded colors to original preprocessed input
        print("[SeedVR2] Color correction...")
        style = processed_image[:, :, :true_height, :true_width]
        decoded = sv2_util.apply_color_correction(decoded, style)

        # 9. Convert to PIL
        img = decoded[0]  # (C, H, W)
        img = mx.transpose(img, (1, 2, 0))  # (H, W, C)
        img = (img.astype(mx.float32) + 1.0) / 2.0
        img = mx.clip(img, 0.0, 1.0)
        img_np = np.array(img * 255).round().astype("uint8")
        pil_image = Image.fromarray(img_np)

        del decoded, style, img, processed_image
        mx.clear_cache()
        gc.collect()

        total_elapsed = time.time() - total_start
        print(f"[SeedVR2] Done ({total_elapsed:.1f}s) → {pil_image.size[0]}×{pil_image.size[1]}")
        return pil_image

    def unload(self) -> None:
        """Free all loaded models from memory."""
        for attr in ('transformer', 'vae', 'txt_pos'):
            obj = getattr(self, attr, None)
            if obj is not None:
                del obj
            setattr(self, attr, None)
        mx.clear_cache()
        gc.collect()
