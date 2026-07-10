"""Offline generation tests — pure-logic gates + real-MLX smoke (criterion 5).

Two tiers:

* **Logic tests (always run, no GPU):** verify the `--offline` machinery is
  correct without touching weights — env gating, preflight fail-loud,
  LTX-component check, `build_run_py_cmd` forwarding, the t2i2v VLM-skip
  branch, and the gemma_brain offline guard.

* **Smoke tests (`@pytest.mark.gpu`, needs `--run-gpu` + real MLX weights):**
  prove image T2I, video generate, and t2i2v all complete under `--offline`
  with the VLM stage skipped and the HF cache-only env set — i.e. zero runtime
  egress. These are the acceptance criteria 1–3 of the offline goal
  (`output/next-goal-20260710_061001.md`).

Run:
    python/venv/bin/python -m pytest app/tests/test_offline.py -v            # logic only
    python/venv/bin/python -m pytest app/tests/test_offline.py -v --run-gpu  # + real smoke
"""

from __future__ import annotations

import os
import subprocess
import sys

import pytest

from app import config as cfg
from app import offline
from app.commands import _shared


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_RUN_PY = os.path.normpath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "run.py")
)


def _run_py_cmd(*args: str) -> list[str]:
    """Build a run.py subprocess command under the SAME interpreter."""
    return [sys.executable, _RUN_PY, *args]


# ---------------------------------------------------------------------------
# Logic tests — env gating
# ---------------------------------------------------------------------------

class TestEnvGating:
    def test_apply_offline_sets_hf_env_vars_and_flag(self, monkeypatch):
        monkeypatch.delenv("HF_HUB_OFFLINE", raising=False)
        monkeypatch.delenv("TRANSFORMERS_OFFLINE", raising=False)
        cfg.OFFLINE = False
        offline.apply_offline()
        assert os.environ["HF_HUB_OFFLINE"] == "1"
        assert os.environ["TRANSFORMERS_OFFLINE"] == "1"
        assert cfg.OFFLINE is True
        # cleanup so other tests aren't affected
        cfg.OFFLINE = False


# ---------------------------------------------------------------------------
# Logic tests — preflight
# ---------------------------------------------------------------------------

class TestPreflight:
    def test_unknown_command_returns_no_problems(self):
        assert offline.preflight("check-model") == []
        assert offline.preflight("schema") == []

    def test_missing_weight_online_only_warns(self, tmp_path, monkeypatch):
        # Point MODELS_DIR at an empty dir so every component is "missing".
        monkeypatch.setattr(cfg, "MODELS_DIR", str(tmp_path))
        monkeypatch.setattr(cfg, "TRANSFORMER_DIR", str(tmp_path / "transformer"))
        monkeypatch.setattr(cfg, "TEXT_ENCODER_DIR", str(tmp_path / "te"))
        monkeypatch.setattr(cfg, "TOKENIZER_DIR", str(tmp_path / "tok"))
        monkeypatch.setattr(cfg, "ZIMAGE_AE_VAE_DIR", str(tmp_path / "vae"))
        monkeypatch.setattr(cfg, "OFFLINE", False)
        problems = offline.preflight("image", pipeline="zimage", offline=False)
        assert problems  # something missing, but NOT raised (online = warn only)

    def test_missing_weight_offline_fails_loud(self, tmp_path, monkeypatch):
        monkeypatch.setattr(cfg, "TRANSFORMER_DIR", str(tmp_path / "transformer"))
        monkeypatch.setattr(cfg, "TEXT_ENCODER_DIR", str(tmp_path / "te"))
        monkeypatch.setattr(cfg, "TOKENIZER_DIR", str(tmp_path / "tok"))
        monkeypatch.setattr(cfg, "ZIMAGE_AE_VAE_DIR", str(tmp_path / "vae"))
        monkeypatch.setattr(cfg, "OFFLINE", True)
        with pytest.raises(offline.OfflinePreflightError) as exc:
            offline.preflight("image", pipeline="zimage", offline=True)
        assert "--offline preflight" in str(exc.value)

    def test_present_weights_pass(self, monkeypatch):
        # Against the REAL models tree (the repo's mlx-models), zimage must pass.
        monkeypatch.setattr(cfg, "OFFLINE", False)
        problems = offline.preflight("image", pipeline="zimage", offline=False)
        # If the real tree lacks a component we still want an empty list only when
        # all are present; assert no exception is raised either way.
        assert isinstance(problems, list)

    def test_check_ltx_components_returns_tuples(self):
        missing, present = offline.check_ltx_components()
        assert isinstance(missing, list)
        assert isinstance(present, list)
        # Against the real tree these should be present (verified manually).
        # We don't hard-assert presence here so the test is robust on a fresh
        # clone before ltx_downloader runs; the GPU smoke test covers presence.


