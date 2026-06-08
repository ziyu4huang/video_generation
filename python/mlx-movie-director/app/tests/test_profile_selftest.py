"""Tests for profile selftest logic — mock-based, no model loading.

Three test layers:
  1. Config validation — all profile registry entries have correct structure
  2. Prompt dispatch — right prompt selected for each pipeline/custom combo
  3. Mock integration — full _run_selftest_profile() flow without ML inference
"""

import importlib
import json
import os
import sys
import types
import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch, call

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../../.."))


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _load_image_review():
    """Import image-review module (hyphen in name requires importlib)."""
    return importlib.import_module("app.commands.image-review")


def _load_profile_mod():
    return importlib.import_module("app.commands.image-profile")


# ---------------------------------------------------------------------------
# 1. Config validation
# ---------------------------------------------------------------------------

class TestProfileConfigs:
    """Validate all profile entries in the test registry."""

    PROFILE_NAMES = [
        "profile-zimage",
        "profile-prompt-abc",
        "profile-flux2-gen",
        "profile-flux2-abc",
    ]

    def _get(self, name):
        from app.test_prompts_image import get_test
        return get_test(name)

    def test_all_profile_configs_loadable(self):
        for name in self.PROFILE_NAMES:
            cfg = self._get(name)
            assert cfg["type"] == "profile", f"{name}: expected type=profile"

    def test_required_keys_present(self):
        required = {"type", "views", "pipeline", "steps", "seed", "ratio"}
        for name in self.PROFILE_NAMES:
            cfg = self._get(name)
            missing = required - cfg.keys()
            assert not missing, f"{name}: missing keys {missing}"

    def test_pipeline_values(self):
        zimage_tests = {"profile-zimage", "profile-prompt-abc"}
        flux2_tests = {"profile-flux2-gen", "profile-flux2-abc"}
        for name in zimage_tests:
            assert self._get(name)["pipeline"] == "zimage", f"{name}: expected zimage"
        for name in flux2_tests:
            assert self._get(name)["pipeline"] == "flux2-klein", f"{name}: expected flux2-klein"

    def test_generate_reference_only_on_flux2(self):
        from app.test_prompts_image import get_test
        assert not get_test("profile-zimage").get("generate_reference", False)
        assert not get_test("profile-prompt-abc").get("generate_reference", False)
        assert get_test("profile-flux2-gen")["generate_reference"] is True
        assert get_test("profile-flux2-abc")["generate_reference"] is True

    def test_prompt_variants_structure(self):
        from app.test_prompts_image import get_test
        for name in ["profile-prompt-abc", "profile-flux2-abc"]:
            cfg = get_test(name)
            variants = cfg["prompt_variants"]
            assert len(variants) == 3, f"{name}: expected 3 variants"
            labels = [v["label"] for v in variants]
            assert "v1-medium" in labels
            assert "v2-ultrashort" in labels
            assert "angle-en" in labels
            # angle-en must have prompts=None (falls back to default)
            angle_variant = next(v for v in variants if v["label"] == "angle-en")
            assert angle_variant["prompts"] is None

    def test_views_contain_all_three(self):
        for name in self.PROFILE_NAMES:
            views = self._get(name)["views"]
            assert set(views) == {"front", "back", "side"}, f"{name}: views={views}"


# ---------------------------------------------------------------------------
# 2. Alias resolution
# ---------------------------------------------------------------------------

class TestProfileAliases:
    def _resolve(self, alias):
        from app.test_prompts_image import _ALL_TESTS_ALIASES
        return _ALL_TESTS_ALIASES.get(alias)

    def test_profile_alias(self):
        assert self._resolve("profile") == "profile-zimage"

    def test_profile_abc_alias(self):
        assert self._resolve("profile-abc") == "profile-prompt-abc"

    def test_profile_flux2_alias(self):
        assert self._resolve("profile-flux2") == "profile-flux2-gen"

    def test_profile_ab_alias(self):
        assert self._resolve("profile-ab") == "profile-prompt-abc"

    def test_profile_prompts_alias(self):
        assert self._resolve("profile-prompts") == "profile-prompt-abc"


