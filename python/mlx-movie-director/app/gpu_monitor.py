"""GPU monitor: multi-tier GPU busy detection for Apple Silicon.

Tiers (highest fidelity first):
  1. macmon  — reads Apple Silicon hardware GPU counters (no sudo)
  2. psutil  — heuristic: Python processes with ML keywords + large RSS
  3. runpy   — scans `ps` for other run.py processes (legacy fallback)

Provides:
  - GpuStatus  — detection result dataclass
  - detect_gpu_busy() — run the tier chain
  - is_gpu_heavy_command() — classify a parsed argparse Namespace
  - GpuLock    — context manager with flock mutex that blocks until GPU is free
"""

import argparse
import fcntl
import json
import os
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass, field

# ---------------------------------------------------------------------------
# GpuStatus
# ---------------------------------------------------------------------------

@dataclass
class GpuStatus:
    """Result of GPU busy detection."""
    busy: bool
    utilization: float = -1.0       # 0.0-1.0, -1.0 if unknown
    source: str = "none"            # "macmon" | "psutil" | "runpy" | "none"
    details: str = ""               # human-readable explanation
    blocking_pids: list[int] = field(default_factory=list)
    blocking_commands: list[str] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Tier 1: macmon (no sudo, reads hardware GPU counters)
# ---------------------------------------------------------------------------

_MACMON_WARNED = False

# Lock file for flock-based mutex
_LOCK_DIR = os.path.join(tempfile.gettempdir(), "mlx-movie-director")
_LOCK_FILE = os.path.join(_LOCK_DIR, "gpu.lock")


def _detect_macmon(threshold: float) -> GpuStatus | None:
    """Try macmon to read actual GPU utilization. Returns None on failure."""
    global _MACMON_WARNED

    try:
        result = subprocess.run(
            ["macmon", "pipe", "-s", "1", "-i", "500"],
            capture_output=True, text=True, timeout=4,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        if not _MACMON_WARNED:
            print("[gpu-monitor] Tip: install macmon for accurate GPU detection: "
                  "brew install macmon", flush=True)
            _MACMON_WARNED = True
        return None

    if result.returncode != 0:
        return None

    # Parse first valid JSON line
    for line in result.stdout.strip().splitlines():
        try:
            data = json.loads(line)
        except json.JSONDecodeError:
            continue

        gpu_usage = data.get("gpu_usage")
        if isinstance(gpu_usage, list) and len(gpu_usage) >= 2:
            freq_hz, util = gpu_usage[0], gpu_usage[1]
            busy = util > threshold
            details = f"utilization={util:.0%} freq={freq_hz / 1e6:.0f} MHz"
            return GpuStatus(
                busy=busy,
                utilization=util,
                source="macmon",
                details=details,
            )

    return None


# ---------------------------------------------------------------------------
# Tier 2: psutil heuristic — ML processes with large RSS
# ---------------------------------------------------------------------------

_GPU_KEYWORDS = frozenset([
    "torch", "mlx", "comfyui", "diffusers", "ltx",
    "zimage", "flux", "stable-diffusion", "transformers",
])

_RSS_THRESHOLD_MB = 4_096  # 4 GB — strong GPU signal on unified memory


def _detect_psutil(threshold: float) -> GpuStatus | None:
    """Scan processes for ML-related Python with large RSS."""
    try:
        import psutil
    except ImportError:
        return None

    self_pid = os.getpid()
    blocking_pids = []
    blocking_commands = []

    try:
        for proc in psutil.process_iter(["pid", "cmdline", "rss", "name"]):
            try:
                pid = proc.info["pid"]
                if pid == self_pid:
                    continue
                rss = proc.info.get("rss") or 0
                cmdline_list = proc.info.get("cmdline") or []
                name = (proc.info.get("name") or "").lower()
                rss_mb = rss / (1024 * 1024)

                # Must be Python process
                if "python" not in name and not any(
                    "python" in (c or "").lower() for c in cmdline_list[:1]
                ):
                    continue

                cmdline_str = " ".join(cmdline_list).lower()

                # Heuristic: ML keyword in cmdline AND large RSS, or very large RSS alone
                has_keyword = any(kw in cmdline_str for kw in _GPU_KEYWORDS)
                if (has_keyword and rss_mb > _RSS_THRESHOLD_MB) or rss_mb > 8_192:
                    short_cmd = " ".join(cmdline_list)[:80]
                    blocking_pids.append(pid)
                    blocking_commands.append(short_cmd)

            except (psutil.NoSuchProcess, psutil.AccessDenied):
                continue
    except Exception as exc:
        print(f"[gpu-monitor] psutil scan error: {exc}", file=sys.stderr)
        return None

    busy = len(blocking_pids) > 0
    details = ""
    if busy:
        parts = [f"PID {p}" for p in blocking_pids]
        details = f"{len(blocking_pids)} ML process(es): {', '.join(parts)}"

    return GpuStatus(
        busy=busy,
        utilization=-1.0,
        source="psutil",
        details=details,
        blocking_pids=blocking_pids,
        blocking_commands=blocking_commands,
    )


# ---------------------------------------------------------------------------
# Tier 3: legacy run.py process scan (always works, lowest fidelity)
# ---------------------------------------------------------------------------

_RUN_PY_PATH = os.path.normpath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "run.py")
)


