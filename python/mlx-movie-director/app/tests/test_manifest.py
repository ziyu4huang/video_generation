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
