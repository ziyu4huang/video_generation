

# ---------------------------------------------------------------------------
# Flux2OutpaintPipeline — CPU-pure unit tests
# Mirrors the proven test_flux2_controlnet_pipeline.py pattern: mock the heavy
# Flux2KleinEdit + ModelConfig (+ mlx.core for the expand() path) so __init__
# and expand()'s arg-mapping / mask-math / temp-file-cleanup run without any
# MLX/GPU/weights load. No --run-gpu / --run-slow / network needed.
# ---------------------------------------------------------------------------

import glob
import os

import numpy as np
import pytest
from unittest import mock

# Importing app.ltx_pipeline first (CPU-pure) places the vendored src dirs on
# sys.path so the target module's `import app.vendor_patches` resolves.
import app.ltx_pipeline  # noqa: F401  (import-order side effect)
from app import config as cfg
from app.flux2_outpaint_pipeline import Flux2OutpaintPipeline
from app.pipeline_types import GenerationResult

# Module paths of the two heavy classes __init__ imports lazily. Patching these
# keeps __init__'s pure resolution/assembly logic while avoiding any MLX load.
_EDIT_PATH = "mflux.models.flux2.variants.edit.flux2_klein_edit.Flux2KleinEdit"
_MCONFIG_PATH = "mflux.models.common.config.model_config.ModelConfig"


@pytest.fixture
def patched_edit():
    """Patch the heavy Flux2KleinEdit + ModelConfig so __init__ is CPU-pure.

    Yields the Flux2KleinEdit mock so a test can inspect the kwargs __init__
    passed to it, or stub generate_outpaint_image for expand()-path tests.
    """
    with mock.patch(_EDIT_PATH) as edit_cls, mock.patch(_MCONFIG_PATH) as mcfg:
        mcfg.flux2_klein_9b.return_value = "CFG_9B"
        mcfg.flux2_klein_4b.return_value = "CFG_4B"
        yield edit_cls


class TestModuleImport:
    def test_mflux_src_points_at_vendored_dir(self):
        import app.flux2_outpaint_pipeline as m
        assert os.path.isdir(m._MFLUX_SRC)
        assert m._MFLUX_SRC.endswith(os.path.join("vendor", "mflux", "src"))


class TestInitResolution:
    def test_explicit_path_9b_passes_model_path_and_quantize(
        self, patched_edit, capsys
    ):
        Flux2OutpaintPipeline(
            model_path="/tmp/fake-model", quantize=8, variant="9b"
        )
        kw = patched_edit.call_args.kwargs
        assert kw["model_path"] == "/tmp/fake-model"
        assert kw["quantize"] == 8
        assert kw["lora_paths"] is None
        assert kw["model_config"] == "CFG_9B"
        out = capsys.readouterr().out
        assert "Loading Klein 9B" in out
        assert "/tmp/fake-model" in out

    def test_explicit_path_4b_uses_4b_config_and_no_local_assembly(
        self, patched_edit, capsys
    ):
        Flux2OutpaintPipeline(
            model_path="/tmp/fake-model", variant="4b", quantize=8
        )
        kw = patched_edit.call_args.kwargs
        assert kw["model_config"] == "CFG_4B"
        out = capsys.readouterr().out
        assert "Loading Klein 4B" in out

    def test_lora_paths_and_scales_passed_through_with_banner(
        self, patched_edit, capsys
    ):
        Flux2OutpaintPipeline(
            model_path="/tmp/fake-model",
            variant="9b",
            lora_paths=["/models/alpha.safetensors", "/models/beta.safetensors"],
            lora_scales=[0.8, 1.0],
        )
        kw = patched_edit.call_args.kwargs
        assert kw["lora_paths"] == [
            "/models/alpha.safetensors", "/models/beta.safetensors"
        ]
        assert kw["lora_scales"] == [0.8, 1.0]
        out = capsys.readouterr().out
        assert "Applying 2 LoRA(s)" in out
        assert "alpha.safetensors" in out and "beta.safetensors" in out

    def test_no_lora_paths_omits_lora_banner(self, patched_edit, capsys):
        Flux2OutpaintPipeline(model_path="/tmp/fake-model", variant="9b")
        out = capsys.readouterr().out
        assert "Applying" not in out

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
            Flux2OutpaintPipeline(model_path=None, variant="9b", quantize=8)
        kw = patched_edit.call_args.kwargs
        # Pre-quantized on disk: quantize forced to None regardless of input.
        assert kw["quantize"] is None
        # model_path became the temp assembly dir (a real path, not None).
        assert kw["model_path"] is not None and os.path.isabs(kw["model_path"])
        # Assembly dir is cleaned up after init (mflux resolved symlinks).
        assert not os.path.isdir(kw["model_path"])
        out = capsys.readouterr().out
        assert "Using local pre-quantized INT8 (9b)" in out

    def test_model_ready_banner_reported(self, patched_edit, capsys):
        Flux2OutpaintPipeline(model_path="/tmp/fake-model", variant="9b")
        out = capsys.readouterr().out
        assert "Model ready" in out


