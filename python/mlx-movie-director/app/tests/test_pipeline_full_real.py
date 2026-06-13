"""Real-model full-regression tests — Tier 3: full resolution, slow, hash-verified.

These tests run the ZImagePipeline at full quality settings (9 steps,
768×768 / 1024×1024) with LoRA loading, and verify output correctness
via pixel hash baselines.

All tests require:
  - ``--run-gpu --run-slow`` (both flags)
  - Real model weight files on disk
  - Apple Silicon with Metal GPU
  - ~1-4 minutes depending on resolution + LoRA

Baseline hashes: stored in ``.baselines/pipeline_hash.json``.
Update with ``--update-baselines`` after model changes.
"""

import gc
import hashlib
import os
import sys

import numpy as np
import pytest
from PIL import Image

pytestmark = [pytest.mark.gpu, pytest.mark.slow]

try:
    import mlx.core as mx
    HAS_MLX = True
except ImportError:
    HAS_MLX = False
    mx = None

# ---------------------------------------------------------------------------
# Model paths (mirrors app/config.py defaults)
# ---------------------------------------------------------------------------

_APP_DIR = os.path.dirname(os.path.abspath(__file__))
_PROJECT_DIR = os.path.normpath(os.path.join(_APP_DIR, "..", ".."))
_MODELS_DIR = os.path.join(_PROJECT_DIR, "models")

TRANSFORMER_DIR = os.path.join(_MODELS_DIR, "transformer", "zimage-moody-v126")
TEXT_ENCODER_DIR = os.path.join(_MODELS_DIR, "text_encoder", "qwen3-4b")
TOKENIZER_DIR = os.path.join(_MODELS_DIR, "tokenizer", "qwen3")
VAE_DIR = os.path.join(_MODELS_DIR, "vae", "flux-ae")
LORA_DIR = os.path.join(_MODELS_DIR, "lora")

ALL_MODELS_PRESENT = all(os.path.isdir(d) for d in [
    TRANSFORMER_DIR, TEXT_ENCODER_DIR, TOKENIZER_DIR, VAE_DIR,
])

# Ensure conftest.py is importable (pytest adds test dirs automatically,
# but direct execution via ``python -m pytest path/to/file`` may not).
if _APP_DIR not in sys.path:
    sys.path.insert(0, _APP_DIR)


def _setup_config_paths():
    """Override config paths so ZImagePipeline finds the right models."""
    import app.config as cfg
    cfg.TRANSFORMER_DIR = TRANSFORMER_DIR
    cfg.TEXT_ENCODER_DIR = TEXT_ENCODER_DIR
    cfg.TOKENIZER_DIR = TOKENIZER_DIR
    cfg.VAE_DIR = VAE_DIR
    cfg.MODELS_DIR = _MODELS_DIR


def _cleanup(*objs) -> None:
    """Delete objects, clear MLX cache, and run GC."""
    for o in objs:
        del o
    for _ in range(3):
        if hasattr(mx, "clear_cache"):
            mx.clear_cache()
        gc.collect()


def _pixel_hash(image: Image.Image) -> str:
    """SHA-256 of the raw pixel bytes for deterministic comparison."""
    rgba = image.convert("RGBA")
    return hashlib.sha256(rgba.tobytes()).hexdigest()


_SHORT_PROMPT = "A cat sitting on a chair, oil painting style, warm lighting."


# ==========================================================================
# Full-resolution regression tests
# ==========================================================================


