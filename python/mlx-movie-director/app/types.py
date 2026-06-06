"""Shared types used across pipeline modules."""

from dataclasses import dataclass
from PIL import Image


@dataclass
class GenerationResult:
    """Pipeline output: the generated image plus structured per-phase timings."""
    image: Image.Image
    timings: dict  # phase_name → seconds; includes "denoising_step_times" list