def _detect_runpy() -> GpuStatus:
    """Scan for other run.py processes (legacy, always available)."""
    self_pid = os.getpid()
    try:
        result = subprocess.run(
            ["ps", "-ax", "-o", "pid=,command="],
            capture_output=True, text=True, timeout=5,
        )
    except Exception:
        return GpuStatus(busy=False, source="runpy", details="ps scan failed")

    blocking_pids = []
    blocking_commands = []
    run_py_tail = os.path.basename(os.path.dirname(_RUN_PY_PATH)) + "/run.py"

    for line in result.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        parts = line.split(None, 1)
        if len(parts) < 2:
            continue
        try:
            pid = int(parts[0])
        except ValueError:
            continue
        cmd = parts[1]
        exe = cmd.split()[0] if cmd else ""
        if "python" not in exe.lower():
            continue
        if pid != self_pid and (_RUN_PY_PATH in cmd or run_py_tail in cmd):
            blocking_pids.append(pid)
            blocking_commands.append(cmd[:80])

    busy = len(blocking_pids) > 0
    details = ""
    if busy:
        parts = [f"PID {p}" for p in blocking_pids]
        details = f"{len(blocking_pids)} run.py process(es): {', '.join(parts)}"

    return GpuStatus(
        busy=busy,
        utilization=-1.0,
        source="runpy",
        details=details,
        blocking_pids=blocking_pids,
        blocking_commands=blocking_commands,
    )


# ---------------------------------------------------------------------------
# Public: detect_gpu_busy()
# ---------------------------------------------------------------------------

def detect_gpu_busy(threshold: float = 0.5) -> GpuStatus:
    """Run the tiered GPU detection chain.

    Tries macmon -> psutil -> runpy. Returns the first conclusive result.
    A result is "conclusive" when busy=True (something is detected) or
    when we reach the last tier (nothing found at any tier).
    """
    # Tier 1: macmon
    status = _detect_macmon(threshold)
    if status is not None:
        return status

    # Tier 2: psutil
    status = _detect_psutil(threshold)
    if status is not None:
        return status

    # Tier 3: runpy (always returns a result)
    return _detect_runpy()


# ---------------------------------------------------------------------------
# Command classifier
# ---------------------------------------------------------------------------

# GPU-heavy image sub-actions
_GPU_HEAVY_IMAGE_ACTIONS = frozenset([
    "t2i", "i2i", "faceswap", "controlnet", "anime2real",
    "expansion", "swap", "workflow", "purify", "restore",
    "angle", "profile",
])

# Always-lightweight image sub-actions (API/caption based)
_LIGHTWEIGHT_IMAGE_ACTIONS = frozenset([
    "review", "quality",  # only heavy when --self-test is set
])

# GPU-heavy video sub-actions
_GPU_HEAVY_VIDEO_ACTIONS = frozenset([
    "generate", "relay", "vbvr", "restore",
])

