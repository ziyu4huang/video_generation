#!/usr/bin/env python3
"""
parity_bench.py — Swift vs Python T2I parity benchmark.

Strategy: monkeypatch numpy.random.randn to capture the EXACT noise Python
generates (np.random.seed + randn), save it, run the full Python T2I
(text-encode → denoise → VAE → PNG), then hand that identical noise to the
Swift binary via --noise-file. Compare the two output PNGs pixel-for-pixel.

This is the definitive drop-in proof: same prompt, same seed, same noise,
same dims → output images must correlate > 0.99.

Usage (from repo root):
  python/venv/bin/python swift/z-image-director/scripts/parity_bench.py \
      --prompt complex-girl --output-dir swift/z-image-director/.scratch/parity
"""

import argparse
import json
import os
import sys

import numpy as np

SCRIPT = os.path.abspath(__file__)
REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(SCRIPT))))
sys.path.insert(0, os.path.join(REPO, "python", "mlx-movie-director"))

# Predefined prompt presets (mirror Swift SelfTestPresets).
PRESETS = {
    "portrait": {
        "prompt": (
            "photorealistic portrait of a young woman, sharp eyes with "
            "detailed irises, natural skin texture with fine pores, soft "
            "studio lighting, bokeh background, high detail, ultra sharp focus"
        ),
        "width": 640,
        "height": 960,
        "steps": 4,
        "seed": 42,
    },
    "complex-girl": {
        "prompt": (
            "a stunningly detailed portrait of a young woman with flowing "
            "auburn hair, intricate lace dress, freckles across her nose, "
            "green eyes catching golden hour sunlight, bokeh background of "
            "autumn forest, ultra realistic skin texture, professional "
            "cinematic photography, shallow depth of field, film grain"
        ),
        "width": 832,
        "height": 1216,
        "steps": 8,
        "seed": 77,
    },
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--prompt", required=True, help="preset name or literal text")
    ap.add_argument("--steps", type=int)
    ap.add_argument("--seed", type=int)
    ap.add_argument("--width", type=int)
    ap.add_argument("--height", type=int)
    ap.add_argument("--cfg-scale", type=float, default=4.0)
    ap.add_argument("--output-dir", default="swift/z-image-director/.scratch/parity")
    ap.add_argument(
        "--swift-binary", default="swift/z-image-director/.build/debug/zimage"
    )
    args = ap.parse_args()

    preset = PRESETS.get(args.prompt)
    if preset:
        prompt = preset["prompt"]
        width = args.width or preset["width"]
        height = args.height or preset["height"]
        steps = args.steps or preset["steps"]
        seed = args.seed or preset["seed"]
        label = args.prompt
    else:
        prompt = args.prompt
        width = args.width or 640
        height = args.height or 960
        steps = args.steps or 4
        seed = args.seed or 42
        label = "custom"

    os.makedirs(args.output_dir, exist_ok=True)
    noise_path = os.path.join(args.output_dir, f"noise_{label}_seed{seed}.safetensors")
    py_png = os.path.join(args.output_dir, f"python_{label}.png")
    sw_png = os.path.join(args.output_dir, f"swift_{label}.png")

    print(
        f"=== Parity benchmark: {label} ({width}x{height}, steps={steps}, seed={seed}) ==="
    )

    # ---- 1. Monkeypatch np.random.randn to capture noise ----
    import mlx.core as mx

    captured = {"noise": None}

    _orig_randn = np.random.randn

    def _capturing_randn(*shape):
        arr = _orig_randn(*shape)
        # The pipeline calls randn(1, 16, H//8, W//8) for t2i noise.
        if len(shape) == 4 and shape[1] == 16 and shape[0] == 1:
            if captured["noise"] is None:
                captured["noise"] = arr.astype(np.float32)
                print(f"   captured noise: shape={shape}")
        return arr

    np.random.randn = _capturing_randn

    # ---- 2. Run Python T2I pipeline ----
    from app.pipeline import ZImagePipeline

    pipeline = ZImagePipeline()
    print(f"[Python] generating {py_png} ...")
    result = pipeline.generate(
        prompt=prompt,
        width=width,
        height=height,
        steps=steps,
        seed=seed,
        cfg_scale=args.cfg_scale,
    )
    np.random.randn = _orig_randn  # restore

    # GenerationResult has .image (PIL Image)
    from PIL import Image

    if hasattr(result, "image"):
        img = result.image
    elif hasattr(result, "save"):
        img = result
    else:
        img = Image.fromarray(np.array(result))
    img.save(py_png)
    print(f"[Python] saved {py_png}")

    if captured["noise"] is None:
        print("ERROR: noise not captured — shape mismatch. Aborting.")
        sys.exit(1)

    # ---- 3. Save captured noise as safetensors (Swift reads this) ----
    from mlx.utils import tree_flatten

    noise_mx = mx.array(captured["noise"])
    mx.save_safetensors(noise_path, dict(tree_flatten({"noise": noise_mx})))
    print(f"[shared] saved noise {noise_path}")

    # ---- 4. Run Swift binary with --noise-file ----
    import subprocess

    print(f"[Swift] generating {sw_png} ...")
    cmd = [
        os.path.join(REPO, args.swift_binary),
        "t2i",
        "--prompt",
        prompt,
        "--seed",
        str(seed),
        "--width",
        str(width),
        "--height",
        str(height),
        "--steps",
        str(steps),
        "--cfg-scale",
        str(args.cfg_scale),
        "--noise-file",
        noise_path,
        "--output",
        sw_png,
    ]
    r = subprocess.run(cmd, capture_output=True, text=True, cwd=REPO)
    if r.returncode != 0:
        print("Swift FAILED:\n", r.stderr[-2000:])
        sys.exit(1)
    print(f"[Swift] saved {sw_png}")

    # ---- 5. Compare ----
    py_arr = np.array(Image.open(py_png).convert("RGB")).astype(np.float32)
    sw_arr = np.array(Image.open(sw_png).convert("RGB")).astype(np.float32)
    diff = np.abs(py_arr - sw_arr)
    corr = float(np.corrcoef(py_arr.flatten(), sw_arr.flatten())[0, 1])
    report = {
        "label": label,
        "prompt": prompt[:60],
        "width": width,
        "height": height,
        "steps": steps,
        "seed": seed,
        "cfg_scale": args.cfg_scale,
        "python_png": py_png,
        "swift_png": sw_png,
        "noise_file": noise_path,
        "metrics": {
            "mean_diff": round(float(diff.mean()), 3),
            "max_diff": round(float(diff.max()), 1),
            "match_at_5_pct": round(float((diff < 5).mean()) * 100, 2),
            "match_at_30_pct": round(float((diff < 30).mean()) * 100, 2),
            "correlation": round(corr, 5),
        },
        "verdict": "PASS" if corr > 0.99 else ("CLOSE" if corr > 0.95 else "FAIL"),
    }
    report_path = os.path.join(args.output_dir, f"parity_{label}.json")
    with open(report_path, "w") as f:
        json.dump(report, f, indent=2)
    print("\n=== RESULT ===")
    print(json.dumps(report["metrics"], indent=2))
    print(f"verdict: {report['verdict']} (threshold: correlation > 0.99)")
    print(f"report:  {report_path}")


if __name__ == "__main__":
    main()
