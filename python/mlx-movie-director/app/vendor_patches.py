"""Monkey-patches for vendor submodules.

Applies runtime fixes at import time so the vendor submodules stay clean
at upstream HEAD.

Patches for vendor/ltx-2-mlx (upstream dgrauet/ltx-2-mlx):
  1. UpSample1d.__call__   — MLX 0.31.2 .at[strided].add() Metal bug
  2. HannSincResampler      — same .at[strided].add() bug
  3. AudioVAEDecoder.decode — causal frame crop (T*4-3)
  4. LTXModelConfig         — av_ca_timestep_scale_multiplier 1.0→1000.0
                               + from_checkpoint_config classmethod
  5. _orchestration          — _load_transformer_config reads embedded_config.json;
                               load_transformer: LTX_DEV_AUDIO env var → audio stream
                               transplant (replace dasiwa/distilled audio keys with dev)
  6. TI2VidTwoStagesPipeline — audio_stage1_only param
  10. _fuse_distilled_lora   — dequantize int8 LoRA weights before fusion
  11. PromptEncoder.load +   — quantize connector to match pre-quantized weights
      load_feature_extractor    BEFORE load_weights; detects bits+group_size from
                                the model's in_features (connector is int4/g32,
                                not the int8/g64 the transformer uses)

Patches for vendor/mflux (upstream filipstrand/mflux):
  7. Flux2KleinEdit.predict  — NaN guard on transformer output (attention overflow)
  8. ImageUtil._numpy_to_pil — NaN/Inf guard before float→uint8 conversion
  9. Flux2KleinEdit + helpers — ref_strength param for reference image conditioning
  12. LoRALoader._apply_single_lora — dequantize int8 LoRA weights (int8
      key.weight + float32 key.weight.scale) before applying; without this the
      mflux image pipelines apply raw int8 (no scale) → pure-noise output
"""

from __future__ import annotations

import json as _json
import os as _os
from pathlib import Path


# ---------------------------------------------------------------------------
# Audio stream transplant helper (used by Patch 5)
# ---------------------------------------------------------------------------


def _transplant_audio_from_dev(weights: dict, dev_path: Path) -> None:
    """Replace audio stream weights in-place with those from the dev transformer.

    Uses mx.load() which lazily mmaps the safetensors file and natively handles
    all dtypes (bfloat16, int8, float32) — only accessed tensors are read from
    disk, so peak extra RAM is O(audio stream) not O(full dev checkpoint).

    Audio stream keys: anything containing "audio" or "video_to_audio"
    (covers audio_attn, audio_ff, audio_adaln_single, audio_patchify_proj,
    audio_proj_out, audio_to_video_attn, video_to_audio_attn and the
    AV cross-attention AdaLN gates).
    """
    import mlx.core as mx

    if not dev_path.exists():
        print(
            f"[load_transformer] WARNING: LTX_DEV_AUDIO path not found: {dev_path} — skipping transplant",
            flush=True,
        )
        return

    audio_keys = [k for k in weights if "audio" in k or "video_to_audio" in k]
    dev_weights = mx.load(str(dev_path))  # lazy mmap — no full file load
    n_ok = 0
    for k in audio_keys:
        dev_key = "transformer." + k
        if dev_key in dev_weights:
            weights[k] = dev_weights[dev_key]
            n_ok += 1
    print(
        f"[load_transformer] Audio transplant from dev: {n_ok}/{len(audio_keys)} keys replaced",
        flush=True,
    )


# ---------------------------------------------------------------------------
# Patch 1 — UpSample1d.__call__  (vocoder.py)
# ---------------------------------------------------------------------------


def _patch_upsample1d() -> None:
    """Fix MLX 0.31.2 .at[strided].add() mis-indexing on Metal."""
    import mlx.core as mx

    from ltx_core_mlx.model.audio_vae.vocoder import UpSample1d

    _orig_call = UpSample1d.__call__

    def __call__(self, x):  # type: ignore[no-untyped-def]
        """x: (B, T, C) -> (B, T*2, C)"""
        B, T, C = x.shape
        # MLX 0.31.2 regression: .at[strided].add() mis-indexes source on Metal.
        # Use direct assignment since x_up is freshly zeroed (add ≡ assign here).
        x_up = mx.zeros((B, T * 2, C))
        x_up[:, ::2, :] = x

        # Reshape for grouped conv1d: (B*C, T*2, 1)
        x_up = x_up.transpose(0, 2, 1).reshape(B * C, T * 2, 1)

        K = self.filter.shape[1]
        pad = K // 2
        left_edge = mx.repeat(x_up[:, :1, :], pad, axis=1)
        right_edge = mx.repeat(x_up[:, -1:, :], pad - 1, axis=1)
        x_up = mx.concatenate([left_edge, x_up, right_edge], axis=1)

        x_up = mx.conv1d(x_up, self.filter)

        T_out = x_up.shape[1]
        return x_up.reshape(B, C, T_out).transpose(0, 2, 1) * 2.0

    UpSample1d.__call__ = __call__


# ---------------------------------------------------------------------------
# Patch 2 — HannSincResampler.__call__  (bwe.py)
# ---------------------------------------------------------------------------


