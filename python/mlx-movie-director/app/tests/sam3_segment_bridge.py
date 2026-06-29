#!/usr/bin/env python3
"""SAM3.1 segmentation bridge — invoked by Swift `flux2 segment`.

Loads mlx-vlm SAM3.1, segments an image for a text prompt, and saves the
best mask as a binary PNG (white=object) + bbox JSON. This is a subprocess
integration: the segmentation runs in Python (mlx-vlm has no Swift port),
while downstream mask compositing (swap/remove) runs in Swift.

Usage:
    python/venv/bin/python python/mlx-movie-director/app/tests/sam3_segment_bridge.py \
        --image IMG --prompt "woman's face" --out-mask MASK.png --threshold 0.3
"""
import sys
from pathlib import Path
REPO = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(REPO / "python" / "mlx-movie-director"))

import argparse
import json
import numpy as np
from PIL import Image


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--image", required=True)
    p.add_argument("--prompt", required=True)
    p.add_argument("--out-mask", required=True)
    p.add_argument("--threshold", type=float, default=0.3)
    args = p.parse_args()

    from app.sam3_predictor import get_sam3_predictor, feather_mask

    predictor = get_sam3_predictor(threshold=args.threshold)
    image = Image.open(args.image).convert("RGB")
    result = predictor.predict(image, text_prompt=args.prompt,
                                score_threshold=args.threshold)

    n = len(result.scores)
    print(f"[sam3] {n} detections for '{args.prompt}'")
    if n == 0:
        # Save an empty (all-black) mask so the caller can detect "no object".
        w, h = image.size
        Image.fromarray(np.zeros((h, w), dtype=np.uint8)).save(args.out_mask)
        json.dump({"count": 0, "scores": [], "boxes": []}, open(args.out_mask + ".json", "w"))
        print(f"[sam3] no detections — saved empty mask {args.out_mask}")
        return

    # Pick the highest-scoring mask, feather edges, save as white-on-black PNG.
    best = int(np.argmax(result.scores))
    mask = np.asarray(result.masks[best])  # (H, W)
    # feather_mask expects 0/1 uint8 input (it does *255 internally).
    binary = (mask > 0).astype(np.uint8)  # ensure 0/1
    feathered = feather_mask(binary, radius=10)  # returns float [0,1]
    mask_out = np.clip(feathered * 255.0, 0, 255).astype(np.uint8)
    Image.fromarray(mask_out).save(args.out_mask)

    box = np.asarray(result.boxes[best]).tolist() if hasattr(result.boxes[0], "tolist") else list(result.boxes[best])
    meta = {
        "count": n,
        "best_idx": best,
        "scores": [float(s) for s in result.scores],
        "best_box": box,
        "best_score": float(result.scores[best]),
    }
    json.dump(meta, open(args.out_mask + ".json", "w"), indent=2)
    print(f"[sam3] saved mask {args.out_mask} (best score={meta['best_score']:.3f}, box={box})")


if __name__ == "__main__":
    main()
