import glob
import os

import pytest
from unittest import mock

# The target module's top-level `import app.vendor_patches` runs
# apply_all_patches() at import time, which imports `ltx_core_mlx` -- a vendored
# package that is only placed on sys.path by app.ltx_pipeline's module body.
# Importing ltx_pipeline first (CPU-pure: it only inserts vendor src dirs, it
# does NOT import mlx at module level) makes the target module importable.
import app.ltx_pipeline  # noqa: F401  (import-order side effect)
from app import config as cfg
from app.flux2_controlnet_pipeline import Flux2KleinControlnetPipeline
from app.pipeline_types import GenerationResult

# Module paths of the two heavy classes __init__ imports lazily. Patching these
# keeps __init__'s pure resolution/assembly logic while avoiding any MLX load.
_EDIT_PATH = "mflux.models.flux2.variants.edit.flux2_klein_edit.Flux2KleinEdit"
_MCONFIG_PATH = "mflux.models.common.config.model_config.ModelConfig"


@pytest.fixture
def patched_edit():
    """Patch the heavy Flux2KleinEdit + ModelConfig so __init__ is CPU-pure.

    Yields the Flux2KleinEdit mock so a test can inspect the kwargs __init__
    passed to it, or stub generate_image for generate()-path tests.
    """
    with mock.patch(_EDIT_PATH) as edit_cls, mock.patch(_MCONFIG_PATH) as mcfg:
        mcfg.flux2_klein_9b.return_value = "CFG_9B"
        mcfg.flux2_klein_4b.return_value = "CFG_4B"
        # generate_image returns an object with a .image attr by default.
        edit_cls.return_value.generate_image.return_value = mock.MagicMock(
            image=mock.MagicMock(name="PILImage")
        )
        yield edit_cls


class TestModuleImport:
    def test_mflux_src_points_at_vendored_dir(self):
        # The module-level _MFLUX_SRC must resolve to the real vendored mflux
        # src dir so mflux is importable.
        import app.flux2_controlnet_pipeline as m
        assert os.path.isdir(m._MFLUX_SRC)
        assert m._MFLUX_SRC.endswith(os.path.join("vendor", "mflux", "src"))


class TestInitResolution:
    def test_explicit_path_9b_passes_model_path_and_quantize(self, patched_edit, capsys):
        pipe = Flux2KleinControlnetPipeline(
            model_path="/tmp/fake-model", quantize=8, variant="9b"
        )
        kw = patched_edit.call_args.kwargs
        assert kw["model_path"] == "/tmp/fake-model"
        assert kw["quantize"] == 8
        assert kw["lora_paths"] is None
        # 9b variant selects the 9b config.
        patched_edit.call_args.kwargs  # model_config is positional
        assert patched_edit.call_args.kwargs["model_config"] == "CFG_9B"
        out = capsys.readouterr().out
        assert "Loading Klein 9B" in out
        assert "/tmp/fake-model" in out

    def test_variant_4b_uses_4b_config_and_no_local_assembly(self, patched_edit):
        pipe = Flux2KleinControlnetPipeline(
            model_path="/tmp/fake-model", variant="4b"
        )
        assert patched_edit.call_args.kwargs["model_config"] == "CFG_4B"

    def test_lora_paths_and_scales_passed_through(self, patched_edit, capsys):
        Flux2KleinControlnetPipeline(
            model_path="/tmp/fake-model",
            variant="9b",
            lora_paths=["/models/a.safetensors", "/models/b.safetensors"],
            lora_scales=[0.8, 1.0],
        )
        assert patched_edit.call_args.kwargs["lora_paths"] == [
            "/models/a.safetensors", "/models/b.safetensors"
        ]
        assert patched_edit.call_args.kwargs["lora_scales"] == [0.8, 1.0]
        # LoRA basenames surfaced in the load banner.
        assert "a.safetensors" in capsys.readouterr().out

    def test_local_prequantized_assembly_overrides_quantize_to_none(
        self, patched_edit, capsys, tmp_path
    ):
        # Make all four local component dirs exist so the assembly branch fires.
        for sub in ("te", "vae", "tok"):
            (tmp_path / sub).mkdir()
        (tmp_path / "transformer" / "klein-9b").mkdir(parents=True)
        with mock.patch.object(cfg, "MODELS_DIR", str(tmp_path)), \
             mock.patch.object(
                 cfg, "KLEIN_9B_TEXT_ENCODER_DIR", str(tmp_path / "te")
             ), \
             mock.patch.object(cfg, "KLEIN_9B_VAE_DIR", str(tmp_path / "vae")), \
             mock.patch.object(
                 cfg, "KLEIN_9B_TOKENIZER_DIR", str(tmp_path / "tok")
             ):
            pipe = Flux2KleinControlnetPipeline(model_path=None, variant="9b")
        kw = patched_edit.call_args.kwargs
        # Pre-quantized on disk: quantize forced to None regardless of input.
        assert kw["quantize"] is None
        # model_path became the temp assembly dir (a real path, not None).
        assert kw["model_path"] is not None and os.path.isabs(kw["model_path"])
        # Assembly dir is cleaned up after init (mflux resolved symlinks).
        assert not os.path.isdir(kw["model_path"])
        out = capsys.readouterr().out
        assert "Using local pre-quantized INT8" in out


