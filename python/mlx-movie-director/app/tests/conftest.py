"""Shared fixtures and configuration for app/tests/.

Provides:
  - check_mlx: pytest.mark.skipif decorator for MLX-dependent tests
  - check_gpu: pytest.mark.gpu marker gated by --run-gpu CLI flag
  - check_slow: pytest.mark.slow marker gated by --run-slow CLI flag
  - update_baselines: config flag for regenerating baseline hashes
  - Helper to share the HAS_MLX check across test files

Usage:
  from conftest import check_mlx, check_gpu, update_baselines

  @check_mlx
  def test_something_requiring_mlx():
      ...

  @check_gpu
  def test_something_requiring_real_models():
      ...

  @pytest.mark.slow
  def test_something_taking_over_30s():
      ...
"""

import json
import os

import pytest

try:
    import mlx.core
    _HAS_MLX = True
except ImportError:
    _HAS_MLX = False

# Decorator for MLX-dependent tests.
# In test files that are entirely MLX-dependent, use:
#   pytestmark = check_mlx
check_mlx = pytest.mark.skipif(not _HAS_MLX, reason="mlx not available")

# ---------------------------------------------------------------------------
# CLI flags
# ---------------------------------------------------------------------------


def pytest_addoption(parser):
    parser.addoption(
        "--run-gpu",
        action="store_true",
        default=False,
        help="Run GPU-dependent tests that load real MLX model weights on Apple Silicon",
    )
    parser.addoption(
        "--run-slow",
        action="store_true",
        default=False,
        help="Run slow tests (>30s each): full-resolution regression, LoRA, etc.",
    )
    parser.addoption(
        "--update-baselines",
        action="store_true",
        default=False,
        help="Update stored baseline hashes instead of failing on mismatch "
             "(use when models have been updated)",
    )


def pytest_configure(config):
    config.addinivalue_line("markers", "gpu: Test requires real MLX model weights and GPU hardware")
    config.addinivalue_line("markers", "slow: Test takes >30s to run (full resolution / many steps)")


def pytest_collection_modifyitems(config, items):
    # --run-gpu: skip gpu-marked tests if flag absent
    if not config.getoption("--run-gpu"):
        skip_gpu = pytest.mark.skip(reason="Use --run-gpu to enable GPU-dependent tests")
        for item in items:
            if "gpu" in item.keywords:
                item.add_marker(skip_gpu)
    # --run-slow: skip slow-marked tests if flag absent
    if not config.getoption("--run-slow"):
        skip_slow = pytest.mark.skip(reason="Use --run-slow to enable slow tests (>30s)")
        for item in items:
            if "slow" in item.keywords:
                item.add_marker(skip_slow)


# ---------------------------------------------------------------------------
# GPU-availability guard — skip if MLX isn't available or no Metal GPU
# ---------------------------------------------------------------------------


def _gpu_available() -> bool:
    """Check that MLX is installed AND a Metal GPU is available."""
    if not _HAS_MLX:
        return False
    try:
        import mlx.core as mx
        return getattr(mx, "metal", None) is not None and mx.metal.is_available()
    except Exception:
        return False


# Module-level: skip the entire module when no GPU is available.
# File-level: assign ``pytestmark = gpu_available`` at module scope.
gpu_available = pytest.mark.skipif(not _gpu_available(), reason="No MLX GPU available")


# ---------------------------------------------------------------------------
# Baseline hash helpers
# ---------------------------------------------------------------------------

_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
_BASELINE_PATH = os.path.join(_THIS_DIR, ".baselines", "pipeline_hash.json")


def get_baseline_hash(test_id: str) -> str | None:
    """Return the stored baseline hash for *test_id*, or None if missing."""
    if not os.path.isfile(_BASELINE_PATH):
        return None
    try:
        with open(_BASELINE_PATH) as f:
            data = json.load(f)
        return data.get(test_id, {}).get("hash")
    except (json.JSONDecodeError, OSError):
        return None


def update_baseline_hash(test_id: str, hash_value: str) -> None:
    """Write or update the hash for *test_id* in the baseline file."""
    os.makedirs(os.path.dirname(_BASELINE_PATH), exist_ok=True)
    data = {}
    if os.path.isfile(_BASELINE_PATH):
        try:
            with open(_BASELINE_PATH) as f:
                data = json.load(f)
        except (json.JSONDecodeError, OSError):
            data = {}
    from datetime import datetime, timezone
    data[test_id] = {"hash": hash_value, "created": datetime.now(timezone.utc).isoformat()}
    with open(_BASELINE_PATH, "w") as f:
        json.dump(data, f, indent=2)
        f.write("\n")


def assert_pipeline_hash(test_id: str, actual_hash: str, config) -> None:
    """Assert that *actual_hash* matches the stored baseline, or update if flag set.

    Call this inside a ``@pytest.mark.gpu`` test after generating an image.
    """
    stored = get_baseline_hash(test_id)
    if stored is None:
        # No baseline yet — always write and skip assertion.
        update_baseline_hash(test_id, actual_hash)
        pytest.skip(f"No baseline hash for '{test_id}' — recorded {actual_hash[:12]}…")
    if config.getoption("--update-baselines"):
        if actual_hash != stored:
            update_baseline_hash(test_id, actual_hash)
            pytest.skip(f"Baseline updated for '{test_id}': {stored[:12]}… → {actual_hash[:12]}…")
        return
    assert actual_hash == stored, (
        f"Hash mismatch for '{test_id}':\n"
        f"  Expected: {stored[:16]}…\n"
        f"  Got:      {actual_hash[:16]}…\n"
        f"  Use --update-baselines to accept the new output."
    )