def _patch_hann_sinc_resampler() -> None:
    """Fix MLX 0.31.2 .at[strided].add() mis-indexing on Metal."""
    import mlx.core as mx

    from ltx_core_mlx.model.audio_vae.bwe import HannSincResampler

    _orig_call = HannSincResampler.__call__

    def __call__(self, x):  # type: ignore[no-untyped-def]
        """Upsample: (B, T) -> (B, T * factor)."""
        B, T = x.shape
        ratio = self.upsample_factor

        # 1. Replicate-pad input
        first = mx.repeat(x[:, :1], self._pad, axis=1)
        last = mx.repeat(x[:, -1:], self._pad, axis=1)
        x_padded = mx.concatenate([first, x, last], axis=1)
        T_padded = x_padded.shape[1]

        # 2. Zero-insert between samples
        zi_len = (T_padded - 1) * ratio + 1
        # MLX 0.31.2 regression: .at[strided].add() mis-indexes source on Metal.
        # Use direct assignment since upsampled is freshly zeroed (add ≡ assign here).
        upsampled = mx.zeros((B, zi_len))
        upsampled[:, ::ratio] = x_padded

        # 3. Full convolution via zero-pad + valid conv1d
        upsampled = upsampled[:, :, None]
        K = self.kernel.shape[0]
        upsampled = mx.pad(upsampled, [(0, 0), (K - 1, K - 1), (0, 0)])
        filt = self.kernel[None, :, :]
        result = mx.conv1d(upsampled, filt, padding=0)
        result = result.squeeze(-1)

        # 4. Scale by ratio
        result = result * ratio

        # 5. Slice to match reference output
        result = result[:, self._pad_left : -self._pad_right]
        return result[:, : T * ratio]

    HannSincResampler.__call__ = __call__


# ---------------------------------------------------------------------------
# Patch 3 — AudioVAEDecoder.decode  (audio_vae.py)
# ---------------------------------------------------------------------------


def _patch_audio_vae_decoder() -> None:
    """Add causal frame crop: target_frames = max(T * 4 - 3, 1)."""
    import mlx.core as mx
    import mlx.nn as nn

    import ltx_core_mlx.model.audio_vae.audio_vae as _m
    from ltx_core_mlx.model.audio_vae.audio_vae import AudioVAEDecoder

    _pixel_norm = _m.pixel_norm

    def decode(self, latent):  # type: ignore[no-untyped-def]
        """Decode audio latent to mel spectrogram.

        Args:
            latent: (B, 8, T, 16) audio latent.

        Returns:
            Mel spectrogram (B, 2, T', 64) where T' = T * 4 - 3 (causal).
        """
        B, C1, T, C2 = latent.shape

        # Compute target output frames: latent_downsample=4, causal offset=3
        target_frames = max(T * 4 - 3, 1)

        # Flatten to (B, T, 128) for denormalization
        x_flat = latent.transpose(0, 2, 1, 3).reshape(B, T, C1 * C2)

        # Denormalize using per-channel statistics
        mean = self.per_channel_statistics.mean_of_means.reshape(1, 1, -1)
        std = self.per_channel_statistics.std_of_means.reshape(1, 1, -1)
        x_flat = x_flat * std + mean

        # Reshape back to 2D spatial
        x = x_flat.reshape(B, T, C1, C2).transpose(0, 1, 3, 2)

        x = self.conv_in(x)
        x = self.mid(x)

        for i in reversed(range(len(self.up))):
            x = self.up[i](x)

        x = _pixel_norm(x)
        x = nn.silu(x)
        x = self.conv_out(x)

        # Convert to (B, 2, T', 64)
        x = x.transpose(0, 3, 1, 2)

        # Adjust output shape to match target_frames (upstream _adjust_output_shape).
        # Causal convolutions produce T*4 frames; upstream crops to T*4 - 3.
        actual_frames = x.shape[2]
        if actual_frames > target_frames:
            x = x[:, :, :target_frames, :]
        elif actual_frames < target_frames:
            x = mx.pad(x, [(0, 0), (0, 0), (0, target_frames - actual_frames), (0, 0)])

        return x

    AudioVAEDecoder.decode = decode


# ---------------------------------------------------------------------------
# Patch 4 — LTXModelConfig  (model.py)
# ---------------------------------------------------------------------------


def _patch_ltx_model_config() -> None:
    """Fix default av_ca_timestep_scale_multiplier 1.0 → 1000.0.

    Also adds ``from_checkpoint_config`` classmethod that reads
    embedded_config.json values (especially av_ca_timestep_scale_multiplier).
    """
    from ltx_core_mlx.model.transformer.model import LTXModelConfig

    # Override the default field value
    LTXModelConfig.av_ca_timestep_scale_multiplier = 1000.0

    @classmethod
    def from_checkpoint_config(cls, cfg: dict) -> LTXModelConfig:  # type: ignore[no-untyped-def]
        """Construct config from embedded_config.json transformer section.

        The checkpoint metadata stores the authoritative values for
        ``timestep_scale_multiplier`` and ``av_ca_timestep_scale_multiplier``.
        The ``av_ca`` value is critical for audio quality: when set to 1.0
        instead of 1000.0, the AV cross-attention gate is attenuated by 1000x,
        effectively zeroing speech information.
        """
        return cls(
            num_layers=cfg.get("num_layers", 48),
            video_num_heads=cfg.get("num_attention_heads", 32),
            video_head_dim=cfg.get("attention_head_dim", 128),
            audio_num_heads=cfg.get("audio_num_attention_heads", 32),
            audio_head_dim=cfg.get("audio_attention_head_dim", 64),
            video_patch_channels=cfg.get("in_channels", 128),
            audio_patch_channels=cfg.get("audio_in_channels", 128),
            timestep_scale_multiplier=float(cfg.get("timestep_scale_multiplier", 1000.0)),
            av_ca_timestep_scale_multiplier=float(cfg.get("av_ca_timestep_scale_multiplier", 1000.0)),
            rope_theta=cfg.get("positional_embedding_theta", 10000.0),
            rope_type=cfg.get("rope_type", "split"),
            positional_embedding_max_pos=tuple(cfg.get("positional_embedding_max_pos", [20, 2048, 2048])),
            audio_positional_embedding_max_pos=tuple(cfg.get("audio_positional_embedding_max_pos", [20])),
            norm_eps=cfg.get("norm_eps", 1e-6),
        )

    LTXModelConfig.from_checkpoint_config = from_checkpoint_config


