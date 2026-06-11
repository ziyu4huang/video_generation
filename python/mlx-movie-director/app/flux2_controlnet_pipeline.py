"""flux2_controlnet_pipeline — Flux2 Klein reference conditioning wrapper for ControlNet-style generation.

Uses Flux2KleinEdit (reference latent concatenation) instead of a dedicated
ControlNet model, since no ControlNet exists for Flux2 Klein 9B.

The reference image is VAE-encoded and its latents are concatenated with noise
latents, providing structural guidance similar to ControlNet. For best results,
use --skip-preprocess (raw image) or --remove-outlines rather than canny —
Flux2KleinEdit is not trained to interpret edge maps as structural guidance.

Model loading priority:
  1. Explicit model_path (if provided)
  2. Local pre-quantized components in models/{category}/{instance}/ (symlink assembly)
  3. HF auto-download + on-the-fly quantization (fallback)
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

# Apply vendor monkey-patches AFTER mflux is on sys.path
import app.vendor_patches  # noqa: F401


class Flux2KleinControlnetPipeline:
    """Flux2 Klein reference-image conditioning wrapper for ControlNet-style generation.

    Keeps the model loaded in memory across multiple generate() calls so that
    batch generation does not reload ~17 GB of weights repeatedly.

    Uses Flux2KleinEdit internally — a reference conditioning approach (VAE-encode
    image, concat latents) rather than a dedicated ControlNet. This is the only
    option available since no ControlNet model has been trained for Flux2 Klein.
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
                        None -> auto-detect local pre-quantized, else HF auto-download.
            quantize:   None / 4 / 8.  Not needed when local pre-quantized model exists.
                        8 is recommended for HF auto-download on Apple Silicon.
            variant:    "4b" or "9b" — selects Flux2 Klein architecture size.
            transformer_name: Instance directory under models/transformer/ (default: klein-9b).
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
            assembly_dir = tempfile.mkdtemp(prefix=f"klein_ctrl_{variant}_")
            for name, src in local_dirs.items():
                os.symlink(src, os.path.join(assembly_dir, name))
            resolved_path = assembly_dir
            effective_quantize = None  # pre-quantized on disk
            print(f"[Flux2KleinControlnet] Using local pre-quantized INT8 ({variant})")
        else:
            source = resolved_path or "HF auto-download"
            print(f"[Flux2KleinControlnet] Loading Klein {variant.upper()} "
                  f"(quantize={quantize}, {source})...")

        if lora_paths:
            print(f"[Flux2KleinControlnet] Applying {len(lora_paths)} LoRA(s): "
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
        print(f"[Flux2KleinControlnet] Model ready.  (load: {elapsed:.1f}s)")

        # Clean up assembly dir (symlinks already resolved by mflux during init)
        if assembly_dir:
            shutil.rmtree(assembly_dir, ignore_errors=True)

    def generate(
        self,
        *,
        prompt: str,
        control_image,         # PIL.Image (already preprocessed)
        width: int = 1024,
        height: int = 1024,
        steps: int = 4,
        seed: int = 42,
        controlnet_strength: float = 1.0,
        ref_count: int = 1,
        ref_strength: float = 1.0,
    ) -> GenerationResult:
        """Generate one image using reference conditioning (ControlNet-style).

        Args:
            prompt:             Text prompt.
            control_image:      PIL.Image — the preprocessed control/reference image.
            width / height:     Output dimensions (multiples of 16).
            steps:              Denoising steps (4 is typical for distilled Klein).
            seed:               RNG seed.
            controlnet_strength: Accepted for interface compatibility but currently
                                 has no effect on Flux2KleinEdit output. The Edit
                                 variant uses reference latent concatenation (not
                                 img2img noise interpolation), so image_strength is
                                 a no-op. Use ref_count for conditioning strength.
            ref_count:          How many times to pass the reference image (1-3).
                                Each repeat gets a distinct positional t_coord in the
                                concatenated latent sequence, increasing the model's
                                attention to the reference. Default 1; profile command
                                uses 3. This is the primary conditioning strength knob.
            ref_strength:       Scalar multiplier applied to reference latents before
                                concatenation with noise latents. 1.0 = full strength
                                (default, full identity lock). Lower values (0.3-0.7)
                                weaken conditioning, giving the model more freedom to
                                deviate from the reference — useful for allowing body
                                proportion changes while preserving style/identity.

        Returns:
            GenerationResult with .image (PIL.Image) and .timings ({}).
        """
        # Save control image to temp file (Flux2KleinEdit reads from file path)
        tmp_path = None
        try:
            fd, tmp_path = tempfile.mkstemp(suffix=".png")
            os.close(fd)
            control_image.save(tmp_path)

            # Build image_paths list (repeat for stronger conditioning)
            # Cap at 4: beyond this, attention overflow causes NaN artifacts
            # and per-step time grows quadratically (ref5 ≈ 56s/step vs ref1 ≈ 6s/step)
            safe_ref_count = min(max(1, ref_count), 4)
            if safe_ref_count != ref_count:
                print(f"[Flux2KleinControlnet] Warning: ref_count={ref_count} capped to "
                      f"{safe_ref_count} (prevents attention overflow)")
            image_paths = [tmp_path] * safe_ref_count

            # NOTE: image_strength is intentionally None. Flux2KleinEdit uses
            # reference latent concatenation (VAE encode → batch norm → patchify →
            # concat with noise latents), not img2img noise interpolation. The
            # image_strength parameter only affects Flux2Klein (txt2img) where it
            # controls the denoising start step via Config.init_time_step. For
            # Flux2KleinEdit, conditioning strength is controlled by ref_count
            # (number of repeated reference image tokens in the latent sequence).
            image_strength = None

            result = self._model.generate_image(
                seed=seed % (2 ** 32),
                prompt=prompt,
                image_paths=image_paths,
                image_strength=image_strength,
                width=width,
                height=height,
                num_inference_steps=steps,
                guidance=1.0,  # Distilled Klein models do not support CFG.
                ref_strength=ref_strength,
                               # guidance=1.0 skips negative prompt encoding
                               # (single forward pass per step). Using >1.0
                               # would waste compute on an untrained unconditional
                               # branch with no quality improvement.
            )

            return GenerationResult(image=result.image, timings={})

        finally:
            if tmp_path and os.path.exists(tmp_path):
                os.unlink(tmp_path)
