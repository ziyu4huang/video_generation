import mlx.core as mx
import mlx.nn as nn
import numpy as np
import json
import os
import sys
import time
import gc
from dataclasses import dataclass
from PIL import Image
from transformers import AutoTokenizer

from app.pipeline_types import GenerationResult
from app.transformer import ZImageTransformerMLX
from app.text_encoder import TextEncoderMLX
from app.lora_utils import apply_lora
from app import config as cfg


def _vae_mlx_available() -> bool:
    """Check if the MLX VAE weights exist at the configured VAE dir."""
    return os.path.exists(os.path.join(cfg.VAE_DIR, "model.safetensors"))


def _load_mlx_vae():
    """Load the MLX-native ZImage VAE from models/vae/flux-ae/model.safetensors."""
    _mflux_src = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                              "..", "vendor", "mflux", "src")
    if os.path.isdir(_mflux_src) and _mflux_src not in sys.path:
        sys.path.insert(0, _mflux_src)

    from mflux.models.z_image.model.z_image_vae import VAE as ZImageVAE
    vae = ZImageVAE()
    vae.load_weights(os.path.join(cfg.VAE_DIR, "model.safetensors"))
    mx.eval(vae.parameters())
    return vae


def create_coordinate_grid(size, start):
    d0, d1, d2 = size
    s0, s1, s2 = start
    i = mx.arange(s0, s0 + d0)
    j = mx.arange(s1, s1 + d1)
    k = mx.arange(s2, s2 + d2)
    grid_i = mx.broadcast_to(i[:, None, None], (d0, d1, d2))
    grid_j = mx.broadcast_to(j[None, :, None], (d0, d1, d2))
    grid_k = mx.broadcast_to(k[None, None, :], (d0, d1, d2))
    return mx.stack([grid_i, grid_j, grid_k], axis=-1).reshape(-1, 3)


def calculate_shift(image_seq_len, base_seq_len=256, max_seq_len=4096, base_shift=0.5, max_shift=1.15):
    m = (max_shift - base_shift) / (max_seq_len - base_seq_len)
    b = base_shift - m * base_seq_len
    return image_seq_len * m + b


def load_sharded_weights(model_path):
    index_path = os.path.join(model_path, "model.safetensors.index.json")
    weights = {}
    if os.path.exists(index_path):
        print(f"   [Loader] Detected sharded weights index: {index_path}")
        with open(index_path, "r") as f:
            index_data = json.load(f)
        shard_files = sorted(list(set(index_data["weight_map"].values())))
        for shard_file in shard_files:
            shard_path = os.path.join(model_path, shard_file)
            print(f"   [Loader] Loading shard: {shard_file}...")
            weights.update(mx.load(shard_path))
            if hasattr(mx, "clear_cache"): mx.clear_cache()
    else:
        single_path = os.path.join(model_path, "model.safetensors")
        if os.path.exists(single_path):
            weights = mx.load(single_path)
        else:
            import glob
            files = glob.glob(os.path.join(model_path, "*.safetensors"))
            for f in files:
                weights.update(mx.load(f))
    return weights


def _latent_upscale(latent_mx: mx.array, scale_factor: float) -> mx.array:
    """Bilinear upscale of latent tensor in spatial dims (keeps even dims for patchify)."""
    # MLX-native bilinear upscale using mx.nn.Upsample
    arr = latent_mx.astype(mx.float32)  # [1, C, H, W]
    _, C, H, W = arr.shape
    new_H = int(H * scale_factor)
    new_W = int(W * scale_factor)
    # Ensure even dims for patchify
    new_H -= new_H % 2
    new_W -= new_W % 2
    upsample = nn.Upsample(scale_factor=scale_factor, mode="bilinear", align_corners=False)
    scaled = upsample(arr)
    # Trim to even dims
    return scaled[:, :, :new_H, :new_W].astype(mx.bfloat16)


class MLXFlowMatchEulerScheduler:
    def __init__(self, shift: float = 3.0, use_dynamic_shifting: bool = True):
        self.shift = shift
        self.use_dynamic_shifting = use_dynamic_shifting
        self.timesteps = None

    def set_timesteps(self, num_inference_steps: int, mu: float = None):
        ts = np.linspace(1.0, 0.0, num_inference_steps + 1)

        if self.use_dynamic_shifting and mu is not None:
            ts = self._time_shift(mu, ts)

        self.timesteps = mx.array(ts).astype(mx.float32)

    def _time_shift(self, mu: float, t: np.ndarray):
        mask = t > 0
        res = np.zeros_like(t)
        res[mask] = np.exp(mu) / (np.exp(mu) + (1 / t[mask] - 1))
        return res

    def step(self, model_output, timestep_idx, sample):
        t_curr = self.timesteps[timestep_idx]
        t_prev = self.timesteps[timestep_idx + 1]
        dt = t_prev - t_curr
        prev_sample = sample + dt * model_output
        return prev_sample


