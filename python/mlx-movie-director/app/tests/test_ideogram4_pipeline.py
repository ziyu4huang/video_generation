"""Logic tests for the Ideogram 4 pipeline (CPU-only, no model weights).

Guards the transcription-critical pipeline pieces the NF4 test does not cover:
the asymmetric-CFG preset schedule, build_inputs sequence packing, the 128-dim
LATENT normalization constants, and the resolution-adaptive scheduler.
"""

import mlx.core as mx
import numpy as np

from app.ideogram4_pipeline import PRESETS, _resolve_guidance
from app.ideogram4_pipeline_helpers import (
    LATENT_SCALE,
    LATENT_SHIFT,
    IMAGE_POSITION_OFFSET,
    build_inputs,
)
from app.ideogram4_scheduler import get_schedule_for_resolution, make_step_intervals


def test_presets_guidance_matches_steps():
    for name, p in PRESETS.items():
        assert len(p["guidance"]) == p["steps"], f"{name}: guidance/steps mismatch"
        # Asymmetric: starts low (3.0), ends high (7.0).
        assert p["guidance"][0] == 3.0 and p["guidance"][-1] == 7.0


def test_resolve_guidance_pad_and_trim():
    d = PRESETS["V4_DEFAULT_20"]  # 20 steps
    assert _resolve_guidance(20, d) == tuple(d["guidance"])  # exact
    trimmed = _resolve_guidance(10, d)
    assert len(trimmed) == 10
    padded = _resolve_guidance(50, d)
    assert len(padded) == 50 and padded[-1] == 3.0  # pad tail with 3.0


def test_build_inputs_shapes_and_packing():
    ntt, h, w = 50, 1024, 1024
    inp = build_inputs(ntt, h, w)
    ni = (h // 16) * (w // 16)  # 4096
    assert inp["num_image_tokens"] == ni
    assert inp["num_text_tokens"] == ntt
    assert inp["grid_h"] == h // 16 and inp["grid_w"] == w // 16
    L = ntt + ni
    assert inp["position_ids"].shape == (1, L, 3)
    assert inp["segment_ids"].shape == (1, L)
    assert inp["indicator"].shape == (1, L)
    # Text tokens carry the LLM indicator (3); image tokens carry the output indicator (2).
    ind = np.array(inp["indicator"][0])
    assert set(ind[:ntt].tolist()) == {3} and set(ind[ntt:].tolist()) == {2}
    # Image positions are offset from the text positions.
    pos = np.array(inp["position_ids"][0])
    assert pos[ntt, 0] >= IMAGE_POSITION_OFFSET  # temporal offset applied to image tokens


def test_latent_constants_byte_exact_sanity():
    sh = np.array(LATENT_SHIFT)
    sc = np.array(LATENT_SCALE)
    assert sh.shape == (128,) and sc.shape == (128,)
    assert abs(sh.mean()) < 0.2, f"LATENT_SHIFT mean off: {sh.mean()}"
    assert 1.5 < sc.min() and sc.max() < 2.0, f"LATENT_SCALE range off: [{sc.min()},{sc.max()}]"


def test_schedule_resolution_adaptive():
    base = get_schedule_for_resolution((512, 512), known_mean=0.0)
    big = get_schedule_for_resolution((1024, 1024), known_mean=0.0)
    # Larger resolution -> larger mean (0.5*log(4) = 0.693...).
    assert big.mean > base.mean
    # Step grid is ascending [0,1].
    grid = np.array(make_step_intervals(20))
    assert grid[0] == 0.0 and grid[-1] == 1.0 and len(grid) == 21
