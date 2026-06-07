"""Monkey-patches for vendor/ltx-2-mlx (upstream dgrauet/ltx-2-mlx).

Applies runtime fixes at import time so the vendor submodule stays clean
at upstream HEAD.  Each patch function corresponds to a diff documented in
patches/ltx-2-mlx/mlx-0.31.2-audio-fixes.patch.

Patches:
  1. UpSample1d.__call__   — MLX 0.31.2 .at[strided].add() Metal bug
  2. HannSincResampler      — same .at[strided].add() bug
  3. AudioVAEDecoder.decode — causal frame crop (T*4-3)
  4. LTXModelConfig         — av_ca_timestep_scale_multiplier 1.0→1000.0
                               + from_checkpoint_config classmethod
  5. _orchestration          — _load_transformer_config reads embedded_config.json
  6. TI2VidTwoStagesPipeline — audio_stage1_only param
"""

from __future__ import annotations

import json as _json
from pathlib import Path


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
        checkpoint-specific config.
        """
        config = _load_transformer_config(transformer_path.parent)
        dit = LTXModel(config=config)
        weights = load_split_safetensors(transformer_path, prefix="transformer.")
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


def apply_all_patches() -> None:
    """Apply all vendor monkey-patches.  Called automatically at import time."""
    _patch_upsample1d()
    _patch_hann_sinc_resampler()
    _patch_audio_vae_decoder()
    _patch_ltx_model_config()
    _patch_orchestration()
    _patch_ti2vid()
    print("[vendor_patches] Applied 6 patches to vendor/ltx-2-mlx")


apply_all_patches()
