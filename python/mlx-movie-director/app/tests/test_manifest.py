"""Unit tests for app/manifest.py — Manifest dataclass and file_fingerprint."""

import json
import os
import tempfile
from datetime import datetime, timezone

import pytest

from app.manifest import Manifest, file_fingerprint, _parse_iso


class TestFileFingerprint:
    def test_existing_file_returns_size_and_hash(self, tmp_path):
        p = tmp_path / "test.bin"
        p.write_bytes(b"hello world")
        result = file_fingerprint(str(p))
        assert "error" not in result
        assert result["size_bytes"] == len(b"hello world")
        assert "md5_partial" in result
        assert len(result["md5_partial"]) == 32  # MD5 hex digest

    def test_missing_file_returns_error_dict(self, tmp_path):
        result = file_fingerprint(str(tmp_path / "nonexistent.bin"))
        assert "error" in result
        assert result["error"] == "file not found"

    def test_large_file_uses_head_and_tail(self, tmp_path):
        # Write 3 MB of data (> 1 MB default chunk)
        p = tmp_path / "large.bin"
        p.write_bytes(b"A" * (3 * 1024 * 1024))
        result = file_fingerprint(str(p))
        assert result["size_bytes"] == 3 * 1024 * 1024
        assert "md5_partial" in result

    def test_two_identical_files_have_same_fingerprint(self, tmp_path):
        data = b"same content " * 100
        p1 = tmp_path / "a.bin"
        p2 = tmp_path / "b.bin"
        p1.write_bytes(data)
        p2.write_bytes(data)
        assert file_fingerprint(str(p1))["md5_partial"] == file_fingerprint(str(p2))["md5_partial"]


class TestManifestFromSuccess:
    def _make_manifest(self, elapsed_seconds: float = 5.0) -> Manifest:
        start = datetime(2026, 1, 1, 0, 0, 0, tzinfo=timezone.utc).isoformat()
        end = datetime(2026, 1, 1, 0, 0, int(elapsed_seconds), tzinfo=timezone.utc).isoformat()
        return Manifest.from_success(
            run_file="/tmp/test.run.json",
            start_time=start,
            end_time=end,
            timings={"encode": 0.5, "denoise": 4.0},
            output_files=[{"path": "/tmp/test.png", "seed": 42, "width": 640, "height": 960}],
            models={"transformer": {"path": "/models/tf", "size_bytes": 100}},
        )

    def test_status_is_success(self):
        mf = self._make_manifest()
        assert mf.status == "success"

    def test_elapsed_seconds_computed_correctly(self):
        mf = self._make_manifest(elapsed_seconds=7.0)
        assert mf.elapsed_seconds == pytest.approx(7.0, abs=0.1)

    def test_error_is_none(self):
        mf = self._make_manifest()
        assert mf.error is None

    def test_output_files_preserved(self):
        mf = self._make_manifest()
        assert len(mf.output_files) == 1
        assert mf.output_files[0]["seed"] == 42

    def test_to_json_round_trip(self, tmp_path):
        mf = self._make_manifest()
        path = str(tmp_path / "test.manifest.json")
        mf.to_json(path)
        with open(path) as f:
            data = json.load(f)
        assert data["status"] == "success"
        assert data["elapsed_seconds"] == pytest.approx(5.0, abs=0.1)


class TestManifestFromError:
    def test_status_is_error(self):
        start = end = datetime(2026, 1, 1, tzinfo=timezone.utc).isoformat()
        try:
            raise ValueError("something went wrong")
        except ValueError as e:
            mf = Manifest.from_error(
                run_file="/tmp/test.run.json",
                start_time=start,
                end_time=end,
                timings={},
                exception=e,
                models={},
            )
        assert mf.status == "error"

    def test_error_captures_exception_type(self):
        start = end = datetime(2026, 1, 1, tzinfo=timezone.utc).isoformat()
        try:
            raise RuntimeError("model load failed")
        except RuntimeError as e:
            mf = Manifest.from_error(
                run_file="/tmp/test.run.json",
                start_time=start,
                end_time=end,
                timings={},
                exception=e,
                models={},
            )
        assert mf.error is not None
        assert mf.error["type"] == "RuntimeError"
        assert "model load failed" in mf.error["message"]

    def test_output_files_is_none_on_error(self):
        start = end = datetime(2026, 1, 1, tzinfo=timezone.utc).isoformat()
        try:
            raise ValueError("err")
        except ValueError as e:
            mf = Manifest.from_error("/tmp/x.run.json", start, end, {}, e, {})
        assert mf.output_files is None


