#!/usr/bin/env python3
"""clip_understand.py — native CLIP video-understanding entry for the movie-director ext.

Spawned by the Bun `clipAdapter` (providers.ts). Given a set of sampled frames
(Bun extracts them via ffmpeg upstream) and a prompt, runs CLIP (HuggingFace
`transformers.CLIPModel` on Apple Silicon MPS via PyTorch) to score each frame
against the prompt and return the mean score + per-frame scores. This closes
the `analysis:video_understand` GAP — the sibling of Item I's transcriber.

CLIP via torch/MPS mirrors the ESRGAN precedent (`app/pipeline.py:upscale_esrgan`
uses torch MPS). Both live in the lightweight `python/vision-venv` (torch +
transformers + pillow); no full MLX pipeline needed for analysis/enhancement.

Contract (JSON, written to --output or stdout):
  {
    "ok": true,
    "video": "<abspath or null when frames given directly>",
    "prompt": "<prompt>",
    "labels": ["<prompt>", ...],          # the candidate labels scored
    "score": 0.312,                       # mean cosine/prob across frames for prompt[0]
    "frames": [                           # per-frame scores
      { "path": "<frame>", "score": 0.34, "index": 0 }, ...
    ],
    "model": "openai/clip-vit-base-patch32",
    "duration_s": 0.87
  }

The adapter passes either `--frames a.png b.png ...` (pre-sampled by ffmpeg) or
`--video x.mp4 --num-frames N` (this script samples via ffmpeg itself). The
prompt is scored against the first label slot; pass `--labels` for multi-way.

On failure: { "ok": false, "error": "<message>" } with a non-zero exit code.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
import time


def main() -> int:
    ap = argparse.ArgumentParser(description="CLIP video-understanding entry (transformers + torch MPS)")
    ap.add_argument("--frames", nargs="*", default=[], help="pre-sampled frame image paths")
    ap.add_argument("--video", default=None, help="video path; sampled into --num-frames frames via ffmpeg")
    ap.add_argument("--num-frames", type=int, default=4, help="frames to sample when --video is given")
    ap.add_argument("--prompt", required=True, help="the text prompt to score frames against")
    ap.add_argument(
        "--labels",
        nargs="*",
        default=None,
        help="extra candidate labels for multi-way ranking (prompt is always label[0])",
    )
    ap.add_argument(
        "--model",
        default=os.environ.get("MD_CLIP_MODEL", "openai/clip-vit-base-patch32"),
        help="HuggingFace CLIP repo. Default: openai/clip-vit-base-patch32 (auto-downloads).",
    )
    ap.add_argument("--output", default=None, help="write JSON here; stdout if omitted.")
    args = ap.parse_args()

    # Resolve the frame list: either given directly, or sampled from a video.
    video_abs = None
    frames = list(args.frames)
    cleanup_dir = None
    if not frames and args.video:
        if not os.path.isfile(args.video):
            return _emit(args.output, {"ok": False, "error": f"video not found: {args.video}"}, exit_code=2)
        video_abs = os.path.abspath(args.video)
        cleanup_dir = tempfile.mkdtemp(prefix="md-clip-")
        frames = _sample_frames(args.video, args.num_frames, cleanup_dir)
        if not frames:
            return _emit(args.output, {"ok": False, "error": "ffmpeg frame sampling produced no frames"}, exit_code=5)
    elif not frames:
        return _emit(args.output, {"ok": False, "error": "no frames: pass --frames or --video"}, exit_code=2)

    for f in frames:
        if not os.path.isfile(f):
            return _emit(args.output, {"ok": False, "error": f"frame not found: {f}"}, exit_code=2)

    try:
        import torch
        from PIL import Image
        from transformers import CLIPModel, CLIPProcessor
    except Exception as exc:  # pragma: no cover - env-dependent
        return _emit(args.output, {"ok": False, "error": f"import failed: {exc}"}, exit_code=3)

    t0 = time.time()
    labels = [args.prompt] + (args.labels or [])
    try:
        device = "mps" if torch.backends.mps.is_available() else "cpu"
        model = CLIPModel.from_pretrained(args.model).to(device).eval()
        processor = CLIPProcessor.from_pretrained(args.model)

        images = [Image.open(f).convert("RGB") for f in frames]
        inputs = processor(text=labels, images=images, return_tensors="pt", padding=True).to(device)
        with torch.no_grad():
            out = model(**inputs)
        # logits_per_image: [num_frames, num_labels]. softmax over labels → prob.
        probs = out.logits_per_image.softmax(dim=-1).cpu().float().numpy()
        # Cosine similarity (image_embeds @ text_embeds) — the raw CLIP score, label-agnostic.
        cos = (
            (out.image_embeds @ out.text_embeds.T).cpu().float().numpy()
        )  # [num_frames, num_labels]
    except Exception as exc:
        return _emit(args.output, {"ok": False, "error": f"clip inference failed: {exc}"}, exit_code=4)

    per_frame = []
    prompt_probs = []
    for i in range(len(frames)):
        per_frame.append(
            {
                "path": os.path.abspath(frames[i]),
                "index": i,
                "score": float(cos[i, 0]),
                "prob": float(probs[i, 0]),
            }
        )
        prompt_probs.append(float(probs[i, 0]))

    score = float(sum(r["score"] for r in per_frame) / max(1, len(per_frame)))
    payload = {
        "ok": True,
        "video": video_abs,
        "prompt": args.prompt,
        "labels": labels,
        "score": score,
        "prob_mean": (sum(prompt_probs) / max(1, len(prompt_probs))) if prompt_probs else 0.0,
        "frames": per_frame,
        "model": args.model,
        "duration_s": round(time.time() - t0, 3),
    }
    return _emit(args.output, payload, exit_code=0)


def _sample_frames(video: str, num_frames: int, out_dir: str) -> list[str]:
    """Sample `num_frames` evenly-spaced frames via ffmpeg into out_dir."""
    try:
        import json as _json

        # Read duration to pick evenly-spaced timestamps (avoid first/last frame edge cases).
        probe = subprocess.run(
            [
                "ffprobe", "-v", "error", "-show_entries", "format=duration",
                "-of", "default=nw=1:nk=1", video,
            ],
            capture_output=True, text=True, check=True,
        )
        duration = float(probe.stdout.strip() or "0") or 0.0
    except Exception:
        duration = 0.0

    frames: list[str] = []
    for i in range(num_frames):
        ts = (duration * (i + 0.5) / num_frames) if duration > 0 else float(i)
        out_path = os.path.join(out_dir, f"frame_{i:03d}.png")
        rc = subprocess.run(
            [
                "ffmpeg", "-y", "-loglevel", "error",
                "-ss", f"{ts:.3f}", "-i", video, "-frames:v", "1",
                out_path,
            ],
            capture_output=True, text=True,
        )
        if rc.returncode == 0 and os.path.isfile(out_path):
            frames.append(out_path)
    return frames


def _emit(output: str | None, payload: dict, exit_code: int) -> int:
    text = json.dumps(payload, ensure_ascii=False, indent=2)
    if output:
        with open(output, "w", encoding="utf-8") as fh:
            fh.write(text + "\n")
    else:
        print(text)
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
