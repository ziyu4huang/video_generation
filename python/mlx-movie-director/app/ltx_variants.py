"""Single source of truth for LTX-2.3 transformer variants.

Centralises the per-variant config that was previously scattered as parallel
dicts/lists + string-matching branches across ``app/ltx_pipeline.py``,
``scripts/setup_ltx_symlinks.py`` and ``app/commands/video-generate.py``.
Adding a new variant (e.g. another dev-architecture finetune) is now ONE entry
in ``LTX_VARIANTS`` instead of edits in N files — this is the structural fix
for the class of bug where ``--transformer dev --low-ram`` silently broke
because the bind-time-fusion strength was only set for dasiwa.

Each variant knows:
  - where its transformer weights live (source dir + filename),
  - which pre-built flat symlink dir presents it to the vendor pipeline,
  - the distilled-LoRA fusion strength (1.0 = pre-fused swap; <1.0 = bind-time),
  - whether it rides the DistilledPipeline (cfg=1, no LoRA stage),
  - a runtime-estimate multiplier vs the distilled transformer (dev/dasiwa ~1.28x).

Shared components (text encoder / VAE / audio / distilled-LoRA) are identical
across every variant, so they live once in ``COMMON_COMPONENTS``.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

from app import config as cfg


@dataclass(frozen=True)
class LTXVariant:
    """One transformer variant."""

    key: str  # "dev" | "distilled" | "dasiwa"
    label: str  # human-readable label for logs / review HTML
    transformer_dir: str  # source dir holding the transformer weights
    transformer_file: str  # filename inside transformer_dir AND the flat dir
    flat_dir: str  # pre-built symlink flat dir (models/ltx-mlx/<key>)
    distilled_lora_strength: float  # 1.0 = swap (needs pre-fused file); <1.0 = bind-time
    is_distilled: bool  # True -> DistilledPipeline (cfg=1, no LoRA stage)
    bench_mult: float  # runtime-estimate multiplier vs distilled (dev/dasiwa ~1.28)

    @property
    def required_files(self) -> list[tuple[str, str]]:
        """Source files whose absence means local components aren't ready.

        The distilled-LoRA is only fused by the two-stage (non-distilled)
        pipelines, so it is required for dev/dasiwa but not for distilled.
        """
        files: list[tuple[str, str]] = [(self.transformer_dir, self.transformer_file)]
        if not self.is_distilled:
            files.append((cfg.LTX_LORA_DIR, "ltx-2.3-22b-distilled-lora-384.int8.safetensors"))
        files.extend([
            (cfg.LTX_TEXT_ENCODER_DIR, "connector.safetensors"),
            (cfg.LTX_VAE_DIR, "vae_encoder.safetensors"),
            (cfg.LTX_VAE_DIR, "vae_decoder.safetensors"),
        ])
        return files

    def component_files(self) -> dict[str, list[str]]:
        """Full {source_dir: [filenames]} map for flat-dir symlink assembly.

        The non-transformer components are shared (COMMON_COMPONENTS); only the
        transformer entry (weights + split/quantize config) is per-variant.
        """
        return {
            **COMMON_COMPONENTS,
            self.transformer_dir: [
                self.transformer_file,
                "split_model.json",
                "quantize_config.json",
            ],
        }


# Shared components symlinked into every variant's flat dir (identical for all).
COMMON_COMPONENTS: dict[str, list[str]] = {
    cfg.LTX_LORA_DIR: [
        "ltx-2.3-22b-distilled-lora-384.int8.safetensors",
        "ltx-2.3-22b-distilled-lora-384-1.1.int8.safetensors",
    ],
    cfg.LTX_TEXT_ENCODER_DIR: [
        "connector.safetensors",
        "config.json",
        "embedded_config.json",
    ],
    cfg.LTX_VAE_DIR: [
        "vae_encoder.safetensors",
        "vae_decoder.safetensors",
        "spatial_upscaler_x2_v1_1.safetensors",
        "spatial_upscaler_x2_v1_1_config.json",
        "spatial_upscaler_x1_5_v1_0.safetensors",
        "spatial_upscaler_x1_5_v1_0_config.json",
        "temporal_upscaler_x2_v1_0.safetensors",
        "temporal_upscaler_x2_v1_0_config.json",
    ],
    cfg.LTX_AUDIO_DIR: [
        "audio_vae.safetensors",
        "vocoder.safetensors",
    ],
}


LTX_VARIANTS: dict[str, LTXVariant] = {
    "dev": LTXVariant(
        key="dev",
        label="dev",
        transformer_dir=cfg.LTX_TRANSFORMER_DIR,
        transformer_file="transformer-dev.safetensors",
        flat_dir=cfg.LTX_MLX_DEV_DIR,
        # dev flat dir ships no pre-fused transformer-distilled*.safetensors, so
        # the two-stage strength-1.0 swap would FileNotFoundError; pin just off
        # 1.0 to force bind-time fusion (vendor: [0.8,1.2] ~= 1.0 swap).
        distilled_lora_strength=0.999,
        is_distilled=False,
        bench_mult=1.28,
    ),
    "distilled": LTXVariant(
        key="distilled",
        label="distilled",
        transformer_dir=cfg.LTX_DISTILLED_TRANSFORMER_DIR,
        transformer_file="transformer-distilled-1.1.safetensors",
        flat_dir=cfg.LTX_MLX_DISTILLED_DIR,
        distilled_lora_strength=1.0,  # uses the separate DistilledPipeline (no LoRA stage)
        is_distilled=True,
        bench_mult=1.0,
    ),
    "dasiwa": LTXVariant(
        key="dasiwa",
        label="DaSiWa (Golden Lace v3)",
        transformer_dir=cfg.LTX_DASIWA_TRANSFORMER_DIR,
        transformer_file="transformer-dev.safetensors",
        flat_dir=cfg.LTX_MLX_DASIWA_DIR,
        distilled_lora_strength=0.999,  # third-party finetune: no pre-fused file -> bind-time
        is_distilled=False,
        bench_mult=1.28,
    ),
}


def get_variant(key: str | None = None, distilled: bool = False) -> LTXVariant:
    """Resolve a variant: explicit ``key`` wins, else fall back to the distilled flag.

    Mirrors the old resolution ``transformer or ("distilled" if distilled else "dev")``.
    """
    if key is None:
        key = "distilled" if distilled else "dev"
    if key not in LTX_VARIANTS:
        raise ValueError(
            f"LTX transformer must be one of {sorted(LTX_VARIANTS)}, got {key!r}"
        )
    return LTX_VARIANTS[key]