# ---------------------------------------------------------------------------
# 3. RATIO_PRESETS validation
# ---------------------------------------------------------------------------

class TestRatioPresets:
    def test_all_dimensions_multiples_of_16(self):
        profile_mod = _load_profile_mod()
        for key, (w, h) in profile_mod.RATIO_PRESETS.items():
            assert w % 16 == 0, f"{key}: width {w} not multiple of 16"
            assert h % 16 == 0, f"{key}: height {h} not multiple of 16"

    def test_916_preset_exists(self):
        profile_mod = _load_profile_mod()
        assert "9:16" in profile_mod.RATIO_PRESETS
        w, h = profile_mod.RATIO_PRESETS["9:16"]
        assert w == 1088
        assert h == 1920

    def test_standing_preset_exists(self):
        profile_mod = _load_profile_mod()
        assert "standing" in profile_mod.RATIO_PRESETS

    def test_all_presets_portrait_orientation(self):
        profile_mod = _load_profile_mod()
        for key, (w, h) in profile_mod.RATIO_PRESETS.items():
            assert h > w, f"{key}: {w}×{h} is not portrait orientation"


# ---------------------------------------------------------------------------
# 4. Prompt dispatch logic
# ---------------------------------------------------------------------------

class TestPromptDispatch:
    """Test the prompt selection logic without calling the full selftest."""

    def _dispatch(self, pipeline_type, custom_prompts, view):
        profile_mod = _load_profile_mod()
        if custom_prompts is not None and custom_prompts.get(view):
            return custom_prompts[view], "custom"
        elif pipeline_type == "flux2-klein":
            return profile_mod.VIEW_PROMPTS_FLUX2[view], "VIEW_PROMPTS_FLUX2"
        else:
            return profile_mod.VIEW_PROMPTS[view], "VIEW_PROMPTS"

    def test_zimage_no_custom_uses_view_prompts(self):
        _, source = self._dispatch("zimage", None, "front")
        assert source == "VIEW_PROMPTS"

    def test_flux2_no_custom_uses_flux2_prompts(self):
        _, source = self._dispatch("flux2-klein", None, "front")
        assert source == "VIEW_PROMPTS_FLUX2"

    def test_custom_prompt_takes_priority_for_zimage(self):
        _, source = self._dispatch("zimage", {"front": "my prompt"}, "front")
        assert source == "custom"

    def test_custom_prompt_takes_priority_for_flux2(self):
        _, source = self._dispatch("flux2-klein", {"front": "my prompt"}, "front")
        assert source == "custom"

    def test_none_custom_entry_falls_back_to_default(self):
        # custom_prompts has None value for this view → should fall back
        _, source = self._dispatch("flux2-klein", {"front": None}, "front")
        assert source == "VIEW_PROMPTS_FLUX2"

    def test_all_views_have_prompts_in_both_dicts(self):
        profile_mod = _load_profile_mod()
        for view in ["front", "back", "side"]:
            assert view in profile_mod.VIEW_PROMPTS, f"VIEW_PROMPTS missing {view}"
            assert view in profile_mod.VIEW_PROMPTS_FLUX2, f"VIEW_PROMPTS_FLUX2 missing {view}"

    def test_zimage_and_flux2_prompts_are_different(self):
        profile_mod = _load_profile_mod()
        for view in ["front", "back", "side"]:
            zp = profile_mod.VIEW_PROMPTS[view]
            fp = profile_mod.VIEW_PROMPTS_FLUX2[view]
            assert zp != fp, f"VIEW_PROMPTS and VIEW_PROMPTS_FLUX2 are identical for {view}"


