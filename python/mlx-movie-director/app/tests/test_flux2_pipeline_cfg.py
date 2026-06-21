"""Flux2KleinPipeline.generate() — cfg_scale → guidance forwarding (CPU-pure).

Asserts the CFG unlock: default/None/≤1.0 → guidance 1.0 (single forward,
byte-identical to pre-CFG behavior), cfg_scale > 1.0 → guidance forwarded to
mflux (which then runs the dual cond/uncond forward per step).

Bypasses __init__ entirely — generate() only touches self._model + self._events,
so a __new__-built instance with a mocked _model exercises the full arg-mapping
without any MLX / GPU / weights load. No --run-gpu / --run-slow / network needed.
"""

from unittest import mock

from PIL import Image

# Importing app.ltx_pipeline first (CPU-pure) places vendored src dirs on
# sys.path so the target module's imports resolve (mirrors sibling tests).
import app.ltx_pipeline  # noqa: F401  (import-order side effect)
from app.flux2_pipeline import Flux2KleinPipeline
from app.pipeline_types import GenerationResult


def _make_pipe() -> Flux2KleinPipeline:
    """A Flux2KleinPipeline with a mocked _model — no MLX/weights load."""
    pipe = Flux2KleinPipeline.__new__(Flux2KleinPipeline)
    pipe._model = mock.MagicMock()
    pipe._model.generate_image.return_value = mock.MagicMock(
        image=Image.new("RGB", (8, 8))
    )
    return pipe


def _gen(pipe, **overrides):
    kwargs = dict(seed=1, prompt="x", reference_images=[], width=64, height=64, steps=2)
    kwargs.update(overrides)
    return pipe.generate(**kwargs)


class TestCfgScaleForwarding:
    def _guidance(self, pipe):
        return pipe._model.generate_image.call_args.kwargs["guidance"]

    def test_default_off_is_guidance_one(self):
        pipe = _make_pipe()
        _gen(pipe)
        assert self._guidance(pipe) == 1.0

    def test_explicit_none_is_guidance_one(self):
        pipe = _make_pipe()
        _gen(pipe, cfg_scale=None)
        assert self._guidance(pipe) == 1.0

    def test_cfg_one_is_off(self):
        pipe = _make_pipe()
        _gen(pipe, cfg_scale=1.0)
        assert self._guidance(pipe) == 1.0

    def test_cfg_sub_one_is_off(self):
        pipe = _make_pipe()
        _gen(pipe, cfg_scale=0.5)
        assert self._guidance(pipe) == 1.0

    def test_cfg_three_forwards(self):
        pipe = _make_pipe()
        _gen(pipe, cfg_scale=3.0)
        assert self._guidance(pipe) == 3.0

    def test_cfg_five_forwards(self):
        pipe = _make_pipe()
        _gen(pipe, cfg_scale=5.0)
        assert self._guidance(pipe) == 5.0

    def test_events_reflect_guidance_and_reference(self):
        pipe = _make_pipe()
        res = _gen(pipe, reference_images=["a.png"], cfg_scale=3.0)
        assert isinstance(res, GenerationResult)
        detail = res.events[-1]["detail"]
        assert detail["guidance"] == 3.0
        assert detail["reference_conditioning"] is True