# ---------------------------------------------------------------------------
# Patch 5 — _orchestration.py  (load_transformer)
# ---------------------------------------------------------------------------


def _patch_orchestration() -> None:
    """Replace load_transformer to read config from embedded_config.json."""
    import mlx.core as mx

    from ltx_core_mlx.model.transformer.model import LTXModel, LTXModelConfig
    from ltx_core_mlx.utils.memory import aggressive_cleanup
    from ltx_core_mlx.utils.weights import apply_quantization, load_split_safetensors

    import ltx_pipelines_mlx.utils._orchestration as _orch

    def _load_transformer_config(model_dir: Path) -> LTXModelConfig:  # type: ignore[no-untyped-def]
        """Read transformer config from ``embedded_config.json`` if available."""
        cfg_path = model_dir / "embedded_config.json"
        if cfg_path.exists():
            cfg_raw = _json.loads(cfg_path.read_text())
            transformer_cfg = cfg_raw.get("transformer", cfg_raw)
            config = LTXModelConfig.from_checkpoint_config(transformer_cfg)
            print(
                f"[load_transformer] Config from {cfg_path.name}: "
                f"av_ca_timestep_scale_multiplier={config.av_ca_timestep_scale_multiplier}, "
                f"timestep_scale_multiplier={config.timestep_scale_multiplier}"
            )
            return config
        print(
            "[load_transformer] No embedded_config.json found — using defaults "
            "(av_ca_timestep_scale_multiplier=1000.0)"
        )
        return LTXModelConfig()

    def load_transformer(transformer_path, *, low_ram_streaming=False):  # type: ignore[no-untyped-def]
        """Build an LTXModel from safetensors with optional block streaming.

        Reads embedded_config.json from the model directory to load
        checkpoint-specific config.  If LTX_DEV_AUDIO is set to the dev
        transformer safetensors path, replaces all audio stream keys in the
        loaded weights dict with those from the dev checkpoint before building
        the model — giving dasiwa/distilled video quality with dev zh audio.
        """
        config = _load_transformer_config(transformer_path.parent)
        dit = LTXModel(config=config)
        weights = load_split_safetensors(transformer_path, prefix="transformer.")
        dev_audio_path_str = _os.environ.get("LTX_DEV_AUDIO", "")
        if dev_audio_path_str and str(transformer_path) != dev_audio_path_str:
            if low_ram_streaming:
                print(
                    "[load_transformer] WARNING: --dev-audio not supported with --low-ram "
                    "(block streaming bypasses weight dict) — audio transplant skipped",
                    flush=True,
                )
            else:
                _transplant_audio_from_dev(weights, Path(dev_audio_path_str))
        if low_ram_streaming:
            from ltx_core_mlx.loader.block_streaming import BlockStreamer, StreamingLTXModel

            dit.transformer_blocks = [dit.transformer_blocks[0]]
            apply_quantization(dit, weights)
            non_block = [(k, v) for k, v in weights.items() if not k.startswith("transformer_blocks.")]
            dit.load_weights(non_block, strict=False)
            streamer = BlockStreamer(transformer_path, block_prefix="transformer.transformer_blocks.")
            dit = StreamingLTXModel(dit, streamer)
        else:
            apply_quantization(dit, weights)
            dit.load_weights(list(weights.items()))
        mx.eval(dit.parameters())
        aggressive_cleanup()
        return dit

    _orch._load_transformer_config = _load_transformer_config
    _orch.load_transformer = load_transformer


# ---------------------------------------------------------------------------
# Patch 6 — TI2VidTwoStagesPipeline  (ti2vid_two_stages.py)
# ---------------------------------------------------------------------------


