"""flux2_t2i_pipeline — Flux2 Klein text-to-image wrapper using mflux (vendored submodule).

Provides pure text-to-image (and optional img2img) generation via the
Flux2 Klein 9B distilled model.  This is the txt2img variant — no reference
image conditioning (that's Flux2KleinEdit, used by the profile command).

Model loading priority:
  1. Explicit model_path (if provided)
  2. Local pre-quantized components in models/{category}/{instance}/ (symlink assembly)
  3. HF auto-download + on-the-fly quantization (fallback)

When local pre-quantized components exist, a temporary symlink assembly directory
is created so mflux sees the standard {root}/transformer/, text_encoder/, vae/,
tokenizer/ layout it expects.
"""

import os
import shutil
import sys
import tempfile
import time
import warnings

from app import config as cfg
from app.pipeline_types import GenerationResult


# Ensure mflux is importable from the vendored submodule
_MFLUX_SRC = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "vendor", "mflux", "src",
)
if os.path.isdir(_MFLUX_SRC) and _MFLUX_SRC not in sys.path:
    sys.path.insert(0, _MFLUX_SRC)


class Flux2KleinT2IPipeline:
    """Thin wrapper around mflux Flux2Klein (txt2img) for generate command.

    Keeps the model loaded in memory across multiple generate() calls so that
    batch generation does not reload ~17 GB of weights repeatedly.
    """

    def __init__(
        self,
        model_path: str | None = None,
        quantize: int | None = None,
        variant: str = "9b",
        lora_paths: list[str] | None = None,
        lora_scales: list[float] | None = None,
    ):
        """
        Args:
            model_path: Local directory (HF structure) or HF repo ID.
                        None → auto-detect local pre-quantized, else HF auto-download.
            quantize:   None / 4 / 8.  Not needed when local pre-quantized model exists.
                        8 is recommended for HF auto-download on Apple Silicon.
            variant:    "4b" or "9b" — selects Flux2 Klein architecture size.
            lora_paths: Optional list of LoRA .safetensors file paths to apply.
            lora_scales: Optional list of scale factors (one per lora_path).
        """
        from mflux.models.flux2.variants.txt2img.flux2_klein import Flux2Klein
        from mflux.models.common.config.model_config import ModelConfig

        if variant == "9b":
            model_config = ModelConfig.flux2_klein_9b()
            local_dirs = {
                "transformer":  cfg.KLEIN_9B_TRANSFORMER_DIR,
                "text_encoder": cfg.KLEIN_9B_TEXT_ENCODER_DIR,
                "vae":          cfg.KLEIN_9B_VAE_DIR,
                "tokenizer":    cfg.KLEIN_9B_TOKENIZER_DIR,
            }
        else:
            model_config = ModelConfig.flux2_klein_4b()
            local_dirs = None

        # Resolve: explicit model_path > local pre-quantized > HF auto-download
        resolved_path = model_path
        effective_quantize = quantize
        assembly_dir = None

        if resolved_path is None and local_dirs and all(
            os.path.isdir(d) for d in local_dirs.values()
        ):
            # All local components exist — create symlink assembly for mflux
            assembly_dir = tempfile.mkdtemp(prefix=f"klein_t2i_{variant}_")
            for name, src in local_dirs.items():
                os.symlink(src, os.path.join(assembly_dir, name))
            resolved_path = assembly_dir
            effective_quantize = None  # pre-quantized on disk
            print(f"[Flux2KleinT2I] Using local pre-quantized INT8 ({variant})")
        else:
            source = resolved_path or "HF auto-download"
            print(f"[Flux2KleinT2I] Loading Klein {variant.upper()} "
                  f"(quantize={quantize}, {source})...")

        if lora_paths:
            print(f"[Flux2KleinT2I] Applying {len(lora_paths)} LoRA(s): "
                  f"{', '.join(os.path.basename(p) for p in lora_paths)}")

        t0 = time.time()
        self._model = Flux2Klein(
            model_config=model_config,
            model_path=resolved_path,
            quantize=effective_quantize,
            lora_paths=lora_paths,
            lora_scales=lora_scales,
        )
        elapsed = time.time() - t0
        print(f"[Flux2KleinT2I] Model ready.  (load: {elapsed:.1f}s)")

        # Clean up assembly dir (symlinks already resolved by mflux during init)
        if assembly_dir:
            shutil.rmtree(assembly_dir, ignore_errors=True)

    def generate(
        self,
        *,
        prompt: str,
        width: int = 1024,
        height: int = 1024,
        steps: int = 4,
        seed: int = 42,
        input_image=None,        # PIL.Image for img2img
        denoise_strength: float = 1.0,
        lora_path: str | None = None,
        lora_scale: float = 1.0,
        upscale: bool = False,
        upscale_model: str | None = None,
        upscale_method: str = "esrgan",
    ) -> GenerationResult:
        """Generate one image (text-to-image or img2img).

        Args:
            prompt:           Text prompt.
            width / height:   Output dimensions (multiples of 16).
            steps:            Denoising steps (4 is typical for distilled Klein).
            seed:             RNG seed.
            input_image:      Optional PIL.Image for img2img refinement.
            denoise_strength: 0.0–1.0, how much to change the input (1.0 = full t2i).
            lora_path:        Ignored (LoRA is applied at model init time, not generate time).
            lora_scale:       Ignored.
            upscale:          Ignored (handled by caller).
            upscale_model:    Ignored.
            upscale_method:   Ignored.

        Returns:
            GenerationResult with .image (PIL.Image) and .timings ({}).
        """
        if lora_path:
            warnings.warn(
                "LoRA must be applied at model init time (Flux2KleinT2IPipeline constructor). "
                "Pass lora_paths/ during pipeline creation. Ignoring generate-time --lora-path.",
                stacklevel=2,
            )

        # img2img: save input image to temp file for mflux
        tmp_path = None
        try:
            if input_image is not None and denoise_strength < 1.0:
                import tempfile as _tf
                from PIL import Image as _PILImage
                # mflux image_strength = fraction of steps skipped (opposite of denoise_strength)
                image_strength = 1.0 - denoise_strength
                fd, tmp_path = _tf.mkstemp(suffix=".png")
                os.close(fd)
                input_image.save(tmp_path)

                result = self._model.generate_image(
                    seed=seed % (2 ** 32),
                    prompt=prompt,
                    num_inference_steps=steps,
                    width=width,
                    height=height,
                    guidance=1.0,  # Distilled Klein must use guidance=1.0
                    image_path=tmp_path,
                    image_strength=image_strength,
                )
            else:
                # Pure text-to-image
                result = self._model.generate_image(
                    seed=seed % (2 ** 32),
                    prompt=prompt,
                    num_inference_steps=steps,
                    width=width,
                    height=height,
                    guidance=1.0,
                )

            return GenerationResult(image=result.image, timings={})

        finally:
            if tmp_path and os.path.exists(tmp_path):
                os.unlink(tmp_path)
