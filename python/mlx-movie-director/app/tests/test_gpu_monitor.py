"""Unit tests for app/gpu_monitor.py — command classifier, detection tiers, GpuLock."""

import fcntl
import json
import os
import subprocess
import sys
import tempfile
import time
from io import StringIO
from types import SimpleNamespace
from unittest.mock import MagicMock, patch, mock_open

import pytest

from app.gpu_monitor import (
    GpuStatus,
    GpuLock,
    _LOCK_DIR,
    _LOCK_FILE,
    _GPU_HEAVY_IMAGE_ACTIONS,
    _GPU_HEAVY_VIDEO_ACTIONS,
    _LIGHTWEIGHT_COMMANDS,
    _LIGHTWEIGHT_IMAGE_ACTIONS,
    _RUN_PY_PATH,
    detect_gpu_busy,
    is_gpu_heavy_command,
    _detect_macmon,
    _detect_psutil,
    _detect_runpy,
    _print_available,
    _print_busy,
    _print_timeout,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_args(command, action=None, **kwargs):
    """Build a SimpleNamespace mimicking parsed argparse output."""
    ns = SimpleNamespace(command=command)
    if action is not None:
        ns.action = action
    for k, v in kwargs.items():
        setattr(ns, k, v)
    return ns


# ---------------------------------------------------------------------------
# Test: is_gpu_heavy_command — GPU-heavy commands
# ---------------------------------------------------------------------------

class TestIsGpuHeavyCommandHeavy:
    """Verify all GPU-heavy commands are classified correctly."""

    def test_t2i_alias(self):
        assert is_gpu_heavy_command(_make_args("t2i"))

    def test_generate_alias(self):
        assert is_gpu_heavy_command(_make_args("generate"))

    def test_refine(self):
        assert is_gpu_heavy_command(_make_args("refine"))

    def test_animate(self):
        assert is_gpu_heavy_command(_make_args("animate"))

    def test_upscale_seedvr2(self):
        assert is_gpu_heavy_command(_make_args("upscale", method="seedvr2"))

    @pytest.mark.parametrize("action", sorted(_GPU_HEAVY_IMAGE_ACTIONS))
    def test_image_gpu_heavy_actions(self, action):
        assert is_gpu_heavy_command(_make_args("image", action))

    @pytest.mark.parametrize("action", sorted(_GPU_HEAVY_VIDEO_ACTIONS))
    def test_video_gpu_heavy_actions(self, action):
        assert is_gpu_heavy_command(_make_args("video", action))


# ---------------------------------------------------------------------------
# Test: is_gpu_heavy_command — Lightweight commands
# ---------------------------------------------------------------------------

class TestIsGpuHeavyCommandLightweight:
    """Verify lightweight commands are not classified as GPU-heavy."""

    @pytest.mark.parametrize("command", sorted(_LIGHTWEIGHT_COMMANDS))
    def test_always_lightweight_commands(self, command):
        assert not is_gpu_heavy_command(_make_args(command))

    def test_upscale_esrgan(self):
        assert not is_gpu_heavy_command(_make_args("upscale", method="esrgan"))

    def test_upscale_default(self):
        assert not is_gpu_heavy_command(_make_args("upscale"))

    @pytest.mark.parametrize("action", ["review", "compare", "quality"])
    def test_video_lightweight_actions(self, action):
        assert not is_gpu_heavy_command(_make_args("video", action))

    @pytest.mark.parametrize("action", sorted(_LIGHTWEIGHT_IMAGE_ACTIONS))
    def test_image_lightweight_actions(self, action):
        assert not is_gpu_heavy_command(_make_args("image", action))

    def test_unknown_command(self):
        assert not is_gpu_heavy_command(_make_args("unknown-cmd"))


# ---------------------------------------------------------------------------
# Test: is_gpu_heavy_command — Conditional classification
# ---------------------------------------------------------------------------

class TestIsGpuHeavyCommandConditional:
    """Verify conditional GPU-heavy classification (self-test, replay, upscale)."""

    def test_image_review_with_selftest(self):
        assert is_gpu_heavy_command(_make_args("image", "review", self_test="ultraflux"))

    def test_image_quality_with_selftest(self):
        assert is_gpu_heavy_command(_make_args("image", "quality", self_test=True))

    def test_image_review_without_selftest(self):
        assert not is_gpu_heavy_command(_make_args("image", "review"))

    def test_image_quality_without_selftest(self):
        assert not is_gpu_heavy_command(_make_args("image", "quality"))

    def test_replay_gpu_heavy_command(self, tmp_path):
        """Replay of a GPU-heavy command is classified as GPU-heavy."""
        run_json = tmp_path / "test.run.json"
        run_json.write_text(json.dumps({"command": "image t2i"}))
        args = _make_args("replay", file=str(run_json))
        assert is_gpu_heavy_command(args)

    def test_replay_lightweight_command(self, tmp_path):
        """Replay of a lightweight command is classified as lightweight."""
        run_json = tmp_path / "test.run.json"
        run_json.write_text(json.dumps({"command": "caption"}))
        args = _make_args("replay", file=str(run_json))
        assert not is_gpu_heavy_command(args)

    def test_replay_missing_file(self):
        """Replay with missing file assumes GPU-heavy (safe default)."""
        args = _make_args("replay", file="/nonexistent/run.json")
        assert is_gpu_heavy_command(args)

    def test_replay_no_file_attr(self):
        """Replay without file attribute assumes GPU-heavy."""
        args = _make_args("replay")
        assert is_gpu_heavy_command(args)

    def test_image_unknown_action_defaults_heavy(self):
        """Unknown image actions default to GPU-heavy (safe)."""
        assert is_gpu_heavy_command(_make_args("image", "unknown-new-feature"))


# ---------------------------------------------------------------------------
# Test: GpuStatus dataclass
# ---------------------------------------------------------------------------

class TestGpuStatus:
    def test_defaults(self):
        s = GpuStatus(busy=False)
        assert s.utilization == -1.0
        assert s.source == "none"
        assert s.details == ""
        assert s.blocking_pids == []
        assert s.blocking_commands == []

    def test_custom_values(self):
        s = GpuStatus(
            busy=True,
            utilization=0.85,
            source="macmon",
            details="high GPU load",
            blocking_pids=[1234],
            blocking_commands=["python run.py"],
        )
        assert s.busy is True
        assert s.utilization == 0.85
        assert len(s.blocking_pids) == 1


# ---------------------------------------------------------------------------
# Test: Tier 1 — macmon detection (mocked subprocess)
# ---------------------------------------------------------------------------

class TestMacmonDetection:
    def test_parse_valid_ndjson(self):
        """Valid macmon NDJSON output with high utilization."""
        mock_output = json.dumps({"gpu_usage": [500000000, 0.85]})
        with patch("subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(
                returncode=0, stdout=mock_output, stderr=""
            )
            status = _detect_macmon(0.5)
            assert status is not None
            assert status.busy is True
            assert status.utilization == 0.85
            assert status.source == "macmon"

    def test_parse_low_utilization(self):
        """Valid macmon output with low utilization → not busy."""
        mock_output = json.dumps({"gpu_usage": [500000000, 0.05]})
        with patch("subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(
                returncode=0, stdout=mock_output, stderr=""
            )
            status = _detect_macmon(0.5)
            assert status is not None
            assert status.busy is False
            assert status.utilization == 0.05

    def test_parse_empty_output(self):
        """Empty macmon output returns None."""
        with patch("subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(returncode=0, stdout="", stderr="")
            status = _detect_macmon(0.5)
            assert status is None

    def test_parse_invalid_json(self):
        """Non-JSON lines are skipped; valid line parsed."""
        mock_output = "not-json\n" + json.dumps({"gpu_usage": [500000000, 0.7]})
        with patch("subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(
                returncode=0, stdout=mock_output, stderr=""
            )
            status = _detect_macmon(0.5)
            assert status is not None
            assert status.utilization == 0.7

    def test_macmon_not_found(self):
        """macmon binary not found returns None."""
        with patch("subprocess.run", side_effect=FileNotFoundError):
            status = _detect_macmon(0.5)
            assert status is None

    def test_macmon_timeout(self):
        """macmon subprocess timeout returns None."""
        with patch("subprocess.run", side_effect=subprocess.TimeoutExpired("macmon", 4)):
            status = _detect_macmon(0.5)
            assert status is None

    def test_macmon_nonzero_returncode(self):
        """macmon returning error code returns None."""
        with patch("subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(returncode=1, stdout="", stderr="error")
            status = _detect_macmon(0.5)
            assert status is None


# ---------------------------------------------------------------------------
# Test: Tier 2 — psutil detection (mocked)
# ---------------------------------------------------------------------------

class TestPsutilDetection:
    def _mock_proc(self, pid, name="python", cmdline=None, rss_mb=5000):
        """Create a mock process info dict."""
        rss_bytes = rss_mb * 1024 * 1024
        return {
            "pid": pid,
            "name": name,
            "cmdline": cmdline or ["python", "run.py", "video", "generate"],
            "rss": rss_bytes,
        }

    def test_detect_ml_process_large_rss(self):
        """Python process with ML keyword + large RSS is detected."""
        mock_procs = [
            self._mock_proc(100, rss_mb=5000, cmdline=["python", "-m", "torch"]),
            self._mock_proc(os.getpid(), rss_mb=5000),  # self (ignored)
        ]
        with patch("psutil.process_iter", return_value=[
            MagicMock(info=self._mock_proc(100, rss_mb=5000, cmdline=["python", "-m", "torch"])),
        ]):
            status = _detect_psutil(0.5)
            assert status is not None
            assert status.busy is True
            assert 100 in status.blocking_pids

    def test_ignore_small_rss(self):
        """Python process with ML keyword but small RSS is ignored."""
        with patch("psutil.process_iter", return_value=[
            MagicMock(info=self._mock_proc(100, rss_mb=500,
                                           cmdline=["python", "-m", "torch"])),
        ]):
            status = _detect_psutil(0.5)
            assert status is not None
            assert status.busy is False

    def test_very_large_rss_no_keyword(self):
        """Non-ML Python process with >8GB RSS is still detected."""
        with patch("psutil.process_iter", return_value=[
            MagicMock(info=self._mock_proc(100, rss_mb=10000,
                                           cmdline=["python", "some_app.py"])),
        ]):
            status = _detect_psutil(0.5)
            assert status is not None
            assert status.busy is True

    def test_ignore_non_python(self):
        """Non-Python processes are ignored."""
        with patch("psutil.process_iter", return_value=[
            MagicMock(info=self._mock_proc(100, name="node", rss_mb=10000,
                                           cmdline=["node", "server.js"])),
        ]):
            status = _detect_psutil(0.5)
            assert status is not None
            assert status.busy is False

    def test_no_blocking_processes(self):
        """No ML processes → not busy."""
        with patch("psutil.process_iter", return_value=[]):
            status = _detect_psutil(0.5)
            assert status is not None
            assert status.busy is False

    def test_no_psutil_module(self):
        """Missing psutil returns None."""
        with patch.dict("sys.modules", {"psutil": None}):
            # Force re-import to hit ImportError
            status = _detect_psutil(0.5)
            # psutil is actually installed in test env, so this tests the try/except
            # In production without psutil, returns None


# ---------------------------------------------------------------------------
# Test: Tier 3 — runpy detection (mocked subprocess)
# ---------------------------------------------------------------------------

class TestRunpyDetection:
    def test_detect_other_run_py(self):
        """Another run.py process (different PID) is detected."""
        self_pid = os.getpid()
        # Use the actual _RUN_PY_PATH to match the detection logic
        ps_output = f"{self_pid} python some_other_thing\n9999 python {_RUN_PY_PATH} video generate\n"
        with patch("subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(returncode=0, stdout=ps_output, stderr="")
            status = _detect_runpy()
            assert status.busy is True
            assert 9999 in status.blocking_pids

    def test_ignore_self_pid(self):
        """Own process is not detected as blocking."""
        self_pid = os.getpid()
        ps_output = f"{self_pid} python run.py video generate\n"
        with patch("subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(returncode=0, stdout=ps_output, stderr="")
            status = _detect_runpy()
            assert status.busy is False

    def test_no_other_processes(self):
        """No other run.py processes → not busy."""
        with patch("subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(returncode=0, stdout="", stderr="")
            status = _detect_runpy()
            assert status.busy is False

    def test_ps_scan_failure(self):
        """ps command failure returns not-busy status."""
        with patch("subprocess.run", side_effect=Exception("ps failed")):
            status = _detect_runpy()
            assert status.busy is False
            assert "failed" in status.details


# ---------------------------------------------------------------------------
# Test: detect_gpu_busy — tier chain
# ---------------------------------------------------------------------------

class TestDetectGpuBusy:
    def test_macmon_succeeds(self):
        """When macmon returns busy, it's the final result."""
        with patch("app.gpu_monitor._detect_macmon") as mock_macmon:
            mock_macmon.return_value = GpuStatus(busy=True, utilization=0.9, source="macmon")
            status = detect_gpu_busy()
            assert status.source == "macmon"
            assert status.busy is True

    def test_falls_through_to_runpy(self):
        """When macmon and psutil fail, falls through to runpy."""
        with patch("app.gpu_monitor._detect_macmon", return_value=None), \
             patch("app.gpu_monitor._detect_psutil", return_value=None), \
             patch("app.gpu_monitor._detect_runpy") as mock_runpy:
            mock_runpy.return_value = GpuStatus(busy=False, source="runpy")
            status = detect_gpu_busy()
            assert status.source == "runpy"
            mock_runpy.assert_called_once()


# ---------------------------------------------------------------------------
# Test: GpuLock context manager
# ---------------------------------------------------------------------------

class TestGpuLock:
    """GpuLock tests use isolated lock files in tmp_path to avoid cross-test interference."""

    def _patch_lock_path(self, tmp_path):
        """Return a dict of patches that redirect lock file to tmp_path."""
        test_lock_dir = str(tmp_path / "gpu-lock")
        test_lock_file = os.path.join(test_lock_dir, "gpu.lock")
        return {
            "lock_dir": patch("app.gpu_monitor._LOCK_DIR", test_lock_dir),
            "lock_file": patch("app.gpu_monitor._LOCK_FILE", test_lock_file),
        }

    def test_skip_bypasses_lock(self, tmp_path):
        """GpuLock(skip=True) enters immediately without flock."""
        lock = GpuLock(skip=True)
        with lock:
            assert lock._lock_fd is None  # no file opened

    def test_force_bypasses_lock(self, tmp_path):
        """GpuLock(force=True) enters immediately without flock."""
        lock = GpuLock(force=True)
        with lock:
            assert lock._lock_fd is None

    def test_lock_acquires_and_releases(self, tmp_path):
        """GpuLock acquires flock and releases on exit."""
        patches = self._patch_lock_path(tmp_path)
        with patches["lock_dir"], patches["lock_file"], \
             patch("app.gpu_monitor._detect_macmon", return_value=None), \
             patch("app.gpu_monitor._detect_psutil", return_value=None), \
             patch("app.gpu_monitor._detect_runpy",
                   return_value=GpuStatus(busy=False, source="runpy")):
            from app.gpu_monitor import _LOCK_FILE as test_lock_file
            lock = GpuLock(max_wait=5)
            with lock:
                assert lock._lock_fd is not None
                assert os.path.exists(test_lock_file)
            assert lock._lock_fd is None

    def test_lock_mutual_exclusion(self, tmp_path):
        """Two GpuLock instances cannot hold the lock simultaneously."""
        patches = self._patch_lock_path(tmp_path)
        with patches["lock_dir"], patches["lock_file"], \
             patch("app.gpu_monitor._detect_macmon", return_value=None), \
             patch("app.gpu_monitor._detect_psutil", return_value=None), \
             patch("app.gpu_monitor._detect_runpy",
                   return_value=GpuStatus(busy=False, source="runpy")):
            lock1 = GpuLock(max_wait=60)
            lock1.__enter__()
            try:
                lock2 = GpuLock(max_wait=1, poll_interval=0.1)
                with pytest.raises(SystemExit):
                    lock2.__enter__()
            finally:
                lock1.__exit__(None, None, None)

    def test_timeout_exits(self, tmp_path):
        """GpuLock with max_wait=0 exits immediately when lock is held."""
        patches = self._patch_lock_path(tmp_path)
        with patches["lock_dir"], patches["lock_file"], \
             patch("app.gpu_monitor._detect_macmon", return_value=None), \
             patch("app.gpu_monitor._detect_psutil", return_value=None), \
             patch("app.gpu_monitor._detect_runpy",
                   return_value=GpuStatus(busy=True, source="runpy")):
            from app.gpu_monitor import _LOCK_DIR as test_lock_dir, \
                _LOCK_FILE as test_lock_file
            # Hold the lock externally
            os.makedirs(test_lock_dir, exist_ok=True)
            fd = open(test_lock_file, "w")
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                lock = GpuLock(max_wait=0, poll_interval=0.1)
                with pytest.raises(SystemExit):
                    lock.__enter__()
            finally:
                fcntl.flock(fd, fcntl.LOCK_UN)
                fd.close()

    def test_lock_released_on_exception(self, tmp_path):
        """Lock is released even when an exception occurs inside the context."""
        patches = self._patch_lock_path(tmp_path)
        with patches["lock_dir"], patches["lock_file"], \
             patch("app.gpu_monitor._detect_macmon", return_value=None), \
             patch("app.gpu_monitor._detect_psutil", return_value=None), \
             patch("app.gpu_monitor._detect_runpy",
                   return_value=GpuStatus(busy=False, source="runpy")):
            from app.gpu_monitor import _LOCK_FILE as test_lock_file
            try:
                with GpuLock(max_wait=5):
                    raise RuntimeError("test error")
            except RuntimeError:
                pass
            # Lock should be released — verify we can acquire it
            fd = open(test_lock_file, "w")
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)  # should not block
            finally:
                fcntl.flock(fd, fcntl.LOCK_UN)
                fd.close()


# ---------------------------------------------------------------------------
# Test: Agent-friendly output functions
# ---------------------------------------------------------------------------

class TestPrintOutput:
    def test_print_available_with_utilization(self, capsys):
        status = GpuStatus(busy=False, utilization=0.05, source="macmon")
        _print_available(status)
        output = capsys.readouterr().out
        assert "[gpu-monitor] GPU available" in output
        assert "5%" in output

    def test_print_available_without_utilization(self, capsys):
        status = GpuStatus(busy=False, source="runpy")
        _print_available(status)
        output = capsys.readouterr().out
        assert "[gpu-monitor] GPU available" in output
        assert "no competing processes" in output

    def test_print_busy_includes_machine_json(self, capsys):
        status = GpuStatus(
            busy=True, utilization=0.85, source="macmon",
            blocking_pids=[1234], blocking_commands=["python run.py"]
        )
        _print_busy(status)
        output = capsys.readouterr().out
        assert "[gpu-monitor] GPU BUSY" in output
        assert "GPU_BUSY:" in output
        # Parse the JSON after GPU_BUSY: prefix
        json_str = output.split("GPU_BUSY:", 1)[1].strip()
        data = json.loads(json_str)
        assert data["status"] == "busy"
        assert data["utilization"] == 0.85
        assert 1234 in data["blocking_pids"]

    def test_print_timeout_to_stderr(self, capsys):
        status = GpuStatus(
            busy=True, utilization=0.9, source="macmon",
            blocking_pids=[1234], blocking_commands=["python run.py"]
        )
        _print_timeout(status, 60)
        err = capsys.readouterr().err
        assert "TIMEOUT" in err
        assert "60s" in err
        # Check JSON on stderr
        combined = capsys.readouterr()
        # The JSON was already captured above, check err
        assert "GPU_BUSY:" in err
        json_str = err.split("GPU_BUSY:", 1)[1].strip()
        data = json.loads(json_str)
        assert data["status"] == "timeout"
        assert data["max_wait"] == 60


# ---------------------------------------------------------------------------
# Test: build_run_py_cmd helper
# ---------------------------------------------------------------------------

class TestBuildRunPyCmd:
    def test_basic_command(self):
        from app.commands._shared import build_run_py_cmd
        cmd = build_run_py_cmd("video", "generate", "--prompt", "test", force=False)
        assert "run.py" in cmd[1]
        assert cmd[2] == "video"
        assert cmd[3] == "generate"
        assert "--force" not in cmd

    def test_explicit_force_true(self):
        from app.commands._shared import build_run_py_cmd
        cmd = build_run_py_cmd("image", "t2i", force=True)
        assert "--force" in cmd

    def test_explicit_force_false(self):
        from app.commands._shared import build_run_py_cmd
        cmd = build_run_py_cmd("caption", "test.png", force=False)
        assert "--force" not in cmd

    def test_auto_detect_force_from_sys_argv(self):
        from app.commands._shared import build_run_py_cmd
        original = sys.argv[:]
        try:
            sys.argv = ["run.py", "--force", "image", "t2i"]
            cmd = build_run_py_cmd("image", "t2i")
            assert "--force" in cmd
        finally:
            sys.argv = original

    def test_auto_detect_skip_gpu_lock(self):
        from app.commands._shared import build_run_py_cmd
        original = sys.argv[:]
        try:
            sys.argv = ["run.py", "--skip-gpu-lock", "image", "t2i"]
            cmd = build_run_py_cmd("image", "t2i")
            assert "--force" in cmd
        finally:
            sys.argv = original

    def test_no_force_by_default(self):
        from app.commands._shared import build_run_py_cmd
        original = sys.argv[:]
        try:
            sys.argv = ["run.py", "image", "t2i"]
            cmd = build_run_py_cmd("image", "t2i")
            assert "--force" not in cmd
        finally:
            sys.argv = original