def _patch_ti2vid() -> None:
    """Add audio_stage1_only parameter to generate_two_stage and generate_and_save.

    Strategy: The upstream ``generate_two_stage`` stores ``output_1`` as a
    local variable — we can't access it from a wrapper.  Instead, when
    ``audio_stage1_only=True``, we temporarily wrap the module-level
    ``guided_denoise_loop`` (imported by the ti2vid module) to capture
    ``output_1.audio_latent``.  After the original method returns, we
    re-compute the audio latent from the captured stage-1 data.
    """
    import ltx_pipelines_mlx.ti2vid_two_stages as _ti2vid_mod
    from ltx_pipelines_mlx.ti2vid_two_stages import TI2VidTwoStagesPipeline

    _orig_g2s = TI2VidTwoStagesPipeline.generate_two_stage
    _orig_gas = TI2VidTwoStagesPipeline.generate_and_save
    _orig_gdl = _ti2vid_mod.guided_denoise_loop

    def generate_two_stage(self, *args, audio_stage1_only=False, **kwargs):  # type: ignore[no-untyped-def]
        # Check both explicit param and instance flag (set by generate_and_save wrapper)
        audio_stage1_only = audio_stage1_only or getattr(self, "_vendor_audio_stage1_only", False)
        if not audio_stage1_only:
            return _orig_g2s(self, *args, **kwargs)

        # audio_stage1_only=True: capture output_1.audio_latent by
        # temporarily wrapping the module-level guided_denoise_loop.
        _captured: dict = {}

        def _capturing_gdl(*a, **kw):  # type: ignore[no-untyped-def]
            result = _orig_gdl(*a, **kw)
            _captured["audio_latent"] = result.audio_latent
            return result

        _ti2vid_mod.guided_denoise_loop = _capturing_gdl
        try:
            video_latent, _audio_latent_s2 = _orig_g2s(self, *args, **kwargs)
        finally:
            _ti2vid_mod.guided_denoise_loop = _orig_gdl

        if "audio_latent" in _captured:
            audio_latent = self.audio_patchifier.unpatchify(_captured["audio_latent"])
            return video_latent, audio_latent

        # Fallback (shouldn't happen)
        return video_latent, _audio_latent_s2

    def generate_and_save(self, *args, audio_stage1_only=False, **kwargs):  # type: ignore[no-untyped-def]
        # Store flag on self so our generate_two_stage wrapper can see it.
        self._vendor_audio_stage1_only = audio_stage1_only  # type: ignore[attr-defined]
        try:
            return _orig_gas(self, *args, **kwargs)
        finally:
            if hasattr(self, "_vendor_audio_stage1_only"):
                del self._vendor_audio_stage1_only  # type: ignore[attr-defined]

    TI2VidTwoStagesPipeline.generate_two_stage = generate_two_stage
    TI2VidTwoStagesPipeline.generate_and_save = generate_and_save


# ---------------------------------------------------------------------------
# Apply all patches
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# Patch 7 — Flux2KleinEdit._predict  (mflux: flux2_klein_edit.py)
# ---------------------------------------------------------------------------


def _patch_klein_edit_nan_guard() -> None:
    """Add mx.nan_to_num() guard on transformer noise output.

    When many reference images are concatenated into a long sequence, the
    attention softmax can overflow and produce NaN/Inf in the noise
    prediction.  This replaces NaN with 0.0 so downstream CFG arithmetic
    doesn't propagate garbage.

    Strategy: replace ``Flux2KleinEdit._predict`` entirely — the inner
    ``predict()`` closure is identical to upstream except for two added
    ``mx.nan_to_num()`` calls on the noise predictions.
    """
    import mlx.core as mx

    from mflux.models.flux2.variants.edit.flux2_klein_edit import Flux2KleinEdit
    from mflux.utils.apple_silicon import AppleSiliconUtil

    @staticmethod
    def _patched_predict(transformer):  # type: ignore[no-untyped-def]
        def predict(
            latents: mx.array,
            image_latents: mx.array,
            latent_ids: mx.array,
            image_latent_ids: mx.array,
            prompt_embeds: mx.array,
            text_ids: mx.array,
            negative_prompt_embeds: mx.array | None,
            negative_text_ids: mx.array | None,
            guidance: float,
            timestep: mx.array,
        ) -> mx.array:
            hidden_states = mx.concatenate([latents, image_latents], axis=1)
            img_ids = mx.concatenate([latent_ids, image_latent_ids], axis=1)

            noise = transformer(
                hidden_states=hidden_states,
                encoder_hidden_states=prompt_embeds,
                timestep=timestep,
                img_ids=img_ids,
                txt_ids=text_ids,
                guidance=None,
            )
            noise = noise[:, : latents.shape[1]]
            # Guard against NaN/Inf from attention overflow when reference
            # image count is high (long concatenated sequence → softmax overflow)
            noise = mx.nan_to_num(noise, nan=0.0)
            if negative_prompt_embeds is not None and negative_text_ids is not None:
                negative_noise = transformer(
                    hidden_states=hidden_states,
                    encoder_hidden_states=negative_prompt_embeds,
                    timestep=timestep,
                    img_ids=img_ids,
                    txt_ids=negative_text_ids,
                    guidance=None,
                )
                negative_noise = negative_noise[:, : latents.shape[1]]
                negative_noise = mx.nan_to_num(negative_noise, nan=0.0)
                noise = negative_noise + guidance * (noise - negative_noise)
            return noise

        if AppleSiliconUtil.is_m1_or_m2():
            return predict
        return mx.compile(predict)

    Flux2KleinEdit._predict = _patched_predict


# ---------------------------------------------------------------------------
# Patch 8 — ImageUtil._numpy_to_pil  (mflux: image_util.py)
# ---------------------------------------------------------------------------


def _patch_image_util_nan_guard() -> None:
    """Add NaN/Inf guard before float→uint8 conversion in _numpy_to_pil.

    Without this, NaN values cause the final image to be black or garbled
    when upstream model outputs contain numerical instabilities.
    """
    import numpy as np

    from mflux.utils.image_util import ImageUtil

    _orig_numpy_to_pil = ImageUtil._numpy_to_pil

    @staticmethod
    def _numpy_to_pil(images: np.ndarray):  # type: ignore[no-untyped-def]
        images = np.nan_to_num(images, nan=0.0, posinf=1.0, neginf=0.0)
        images = np.clip(images, 0.0, 1.0)
        return _orig_numpy_to_pil(images)

    ImageUtil._numpy_to_pil = _numpy_to_pil


# ---------------------------------------------------------------------------
# Patch 9 — Flux2KleinEdit ref_strength  (mflux: flux2_klein_edit.py + helpers)
# ---------------------------------------------------------------------------