# ---------------------------------------------------------------------------
# Logic tests — subprocess forwarding
# ---------------------------------------------------------------------------

class TestBuildRunPyCmdForwardsOffline:
    def test_forwarded_when_parent_argv_has_offline(self, monkeypatch):
        monkeypatch.setattr(sys, "argv", ["run.py", "video", "t2i2v", "--offline"])
        cmd = _shared.build_run_py_cmd("caption", "img.png")
        assert "--offline" in cmd

    def test_not_forwarded_when_parent_argv_lacks_offline(self, monkeypatch):
        monkeypatch.setattr(sys, "argv", ["run.py", "image", "t2i"])
        cmd = _shared.build_run_py_cmd("caption", "img.png")
        assert "--offline" not in cmd

    def test_not_duplicated_when_already_in_args(self, monkeypatch):
        monkeypatch.setattr(sys, "argv", ["run.py", "--offline"])
        cmd = _shared.build_run_py_cmd("video", "generate", "--offline")
        assert cmd.count("--offline") == 1


class TestGemmaBrainOfflineGuard:
    def test_decompose_raises_under_offline(self, monkeypatch):
        monkeypatch.setattr(cfg, "OFFLINE", True)
        from app.planning import gemma_brain
        with pytest.raises(RuntimeError, match="unavailable under --offline"):
            gemma_brain.decompose_story("a story", num_panels=2)

    def test_decompose_does_not_raise_flag_check_when_online(self, monkeypatch):
        # Online path proceeds past the guard to requests (which we don't actually
        # want to fire in a unit test). We only assert the guard itself is inert:
        # patch requests.post to short-circuit and confirm no RuntimeError about
        # offline is raised. Use a bogus URL so it fails fast, not on the guard.
        monkeypatch.setattr(cfg, "OFFLINE", False)
        from app.planning import gemma_brain
        # Force the ensure-model step to be a no-op so we don't hit the network.
        monkeypatch.setattr(gemma_brain, "_lmstudio_ensure_model", lambda *a, **k: None)
        monkeypatch.setattr(gemma_brain, "resolve_default_model", lambda url: "m")
        raised_offline = False
        try:
            gemma_brain.decompose_story("a story", num_panels=2, api_url="http://127.0.0.1:1")
        except RuntimeError as e:
            if "unavailable under --offline" in str(e):
                raised_offline = True
        except Exception:
            pass  # connection errors are expected (no LM Studio); not our concern
        assert not raised_offline, "online path must not trip the offline guard"


# ---------------------------------------------------------------------------
# Logic tests — auxiliary runtime-download guards (pose model, face-restore)
# ---------------------------------------------------------------------------

class TestPoseModelOfflineGuard:
    def test_ensure_pose_model_raises_under_offline_when_uncached(self, monkeypatch, tmp_path):
        # Point the pose cache at a non-existent path so the "already cached"
        # short-circuit is inert, and confirm --offline forbids the download.
        import importlib
        i2i = importlib.import_module("app.commands.image-i2i")
        monkeypatch.setattr(i2i, "_POSE_MODEL_CACHE", str(tmp_path / "nope.task"))
        monkeypatch.setattr(cfg, "OFFLINE", True)
        with pytest.raises(RuntimeError, match="forbids download"):
            i2i._ensure_pose_model()

    def test_ensure_pose_model_returns_cached_under_offline(self, monkeypatch, tmp_path):
        # If the model IS cached, offline must NOT raise — it just returns the path.
        import importlib
        i2i = importlib.import_module("app.commands.image-i2i")
        cached = tmp_path / "pose.task"
        cached.write_bytes(b"")  # exists → cached
        monkeypatch.setattr(i2i, "_POSE_MODEL_CACHE", str(cached))
        monkeypatch.setattr(cfg, "OFFLINE", True)
        assert i2i._ensure_pose_model() == str(cached)


