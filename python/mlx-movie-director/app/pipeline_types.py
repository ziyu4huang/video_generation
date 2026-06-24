"""Shared types used across pipeline modules."""

from dataclasses import dataclass
from typing import Any
from PIL import Image


@dataclass
class GenerationResult:
    """Pipeline output: the generated image plus structured per-phase timings."""
    image: Image.Image
    timings: dict[str, float | list[float]]  # phase_name → seconds; includes "denoising_step_times" list
    # Runtime events trace: what the pipeline ACTUALLY did (model loads with quant/format,
    # LoRA apply with type/scale/applied_count, denoise config, VAE backend, fallbacks).
    # Each event: {"event", "target", "detail", "seconds"}. None when nothing recorded.
    events: list[dict[str, Any]] | None = None
    # The final denoised latent (mx.array, shape [1, C, H//8, W//8]) BEFORE VAE
    # decode. Only populated when the caller passes return_latent=True (e.g. the
    # multi-character latent-couple path, which composites two latents in latent
    # space and resume-denoises the merge). None otherwise — keeps the field
    # optional/CPU-import-safe (typed Any so this module need not import mlx).
    latent: Any = None


@dataclass
class WorkflowResult:
    """Output of the full multi-stage workflow."""
    final_image: Image.Image
    stage_images: dict[str, Image.Image]  # stage_name → PIL Image (intermediate results)
    stage_timings: dict[str, dict[str, float]]  # stage_name → timings dict
    total_seconds: float
    output_dir: str | None = None
    # Flattened runtime events across all stages (same shape as GenerationResult.events).
    stage_events: list[dict[str, Any]] | None = None
