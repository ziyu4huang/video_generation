"""flux2_pipeline — Flux2 Klein Edit wrapper using mflux (vendored submodule).

Provides real reference image conditioning via concatenated image latents
(prepare_reference_image_conditioning), unlike ZImagePipeline which is
text-to-image only and cannot inject a reference image into generation.

Model acquisition:
  - model_path=None  → mflux auto-downloads from HuggingFace
                        (black-forest-labs/FLUX.2-klein-4B, ~15-20 GB first run)
  - model_path=<dir> → local directory in HuggingFace directory structure:
                        {dir}/transformer/, vae/, text_encoder/, tokenizer/

mflux source is included as a git submodule at vendor/mflux/ — no pip install needed.
"""

import os
import sys

from app.types import GenerationResult


# Ensure mflux is importable from the vendored submodule
_MFLUX_SRC = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "vendor", "mflux", "src",
)
if os.path.isdir(_MFLUX_SRC) and _MFLUX_SRC not in sys.path:
    sys.path.insert(0, _MFLUX_SRC)


class Flux2KleinPipeline:
    """Thin wrapper around mflux Flux2KleinEdit for multi-view profile generation.

    Keeps the model loaded in memory across multiple generate() calls so that
    3-view profile generation does not reload ~15 GB of weights three times.
    """

    def __init__(
        self,
        model_path: str | None = None,
        quantize: int | None = None,
        variant: str = "9b",
    ):
        """
        Args:
            model_path: Local directory (HF structure) or HF repo ID.
                        None → mflux uses ModelConfig.model_name to auto-download.
            quantize:   None / 4 / 8.  None keeps original precision (BF16 if downloaded).
                        8 is recommended for memory-constrained Apple Silicon.
            variant:    "4b" or "9b" — selects Flux2 Klein architecture size.
        """
        from mflux.models.flux2.variants.edit.flux2_klein_edit import Flux2KleinEdit
        from mflux.models.common.config.model_config import ModelConfig

        if variant == "9b":
            model_config = ModelConfig.flux2_klein_9b()
        else:
            model_config = ModelConfig.flux2_klein_4b()

        print(f"[Flux2KleinPipeline] Loading Klein {variant.upper()} "
              f"(quantize={quantize}, model_path={model_path or 'HF auto-download'})...")

        self._model = Flux2KleinEdit(
            model_config=model_config,
            model_path=model_path,
            quantize=quantize,
        )
        print("[Flux2KleinPipeline] Model ready.")

    def generate(
        self,
        seed: int,
        prompt: str,
        reference_images: list[str],
        width: int = 1024,
        height: int = 1024,
        steps: int = 4,
    ) -> GenerationResult:
        """Generate one image with reference image conditioning.

        Args:
            seed:             RNG seed (folded to 32-bit for mflux compatibility).
            prompt:           Text prompt describing the desired view.
            reference_images: Paths to reference images (usually just one).
            width / height:   Output dimensions.
            steps:            Denoising steps (4 is typical for distilled Klein).

        Returns:
            GenerationResult with .image (PIL.Image) and .timings ({}).
        """
        result = self._model.generate_image(
            seed=seed % (2 ** 32),
            prompt=prompt,
            image_paths=reference_images if reference_images else None,
            width=width,
            height=height,
            num_inference_steps=steps,
            guidance=1.0,  # Distilled Klein (4B/9B) must use guidance=1.0
        )
        # mflux GeneratedImage has a single .image PIL attribute
        return GenerationResult(image=result.image, timings={})
