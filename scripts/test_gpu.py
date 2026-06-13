#!/usr/bin/env python3
"""GPU capability test for Apple Silicon (M5 Max / MPS + MLX)."""

import subprocess
import sys
import time


def banner(title: str) -> None:
    print(f"\n{'=' * 60}")
    print(f"  {title}")
    print(f"{'=' * 60}")


def check_system() -> dict:
    banner("System Info")
    info = {"chip": "?", "memory_gb": "?"}
    try:
        out = subprocess.check_output(
            ["system_profiler", "SPHardwareDataType"],
            text=True
        )
        for line in out.splitlines():
            if "Chip:" in line:
                info["chip"] = line.split("Chip:")[-1].strip()
            if "Memory:" in line:
                info["memory_gb"] = line.split("Memory:")[-1].strip()
    except Exception:
        pass
    print(f"  Chip:   {info['chip']}")
    print(f"  RAM:    {info['memory_gb']}")
    return info


def test_mlx() -> dict:
    banner("MLX (Apple GPU)")
    results = {"metal_available": False, "compute_ok": False, "mem_gb": 0, "peak_mem_gb": 0}
    try:
        import mlx.core as mx
        print(f"  MLX version:   {mx.__version__}")
        print(f"  Metal avail:   {mx.metal.is_available()}")
        results["metal_available"] = bool(mx.metal.is_available())

        if mx.metal.is_available():
            # Try simple compute
            t0 = time.time()
            a = mx.ones((2048, 2048))
            b = mx.ones((2048, 2048))
            c = a @ b
            mx.eval(c)
            elapsed = time.time() - t0
            print(f"  Matmul 2048x2048: {elapsed*1000:.1f}ms  OK")
            results["compute_ok"] = True

            # Memory info (new API)
            try:
                info = mx.metal.memory_info()
                print(f"  GPU memory info: {info}")
            except AttributeError:
                pass

            # Peak / active
            try:
                peak = mx.metal.get_peak_memory()
                active = mx.metal.get_active_memory()
                print(f"  Active memory:   {active / 1e9:.2f} GB")
                print(f"  Peak memory:     {peak / 1e9:.2f} GB")
                results["peak_mem_gb"] = peak / 1e9
                results["mem_gb"] = active / 1e9
            except (RuntimeError, AttributeError):
                print("  (memory stats unavailable in this sandbox)")
        else:
            print("  ⚠  Metal not available (headless/sandbox)")
    except ImportError:
        print("  ❌ MLX not installed")
    except Exception as e:
        print(f"  ❌ Error: {e}")
    return results


def test_torch_mps() -> dict:
    banner("PyTorch MPS")
    results = {"mps_available": False, "compute_ok": False}
    try:
        import torch
        print(f"  PyTorch version: {torch.__version__}")
        avail = torch.backends.mps.is_available()
        built = torch.backends.mps.is_built()
        print(f"  MPS built:       {built}")
        print(f"  MPS available:   {avail}")
        results["mps_available"] = bool(avail)

        if avail:
            device = torch.device("mps")
            t0 = time.time()
            a = torch.ones((2048, 2048), device=device)
            b = torch.ones((2048, 2048), device=device)
            c = a @ b
            c.cpu()  # force sync
            elapsed = time.time() - t0
            print(f"  Matmul 2048x2048: {elapsed*1000:.1f}ms  OK")
            results["compute_ok"] = True

            # Memory check
            try:
                if hasattr(torch.mps, "current_allocated_memory"):
                    mem = torch.mps.current_allocated_memory()
                    print(f"  MPS allocated:   {mem / 1e9:.2f} GB")
            except (RuntimeError, AttributeError):
                pass
        else:
            print("  ⚠  MPS not available")
    except ImportError:
        print("  ❌ PyTorch not installed")
    except Exception as e:
        print(f"  ❌ Error: {e}")
    return results


def test_comfyui_venv() -> dict:
    banner("ComfyUI venv (PyTorch MPS)")
    results = {"mps_available": False}
    try:
        import sys
        sys.path.insert(0, "ComfyUI")
        # Just check torch from the comfy venv
        import torch
        print(f"  PyTorch: {torch.__version__}")
        print(f"  MPS built:   {torch.backends.mps.is_built()}")
        print(f"  MPS avail:   {torch.backends.mps.is_available()}")
        results["mps_available"] = bool(torch.backends.mps.is_available())
    except ImportError:
        print("  (run from ComfyUI/.venv/bin/python for this check)")
    except Exception as e:
        print(f"  {e}")
    return results


def summary(system: dict, mlx: dict, torch_mps: dict, comfy: dict) -> None:
    banner("SUMMARY")
    gpu_count = 0
    if mlx["compute_ok"]:
        print("  ✅  MLX (Apple GPU) — WORKS")
        gpu_count += 1
    else:
        print("  ❌  MLX (Apple GPU) — NOT available")

    if torch_mps["compute_ok"]:
        print("  ✅  PyTorch MPS — WORKS")
        gpu_count += 1
    else:
        print("  ❌  PyTorch MPS — NOT available")

    print()
    if gpu_count == 0:
        print("  ⚠  No GPU acceleration detected.")
        print("     This is expected in headless/sandboxed environments")
        print("     (CodeWhale, remote SSH, CI runners, etc).")
        print()
        print("  ▶  Run this script in a local Terminal to use the GPU:")
        print(f"     cd {__file__.rsplit('/', 1)[0] if '/' in __file__ else '.'}")
        print("     python/venv/bin/python test_gpu.py")
    else:
        print(f"  🎯  {gpu_count} GPU backend(s) working — ready to generate!")


if __name__ == "__main__":
    print(f"  Running from: {__file__}")
    print(f"  Python:       {sys.version.split()[0]} ({sys.executable})")
    system = check_system()
    mlx = test_mlx()
    torch_mps = test_torch_mps()
    comfy = test_comfyui_venv()
    summary(system, mlx, torch_mps, comfy)