class TestFullResolution:
    """9-step generation at standard resolutions with hash baseline."""

    @pytest.mark.skipif(not ALL_MODELS_PRESENT, reason="Model directories missing")
    @pytest.mark.skipif(not HAS_MLX, reason="mlx not available")
    def test_9_steps_768(self, pytestconfig):
        """9-step 768×768 generation — the standard quality preset.

        Expected duration: ~60–90s.
        """
        _setup_config_paths()
        from app.pipeline import ZImagePipeline

        pipeline = ZImagePipeline()
        try:
            result = pipeline.generate(
                prompt=_SHORT_PROMPT,
                width=768,
                height=768,
                steps=9,
                seed=42,
            )
        finally:
            _cleanup(pipeline)

        # Basic validation
        assert isinstance(result.image, Image.Image)
        assert result.image.size == (768, 768)
        assert result.image.mode == "RGB"

        img_np = np.array(result.image).astype(np.float32)
        assert not np.any(np.isnan(img_np)), "Output contains NaN"
        assert not np.any(np.isinf(img_np)), "Output contains Inf"
        assert img_np.min() >= 0 and img_np.max() <= 255

        # Timing sanity: 9 steps should take > 1s (not trivial)
        denoise_s = result.timings.get("denoising_seconds", 0)
        assert denoise_s > 1.0, f"Denoising too fast ({denoise_s:.2f}s) — suspicious"

        # Pixel hash baseline
        from conftest import assert_pipeline_hash
        h = _pixel_hash(result.image)
        assert_pipeline_hash("zimage_9steps_768x768_seed42_prod", h, pytestconfig)

    @pytest.mark.skipif(not ALL_MODELS_PRESENT, reason="Model directories missing")
    @pytest.mark.skipif(not HAS_MLX, reason="mlx not available")
    def test_9_steps_1024(self, pytestconfig):
        """9-step 1024×1024 generation — maximum quality.

        Expected duration: ~120–180s.
        """
        _setup_config_paths()
        from app.pipeline import ZImagePipeline

        pipeline = ZImagePipeline()
        try:
            result = pipeline.generate(
                prompt=_SHORT_PROMPT,
                width=1024,
                height=1024,
                steps=9,
                seed=42,
            )
        finally:
            _cleanup(pipeline)

        assert isinstance(result.image, Image.Image)
        assert result.image.size == (1024, 1024)
        assert result.image.mode == "RGB"

        img_np = np.array(result.image).astype(np.float32)
        assert not np.any(np.isnan(img_np)), "Output contains NaN"
        assert not np.any(np.isinf(img_np)), "Output contains Inf"

        denoise_s = result.timings.get("denoising_seconds", 0)
        step_times = result.timings.get("denoising_step_times", [])
        assert len(step_times) == 9, f"Expected 9 steps, got {len(step_times)}"
        avg_step = denoise_s / 9 if denoise_s > 0 else 0
        print(f"  1024×1024 avg step: {avg_step:.2f}s, total denoise: {denoise_s:.2f}s")

        # Pixel hash baseline
        from conftest import assert_pipeline_hash
        h = _pixel_hash(result.image)
        assert_pipeline_hash("zimage_9steps_1024x1024_seed42_prod", h, pytestconfig)


# ==========================================================================
# LoRA integration
# ==========================================================================


class TestWithLoRA:
    """Full-resolution generation with LoRA weight injection."""

    ZIT_SDA_DIR = os.path.join(LORA_DIR, "zit-sda-v1")
    JIB_REALISTIC_DIR = os.path.join(LORA_DIR, "jib-mix-realistic-z-image-lora")

    @staticmethod
    def _find_safetensors(lora_dir: str) -> str | None:
        """Return the .safetensors file in *lora_dir*, or None."""
        if not os.path.isdir(lora_dir):
            return None
        for f in os.listdir(lora_dir):
            if f.endswith(".safetensors"):
                return os.path.join(lora_dir, f)
        return None

    @pytest.mark.skipif(not ALL_MODELS_PRESENT, reason="Model directories missing")
    @pytest.mark.skipif(not HAS_MLX, reason="mlx not available")
    def test_with_zit_sda_lora(self, pytestconfig):
        """9-step 768×768 with LoRA 'zit-sda-v1' (zimage-turbo style LoRA)."""
        lora_path = self._find_safetensors(self.ZIT_SDA_DIR)
        if lora_path is None:
            pytest.skip(f"LoRA weights not found at {self.ZIT_SDA_DIR}")

        _setup_config_paths()
        from app.pipeline import ZImagePipeline

        pipeline = ZImagePipeline()
        try:
            result = pipeline.generate(
                prompt=_SHORT_PROMPT,
                width=768,
                height=768,
                steps=9,
                seed=42,
                lora_path=lora_path,
                lora_scale=0.8,
            )
        finally:
            _cleanup(pipeline)

        assert isinstance(result.image, Image.Image)
        assert result.image.size == (768, 768)

        img_np = np.array(result.image).astype(np.float32)
        assert not np.any(np.isnan(img_np)), "Output contains NaN"
        assert not np.any(np.isinf(img_np)), "Output contains Inf"

        from conftest import assert_pipeline_hash
        h = _pixel_hash(result.image)
        assert_pipeline_hash("zimage_9steps_768x768_lora_zitsda_seed42", h, pytestconfig)

    @pytest.mark.skipif(not ALL_MODELS_PRESENT, reason="Model directories missing")
    @pytest.mark.skipif(not HAS_MLX, reason="mlx not available")
    def test_with_jib_realistic_lora(self, pytestconfig):
        """9-step 768×768 with LoRA 'jib-mix-realistic-z-image-lora'."""
        lora_path = self._find_safetensors(self.JIB_REALISTIC_DIR)
        if lora_path is None:
            pytest.skip(f"LoRA weights not found at {self.JIB_REALISTIC_DIR}")

        _setup_config_paths()
        from app.pipeline import ZImagePipeline

        pipeline = ZImagePipeline()
        try:
            result = pipeline.generate(
                prompt=_SHORT_PROMPT,
                width=768,
                height=768,
                steps=9,
                seed=42,
                lora_path=lora_path,
                lora_scale=0.8,
            )
        finally:
            _cleanup(pipeline)

        assert isinstance(result.image, Image.Image)
        assert result.image.size == (768, 768)

        img_np = np.array(result.image).astype(np.float32)
        assert not np.any(np.isnan(img_np)), "Output contains NaN"
        assert not np.any(np.isinf(img_np)), "Output contains Inf"

        from conftest import assert_pipeline_hash
        h = _pixel_hash(result.image)
        assert_pipeline_hash("zimage_9steps_768x768_lora_jibmix_seed42", h, pytestconfig)