def _patch_klein_edit_ref_strength() -> None:
    """Add ref_strength parameter to Flux2KleinEdit reference image conditioning.

    Upstream ``generate_image()`` and ``prepare_reference_image_conditioning()``
    have no way to scale reference latents.  This patch adds a ``ref_strength``
    parameter (default 1.0) that multiplies packed reference latents, allowing
    finer control over how strongly reference images influence generation.

    Strategy: wrap ``generate_image`` to capture ``ref_strength`` into a
    closure variable; wrap ``prepare_reference_image_conditioning`` to read
    from that variable.  The original methods are NOT aware of ``ref_strength``.
    """
    from mflux.models.flux2.variants.edit.flux2_klein_edit import Flux2KleinEdit
    from mflux.models.flux2.variants.edit.flux2_klein_edit_helpers import (
        _Flux2KleinEditHelpers,
    )

    _orig_generate_image = Flux2KleinEdit.generate_image
    _orig_prepare_ref = _Flux2KleinEditHelpers.prepare_reference_image_conditioning

    # Mutable holder so the two wrappers share state.  Single-threaded only.
    _current_ref_strength = [1.0]

    def generate_image(self, *args, ref_strength: float = 1.0, **kwargs):  # type: ignore[no-untyped-def]
        _current_ref_strength[0] = ref_strength
        return _orig_generate_image(self, *args, **kwargs)

    @staticmethod
    def prepare_reference_image_conditioning(  # type: ignore[no-untyped-def]
        **kwargs,
    ):
        ref_strength = _current_ref_strength[0]
        image_latents, image_latent_ids = _orig_prepare_ref(**kwargs)
        if image_latents is not None and ref_strength not in (1.0, None):
            import mlx.core as mx

            image_latents = image_latents * ref_strength
            mx.eval(image_latents)
        return image_latents, image_latent_ids

    Flux2KleinEdit.generate_image = generate_image
    _Flux2KleinEditHelpers.prepare_reference_image_conditioning = prepare_reference_image_conditioning


# ---------------------------------------------------------------------------
# Apply all patches
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# Patch 10 — dequantize int8 LoRA weights in _fuse_distilled_lora
# ---------------------------------------------------------------------------


