"""Shared types used across pipeline modules."""

from dataclasses import dataclass
from PIL import Image


@dataclass
class GenerationResult:
    """Pipeline output: the generated image plus structured per-phase timings."""
    image: Image.Image
    timings: dict[str, float | list[float]]  # phase_name → seconds; includes "denoising_step_times" list


@dataclass
class WorkflowResult:
    """Output of the full multi-stage workflow."""
    final_image: Image.Image
    stage_images: dict[str, Image.Image]  # stage_name → PIL Image (intermediate results)
    stage_timings: dict[str, dict[str, float]]  # stage_name → timings dict
    total_seconds: float
    output_dir: str | None = None