class ZImagePipeline:
    def __init__(self):
        self.model_path = cfg.MODELS_DIR
        self.text_encoder_path = cfg.TEXT_ENCODER_DIR

        self._pos_cache_key = None
        self._pos_cache = None
        self._rope_cache = None

        for required_dir in [cfg.TRANSFORMER_DIR, cfg.TEXT_ENCODER_DIR, cfg.TOKENIZER_DIR, cfg.VAE_DIR]:
            if not cfg.check_model_available(required_dir):
                raise FileNotFoundError(
                    f"Model directory not available: {required_dir}\n"
                    f"Run convert.py --all first to convert and download models."
                )

    @staticmethod
    def upscale_esrgan(image: Image.Image, model_path: str) -> Image.Image:
        """Upscale PIL image using a spandrel-compatible ESRGAN model (.pth)."""
        import spandrel
        import torch
        device = "mps" if torch.backends.mps.is_available() else "cpu"
        loader = spandrel.ModelLoader(device=device)
        model_sr = loader.load_from_file(model_path)
        model_sr.eval()
        img_np = np.array(image.convert("RGB")).astype(np.float32) / 255.0
        img_pt = torch.from_numpy(img_np).permute(2, 0, 1).unsqueeze(0).to(device)
        with torch.no_grad():
            result_pt = model_sr(img_pt)
        result_np = result_pt.squeeze(0).permute(1, 2, 0).cpu().float().numpy()
        result_np = np.clip(result_np * 255, 0, 255).round().astype("uint8")
        return Image.fromarray(result_np)

    def generate(
        self,
        prompt,
        width=1024,
        height=1024,
        steps=9,
        seed=42,
        lora_path=None,
        lora_scale=1.0,
        # img2img params
        input_image: Image.Image = None,
        latent_upscale: float = 1.0,
        denoise_strength: float = 1.0,
        # post-process
        upscale: bool = False,
        upscale_model: str = None,
        upscale_method: str = "esrgan",
    ) -> "GenerationResult":
        mx.set_cache_limit(0)
        timings = {}

        label = f"{width}x{height}"
        if input_image is not None:
            label = f"img2img denoise={denoise_strength}"
            if latent_upscale != 1.0:
                label += f" latent×{latent_upscale}"
        print(f"Pipeline Started | {label} | Steps: {steps}")
        global_start = time.time()

        # ----------------------------------------------------------------
        # [Phase 0] VAE Encode input image (img2img only)
        # ----------------------------------------------------------------
        clean_latent = None
        if input_image is not None:
            t0 = time.time()
            print("[Phase 0] VAE Encoding input image...", end=" ", flush=True)

            # Resize to multiple of 16 for clean latent dims
            iw, ih = input_image.size
            iw = (iw // 16) * 16
            ih = (ih // 16) * 16
            if (iw, ih) != input_image.size:
                input_image = input_image.resize((iw, ih), Image.LANCZOS)

            img_np = np.array(input_image.convert("RGB")).astype(np.float32) / 127.5 - 1.0

            if _vae_mlx_available():
                # MLX-native VAE encode
                vae_mlx = _load_mlx_vae()
                img_mx = mx.array(img_np.transpose(2, 0, 1)[None]).astype(mx.bfloat16)  # (1, C, H, W)
                encoded = vae_mlx.encode(img_mx)  # (1, C, 1, H_lat, W_lat)
                clean_latent = encoded[:, :, 0, :, :]  # squeeze temporal dim → (1, C, H_lat, W_lat)
                del vae_mlx
            else:
                # PyTorch fallback
                import torch
                from diffusers import AutoencoderKL
                device_pt = "mps" if torch.backends.mps.is_available() else "cpu"
                vae_enc = AutoencoderKL.from_pretrained(cfg.VAE_DIR).to(device_pt)
                img_pt = torch.from_numpy(img_np).permute(2, 0, 1).unsqueeze(0).to(device_pt)
                with torch.no_grad():
                    enc = vae_enc.encode(img_pt).latent_dist.mean
                shift = getattr(vae_enc.config, "shift_factor", 0.0)
                enc = (enc - shift) * vae_enc.config.scaling_factor
                clean_latent = mx.array(enc.cpu().numpy()).astype(mx.bfloat16)
                del vae_enc, img_pt, enc

            gc.collect()
            timings["vae_encode_seconds"] = time.time() - t0
            print(f"Done ({timings['vae_encode_seconds']:.2f}s) → latent {list(clean_latent.shape)}")

            # [Phase 0.5] Latent upscale
            if latent_upscale != 1.0:
                t05 = time.time()
                print(f"[Phase 0.5] Latent ×{latent_upscale} upscale...", end=" ", flush=True)
                clean_latent = _latent_upscale(clean_latent, latent_upscale)
                timings["latent_upscale_seconds"] = time.time() - t05
                print(f"Done → {list(clean_latent.shape)}")

            # Derive generation size from latent
            _, _, H_lat, W_lat = clean_latent.shape
            height = H_lat * 8
            width = W_lat * 8

        # ----------------------------------------------------------------
        # [Phase 1] Text Encoding
        # ----------------------------------------------------------------
        t_start = time.time()
        print(f"[Phase 1] Text Encoding...", end=" ", flush=True)

        tokenizer_path = cfg.TOKENIZER_DIR
        tokenizer = AutoTokenizer.from_pretrained(tokenizer_path, trust_remote_code=True)

        te_config_path = os.path.join(self.text_encoder_path, "config.json")
        with open(te_config_path, "r") as f:
            te_config = json.load(f)

        text_encoder = TextEncoderMLX(te_config)

        quantized_weights_path = os.path.join(self.text_encoder_path, "model.safetensors")

        if os.path.exists(quantized_weights_path):
            print(f"(Fast Load: Pre-Quantized)...", end=" ", flush=True)
            nn.quantize(text_encoder, bits=4, group_size=32)
            text_encoder.load_weights(quantized_weights_path)
        else:
            print(f"(Slow Load: On-the-fly Quantization)...", end=" ", flush=True)
            te_weights = load_sharded_weights(self.text_encoder_path)
            text_encoder.load_weights(list(te_weights.items()))
            del te_weights
            nn.quantize(text_encoder, bits=4, group_size=32)

        mx.eval(text_encoder)

        messages = [{"role": "user", "content": prompt}]
        try:
            prompt_fmt = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
        except:
            prompt_fmt = prompt

        inputs = tokenizer(prompt_fmt, padding="max_length", max_length=512, truncation=True, return_tensors="np")

        prompt_embeds = text_encoder(mx.array(inputs["input_ids"]))
        mx.eval(prompt_embeds)

        cap_feats_np = np.array(prompt_embeds)
        pad = (-cap_feats_np.shape[1]) % 32
        if pad > 0:
            cap_feats_np = np.concatenate([cap_feats_np, np.repeat(cap_feats_np[:, -1:, :], pad, axis=1)], axis=1)
        cap_feats_mx = mx.array(cap_feats_np).astype(mx.bfloat16)

        del text_encoder, tokenizer
        mx.clear_cache()
        gc.collect()
        timings["text_encoding_seconds"] = time.time() - t_start
        print(f"Done ({timings['text_encoding_seconds']:.2f}s)")

        # ----------------------------------------------------------------
        # [Phase 2] Transformer Loading (4-bit)
        # ----------------------------------------------------------------
        t_start = time.time()
        trans_path = cfg.TRANSFORMER_DIR
        print(f"[Phase 2] Loading Transformer (4-bit GS32)...", end=" ", flush=True)

        with open(os.path.join(trans_path, "config.json"), "r") as f:
            config = json.load(f)

        model = ZImageTransformerMLX(config)
        nn.quantize(model, bits=4, group_size=32)

        if os.path.exists(os.path.join(trans_path, "model.safetensors.index.json")):
            weights = load_sharded_weights(trans_path)
            model.load_weights(list(weights.items()))
            del weights
        else:
            model.load_weights(os.path.join(trans_path, "model.safetensors"))

        # ----------------------------------------------------------------
        # [Phase 2.5] Apply LoRA
        # ----------------------------------------------------------------
        lora_start = time.time()
        if lora_path:
            print(f"[Phase 2.5] Applying LoRA...", end=" ", flush=True)
            model = apply_lora(model, lora_path, scale=lora_scale)
            timings["lora_apply_seconds"] = time.time() - lora_start
            print("Done")
        else:
            timings["lora_apply_seconds"] = 0.0

        print(f"Fusing QKV projection layers...", end=" ", flush=True)
        model.fuse_model()
        print("Done")

        model.eval()
        timings["transformer_load_seconds"] = time.time() - t_start
        print(f"Done ({timings['transformer_load_seconds']:.2f}s)")

        # ----------------------------------------------------------------
        # [Phase 3] Denoising (Fully MLX & Compiled)
        # ----------------------------------------------------------------
        print(f"[Phase 3] Denoising (MLX Scheduler & Compiled)...", end="\n")

        scheduler = MLXFlowMatchEulerScheduler(shift=3.0, use_dynamic_shifting=True)

        if seed is not None:
            np.random.seed(seed)

        if clean_latent is not None:
            # img2img: use clean latent shape
            noise = mx.array(np.random.randn(*clean_latent.shape)).astype(mx.bfloat16)
        else:
            noise = mx.array(np.random.randn(1, 16, height // 8, width // 8)).astype(mx.bfloat16)

        # Use latent shape as ground truth for spatial dims
        _, C_lat, H_lat, W_lat = noise.shape if clean_latent is None else clean_latent.shape
        H_tok, W_tok = H_lat // 2, W_lat // 2

        mu = calculate_shift(H_tok * W_tok)
        scheduler.set_timesteps(steps, mu=mu)

        # Determine start step for img2img
        # Use steps×strength to decide how many steps to run (matches ComfyUI denoise semantics).
        # Dynamic mu-shifting compresses timesteps near 1.0, so searching by t value is unreliable.
        start_step = 0
        if clean_latent is not None and denoise_strength < 1.0:
            steps_to_run = max(1, round(steps * denoise_strength))
            start_step = steps - steps_to_run
            t_mix = float(scheduler.timesteps[start_step])
            latents = (1.0 - t_mix) * clean_latent + t_mix * noise
            print(f"   img2img: {steps_to_run} steps from step {start_step + 1}/{steps} (t_mix={t_mix:.3f})")
        elif clean_latent is not None:
            # denoise_strength=1.0 → full re-denoise from noise
            latents = noise
        else:
            latents = noise

        total_len = cap_feats_mx.shape[1]

        cache_key = (W_lat, H_lat, total_len)
        if self._pos_cache_key == cache_key and self._pos_cache is not None:
            img_pos, cap_pos = self._pos_cache
            cos_cached, sin_cached = self._rope_cache
        else:
            img_pos = mx.array(
                create_coordinate_grid((1, H_tok, W_tok), (total_len + 1, 0, 0)).reshape(-1, 3)[None]).astype(mx.bfloat16)
            cap_pos = mx.array(create_coordinate_grid((total_len, 1, 1), (1, 0, 0)).reshape(-1, 3)[None]).astype(mx.bfloat16)

            unified_pos_all = mx.concatenate([img_pos, cap_pos], axis=1)
            cos_cached, sin_cached = model.prepare_rope(unified_pos_all)
            cos_cached = cos_cached.astype(mx.bfloat16)
            sin_cached = sin_cached.astype(mx.bfloat16)

            self._pos_cache_key = cache_key
            self._pos_cache = (img_pos, cap_pos)
            self._rope_cache = (cos_cached, sin_cached)

        @mx.compile
        def step_fn(x, t, feats, i_pos, c_pos, cos, sin):
            B, C, H, W = x.shape
            x_reshaped = x.reshape(C, 1, 1, H_tok, 2, W_tok, 2).transpose(1, 2, 3, 5, 4, 6, 0).reshape(1, -1, C * 4)
            out = model(x_reshaped, t, feats, i_pos, c_pos, cos, sin, cap_mask=None)
            noise_pred = -out.reshape(1, 1, H_tok, W_tok, 2, 2, C).transpose(6, 0, 1, 2, 4, 3, 5).reshape(1, C, H, W)
            return noise_pred

        denoise_start = time.time()
        step_times = []

        for i in range(start_step, steps):
            step_start = time.time()

            t_curr = scheduler.timesteps[i]
            t_input = (1.0 - t_curr)[None].astype(mx.bfloat16)

            noise_pred = step_fn(latents, t_input, cap_feats_mx, img_pos, cap_pos, cos_cached, sin_cached)
            latents = scheduler.step(noise_pred, i, latents)
            mx.eval(latents)

            step_elapsed = time.time() - step_start
            step_times.append(step_elapsed)
            print(f"   Step {i + 1}/{steps}: {step_elapsed:.2f}s")

        steps_run = steps - start_step
        timings["denoising_seconds"] = time.time() - denoise_start
        timings["denoising_step_times"] = step_times
        if steps_run > 0:
            print(f"   Avg Speed: {timings['denoising_seconds'] / steps_run:.2f} s/it")

        # ----------------------------------------------------------------
        # [Phase 4] Decoding (VAE with Memory Cleanup)
        # ----------------------------------------------------------------
        print("[Phase 4] Decoding...", end=" ", flush=True)
        t_dec = time.time()

        del model, scheduler, step_fn, cos_cached, sin_cached
        for _ in range(3):
            mx.clear_cache()
            gc.collect()

        if _vae_mlx_available():
            # MLX-native VAE decode
            vae_mlx = _load_mlx_vae()
            latents_mx = latents.astype(mx.bfloat16)
            decoded = vae_mlx.decode(latents_mx)  # (1, C, 1, H, W)
            if decoded.ndim == 5:
                decoded = decoded[:, :, 0, :, :]  # squeeze temporal dim
            image_np = np.array(mx.clip(decoded.astype(mx.float32) / 2.0 + 0.5, 0, 1))
            image_np = np.nan_to_num(image_np, nan=0.0, posinf=1.0, neginf=0.0)
            image_np = image_np[0].transpose(1, 2, 0)  # (C, H, W) → (H, W, C)
            pil_image = Image.fromarray((image_np * 255).round().astype("uint8"))
            del vae_mlx, decoded
        else:
            # PyTorch fallback
            import torch
            from diffusers import AutoencoderKL
            vae_path = cfg.VAE_DIR
            device = "mps" if torch.backends.mps.is_available() else "cpu"

            vae = AutoencoderKL.from_pretrained(vae_path).to(device)
            vae.enable_tiling()

            latents_pt = torch.from_numpy(np.array(latents.astype(mx.float32))).to(device)
            latents_pt = (latents_pt / vae.config.scaling_factor) + getattr(vae.config, "shift_factor", 0.0)

            with torch.no_grad():
                image = vae.decode(latents_pt).sample

            image_np = (image / 2 + 0.5).clamp(0, 1).cpu().permute(0, 2, 3, 1).numpy()
            image_np = np.nan_to_num(image_np, nan=0.0, posinf=1.0, neginf=0.0)
            pil_image = Image.fromarray((image_np[0] * 255).round().astype("uint8"))

            del vae, latents_pt, image, image_np

        gc.collect()

        timings["vae_decode_seconds"] = time.time() - t_dec
        print(f"Done ({timings['vae_decode_seconds']:.2f}s)")

        # ----------------------------------------------------------------
        # [Phase 5] Upscale (optional)
        # ----------------------------------------------------------------
        if upscale:
            if upscale_method == "seedvr2":
                t_up = time.time()
                w0, h0 = pil_image.size
                print(f"[Phase 5] SeedVR2 upscale ({w0}×{h0})...", end=" ", flush=True)
                from app.seedvr2.pipeline import SeedVR2Upscaler as _SV2
                sv2 = _SV2(model_size="7b")
                try:
                    pil_image = sv2.upscale(pil_image, resolution=2.0, softness=0.5, seed=seed or 42)
                finally:
                    sv2.unload()
                timings["seedvr2_seconds"] = time.time() - t_up
                print(f"Done ({timings['seedvr2_seconds']:.2f}s) → {pil_image.size[0]}×{pil_image.size[1]}")
            elif upscale_model:
                if not os.path.exists(upscale_model):
                    print(f"[Phase 5] ESRGAN model not found: {upscale_model} — skipping")
                else:
                    t_up = time.time()
                    w0, h0 = pil_image.size
                    print(f"[Phase 5] ESRGAN upscale ({w0}×{h0})...", end=" ", flush=True)
                    pil_image = self.upscale_esrgan(pil_image, upscale_model)
                    timings["esrgan_seconds"] = time.time() - t_up
                    print(f"Done ({timings['esrgan_seconds']:.2f}s) → {pil_image.size[0]}×{pil_image.size[1]}")

        return GenerationResult(image=pil_image, timings=timings)

        print(f"Pipeline Finished in {time.time() - global_start:.2f}s")

        return GenerationResult(image=pil_image, timings=timings)
