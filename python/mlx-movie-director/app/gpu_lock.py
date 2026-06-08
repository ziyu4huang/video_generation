"""GPU lock: wait until no other run.py process is running before acquiring GPU."""

import os
import subprocess
import time

# Absolute path of the run.py entry point — used for process matching
_RUN_PY_PATH = os.path.normpath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "run.py")
)


def _find_other_run_py_pids() -> list:
    """Return [(pid, command), ...] for other run.py processes using our script path."""
    self_pid = os.getpid()
    try:
        result = subprocess.run(
            ["ps", "-ax", "-o", "pid=,command="],
            capture_output=True, text=True, timeout=5,
        )
    except Exception:
        return []
    found = []
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
        # Only match Python processes (not shells that happen to eval a cmd containing run.py)
        exe = cmd.split()[0] if cmd else ""
        if "python" not in exe.lower():
            continue
        # Match absolute path ("/Users/.../mlx-movie-director/run.py") OR
        # relative path ("python/mlx-movie-director/run.py") from any CWD
        _run_py_tail = os.path.basename(os.path.dirname(_RUN_PY_PATH)) + "/run.py"
        if pid != self_pid and (_RUN_PY_PATH in cmd or _run_py_tail in cmd):
            found.append((pid, cmd))
    return found


class GpuLock:
    """Block until no other run.py process is active on this machine.

    Polls the process list every 10s. No lock files — process death resolves
    the wait automatically. Race condition (two processes starting
    simultaneously both pass) is acceptable on single-GPU Apple Silicon.
    """

    def __init__(self, skip: bool = False):
        self.skip = skip

    def __enter__(self):
        if self.skip:
            return self
        while True:
            others = _find_other_run_py_pids()
            if not others:
                return self
            for pid, cmd in others:
                short_cmd = cmd[:80] + "..." if len(cmd) > 80 else cmd
                print(
                    f"[gpu-lock] GPU busy (PID {pid}: {short_cmd}), waiting 10s...",
                    flush=True,
                )
            time.sleep(10)

    def __exit__(self, *_):
        return False