# Always-lightweight commands (never use GPU)
_LIGHTWEIGHT_COMMANDS = frozenset([
    "caption", "import-lora-image", "import-workflow",
    "check-model", "schema-defaults",
])


def is_gpu_heavy_command(args: "argparse.Namespace") -> bool:
    """Determine if a parsed command requires GPU heavy lifting.

    Inspects args.command and args.action to classify.
    Returns True for GPU-heavy commands, False for lightweight ones.
    """
    command = getattr(args, "command", None) or ""

    # Direct aliases
    if command in ("t2i", "generate"):
        return True

    # Always lightweight
    if command in _LIGHTWEIGHT_COMMANDS:
        return False

    # animate is a stub but will be GPU-heavy
    if command == "animate":
        return True

    # replay: depends on the replayed command
    if command == "replay":
        return _is_replay_gpu_heavy(args)

    # refine: always GPU-heavy (MLX image generation)
    if command == "refine":
        return True

    # image dispatcher
    if command == "image":
        action = getattr(args, "action", None) or ""
        if action in _GPU_HEAVY_IMAGE_ACTIONS:
            return True
        if action in _LIGHTWEIGHT_IMAGE_ACTIONS:
            # Only heavy when --self-test is set (loads pipeline for generation)
            self_test = getattr(args, "self_test", None)
            return bool(self_test)
        # Default: treat unknown image actions as GPU-heavy (safe)
        return True

    # video dispatcher
    if command == "video":
        action = getattr(args, "action", None) or ""
        if action in _GPU_HEAVY_VIDEO_ACTIONS:
            return True
        # video review/compare/quality are lightweight (spawn subprocesses
        # or do API calls). The subprocesses themselves will be caught
        # when they run through run.py main() with their own command.
        return False

    # upscale: depends on method
    if command == "upscale":
        method = getattr(args, "method", "esrgan")
        return method == "seedvr2"

    # Unknown commands: treat as lightweight (conservative — avoids false locks)
    return False


def _is_replay_gpu_heavy(args: "argparse.Namespace") -> bool:
    """Check if a replay command is GPU-heavy by reading the target run.json."""
    replay_file = getattr(args, "file", None)
    if not replay_file or not os.path.exists(replay_file):
        # Can't determine — assume GPU-heavy (safe default)
        return True

    try:
        with open(replay_file, "r") as f:
            data = json.load(f)
        replayed_cmd = data.get("command", "")
        # Simple string matching for known GPU-heavy replay patterns
        gpu_patterns = [
            "generate", "refine", "image", "t2i", "video generate",
            "video relay", "video vbvr", "video restore",
        ]
        return any(p in replayed_cmd for p in gpu_patterns)
    except Exception:
        return True


# ---------------------------------------------------------------------------
# GpuLock context manager
# ---------------------------------------------------------------------------