class TestPipelineSteps:
    def test_timings_become_ordered_steps(self):
        start = end = datetime(2026, 1, 1, tzinfo=timezone.utc).isoformat()
        mf = Manifest.from_success(
            "/tmp/x.run.json", start, end,
            timings={"text_encoding_seconds": 0.5, "denoising_seconds": 4.0, "vae_decode_seconds": 0.7},
            output_files=[], models={})
        assert [s["step"] for s in mf.pipeline_steps] == [
            "text_encoding_seconds", "denoising_seconds", "vae_decode_seconds"]
        assert mf.pipeline_steps[1]["seconds"] == 4.0

    def test_denoise_step_times_collapsed_into_detail(self):
        start = end = datetime(2026, 1, 1, tzinfo=timezone.utc).isoformat()
        mf = Manifest.from_success("/tmp/x.run.json", start, end,
            timings={"denoising_seconds": 4.0, "denoising_step_times": [0.4, 0.41, 0.39]},
            output_files=[], models={})
        steps = {s["step"]: s for s in mf.pipeline_steps}
        assert "denoising_step_times" not in steps
        assert steps["denoising_per_step"]["detail"] == [0.4, 0.41, 0.39]

    def test_empty_timings_yields_none_pipeline_steps(self):
        start = end = datetime(2026, 1, 1, tzinfo=timezone.utc).isoformat()
        mf = Manifest.from_success("/tmp/x.run.json", start, end, timings={}, output_files=[], models={})
        assert mf.pipeline_steps is None

    def test_stage_timings_prepended(self):
        start = end = datetime(2026, 1, 1, tzinfo=timezone.utc).isoformat()
        mf = Manifest.from_success("/tmp/x.run.json", start, end,
            timings={"denoising_seconds": 4.0}, output_files=[], models={},
            stage_timings={"base": {"denoising_seconds": 4.0}, "face_detail": {"total": 2.0}})
        assert [s["step"] for s in mf.pipeline_steps] == [
            "stage:base", "stage:face_detail", "denoising_seconds"]
        assert mf.pipeline_steps[1]["seconds"] == 2.0


class TestMultiLoraFingerprint:
    def test_loras_list_includes_main_and_extra(self, tmp_path):
        from app.manifest import collect_model_fingerprint
        main = tmp_path / "main.safetensors"
        main.write_bytes(b"main")
        extra = tmp_path / "extra.safetensors"
        extra.write_bytes(b"extra")
        models = collect_model_fingerprint(lora_path=str(main), extra_loras=[str(extra)])
        assert "loras" in models
        assert len(models["loras"]) == 2
        assert models["lora"]["path"] == str(main)  # backward-compat single entry

    def test_no_lora_keys_when_none(self):
        from app.manifest import collect_model_fingerprint
        models = collect_model_fingerprint(lora_path=None, extra_loras=None)
        assert "loras" not in models
        assert "lora" not in models


class TestEvents:
    """Runtime events trace: what the pipeline ACTUALLY did (model loads, LoRA, denoise)."""

    _SAMPLE_EVENTS = [
        {"event": "model_loaded", "target": "transformer",
         "detail": {"quant": "4bit", "weights": "sharded"}, "seconds": 12.3},
        {"event": "lora_applied", "target": "style.safetensors",
         "detail": {"type": "lora", "applied_count": 64, "user_scale": 0.8}, "seconds": None},
        {"event": "denoise_config", "target": "denoise",
         "detail": {"steps": 9, "img2img": False}, "seconds": None},
    ]

    def _iso(self) -> str:
        return datetime(2026, 1, 1, tzinfo=timezone.utc).isoformat()

    def test_from_success_accepts_events(self):
        mf = Manifest.from_success("/tmp/x.run.json", self._iso(), self._iso(),
                                   timings={}, output_files=[], models={},
                                   events=self._SAMPLE_EVENTS)
        assert mf.events == self._SAMPLE_EVENTS
        assert mf.events[1]["detail"]["type"] == "lora"

    def test_from_success_events_defaults_none(self):
        mf = Manifest.from_success("/tmp/x.run.json", self._iso(), self._iso(),
                                   timings={}, output_files=[], models={})
        assert mf.events is None

    def test_events_round_trip_json(self, tmp_path):
        mf = Manifest.from_success("/tmp/x.run.json", self._iso(), self._iso(),
                                   timings={}, output_files=[], models={},
                                   events=self._SAMPLE_EVENTS)
        path = str(tmp_path / "ev.manifest.json")
        mf.to_json(path)
        with open(path) as f:
            data = json.load(f)
        assert data["events"] == self._SAMPLE_EVENTS
        assert data["events"][0]["target"] == "transformer"

    def test_from_error_events_none_by_default(self):
        try:
            raise ValueError("boom")
        except ValueError as e:
            mf = Manifest.from_error("/tmp/x.run.json", self._iso(), self._iso(),
                                     timings={}, exception=e, models={})
        assert mf.events is None

    def test_events_and_pipeline_steps_coexist(self):
        mf = Manifest.from_success("/tmp/x.run.json", self._iso(), self._iso(),
                                   timings={"denoising_seconds": 4.0},
                                   output_files=[], models={},
                                   events=self._SAMPLE_EVENTS)
        assert mf.events is not None and len(mf.events) == 3
        # pipeline_steps built independently from timings; events untouched
        assert [s["step"] for s in mf.pipeline_steps] == ["denoising_seconds"]
        assert mf.pipeline_steps[0]["seconds"] == 4.0