def _patch_int8_lora() -> None:
    """Dequantize int8-quantized LoRA weights in TI2VidTwoStagesPipeline.

    When a distilled LoRA file has been converted to int8 (via
    ``scripts/convert_lora_mlx.py``), weights are stored as int8 with
    per-tensor float32 scale keys (``key.scale``).  After ``mx.load()``,
    the raw int8 values need to be multiplied by their scale before
    remapping and fusion.

    Strategy: patch ``_fuse_distilled_lora`` to insert the dequantize
    step between ``mx.load()`` and ``_remap_lora_keys()``.
    """
    import mlx.core as mx

    from ltx_pipelines_mlx.ti2vid_two_stages import TI2VidTwoStagesPipeline

    _orig_fuse = TI2VidTwoStagesPipeline._fuse_distilled_lora

    def _patched_fuse_distilled_lora(self, dit):  # type: ignore[no-untyped-def]
        # For low_ram_streaming at default strength (1.0), swap to pre-fused
        # transformer-distilled.safetensors streamer (original behavior).
        # For non-1.0 strength (e.g. dasiwa uses 0.999), the original
        # _swap_to_distilled_streamer() tries to load the non-existent bf16
        # LoRA file.  Instead resolve the int8 LoRA and attach it as a
        # BlockLoraSource so bind-time fusion uses the available int8 file.
        if self.low_ram_streaming:
            if abs(self._distilled_lora_strength - 1.0) <= 1e-6:
                # Default strength → pre-fused streamer swap (original path).
                self._swap_to_distilled_streamer()
                return
            # Non-default strength (e.g. 0.999 for dasiwa) → the original
            # _swap_to_distilled_streamer() requires a bf16 LoRA at
            # self._distilled_lora.  Dasiwa ships only int8 LoRA files.
            # Resolve the int8 file, dequantize the A/B weights into bf16,
            # and attach the result as a BlockLoraSource for bind-time fusion.
            from pathlib import Path
            lora_stem = Path(self._distilled_lora).stem
            bf16_lora = self.model_dir / self._distilled_lora
            if bf16_lora.exists():
                # bf16 LoRA exists — let original streaming path handle it.
                self._swap_to_distilled_streamer()
                return
            # Resolve int8 LoRA.
            int8_versioned = sorted(self.model_dir.glob(f"{lora_stem}-*.int8.safetensors"))
            int8_path = self.model_dir / f"{lora_stem}.int8.safetensors"
            if int8_versioned:
                lora_path = int8_versioned[-1]
            elif int8_path.exists():
                lora_path = int8_path
            else:
                raise FileNotFoundError(
                    f"Distilled LoRA not found at {bf16_lora} (or .int8 variant). "
                    "Use: --model dgrauet/ltx-2.3-mlx-q8"
                )
            print(f"  [int8 LoRA / low-ram] Dequantizing and building DictBlockLoraSource: {lora_path.name}")

            class _DictBlockLoraSource:
                """BlockLoraSource-compatible class backed by a pre-loaded dict.

                Accepts a dict of dequantized+remapped LoRA weights with keys
                like ``{idx}.{param}.lora_A.weight`` (relative to block_prefix)
                and exposes the same has_block/get_block_lora_dict/close API.
                """

                def __init__(self, lora_data: dict, block_prefix: str, strength: float) -> None:
                    self.strength = strength
                    self._lora_data = lora_data
                    self._block_keys: dict[int, dict[str, dict[str, str]]] = {}
                    for model_key in lora_data:
                        if not model_key.startswith(block_prefix):
                            continue
                        rest = model_key[len(block_prefix):]
                        idx_str, _, param_path = rest.partition(".")
                        try:
                            block_idx = int(idx_str)
                        except ValueError:
                            continue
                        for suffix, slot in ((".lora_A.weight", "a"), (".lora_B.weight", "b")):
                            if param_path.endswith(suffix):
                                param_name = param_path[: -len(suffix)]
                                self._block_keys.setdefault(block_idx, {}).setdefault(param_name, {})[slot] = model_key
                                break

                def has_block(self, block_idx: int) -> bool:
                    block = self._block_keys.get(block_idx)
                    if not block:
                        return False
                    return any("a" in slots and "b" in slots for slots in block.values())

                def get_block_lora_dict(self, block_idx: int) -> dict:
                    out = {}
                    block = self._block_keys.get(block_idx, {})
                    for param_name, slots in block.items():
                        if "a" not in slots or "b" not in slots:
                            continue
                        out[f"{param_name}.lora_A.weight"] = self._lora_data[slots["a"]]
                        out[f"{param_name}.lora_B.weight"] = self._lora_data[slots["b"]]
                    return out

                def close(self) -> None:
                    self._lora_data = {}
                    self._block_keys = {}

            # Load and dequantize: int8 * scale → bf16.
            raw = dict(mx.load(str(lora_path)))
            scale_keys = {k for k in raw if k.endswith(".scale")}
            if scale_keys:
                deq: dict[str, mx.array] = {}
                for k, v in raw.items():
                    if k.endswith(".scale"):
                        continue
                    sk = f"{k}.scale"
                    if sk in scale_keys:
                        deq[k] = (v.astype(mx.float32) * raw[sk].astype(mx.float32)).astype(mx.bfloat16)
                    else:
                        deq[k] = v
                raw = deq

            # Remap keys: diffusion_model.transformer_blocks.* → transformer_blocks.*
            from ltx_core_mlx.loader.sd_ops import LTXV_LORA_COMFY_RENAMING_MAP
            remapped_lora: dict[str, mx.array] = {}
            for k, v in raw.items():
                mk = LTXV_LORA_COMFY_RENAMING_MAP.apply_to_key(k)
                if mk is not None:
                    remapped_lora[mk] = v
            del raw

            lora_source = _DictBlockLoraSource(
                remapped_lora,
                block_prefix="transformer_blocks.",
                strength=self._distilled_lora_strength,
            )
            try:
                existing = list(object.__getattribute__(dit, "_lora_sources"))
            except AttributeError:
                existing = []
            existing.append(lora_source)
            object.__setattr__(dit, "_lora_sources", existing)
            from ltx_core_mlx.utils.memory import aggressive_cleanup
            aggressive_cleanup()
            return

        from pathlib import Path

        lora_stem = Path(self._distilled_lora).stem
        # Prefer int8-quantized file (*.int8.safetensors) over original bf16
        int8_path = self.model_dir / f"{lora_stem}.int8.safetensors"
        int8_versioned = sorted(self.model_dir.glob(f"{lora_stem}-*.int8.safetensors"))
        if int8_versioned:
            lora_path = int8_versioned[-1]  # latest versioned int8
        elif int8_path.exists():
            lora_path = int8_path
        else:
            lora_path = self._resolve_safetensors(self.model_dir, lora_stem)
        if not lora_path.exists():
            raise FileNotFoundError(
                f"Distilled LoRA not found: {lora_path}\n"
                "Two-stage requires the distilled LoRA for Stage 2.\n"
                "Use: --model dgrauet/ltx-2.3-mlx-q8"
            )
        if str(lora_path).endswith(".int8.safetensors"):
            print(f"  [int8 LoRA] Loading quantized: {lora_path.name}")
        lora_raw = dict(mx.load(str(lora_path)))

        # ---- Int8 dequantize step ----
        # Detect int8 tensors with companion .scale keys and dequantize
        scale_keys = {k for k in lora_raw if k.endswith(".scale")}
        if scale_keys:
            dequantized: dict[str, mx.array] = {}
            for key, val in lora_raw.items():
                if key.endswith(".scale"):
                    continue  # skip raw scale keys
                scale_key = f"{key}.scale"
                if scale_key in scale_keys:
                    # Int8 LoRA: dequantize = int8 * scale, then cast to bf16
                    scale = lora_raw[scale_key].astype(mx.float32)
                    dequantized[key] = (val.astype(mx.float32) * scale).astype(mx.bfloat16)
                else:
                    # Standard float weight — pass through
                    dequantized[key] = val
            lora_raw = dequantized
        # ---- End int8 dequantize ----

        # Continue with original logic (remap + fuse)
        from ltx_pipelines_mlx.ti2vid_two_stages import _remap_lora_keys
        from ltx_core_mlx.loader.fuse_loras import apply_loras
        from ltx_core_mlx.loader.primitives import LoraStateDictWithStrength, StateDict

        lora_remapped = _remap_lora_keys(lora_raw)

        import mlx.utils

        flat_params = mlx.utils.tree_flatten(dit.parameters())
        flat_model = {k: v for k, v in flat_params if isinstance(v, mx.array)}

        model_sd = StateDict(sd=flat_model, size=0, dtype=set())
        lora_sd = StateDict(sd=lora_remapped, size=0, dtype=set())
        lora_with_strength = LoraStateDictWithStrength(lora_sd, self._distilled_lora_strength)

        fused = apply_loras(model_sd, [lora_with_strength])
        dit.load_weights(list(fused.sd.items()))

        from ltx_core_mlx.utils.memory import aggressive_cleanup
        aggressive_cleanup()

    TI2VidTwoStagesPipeline._fuse_distilled_lora = _patched_fuse_distilled_lora