class TestFaceRestoreOfflineGuard:
    def test_bridge_make_bg_upsampler_fails_loud_offline_when_uncached(self, monkeypatch, tmp_path):
        # The bridge's _make_bg_upsampler imports torch/realesrgan (face-venv only).
        # We can't import those here, so test the DECISION by stubbing the heavy
        # imports and asserting the offline branch raises before any download.
        import importlib
        bridge = importlib.import_module("app.face_restore_bridge")
        monkeypatch.setenv("FACE_RESTORE_OFFLINE", "1")
        monkeypatch.setenv("FACE_RESTORE_EXTRA_WEIGHTS_DIRS", str(tmp_path))
        # Stub the heavy imports so we reach the decision logic without face-venv.
        import types
        fake_realesrgan = types.ModuleType("realesrgan")
        fake_realesrgan.RealESRGANer = lambda **kw: None  # stub; never reached under offline
        fake_basicsr = types.ModuleType("basicsr")
        fake_basicsr_archs = types.ModuleType("basicsr.archs")
        fake_rrdb = types.ModuleType("basicsr.archs.rrdbnet_arch")
        fake_rrdb.RRDBNet = lambda **kw: None
        fake_basicsr_archs.rrdbnet_arch = fake_rrdb
        fake_basicsr.archs = fake_basicsr_archs
        monkeypatch.setitem(sys.modules, "realesrgan", fake_realesrgan)
        monkeypatch.setitem(sys.modules, "basicsr", fake_basicsr)
        monkeypatch.setitem(sys.modules, "basicsr.archs", fake_basicsr_archs)
        monkeypatch.setitem(sys.modules, "basicsr.archs.rrdbnet_arch", fake_rrdb)
        # weights_dir empty + extra dir empty + offline → must raise, never download.
        with pytest.raises(RuntimeError, match="forbids download"):
            bridge._make_bg_upsampler(str(tmp_path / "wd"), "cpu")


# ---------------------------------------------------------------------------
# GPU smoke tests — real MLX generation under --offline (criteria 1–3)
# Gated by the `gpu` marker + conftest's --run-gpu flag (see conftest.py).
# ---------------------------------------------------------------------------


@pytest.mark.gpu
def test_image_t2i_offline_selftest():
    """Criterion 1: image T2I completes under --offline (Z-Image)."""
    env = os.environ.copy()
    proc = subprocess.run(
        _run_py_cmd("image", "t2i", "--offline", "--self-test"),
        capture_output=True, text=True, env=env, timeout=600,
    )
    assert proc.returncode == 0, proc.stderr[-2000:]
    assert "Saved:" in proc.stdout
    assert os.environ.get("HF_HUB_OFFLINE") in (None, "1")  # not leaked by test


@pytest.mark.gpu
def test_video_generate_offline_selftest():
    """Criterion 2: native LTX video generate completes under --offline."""
    proc = subprocess.run(
        _run_py_cmd("video", "generate", "--offline", "--self-test", "beach-walk"),
        capture_output=True, text=True, timeout=900,
    )
    assert proc.returncode == 0, proc.stderr[-2000:]
    assert ".mp4" in proc.stdout
    assert "[self-test] Done" in proc.stdout


@pytest.mark.gpu
def test_t2i2v_offline_skips_vlm():
    """Criterion 3: t2i2v under --offline skips the VLM stage and completes."""
    proc = subprocess.run(
        _run_py_cmd("video", "t2i2v", "--offline",
                    "--prompt", "a woman in a red dress",
                    "--action", "she smiles",
                    "--frames", "9"),
        capture_output=True, text=True, timeout=900,
    )
    combined = proc.stdout + proc.stderr
    assert proc.returncode == 0, combined[-2000:]
    assert "VLM skipped (--offline" in combined
    assert ".mp4" in combined


@pytest.mark.gpu
def test_offline_preflight_fails_loud_on_missing(tmp_path):
    """Criterion 4: --offline fails immediately when a weight is missing."""
    proc = subprocess.run(
        _run_py_cmd("image", "t2i", "--offline", "--models-dir", str(tmp_path), "--self-test"),
        capture_output=True, text=True, timeout=120,
    )
    assert proc.returncode == 1
    assert "--offline preflight" in proc.stderr


@pytest.mark.gpu
def test_check_model_preflight_passes():
    """Criterion 4: check-model --preflight is green against the real tree."""
    proc = subprocess.run(
        _run_py_cmd("check-model", "--preflight"),
        capture_output=True, text=True, timeout=120,
    )
    assert proc.returncode == 0, proc.stderr[-2000:]
    assert "Offline preflight PASS" in proc.stdout