class GpuLock:
    """Acquire an exclusive flock, blocking until GPU is free.

    Uses fcntl.flock() for true mutual exclusion (no race condition).
    Falls back to multi-tier detection (macmon -> psutil -> runpy) for
    advisory diagnostics when the lock is held by another process.

    The lock file lives in /tmp/mlx-movie-director/gpu.lock and is
    automatically released when the process exits (kernel cleanup).

    Args:
        skip:  If True, skip lock entirely (programmatic bypass).
        force: If True, skip lock (user --force override).
        poll_interval: Seconds between retries when lock is held.
        threshold: GPU utilization threshold (0.0-1.0) for macmon.
        max_wait: Maximum seconds to wait before giving up (default: 3600).
    """

    def __init__(self, skip: bool = False, force: bool = False,
                 poll_interval: int = 10, threshold: float = 0.5,
                 max_wait: int = 3600):
        self.skip = skip
        self.force = force
        self.poll_interval = poll_interval
        self.threshold = threshold
        self.max_wait = max_wait
        self._lock_fd = None

    def __enter__(self):
        if self.skip or self.force:
            return self

        os.makedirs(_LOCK_DIR, exist_ok=True)
        self._lock_fd = open(_LOCK_FILE, "w")
        deadline = time.time() + self.max_wait

        while True:
            # 1. Try non-blocking flock
            try:
                fcntl.flock(self._lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                _print_available(detect_gpu_busy(self.threshold))
                return self
            except (IOError, OSError):
                pass

            # 2. Check timeout
            if time.time() >= deadline:
                status = detect_gpu_busy(self.threshold)
                self._lock_fd.close()
                self._lock_fd = None
                _print_timeout(status, self.max_wait)
                sys.exit(1)

            # 3. Report busy + sleep
            status = detect_gpu_busy(self.threshold)
            _print_busy(status)
            time.sleep(self.poll_interval)

    def __exit__(self, *_):
        if self._lock_fd:
            try:
                fcntl.flock(self._lock_fd, fcntl.LOCK_UN)
                self._lock_fd.close()
            except (IOError, OSError):
                pass
            self._lock_fd = None
        return False


# ---------------------------------------------------------------------------
# Agent-friendly output
# ---------------------------------------------------------------------------

def _print_available(status: GpuStatus) -> None:
    """Print a one-line status when GPU is available."""
    if status.utilization >= 0:
        print(f"[gpu-monitor] GPU available — utilization={status.utilization:.0%} "
              f"({status.source})", flush=True)
    else:
        print(f"[gpu-monitor] GPU available — no competing processes detected "
              f"({status.source})", flush=True)


def _print_busy(status: GpuStatus) -> None:
    """Print human-readable + machine-parseable GPU busy message."""
    # Human-readable
    if status.utilization >= 0:
        print(f"[gpu-monitor] GPU BUSY — utilization={status.utilization:.0%} "
              f"({status.source})", flush=True)
    else:
        print(f"[gpu-monitor] GPU BUSY — {status.details} ({status.source})",
              flush=True)

    for pid, cmd in zip(status.blocking_pids, status.blocking_commands):
        short = cmd[:70] + "..." if len(cmd) > 70 else cmd
        print(f"[gpu-monitor]   Blocking: PID {pid} ({short})", flush=True)

    print("[gpu-monitor]   Recommendation: wait for the blocking process to finish, "
          "or use --force to override", flush=True)

    # Machine-parseable (agent-friendly)
    busy_json = json.dumps({
        "status": "busy",
        "utilization": round(status.utilization, 3),
        "source": status.source,
        "blocking_pids": status.blocking_pids,
        "blocking_commands": status.blocking_commands[:5],
        "recommendation": "wait for blocking process, or use --force to override",
    })
    print(f"GPU_BUSY:{busy_json}", flush=True)


def _print_timeout(status: GpuStatus, max_wait: int) -> None:
    """Print timeout error when GPU lock could not be acquired."""
    print(f"[gpu-monitor] TIMEOUT — waited {max_wait}s but GPU is still busy",
          file=sys.stderr, flush=True)
    if status.utilization >= 0:
        print(f"[gpu-monitor]   Last reading: utilization={status.utilization:.0%} "
              f"({status.source})", file=sys.stderr, flush=True)
    elif status.details:
        print(f"[gpu-monitor]   {status.details} ({status.source})",
              file=sys.stderr, flush=True)
    for pid, cmd in zip(status.blocking_pids, status.blocking_commands):
        short = cmd[:70] + "..." if len(cmd) > 70 else cmd
        print(f"[gpu-monitor]   Blocking: PID {pid} ({short})",
              file=sys.stderr, flush=True)
    print("[gpu-monitor]   Recommendation: wait for the blocking process or use --force",
          file=sys.stderr, flush=True)

    # Machine-parseable
    timeout_json = json.dumps({
        "status": "timeout",
        "max_wait": max_wait,
        "utilization": round(status.utilization, 3),
        "source": status.source,
        "blocking_pids": status.blocking_pids,
        "blocking_commands": status.blocking_commands[:5],
        "recommendation": "wait for blocking process, or use --force to override",
    })
    print(f"GPU_BUSY:{timeout_json}", file=sys.stderr, flush=True)
