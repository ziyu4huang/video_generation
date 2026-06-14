"""flux2_pipeline — Flux2 Klein Edit wrapper using mflux (vendored submodule).

Provides real reference image conditioning via concatenated image latents
(prepare_reference_image_conditioning), unlike ZImagePipeline which is
text-to-image only and cannot inject a reference image into generation.

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

from app import config as cfg
from app.pipeline_types import GenerationResult


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
    3-view profile generation does not reload ~16 GB of weights three times.
    """

    def __init__(
        self,
        model_path: str | None = None,
        quantize: int | None = None,
        variant: str = "9b",
        transformer_name: str = "klein-9b",
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
            transformer_name: Instance directory under models/transformer/ (default: klein-9b).
                              Use to select a specific checkpoint variant, e.g. "klein-9b-dark-beast-bfs".
            lora_paths: Optional list of LoRA .safetensors file paths to apply.
            lora_scales: Optional list of scale factors (one per lora_path).
        """
        from mflux.models.flux2.variants.edit.flux2_klein_edit import Flux2KleinEdit
        from mflux.models.common.config.model_config import ModelConfig

        if variant == "9b":
            model_config = ModelConfig.flux2_klein_9b()
            transformer_dir = os.path.join(cfg.MODELS_DIR, "transformer", transformer_name)
            local_dirs = {
                "transformer":  transformer_dir,
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
            assembly_dir = tempfile.mkdtemp(prefix=f"klein{variant}_")
            for name, src in local_dirs.items():
                os.symlink(src, os.path.join(assembly_dir, name))
            resolved_path = assembly_dir
            effective_quantize = None  # pre-quantized on disk
            print(f"[Flux2KleinPipeline] Using local pre-quantized INT8 ({transformer_name})")
        else:
            source = resolved_path or "HF auto-download"
            print(f"[Flux2KleinPipeline] Loading Klein {variant.upper()} "
                  f"(quantize={quantize}, {source})...")

        if lora_paths:
            print(f"[Flux2KleinPipeline] Applying {len(lora_paths)} LoRA(s): "
                  f"{', '.join(os.path.basename(p) for p in lora_paths)}")

        t0 = time.time()
        self._model = Flux2KleinEdit(
            model_config=model_config,
            model_path=resolved_path,
            quantize=effective_quantize,
            lora_paths=lora_paths,
            lora_scales=lora_scales,
        )
        elapsed = time.time() - t0
        print(f"[Flux2KleinPipeline] Model ready.  (load: {elapsed:.1f}s)")

        # Runtime trace: record what was actually loaded at the boundary.
        self._events = [{
            "event": "model_loaded", "target": "flux2_klein_edit",
            "detail": {
                "variant": variant,
                "transformer_name": transformer_name,
                "quantize": effective_quantize,
                "source": "local_prequant" if assembly_dir else (model_path or "hf_autodownload"),
                "lora_count": len(lora_paths) if lora_paths else 0,
            },
            "seconds": elapsed,
        }]

        # Clean up assembly dir (symlinks already resolved by mflux during init)
        if assembly_dir:
            shutil.rmtree(assembly_dir, ignore_errors=True)

    def generate(
        self,
        seed: int,
        prompt: str,
        reference_images: list[str],
        width: int = 1024,
        height: int = 1024,
        steps: int = 4,
        image_strength: float | None = None,
    ) -> GenerationResult:
        """Generate one image with reference image conditioning.

        Args:
            seed:             RNG seed (folded to 32-bit for mflux compatibility).
            prompt:           Text prompt describing the desired view.
            reference_images: Paths to reference images (usually just one).
            width / height:   Output dimensions.
            steps:            Denoising steps (4 is typical for distilled Klein).
            image_strength:   Reference conditioning strength (None = mflux default).
                              Lower = less reference influence, higher = more.

        Returns:
            GenerationResult with .image (PIL.Image) and .timings ({}).
        """
        result = self._model.generate_image(
            seed=seed % (2 ** 32),
            prompt=prompt,
            image_paths=reference_images if reference_images else None,
            image_strength=image_strength,
            width=width,
            height=height,
            num_inference_steps=steps,
            guidance=1.0,  # Distilled Klein (4B/9B) must use guidance=1.0
        )
        # mflux GeneratedImage has a single .image PIL attribute
        events = list(getattr(self, "_events", []) or [])
        events.append({
            "event": "denoise_config", "target": "denoise",
            "detail": {"steps": steps, "guidance": 1.0,
                       "reference_conditioning": bool(reference_images),
                       "image_strength": image_strength,
                       "model": "flux2_klein_edit_distilled"},
            "seconds": None,
        })
        return GenerationResult(image=result.image, timings={}, events=events)