class TestExpandArgMapping:
    """expand() is CPU-pure once mlx.core is mocked and the underlying
    generate_outpaint_image is stubbed: it builds the mask in numpy/PIL, maps
    args, saves/cleans a temp file, and runs the final composite blend.
    """

    @pytest.fixture
    def pipe(self, patched_edit):
        return Flux2OutpaintPipeline(
            model_path="/tmp/fake-model", variant="9b", quantize=8
        )

    def _make_pipe_with_result(self, patched_edit, gen_image_np):
        """Build a pipeline whose mocked generate_outpaint_image returns a
        result carrying the given RGB numpy array under .image."""
        pipe = Flux2OutpaintPipeline(
            model_path="/tmp/fake-model", variant="9b", quantize=8
        )
        from PIL import Image
        gen_img = Image.fromarray(
            (np.clip(gen_image_np, 0, 255)).astype(np.uint8), mode="RGB"
        )
        pipe._model.generate_outpaint_image = mock.MagicMock(
            return_value=mock.MagicMock(image=gen_img)
        )
        return pipe

    def test_seed_mod_2pow32_guidance_and_dimensions(self, patched_edit):
        from PIL import Image
        pipe = self._make_pipe_with_result(
            patched_edit, np.zeros((1024, 768, 3), dtype=np.float32)
        )
        with mock.patch("mlx.core") as mx_mock:
            mx_mock.array.return_value = mock.MagicMock(name="mask_latents")
            res = pipe.expand(
                padded_image=Image.new("RGB", (768, 1024)),
                mask_image=Image.new("L", (768, 1024), 255),
                width=768, height=1024,
                prompt="sky", steps=4, seed=(2 ** 32) + 7,
            )
        kw = pipe._model.generate_outpaint_image.call_args.kwargs
        assert kw["seed"] == ((2 ** 32) + 7) % (2 ** 32)
        # Distilled Klein: guidance forced to 1.0.
        assert kw["guidance"] == 1.0
        assert kw["num_inference_steps"] == 4
        assert kw["width"] == 768 and kw["height"] == 1024
        assert kw["prompt"] == "sky"
        assert kw["ref_strength"] == 1.0
        assert isinstance(res, GenerationResult)

    def test_mask_downsample_yields_latent_grid_token_count(self, patched_edit):
        # 1024x768 -> latent grid 64x48 = 3072 tokens; mask must reshape to that.
        from PIL import Image
        pipe = self._make_pipe_with_result(
            patched_edit, np.zeros((1024, 768, 3), dtype=np.float32)
        )
        with mock.patch("mlx.core") as mx_mock:
            captured = {}
            mx_mock.array.side_effect = lambda a: captured.setdefault("arr", a)
            pipe.expand(
                padded_image=Image.new("RGB", (768, 1024)),
                mask_image=Image.new("L", (768, 1024), 255),
                width=768, height=1024,
                prompt="x", steps=4, seed=1,
            )
        # mx.array received the flattened mask [1, latent_h*latent_w, 1].
        assert captured["arr"].shape == (1, 64 * 48, 1)

    def test_temp_file_cleaned_up_after_expand(self, patched_edit):
        from PIL import Image
        pipe = self._make_pipe_with_result(
            patched_edit, np.zeros((1024, 768, 3), dtype=np.float32)
        )
        before = set(glob.glob("/tmp/tmp*.png"))
        with mock.patch("mlx.core"):
            pipe.expand(
                padded_image=Image.new("RGB", (768, 1024)),
                mask_image=Image.new("L", (768, 1024), 255),
                width=768, height=1024,
                prompt="x", steps=4, seed=1,
            )
        after = set(glob.glob("/tmp/tmp*.png"))
        assert before == after  # no leftover temp init png

    def test_temp_file_cleaned_up_even_when_generate_raises(
        self, patched_edit, tmp_path
    ):
        from PIL import Image
        pipe = Flux2OutpaintPipeline(
            model_path="/tmp/fake-model", variant="9b", quantize=8
        )
        pipe._model.generate_outpaint_image = mock.MagicMock(side_effect=RuntimeError("model exploded"))
        before = set(glob.glob("/tmp/tmp*.png"))
        with mock.patch("mlx.core"):
            with pytest.raises(RuntimeError, match="model exploded"):
                pipe.expand(
                    padded_image=Image.new("RGB", (768, 1024)),
                    mask_image=Image.new("L", (768, 1024), 255),
                    width=768, height=1024,
                    prompt="x", steps=4, seed=1,
                )
        after = set(glob.glob("/tmp/tmp*.png"))
        assert before == after  # finally block removed the temp png

    def test_final_composite_keeps_original_where_mask_zero(
        self, patched_edit
    ):
        # All-white margin (mask 255) keeps generated; original region
        # (mask 0) must equal the padded source pixels bit-for-bit.
        from PIL import Image
        height, width = 64, 64
        padded = np.zeros((height, width, 3), dtype=np.float32)
        padded[: height // 2] = 50  # top half = "original" (mask 0)
        gen = np.full((height, width, 3), 200, dtype=np.float32)  # generated
        pipe = self._make_pipe_with_result(patched_edit, gen)
        mask = Image.new("L", (width, height), 255)
        # mask: top half black (keep), bottom half white (regenerate)
        mask_arr = np.zeros((height, width), dtype=np.uint8)
        mask_arr[height // 2:] = 255
        mask = Image.fromarray(mask_arr, mode="L")
        with mock.patch("mlx.core"):
            res = pipe.expand(
                padded_image=Image.fromarray(padded.astype(np.uint8), "RGB"),
                mask_image=mask,
                width=width, height=height,
                prompt="x", steps=4, seed=1,
            )
        out = np.asarray(res.image.convert("RGB"), dtype=np.float32)
        # Kept region equals padded original.
        assert np.allclose(out[: height // 2], padded[: height // 2])
        # Regenerated region equals generated.
        assert np.allclose(out[height // 2:], gen[height // 2:])
