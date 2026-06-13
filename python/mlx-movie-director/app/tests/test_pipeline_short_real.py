"""Real-model GPU pipeline test — Tier 2: short inference with real weights.

Loads ZImagePipeline, runs 2-step 256×256 generation, and verifies:
  - Output is a valid PIL Image
  - Correct output dimensions
  - No NaN or Inf pixels
  - Pipeline timing dict is populated

All tests require:
  - ``--run-gpu`` CLI flag
  - Real model weight files on disk
  - Apple Silicon with Metal GPU
"""

import gc
import os
import sys

import numpy as np
import pytest
from PIL import Image

pytestmark = [pytest.mark.gpu]

try:
    import mlx.core as mx
    HAS_MLX = True
except ImportError:
    HAS_MLX = False
    mx = None

# ---------------------------------------------------------------------------
# Model path detection (mirrors app/config.py defaults)
# ---------------------------------------------------------------------------

_APP_DIR = os.path.dirname(os.path.abspath(__file__))
_PROJECT_DIR = os.path.normpath(os.path.join(_APP_DIR, "..", ".."))
_MODELS_DIR = os.path.join(_PROJECT_DIR, "models")

TRANSFORMER_DIR = os.path.join(_MODELS_DIR, "transformer", "zimage-moody-v126")
TEXT_ENCODER_DIR = os.path.join(_MODELS_DIR, "text_encoder", "qwen3-4b")
TOKENIZER_DIR = os.path.join(_MODELS_DIR, "tokenizer", "qwen3")
VAE_DIR = os.path.join(_MODELS_DIR, "vae", "flux-ae")

# To avoid modifying config.py at import time, we set env vars that app/config.py
# already reads (or override via the pipeline constructor).
# ZImagePipeline uses cfg.TRANSFORMER_DIR / TEXT_ENCODER_DIR / TOKENIZER_DIR / VAE_DIR
# directly.  The cleanest approach is to set these on the config module before
# importing the pipeline.  We do that via a setup function.


def _check_all_models_present() -> bool:
    """Verify all four required model directories exist on disk."""
    for d, label in [
        (TRANSFORMER_DIR, "Transformer"),
        (TEXT_ENCODER_DIR, "TextEncoder"),
        (TOKENIZER_DIR, "Tokenizer"),
        (VAE_DIR, "VAE"),
    ]:
        if not os.path.isdir(d):
            return False
    return True


def _setup_config_paths():
    """Override config paths so ZImagePipeline finds the right models.

    ZImagePipeline.__init__ reads these from app.config:
        cfg.TRANSFORMER_DIR
        cfg.TEXT_ENCODER_DIR
        cfg.TOKENIZER_DIR
        cfg.VAE_DIR
        cfg.MODELS_DIR

    We patch them at the module level before the pipeline is instantiated.
    """
    # We must do a late import to avoid triggering pipeline imports at module level
    import app.config as cfg

    cfg.TRANSFORMER_DIR = TRANSFORMER_DIR
    cfg.TEXT_ENCODER_DIR = TEXT_ENCODER_DIR
    cfg.TOKENIZER_DIR = TOKENIZER_DIR
    cfg.VAE_DIR = VAE_DIR
    cfg.MODELS_DIR = _MODELS_DIR

    # Ensure check_model_available passes for the overridden paths
    # by validating they exist
    assert cfg.check_model_available(TRANSFORMER_DIR), f"Transformer dir not found: {TRANSFORMER_DIR}"
    assert cfg.check_model_available(TEXT_ENCODER_DIR), f"TextEncoder dir not found: {TEXT_ENCODER_DIR}"
    assert cfg.check_model_available(TOKENIZER_DIR), f"Tokenizer dir not found: {TOKENIZER_DIR}"
    assert cfg.check_model_available(VAE_DIR), f"VAE dir not found: {VAE_DIR}"


def _cleanup_pipeline(pipeline) -> None:
    """Delete pipeline and clear MLX cache + Python GC."""
    del pipeline
    for _ in range(3):
        if hasattr(mx, "clear_cache"):
            mx.clear_cache()
        gc.collect()


ALL_MODELS_PRESENT = _check_all_models_present()


# ==========================================================================
# Full pipeline tests
# ==========================================================================


