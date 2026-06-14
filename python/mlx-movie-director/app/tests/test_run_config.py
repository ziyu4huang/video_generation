"""Unit tests for app/run_config.py — schema migration and serialization."""

import pytest
from dataclasses import asdict

from app.run_config import RunConfig, SCHEMA_VERSION, _migrate


class TestSchemaVersion:
    def test_schema_version_is_13(self):
        assert SCHEMA_VERSION == 13

    def test_new_runconfig_has_current_version(self):
        rc = RunConfig()
        assert rc.schema_version == 13


class TestWorkflowFieldsInAsdict:
    def test_asdict_includes_film_grain(self):
        rc = RunConfig(film_grain=0.02)
        d = asdict(rc)
        assert d["film_grain"] == 0.02

    def test_asdict_includes_face_detail(self):
        rc = RunConfig(face_detail=True, face_detail_denoise=0.2)
        d = asdict(rc)
        assert d["face_detail"] is True
        assert d["face_detail_denoise"] == 0.2

    def test_asdict_includes_all_10_workflow_fields(self):
        rc = RunConfig(
            face_detail=True,
            face_detail_denoise=0.15,
            face_detail_steps=9,
            face_detail_lora="lora.safetensors",
            film_grain=0.01,
            sharpening=0.1,
            lut_path="lut/NaturalBoost.cube",
            lut_strength=0.3,
            skin_contrast=True,
            noise_clean=False,
        )
        d = asdict(rc)
        assert d["face_detail"] is True
        assert d["face_detail_denoise"] == 0.15
        assert d["face_detail_steps"] == 9
        assert d["face_detail_lora"] == "lora.safetensors"
        assert d["film_grain"] == 0.01
        assert d["sharpening"] == 0.1
        assert d["lut_path"] == "lut/NaturalBoost.cube"
        assert d["lut_strength"] == 0.3
        assert d["skin_contrast"] is True
        assert d["noise_clean"] is False


class TestDefaultWorkflowFields:
    def test_workflow_defaults_are_falsy(self):
        rc = RunConfig()
        assert rc.face_detail is False
        assert rc.face_detail_lora is None
        assert rc.film_grain == 0.0
        assert rc.sharpening == 0.0
        assert rc.lut_path is None
        assert rc.skin_contrast is False
        assert rc.noise_clean is False


class TestV11Migration:
    def _v11_dict(self) -> dict:
        return {
            "schema_version": 11,
            "command": "generate",
            "pipeline": "zimage",
            "transformer": "klein-9b",
            "prompt": "test",
            "prompt_file": None,
            "width": 640,
            "height": 960,
            "steps": 9,
            "seed": 42,
            "lora_path": None,
            "lora_scale": 1.0,
            "vae_path": None,
            "input_image": None,
            "latent_upscale": 1.0,
            "denoise_strength": 1.0,
            "upscale": False,
            "upscale_model": None,
            "upscale_method": "esrgan",
            "count": 1,
            "seed_start": None,
            "frames": None,
            "fps": None,
            "video_model": None,
            "cfg_scale": 5.0,
            "stg_scale": 1.0,
            "low_ram": False,
            "audio": None,
            "stage1_steps": None,
            "stage2_steps": None,
            "hq": False,
            "teacache": False,
            "teacache_thresh": None,
            "enhance_prompt": False,
            "begin_image": None,
            "end_image": None,
            "begin_strength": 1.0,
            "end_strength": 1.0,
            "distilled": False,
            "temporal_upscale": False,
            "control_image": None,
            "control_type": None,
            "control_strength": None,
            "variation_index": None,
            "ab_params": None,
            "draft": False,
            "seed_variance": False,
            "seed_variance_percent": 50.0,
            "seed_variance_strength": 20.0,
            "seed_variance_switchover": 20.0,
        }

    def test_v11_migrates_to_v12(self):
        raw = self._v11_dict()
        migrated = _migrate(raw)
        assert migrated["schema_version"] == 12

    def test_v11_migration_adds_all_workflow_fields(self):
        raw = self._v11_dict()
        migrated = _migrate(raw)
        workflow_fields = [
            "face_detail", "face_detail_denoise", "face_detail_steps", "face_detail_lora",
            "film_grain", "sharpening", "lut_path", "lut_strength",
            "skin_contrast", "noise_clean",
        ]
        for field in workflow_fields:
            assert field in migrated, f"Migration did not add field: {field}"

    def test_v11_migration_workflow_defaults(self):
        raw = self._v11_dict()
        migrated = _migrate(raw)
        assert migrated["face_detail"] is False
        assert migrated["face_detail_denoise"] == 0.15
        assert migrated["face_detail_steps"] == 9
        assert migrated["film_grain"] == 0.0
        assert migrated["sharpening"] == 0.0
        assert migrated["lut_path"] is None
        assert migrated["lut_strength"] == 0.3
        assert migrated["skin_contrast"] is False
        assert migrated["noise_clean"] is False

    def test_v11_migration_does_not_overwrite_existing_values(self):
        raw = self._v11_dict()
        raw["film_grain"] = 0.025  # pre-set (unusual but possible)
        migrated = _migrate(raw)
        assert migrated["film_grain"] == 0.025  # setdefault should NOT overwrite