# ---------------------------------------------------------------------------
# Patch 11 — apply_quantization before connector.load_weights
# ---------------------------------------------------------------------------


def _quantize_connector_to_match_weights(module, weights) -> None:  # type: ignore[no-untyped-def]
    """Quantize connector Linear layers to match pre-quantized weights.

    The vendor ``apply_quantization`` hardcodes ``group_size=64`` and derives
    ``bits`` from a formula that assumes that group size. That is correct for
    the transformer (int8 / group_size=64) but WRONG for the connector, whose
    weights are int4 / group_size=32 — there the vendor detection returns
    ``bits=2`` and ``nn.quantize`` reshapes e.g. a (4096, 188160) Linear to a
    (4096, 11760) param that the (4096, 23520) file can't load into.

    This derives BOTH bits and group_size from the model's own in_features plus
    the file shapes, so it handles any quant config. MLX stores a quantized
    Linear(I, O) as (uint32-packed):

        weight: (O, I * bits / 32)
        scales: (O, I / group_size)

    Given the model's bf16 in_features I and the file shapes, both unknowns
    are solvable per layer:

        group_size = I // scales.shape[-1]
        bits       = round(32 * weight.shape[-1] / I)

    All quantized layers in a connector share one (bits, group_size); we assert
    uniformity. No-op for plain BF16 weights (no ``.scales`` keys).
    """
    import mlx.nn as nn
    import mlx.utils

    quantized_layers = {k[: -len(".scales")] for k in weights if k.endswith(".scales")}
    if not quantized_layers:
        return  # BF16 connector — nothing to quantize

    flat = dict(mlx.utils.tree_flatten(module.parameters()))
    bits_set, gs_set = set(), set()
    for layer in quantized_layers:
        bf16_wkey = layer + ".weight"
        if bf16_wkey not in flat or bf16_wkey not in weights:
            continue
        in_features = flat[bf16_wkey].shape[-1]  # model's bf16 (O, I), pre-quantize
        scales_cols = weights[layer + ".scales"].shape[-1]
        weight_cols = weights[bf16_wkey].shape[-1]
        gs_set.add(in_features // scales_cols)
        bits_set.add(round(32 * weight_cols / in_features))

    if not bits_set:
        return  # quantized keys present but none matched a model leaf — leave as-is
    if len(bits_set) != 1 or len(gs_set) != 1:
        raise ValueError(
            f"Non-uniform connector quantization: bits={sorted(bits_set)} "
            f"group_size={sorted(gs_set)}"
        )
    bits, group_size = bits_set.pop(), gs_set.pop()

    def _should_quantize(path: str, mod) -> bool:  # type: ignore[no-untyped-def]
        return path in quantized_layers and isinstance(mod, nn.Linear)

    nn.quantize(module, group_size=group_size, bits=bits, class_predicate=_should_quantize)


def _patch_connector_apply_quantization() -> None:
    """Quantize the connector to match pre-quantized weights BEFORE load_weights().

    Pre-quantized connector weights carry ``.scales``/``.biases`` keys; the
    connector module structure must be quantized (matched) BEFORE the raw
    weights are loaded, otherwise load_weights raises a shape mismatch. The
    quant is a no-op for plain BF16 weights (no ``.scales`` keys).

    Unlike the vendor ``apply_quantization`` (Patch 5, hardcoded group_size=64),
    the connector helper detects bits AND group_size from the model's
    in_features — the connector is int4/group_size=32, which the vendor
    detection mis-quantizes as bits=2.

    Two vendor sites build the GemmaFeaturesExtractorV2 connector:

      * ``PromptEncoder.load`` (ltx_pipelines_mlx.utils.blocks) — the inference
        runtime path used by all generation pipelines. On sys.path, patched
        unconditionally.
      * ``load_feature_extractor`` (ltx_trainer_mlx.model_loader) — the trainer
        path. ltx_trainer_mlx is NOT on sys.path for inference runs, so the
        import is wrapped defensively; if the trainer is ever wired in, the
        fix applies automatically.
    """
    from pathlib import Path

    from ltx_core_mlx.text_encoders.gemma.encoders.base_encoder import GemmaLanguageModel
    from ltx_core_mlx.text_encoders.gemma.feature_extractor import GemmaFeaturesExtractorV2
    from ltx_core_mlx.utils.memory import aggressive_cleanup
    from ltx_core_mlx.utils.weights import load_split_safetensors

    # --- Inference path: PromptEncoder.load (always available) ---
    from ltx_pipelines_mlx.utils.blocks import PromptEncoder

    def prompt_encoder_load(self) -> None:  # type: ignore[no-untyped-def]
        """Load Gemma + connector if not already loaded (quantization-aware)."""
        if self._text_encoder is None:
            self._text_encoder = GemmaLanguageModel()
            self._text_encoder.load(self.gemma_model_id)
            aggressive_cleanup()

        if self._feature_extractor is None:
            self._feature_extractor = GemmaFeaturesExtractorV2()
            connector_weights = load_split_safetensors(
                self.model_dir / "connector.safetensors", prefix="connector."
            )
            # Quantize structure to match pre-quantized weights (.scales keys);
            # no-op for BF16. Must run before load_weights.
            _quantize_connector_to_match_weights(self._feature_extractor.connector, connector_weights)
            self._feature_extractor.connector.load_weights(list(connector_weights.items()))
            aggressive_cleanup()

    PromptEncoder.load = prompt_encoder_load

    # --- Trainer path: load_feature_extractor (defensive — trainer not on sys.path) ---
    try:
        import ltx_trainer_mlx.model_loader as _ml

        def load_feature_extractor(model_dir):  # type: ignore[no-untyped-def]
            """Load the Gemma feature-extractor connector (quantization-aware)."""
            model_dir = Path(model_dir)
            model = GemmaFeaturesExtractorV2()
            connector_weights = load_split_safetensors(
                model_dir / "connector.safetensors", prefix="connector."
            )
            _quantize_connector_to_match_weights(model.connector, connector_weights)
            model.connector.load_weights(list(connector_weights.items()))
            aggressive_cleanup()
            return model

        _ml.load_feature_extractor = load_feature_extractor
    except ImportError:
        # ltx_trainer_mlx is not on sys.path during inference runs — nothing to patch.
        pass


# ---------------------------------------------------------------------------
# Patch 12 — dequantize int8 LoRA weights in mflux LoRALoader (image pipelines)
# ---------------------------------------------------------------------------


def _patch_mflux_int8_lora() -> None:
    """Dequantize int8-quantized LoRA weights in mflux's image LoRALoader.

    Sibling of Patch 10 (`_patch_int8_lora`) for the **mflux image** path.
    Mflux's ``LoRALoader._apply_single_lora`` (used by Flux2Klein / zimage /
    anime2real / i2i) pattern-matches only ``lora_A.weight`` / ``lora_B.weight``
    / ``alpha`` keys. When a LoRA has been converted to per-tensor int8 (via
    ``scripts/convert_lora_mlx.py`` — stored as int8 ``key.weight`` plus a
    float32 scalar ``key.weight.scale``), the loader matches the raw int8
    ``.weight`` and applies it WITHOUT its companion scale. The resulting LoRA
    matrices are ~hundreds of times too large, which corrupts the transformer
    and yields pure-noise output (no recognizable subject).

    Strategy: replace ``_apply_single_lora`` to dequantize each int8 ``.weight``
    by its ``.weight.scale`` (→ bf16, matching the original bf16 LoRA format)
    right after ``mx.load()``, then delegate to the upstream pattern-match +
    apply helpers (``_build_pattern_mappings`` / ``_apply_lora_with_mapping``).
    The consumed ``.scale`` keys are dropped so they no longer surface as
    "unmatched keys" warnings. Non-int8 LoRAs (no ``.scale`` companions, or a
    float ``.weight``) pass through unchanged.
    """
    import mlx.core as mx

    from mflux.models.common.lora.mapping.lora_loader import LoRALoader

    def _dequant_int8_weights(weights):  # type: ignore[no-untyped-def]
        scale_keys = {k for k in weights if k.endswith(".scale")}
        if not scale_keys:
            return weights
        dequantized: dict[str, mx.array] = {}
        for key, val in weights.items():
            if key.endswith(".scale"):
                continue  # consumed by its companion .weight below
            scale_key = f"{key}.scale"
            if scale_key in scale_keys and val.dtype == mx.int8:
                scale = weights[scale_key].astype(mx.float32)
                dequantized[key] = (val.astype(mx.float32) * scale).astype(mx.bfloat16)
            else:
                dequantized[key] = val
        return dequantized

    @staticmethod
    def _patched_apply_single_lora(  # type: ignore[no-untyped-def]
        transformer, lora_file, scale, lora_mapping, *, role=None
    ):
        if not Path(lora_file).exists():
            print(f"❌ LoRA file not found: {lora_file}")
            return

        print(f"🔧 Applying LoRA: {Path(lora_file).name} (scale={scale})")

        try:
            weights = dict(mx.load(lora_file, return_metadata=True)[0].items())
        except (FileNotFoundError, ValueError, RuntimeError) as e:
            print(f"❌ Failed to load LoRA file: {e}")
            return

        weights = _dequant_int8_weights(weights)

        pattern_mappings = LoRALoader._build_pattern_mappings(lora_mapping)
        applied_count, matched_keys = LoRALoader._apply_lora_with_mapping(
            transformer, weights, scale, pattern_mappings, role=role
        )

        total_keys = len(weights)
        unmatched_keys = set(weights.keys()) - matched_keys
        print(f"   ✅ Applied to {applied_count} layers ({len(matched_keys)}/{total_keys} keys matched)")
        if unmatched_keys:
            print(f"   ⚠️  {len(unmatched_keys)} unmatched keys in LoRA file:")
            for key in sorted(unmatched_keys)[:5]:
                print(f"      - {key}")
            if len(unmatched_keys) > 5:
                print(f"      ... and {len(unmatched_keys) - 5} more")

    LoRALoader._apply_single_lora = _patched_apply_single_lora


def apply_all_patches() -> None:
    """Apply all vendor monkey-patches.  Called automatically at import time."""
    _patch_upsample1d()
    _patch_hann_sinc_resampler()
    _patch_audio_vae_decoder()
    _patch_ltx_model_config()
    _patch_orchestration()
    _patch_ti2vid()
    _patch_klein_edit_nan_guard()
    _patch_image_util_nan_guard()
    _patch_klein_edit_ref_strength()
    _patch_int8_lora()
    _patch_connector_apply_quantization()
    _patch_mflux_int8_lora()
    print("[vendor_patches] Applied 12 patches (8 ltx-2-mlx + 4 mflux) + audio transplant helper")


apply_all_patches()