class TestPipelineShortGeneration:
    """Minimal pipeline run: 2 steps, 256×256, real model weights."""

    @pytest.mark.skipif(not ALL_MODELS_PRESENT, reason="One or more model directories missing")
    @pytest.mark.skipif(not HAS_MLX, reason="mlx not available")
    def test_generate_2_steps_256(self):
        """Run full pipeline at 256×256 with 2 denoising steps.

        Expected duration: ~8–20s (model load dominates, not steps).
        """
        _setup_config_paths()

        from app.pipeline import ZImagePipeline

        pipeline = ZImagePipeline()

        try:
            result = pipeline.generate(
                prompt="A cat sitting on a chair, oil painting style, warm lighting.",
                width=256,
                height=256,
                steps=2,
                seed=42,
            )
        finally:
            _cleanup_pipeline(pipeline)

        # --- Assertions ---

        # Output is a PIL Image
        assert isinstance(result.image, Image.Image), (
            f"Expected PIL Image, got {type(result.image)}"
        )

        # Dimensions match request
        assert result.image.size == (256, 256), (
            f"Expected (256, 256), got {result.image.size}"
        )

        # Image mode should be RGB
        assert result.image.mode == "RGB", (
            f"Expected RGB mode, got {result.image.mode}"
        )

        # --- NaN/Inf check ---
        img_np = np.array(result.image).astype(np.float32)
        assert not np.any(np.isnan(img_np)), "Output image contains NaN pixels"
        assert not np.any(np.isinf(img_np)), "Output image contains Inf pixels"

        # Pixel values in valid range [0, 255]
        assert img_np.min() >= 0, f"Pixel value below 0: {img_np.min()}"
        assert img_np.max() <= 255, f"Pixel value above 255: {img_np.max()}"

        # --- Timing dict ---
        assert isinstance(result.timings, dict), (
            f"Expected timings dict, got {type(result.timings)}"
        )
        for phase in ("text_encoding_seconds", "transformer_load_seconds",
                      "denoising_seconds", "vae_decode_seconds"):
            assert phase in result.timings, (
                f"Missing timing phase: {phase}"
            )
            assert result.timings[phase] > 0, (
                f"Timing {phase} should be > 0, got {result.timings[phase]}"
            )

        # Denoising step count should match
        step_times = result.timings.get("denoising_step_times", [])
        assert len(step_times) == 2, (
            f"Expected 2 denoising steps, got {len(step_times)}"
        )

    @pytest.mark.skipif(not ALL_MODELS_PRESENT, reason="One or more model directories missing")
    @pytest.mark.skipif(not HAS_MLX, reason="mlx not available")
    def test_generate_deterministic_same_seed(self):
        """Same seed → identical output (determinism check)."""
        _setup_config_paths()

        from app.pipeline import ZImagePipeline

        # Run twice with same seed
        pipeline1 = ZImagePipeline()
        try:
            r1 = pipeline1.generate(
                prompt="A test image, solid color background.",
                width=256, height=256, steps=2, seed=123,
            )
        finally:
            _cleanup_pipeline(pipeline1)

        pipeline2 = ZImagePipeline()
        try:
            r2 = pipeline2.generate(
                prompt="A test image, solid color background.",
                width=256, height=256, steps=2, seed=123,
            )
        finally:
            _cleanup_pipeline(pipeline2)

        arr1 = np.array(r1.image)
        arr2 = np.array(r2.image)

        assert np.array_equal(arr1, arr2), (
            "Same seed produced different outputs (non-deterministic)"
        )


class TestPipelineIMG2IMG:
    """Verify the img2img code path loads and runs."""

    @pytest.mark.skipif(not ALL_MODELS_PRESENT, reason="One or more model directories missing")
    @pytest.mark.skipif(not HAS_MLX, reason="mlx not available")
    def test_img2img_2_steps(self):
        """Img2img with denoise=0.8, 2 steps, 256×256 input."""
        _setup_config_paths()

        from app.pipeline import ZImagePipeline

        # Create a simple test input image (gray gradient)
        input_img = Image.new("RGB", (256, 256), color=(100, 120, 140))

        pipeline = ZImagePipeline()
        try:
            result = pipeline.generate(
                prompt="Turn this into an oil painting.",
                width=256, height=256,
                steps=2, seed=42,
                input_image=input_img,
                denoise_strength=0.8,
            )
        finally:
            _cleanup_pipeline(pipeline)

        assert isinstance(result.image, Image.Image)
        assert result.image.size == (256, 256)

        img_np = np.array(result.image).astype(np.float32)
        assert not np.any(np.isnan(img_np)), "Output contains NaN"
        assert not np.any(np.isinf(img_np)), "Output contains Inf"

        # The output should differ from the flat gray input
        assert img_np.std() > 1.0, (
            "Output appears nearly uniform — img2img may not have run"
        )


# ==========================================================================
# Model-specific variant tests
# ==========================================================================



