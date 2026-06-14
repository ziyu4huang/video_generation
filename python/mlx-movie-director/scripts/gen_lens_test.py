"""End-to-end Lens T2I generation test. Saves output/output/lens_test.png."""
from __future__ import annotations
import os, sys, time
import mlx.core as mx

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)) + "/..")
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)) + "/..", "vendor", "mflux", "src"))

from app.lens_pipeline import LensPipeline

def main():
    pipe = LensPipeline(num_steps=20, cfg_scale=3.5)
    t0 = time.time()
    res = pipe.generate(
        prompt="a cute corgi puppy sitting in a sunny garden, highly detailed, photorealistic",
        seed=42,
        width=512,
        height=512,
    )
    print(f"\n[gen] total {time.time()-t0:.1f}s  timings={res.timings}")
    out_dir = os.path.join(os.path.dirname(__file__), "..", "output", "lens")
    os.makedirs(out_dir, exist_ok=True)
    for w, h, s in [(256, 256, "low"), (512, 512, "med")]:
        pass
    path = os.path.join(out_dir, "lens_test.png")
    res.image.save(path)
    print(f"[gen] saved {path}  size={res.image.size}")
    # quick stat on the image
    import numpy as np
    arr = np.array(res.image)
    print(f"[gen] pixel mean={arr.mean():.1f} std={arr.std():.1f} min={arr.min()} max={arr.max()}")

if __name__ == "__main__":
    main()