# ==========================================================================
# Cross-seed determinism
# ==========================================================================


class TestDeterminism:
    """Verify that MLX pipeline is deterministic across independent runs."""

    @pytest.mark.skipif(not ALL_MODELS_PRESENT, reason="Model directories missing")
    @pytest.mark.skipif(not HAS_MLX, reason="mlx not available")
    def test_triple_run_identical(self):
        """Three runs with same seed → all three outputs identical."""
        _setup_config_paths()
        from app.pipeline import ZImagePipeline

        images = []
        for _ in range(3):
            p = ZImagePipeline()
            try:
                r = p.generate(
                    prompt=_SHORT_PROMPT,
                    width=256,
                    height=256,
                    steps=4,
                    seed=999,
                )
            finally:
                _cleanup(p)
            images.append(r.image)

        hashes = [_pixel_hash(img) for img in images]
        assert hashes[0] == hashes[1] == hashes[2], (
            f"Triple run not deterministic:\n  {hashes[0][:16]}…\n  "
            f"{hashes[1][:16]}…\n  {hashes[2][:16]}…"
        )


# ==========================================================================
# Performance regression
# ==========================================================================


class TestPerformanceBaseline:
    """Track step-time baselines to catch performance regressions.

    These don't assert hard thresholds (too hardware-dependent) but record
    timing stats for manual review in CI logs.
    """

    @pytest.mark.skipif(not ALL_MODELS_PRESENT, reason="Model directories missing")
    @pytest.mark.skipif(not HAS_MLX, reason="mlx not available")
    def test_1024_step_time_profile(self):
        """Profile per-step times at 1024×1024 9 steps.

        Prints avg/max/min step times for manual regression tracking.
        Expected avg: ~12-20s/step on Apple Silicon.
        """
        _setup_config_paths()
        from app.pipeline import ZImagePipeline

        pipeline = ZImagePipeline()
        try:
            result = pipeline.generate(
                prompt=_SHORT_PROMPT,
                width=1024,
                height=1024,
                steps=9,
                seed=42,
            )
        finally:
            _cleanup(pipeline)

        step_times = result.timings.get("denoising_step_times", [])
        assert len(step_times) == 9
        avg = sum(step_times) / len(step_times)
        print(f"\n  [Perf] 1024×1024 9-step timing profile:")
        print(f"    avg={avg:.2f}s  min={min(step_times):.2f}s  "
              f"max={max(step_times):.2f}s  total={sum(step_times):.2f}s")
        for i, t in enumerate(step_times):
            print(f"    step {i+1}: {t:.2f}s")