# ---------------------------------------------------------------------------
# 5. VLM prompt builder
# ---------------------------------------------------------------------------

class TestProfileVerifyPrompt:
    def test_returns_string(self):
        from app.commands.caption import get_profile_verify_prompt
        for view in ["front", "back", "side"]:
            p = get_profile_verify_prompt(view)
            assert isinstance(p, str) and len(p) > 50

    def test_view_specific_description(self):
        from app.commands.caption import get_profile_verify_prompt
        front_p = get_profile_verify_prompt("front")
        back_p = get_profile_verify_prompt("back")
        side_p = get_profile_verify_prompt("side")
        assert "front" in front_p.lower()
        assert "back" in back_p.lower()
        assert "side" in side_p.lower()
        # Each must be distinct
        assert front_p != back_p != side_p

    def test_contains_json_schema_keys(self):
        from app.commands.caption import get_profile_verify_prompt
        p = get_profile_verify_prompt("front")
        for key in ["view_correct", "full_body", "apose", "clean_bg", "score"]:
            assert key in p, f"VLM prompt missing field: {key}"


# ---------------------------------------------------------------------------
# 6. Mock integration — full flow without ML
# ---------------------------------------------------------------------------

class MockGenerationResult:
    """Minimal stand-in for ZImage/Flux2 GenerationResult."""
    def __init__(self, out_path_holder):
        self._out_path_holder = out_path_holder
        self.timings = {}
        self.image = self

    def save(self, path):
        self._out_path_holder.append(path)
        open(path, "wb").close()  # create real file so later code doesn't break