class TestGenerateArgMapping:
    def test_seed_mod_guidance_image_strength_and_dimensions(
        self, patched_edit
    ):
        pipe = Flux2KleinControlnetPipeline(
            model_path="/tmp/fake-model", variant="9b", quantize=8
        )
        ctrl = mock.MagicMock()
        res = pipe.generate(
            prompt="a cat", control_image=ctrl,
            width=768, height=1024, steps=4, seed=7,
            ref_count=1, ref_strength=1.0,
        )
        # Returns a real GenerationResult wrapping the mocked image.
        assert isinstance(res, GenerationResult)
        assert res.timings == {}
        gi = patched_edit.return_value.generate_image
        kw = gi.call_args.kwargs
        assert kw["seed"] == 7 % (2 ** 32)
        # Distilled Klein: guidance forced to 1.0, image_strength forced None.
        assert kw["guidance"] == 1.0
        assert kw["image_strength"] is None
        assert kw["num_inference_steps"] == 4
        assert kw["width"] == 768 and kw["height"] == 1024
        assert kw["prompt"] == "a cat"
        assert kw["ref_strength"] == 1.0
        assert len(kw["image_paths"]) == 1
        # control_image was saved to a temp file that got cleaned up.
        ctrl.save.assert_called_once()

    def test_ref_count_is_clamped_floor_and_ceiling(self, patched_edit, capsys):
        pipe = Flux2KleinControlnetPipeline(
            model_path="/tmp/fake-model", variant="9b", quantize=8
        )
        gi = patched_edit.return_value.generate_image
        # Ceiling: 10 -> 4.
        pipe.generate(prompt="x", control_image=mock.MagicMock(), ref_count=10)
        assert len(gi.call_args.kwargs["image_paths"]) == 4
        capsys.readouterr()  # drain the capping warning
        # Floor: 0 -> 1.
        pipe.generate(prompt="x", control_image=mock.MagicMock(), ref_count=0)
        assert len(gi.call_args.kwargs["image_paths"]) == 1
        # Floor: negative -> 1.
        pipe.generate(prompt="x", control_image=mock.MagicMock(), ref_count=-3)
        assert len(gi.call_args.kwargs["image_paths"]) == 1

    def test_ref_count_capped_emits_warning(self, patched_edit, capsys):
        pipe = Flux2KleinControlnetPipeline(
            model_path="/tmp/fake-model", variant="9b", quantize=8
        )
        pipe.generate(prompt="x", control_image=mock.MagicMock(), ref_count=10)
        out = capsys.readouterr().out
        assert "ref_count=10 capped to 4" in out

    def test_temp_file_cleaned_up_even_when_generate_raises(
        self, patched_edit, tmp_path
    ):
        pipe = Flux2KleinControlnetPipeline(
            model_path="/tmp/fake-model", variant="9b", quantize=8
        )
        patched_edit.return_value.generate_image.side_effect = RuntimeError(
            "model exploded"
        )
        before = set(glob.glob("/tmp/tmp*.png"))
        # control_image.save must write a real file so cleanup has something.
        def _save(path):
            with open(path, "wb") as f:
                f.write(b"x")
        ctrl = mock.MagicMock()
        ctrl.save.side_effect = _save
        with pytest.raises(RuntimeError, match="model exploded"):
            pipe.generate(prompt="x", control_image=ctrl, ref_count=1)
        after = set(glob.glob("/tmp/tmp*.png"))
        # finally block removed the temp png; no leftover files.
        assert before == after