class TestReproducibilityFields:
    def test_defaults_are_none(self):
        rc = RunConfig()
        assert rc.argv is None
        assert rc.loras is None

    def test_asdict_includes_argv_and_loras(self):
        rc = RunConfig(
            argv=["image", "generate"],
            loras=[{"path": "/lora.safetensors", "scale": 0.8, "stage": "main"}],
        )
        d = asdict(rc)
        assert d["argv"] == ["image", "generate"]
        assert d["loras"][0]["stage"] == "main"

    def test_from_args_snapshots_argv_and_builds_loras(self, monkeypatch):
        import argparse
        import sys
        import types
        # Stub the _shared helpers so from_args doesn't pull heavy pipeline imports.
        fake = types.ModuleType("app.commands._shared")
        fake.resolve_lora_path = lambda p: p
        fake.resolve_vae_path = lambda p: p
        monkeypatch.setitem(sys.modules, "app.commands._shared", fake)
        monkeypatch.setattr("sys.argv", ["run.py", "image", "generate", "--seed", "7"])
        ns = argparse.Namespace(
            prompt="cat", prompt_file=None,
            lora_path="/main.safetensors", lora_scale=0.9, face_detail_lora="/fd.safetensors",
        )
        rc = RunConfig.from_args(ns)
        assert rc.argv == ["image", "generate", "--seed", "7"]
        stages = {e["stage"]: e for e in rc.loras}
        assert stages["main"] == {"path": "/main.safetensors", "scale": 0.9, "stage": "main"}
        assert stages["face_detail"] == {"path": "/fd.safetensors", "scale": None, "stage": "face_detail"}

    def test_from_args_loras_none_when_no_lora(self, monkeypatch):
        import argparse
        import sys
        import types
        fake = types.ModuleType("app.commands._shared")
        fake.resolve_lora_path = lambda p: p
        fake.resolve_vae_path = lambda p: p
        monkeypatch.setitem(sys.modules, "app.commands._shared", fake)
        monkeypatch.setattr("sys.argv", ["run.py", "generate"])
        ns = argparse.Namespace(prompt="cat", prompt_file=None,
                                lora_path=None, lora_scale=1.0, face_detail_lora=None)
        rc = RunConfig.from_args(ns)
        assert rc.loras is None


class TestV12Migration:
    def test_v12_migrates_to_v13(self):
        assert _migrate({"schema_version": 12})["schema_version"] == 13

    def test_v12_migration_adds_argv_and_loras_defaults(self):
        m = _migrate({"schema_version": 12})
        assert m["argv"] is None
        assert m["loras"] is None

    def test_v12_migration_preserves_existing_argv(self):
        m = _migrate({"schema_version": 12, "argv": ["image", "generate"]})
        assert m["argv"] == ["image", "generate"]  # setdefault does not overwrite