class TestProfileSelftestIntegration:
    """Mock-based end-to-end test of _run_selftest_profile().

    No model loading — all pipelines and VLM calls are replaced with stubs.
    Verifies:
    - generate_reference: ZImage generates portrait first, Flux2-Klein uses it
    - Pipeline chosen matches test config
    - generate() receives correct kwargs (reference_images, seed, prompt)
    - Output files are created (.png, .caption.json, .run.json)
    - VLM is called once per view
    """

    VLM_RESPONSE = json.dumps({
        "view_correct": True,
        "full_body": True,
        "apose": True,
        "clean_bg": True,
        "score": 8,
        "issues": [],
        "summary": "Good front view",
    })

    def _make_args(self):
        return SimpleNamespace(steps=None, open=False, self_test="profile-flux2-gen")

    def _run_with_mocks(self, test_cfg: dict, tmp_path: str):
        """Run _run_selftest_profile with all heavy deps mocked."""
        saved_paths = []

        def make_zimage_result():
            r = MockGenerationResult(saved_paths)
            return r

        def make_flux2_result():
            r = MockGenerationResult(saved_paths)
            return r

        MockZImage = MagicMock()
        MockZImage.return_value.generate.side_effect = lambda **kw: make_zimage_result()

        MockFlux2 = MagicMock()
        MockFlux2.return_value.generate.side_effect = lambda **kw: make_flux2_result()

        MockManifest = MagicMock()
        MockManifest.from_success.return_value = MagicMock()

        patches = {
            "app.pipeline.ZImagePipeline": MockZImage,
            "app.flux2_pipeline.Flux2KleinPipeline": MockFlux2,
            "app.manifest.Manifest": MockManifest,
            "app.manifest.collect_model_fingerprint": MagicMock(return_value={}),
            "app.commands.caption._image_to_base64": MagicMock(return_value="fakeb64"),
            "app.commands.caption._call_vlm": MagicMock(return_value=self.VLM_RESPONSE),
            "mlx.core.clear_cache": MagicMock(),
        }

        review_mod = _load_image_review()

        with unittest.mock.patch("app.config.OUTPUT_DIR", tmp_path), \
             unittest.mock.patch.object(review_mod, "_open_manifest_review", MagicMock()), \
             unittest.mock.patch("app.pipeline.ZImagePipeline", MockZImage), \
             unittest.mock.patch("app.flux2_pipeline.Flux2KleinPipeline", MockFlux2), \
             unittest.mock.patch("app.manifest.Manifest", MockManifest), \
             unittest.mock.patch("app.manifest.collect_model_fingerprint", MagicMock(return_value={})), \
             unittest.mock.patch("app.commands.caption._image_to_base64", MagicMock(return_value="fakeb64")), \
             unittest.mock.patch("app.commands.caption._call_vlm", MagicMock(return_value=self.VLM_RESPONSE)), \
             unittest.mock.patch("mlx.core.clear_cache", MagicMock()):

            args = self._make_args()
            review_mod._run_selftest_profile(args, "profile-flux2-gen", test_cfg)

        return MockZImage, MockFlux2, saved_paths

    def test_zimage_pipeline_selected_for_zimage_config(self, tmp_path):
        test_cfg = {
            "type": "profile",
            "views": ["front"],
            "pipeline": "zimage",
            "steps": 2,
            "seed": 1,
            "ratio": "standing",
        }
        MockZImage, MockFlux2, _ = self._run_with_mocks(test_cfg, str(tmp_path))
        assert MockZImage.called, "ZImagePipeline should be instantiated"
        assert not MockFlux2.called, "Flux2KleinPipeline should NOT be instantiated"

    def test_flux2_pipeline_selected_for_flux2_config(self, tmp_path):
        test_cfg = {
            "type": "profile",
            "views": ["front"],
            "pipeline": "flux2-klein",
            "generate_reference": True,
            "test_prompt": "portrait",
            "steps_ref": 2,
            "steps": 2,
            "seed": 42,
            "ratio": "standing",
        }
        MockZImage, MockFlux2, _ = self._run_with_mocks(test_cfg, str(tmp_path))
        # ZImage is used for reference generation
        assert MockZImage.called, "ZImagePipeline should be used for reference generation"
        # Flux2-Klein used for profile views
        assert MockFlux2.called, "Flux2KleinPipeline should be instantiated for views"

    def test_flux2_generate_receives_reference_images_kwarg(self, tmp_path):
        test_cfg = {
            "type": "profile",
            "views": ["front"],
            "pipeline": "flux2-klein",
            "generate_reference": True,
            "test_prompt": "portrait",
            "steps_ref": 2,
            "steps": 2,
            "seed": 42,
            "ratio": "standing",
        }
        MockZImage, MockFlux2, _ = self._run_with_mocks(test_cfg, str(tmp_path))
        flux2_instance = MockFlux2.return_value
        assert flux2_instance.generate.called
        call_kwargs = flux2_instance.generate.call_args.kwargs
        assert "reference_images" in call_kwargs, "Flux2-Klein generate() must receive reference_images"
        assert isinstance(call_kwargs["reference_images"], list)
        assert len(call_kwargs["reference_images"]) == 1

    def test_zimage_generate_no_reference_images_kwarg(self, tmp_path):
        test_cfg = {
            "type": "profile",
            "views": ["front"],
            "pipeline": "zimage",
            "steps": 2,
            "seed": 1,
            "ratio": "standing",
        }
        MockZImage, MockFlux2, _ = self._run_with_mocks(test_cfg, str(tmp_path))
        zimage_instance = MockZImage.return_value
        # The ZImage instance is used for the view generation in this config
        call_kwargs = zimage_instance.generate.call_args.kwargs
        assert "reference_images" not in call_kwargs, "ZImage generate() must NOT receive reference_images"

    def test_output_png_files_created(self, tmp_path):
        test_cfg = {
            "type": "profile",
            "views": ["front"],
            "pipeline": "zimage",
            "steps": 2,
            "seed": 1,
            "ratio": "standing",
        }
        _, _, saved_paths = self._run_with_mocks(test_cfg, str(tmp_path))
        png_files = [p for p in saved_paths if p.endswith(".png")]
        assert len(png_files) >= 1, "At least one .png must be saved"

    def test_run_json_created_per_view(self, tmp_path):
        test_cfg = {
            "type": "profile",
            "views": ["front", "side"],
            "pipeline": "zimage",
            "steps": 2,
            "seed": 1,
            "ratio": "standing",
        }
        self._run_with_mocks(test_cfg, str(tmp_path))
        run_files = [f for f in os.listdir(str(tmp_path)) if f.endswith(".run.json")]
        assert len(run_files) == 2, f"Expected 2 .run.json (one per view), got {len(run_files)}"

    def test_run_json_has_expected_fields(self, tmp_path):
        test_cfg = {
            "type": "profile",
            "views": ["front"],
            "pipeline": "zimage",
            "steps": 2,
            "seed": 1,
            "ratio": "standing",
        }
        self._run_with_mocks(test_cfg, str(tmp_path))
        run_files = [f for f in os.listdir(str(tmp_path)) if f.endswith(".run.json")]
        assert run_files
        with open(os.path.join(str(tmp_path), run_files[0])) as f:
            data = json.load(f)
        for field in ["command", "action", "prompt", "width", "height", "steps", "seed", "pipeline", "view"]:
            assert field in data, f".run.json missing field: {field}"
        assert data["command"] == "image"
        assert data["action"] == "profile"
        assert data["view"] == "front"

    def test_caption_json_created_per_view(self, tmp_path):
        test_cfg = {
            "type": "profile",
            "views": ["front"],
            "pipeline": "zimage",
            "steps": 2,
            "seed": 1,
            "ratio": "standing",
        }
        self._run_with_mocks(test_cfg, str(tmp_path))
        cap_files = [f for f in os.listdir(str(tmp_path)) if f.endswith(".caption.json")]
        assert len(cap_files) >= 1, "caption.json must be created for VLM results"

    def test_caption_json_has_profile_verify_style(self, tmp_path):
        test_cfg = {
            "type": "profile",
            "views": ["front"],
            "pipeline": "zimage",
            "steps": 2,
            "seed": 1,
            "ratio": "standing",
        }
        self._run_with_mocks(test_cfg, str(tmp_path))
        cap_files = [f for f in os.listdir(str(tmp_path)) if f.endswith(".caption.json")]
        with open(os.path.join(str(tmp_path), cap_files[0])) as f:
            data = json.load(f)
        assert data["style"] == "profile-verify"
        assert "view_correct" in data["caption"]

    def test_variant_loop_generates_per_variant(self, tmp_path):
        test_cfg = {
            "type": "profile",
            "views": ["front"],
            "pipeline": "zimage",
            "steps": 2,
            "seed": 1,
            "ratio": "standing",
            "prompt_variants": [
                {"label": "A", "prompts": {"front": "prompt A"}},
                {"label": "B", "prompts": {"front": "prompt B"}},
            ],
        }
        self._run_with_mocks(test_cfg, str(tmp_path))
        run_files = [f for f in os.listdir(str(tmp_path)) if f.endswith(".run.json")]
        # 2 variants × 1 view = 2 run files
        assert len(run_files) == 2

    def test_flux2_no_generate_reference_skips_zimage(self, tmp_path):
        """flux2-klein without generate_reference should NOT call ZImage at all."""
        test_cfg = {
            "type": "profile",
            "views": ["front"],
            "pipeline": "flux2-klein",
            "generate_reference": False,
            "steps": 2,
            "seed": 42,
            "ratio": "standing",
        }
        MockZImage, MockFlux2, _ = self._run_with_mocks(test_cfg, str(tmp_path))
        assert not MockZImage.called, "ZImagePipeline should NOT be called when generate_reference=False"
        # Flux2 generate is called without reference_images
        call_kwargs = MockFlux2.return_value.generate.call_args.kwargs
        assert "reference_images" not in call_kwargs or call_kwargs["reference_images"] is None
