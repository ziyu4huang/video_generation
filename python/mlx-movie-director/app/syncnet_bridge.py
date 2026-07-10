"""syncnet_bridge -- LSE-D/LSE-C lip-sync metric, run in a DEDICATED python/sync-venv.

Replaces the mouth-ratio/RMS proxy in ``app/lipsync_metrics.py`` (known-weak —
two inconclusive measurements traced to the proxy correlating presence/absence
of speech, not frame-level sync; full history in ``docs/openmontage-capability-
matrix.md``'s ``lip_sync`` row) with the actual literature-standard metric: SyncNet
(Chung & Zisserman, "Out of Time: Automated Lip Sync in the Wild", ACCV 2016)
embedding distance between mouth-crop video and MFCC audio features.

Runs in ``python/sync-venv`` (isolated, like face-venv/vision-venv/whisper-venv
-- see CLAUDE.md Item I adapter note) because ``syncnet-python`` pulls its own
torch/torchvision/opencv-contrib pin unrelated to the MLX generation stack.
The PyPI package (``syncnet-python`` 0.2.2) bundles ``syncnet_pipeline.py``,
which imports ``scenedetect.video_manager`` -- removed in scenedetect>=0.7, so
that top-level import (and the package's ``__init__.py`` re-export, which
silently swallows the ImportError) is dead. This module imports the needed
submodules directly (``SyncNetInstance``, ``SyncNetModel``, ``detectors.s3fd``)
and reimplements the face-crop + frame/audio extraction that
``syncnet_pipeline``/``run_pipeline.py`` would otherwise provide, since our
inputs are single-face, near-static talking-portrait clips (not multi-shot
footage needing scene-cut splitting) -- a full multi-shot tracker is
unnecessary complexity for this input shape.

Weights (``sfd_face.pth``, ``syncnet_v2.model`` -- Chung & Zisserman's
original release) live in the gitignored
``app/models/syncnet/`` directory, matching the existing mediapipe
``face_landmarker.task`` precedent (measurement-tool assets are NOT run
through ``mlx-models/store-manifest.json``, which is for generation-model
binaries only).

CLI:
    python/sync-venv/bin/python app/syncnet_bridge.py <mp4_path>

Emits a ``__SYNCNET_MANIFEST__`` marker line followed by a JSON payload (see
``_build_result`` / the module docstring) -- the same convention as
``app/face_restore_bridge.py``, so ``app.lipsync_metrics`` can spawn this as a
subprocess and parse stdout after the marker.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile

MANIFEST_MARKER = "__SYNCNET_MANIFEST__"

_TARGET_FPS = 25
_TARGET_SAMPLE_RATE = 16000
_CROP_SIZE = 224
_CROP_MARGIN = 1.6  # half-size multiplier around the raw face bbox
_SMOOTH_WINDOW = 5  # frames, moving-average bbox smoothing (reduces per-frame jitter)
_VSHIFT = 15  # AV-offset search window, +/- frames


def _models_dir() -> str:
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "models", "syncnet")


def _weight_paths() -> tuple[str, str]:
    base = _models_dir()
    return (
        os.path.join(base, "sfd_face.pth"),
        os.path.join(base, "syncnet_v2.model"),
    )


def _resolve_device() -> str:
    import torch

    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def _extract_frames_and_audio(mp4_path: str, out_dir: str) -> tuple[list[str], str]:
    """Extract frames at 25fps (jpg) and audio at 16kHz mono (wav) into out_dir."""
    frame_pattern = os.path.join(out_dir, "frame_%05d.jpg")
    subprocess.run(
        ["ffmpeg", "-y", "-i", mp4_path, "-vf", f"fps={_TARGET_FPS}", "-q:v", "2", frame_pattern],
        capture_output=True, timeout=120,
    )
    audio_path = os.path.join(out_dir, "audio.wav")
    subprocess.run(
        ["ffmpeg", "-y", "-i", mp4_path, "-vn", "-ac", "1", "-ar", str(_TARGET_SAMPLE_RATE),
         "-acodec", "pcm_s16le", audio_path],
        capture_output=True, timeout=120,
    )
    frames = sorted(
        os.path.join(out_dir, f) for f in os.listdir(out_dir) if f.startswith("frame_")
    )
    return frames, audio_path


def _smooth_bboxes(bboxes: list) -> list:
    """Moving-average smoothing of (cx, cy, half_size) over _SMOOTH_WINDOW frames."""
    import numpy as np

    valid_idx = [i for i, b in enumerate(bboxes) if b is not None]
    if not valid_idx:
        return bboxes
    arr = np.array([bboxes[i] for i in valid_idx], dtype=np.float64)  # N x 3
    k = min(_SMOOTH_WINDOW, len(arr))
    if k < 2:
        smoothed = arr
    else:
        kernel = np.ones(k) / k
        smoothed = np.stack(
            [np.convolve(arr[:, j], kernel, mode="same") for j in range(3)], axis=1
        )
    out = list(bboxes)
    for pos, i in enumerate(valid_idx):
        out[i] = tuple(smoothed[pos])
    # Forward/back-fill frames with no detection using the nearest smoothed bbox.
    last = None
    for i in range(len(out)):
        if out[i] is not None:
            last = out[i]
        elif last is not None:
            out[i] = last
    last = None
    for i in range(len(out) - 1, -1, -1):
        if out[i] is not None:
            last = out[i]
        elif last is not None:
            out[i] = last
    return out


def _detect_and_crop_faces(frame_paths: list[str], device: str, crop_dir: str) -> dict:
    """Run S3FD per frame, smooth bboxes, write 224x224 face crops to crop_dir.

    Returns stats: n_frames, n_detected.
    """
    import cv2
    import numpy as np
    import torch

    from syncnet_python.detectors.s3fd import S3FD
    from syncnet_python.detectors.s3fd.nets import S3FDNet

    s3fd_weights, _ = _weight_paths()
    net = S3FDNet(device=device)
    state = torch.load(s3fd_weights, map_location=device)
    net.load_state_dict(state)
    detector = S3FD(net=net, device=device)

    raw_bboxes: list = []
    images = []
    for frame_path in frame_paths:
        img = cv2.imread(frame_path)
        images.append(img)
        dets = detector.detect_faces(img, conf_th=0.8, scales=[1])
        if dets is None or len(dets) == 0:
            raw_bboxes.append(None)
            continue
        best = dets[np.argmax(dets[:, 4])]
        x1, y1, x2, y2 = best[0], best[1], best[2], best[3]
        cx, cy = (x1 + x2) / 2.0, (y1 + y2) / 2.0
        half_size = max(x2 - x1, y2 - y1) / 2.0 * _CROP_MARGIN
        raw_bboxes.append((cx, cy, half_size))

    n_detected = sum(1 for b in raw_bboxes if b is not None)
    smoothed = _smooth_bboxes(raw_bboxes)

    for i, (img, bbox) in enumerate(zip(images, smoothed)):
        if bbox is None or img is None:
            continue
        cx, cy, hs = bbox
        h, w = img.shape[:2]
        x1, y1, x2, y2 = int(cx - hs), int(cy - hs), int(cx + hs), int(cy + hs)
        pad_l, pad_t = max(0, -x1), max(0, -y1)
        pad_r, pad_b = max(0, x2 - w), max(0, y2 - h)
        padded = cv2.copyMakeBorder(img, pad_t, pad_b, pad_l, pad_r, cv2.BORDER_CONSTANT, value=0)
        crop = padded[y1 + pad_t: y2 + pad_t, x1 + pad_l: x2 + pad_l]
        if crop.size == 0:
            continue
        crop = cv2.resize(crop, (_CROP_SIZE, _CROP_SIZE))
        cv2.imwrite(os.path.join(crop_dir, f"frame_{i:05d}.jpg"), crop)

    return {"n_frames": len(frame_paths), "n_detected": n_detected}


def _run_syncnet_eval(crop_dir: str, audio_path: str, device: str) -> dict:
    """Load SyncNet, evaluate offset/confidence/min-distance on cropped frames + audio."""
    import argparse

    from syncnet_python.SyncNetInstance import SyncNetInstance
    from syncnet_python.SyncNetModel import S as SyncNetModel

    _, syncnet_weights = _weight_paths()
    model = SyncNetModel()
    instance = SyncNetInstance(net=model, device=device)
    instance.loadParameters(syncnet_weights)

    opt = argparse.Namespace(tmp_dir=crop_dir, batch_size=20, vshift=_VSHIFT)
    offset, conf, minval = instance.evaluate(opt)
    return {"offset_frames": offset, "lse_c": conf, "lse_d": minval}


def measure(mp4_path: str) -> dict:
    """End-to-end LSE-D/LSE-C measurement for one mp4. Returns a result dict."""
    device = _resolve_device()
    s3fd_weights, syncnet_weights = _weight_paths()
    if not os.path.exists(s3fd_weights) or not os.path.exists(syncnet_weights):
        return {
            "verdict": "weights_missing",
            "note": f"expected weights at {_models_dir()} "
                    "(sfd_face.pth, syncnet_v2.model) -- see app/syncnet_bridge.py docstring",
        }

    with tempfile.TemporaryDirectory() as raw_dir, tempfile.TemporaryDirectory() as crop_dir:
        frame_paths, audio_path = _extract_frames_and_audio(mp4_path, raw_dir)
        if not frame_paths:
            return {"verdict": "no_frames", "note": "ffmpeg produced no frames"}

        face_stats = _detect_and_crop_faces(frame_paths, device, crop_dir)
        if face_stats["n_detected"] < 4:
            return {
                "verdict": "no_face",
                "note": "S3FD detected fewer than 4 faces across the clip",
                **face_stats,
            }

        n_crops = len([f for f in os.listdir(crop_dir) if f.startswith("frame_")])
        if n_crops < 6:
            return {
                "verdict": "too_short",
                "note": "fewer than 6 usable frames after cropping "
                        "(SyncNet needs lastframe = n - 5 >= 1)",
                **face_stats,
            }

        # SyncNetInstance.evaluate() hardcodes reading "audio.wav" from
        # opt.tmp_dir (the same dir as the cropped face jpgs it globs) --
        # it takes no separate audio-path argument, so the extracted wav
        # (in raw_dir) must be copied alongside the crops before eval.
        import shutil
        shutil.copy(audio_path, os.path.join(crop_dir, "audio.wav"))

        try:
            metrics = _run_syncnet_eval(crop_dir, audio_path, device)
        except Exception as exc:  # noqa: BLE001 -- surface any inference failure as a verdict
            return {"verdict": "inference_error", "note": str(exc), **face_stats}

    # Reference premium bar found in web research: LSE-D <= 1.5 (Chung & Zisserman
    # follow-on literature). LSE-D correlates only ~0.36 with human judgment, so
    # treat this as a sharper signal than the mouth-ratio proxy, not an oracle.
    verdict = "adequate" if metrics["lse_d"] <= 1.5 else "inadequate"
    result = {"verdict": verdict, **metrics, **face_stats}
    if abs(metrics["offset_frames"]) == _VSHIFT:
        result["caveat"] = (
            f"AV offset search hit the ±{_VSHIFT}-frame boundary -- on a clip this "
            "decorrelated, the min-distance search trends toward the window edge "
            "rather than converging, which is itself a signal of poor sync (a "
            "well-synced clip converges to a small offset well inside the window)."
        )
    return result


def main() -> None:
    if len(sys.argv) != 2:
        print("usage: python app/syncnet_bridge.py <mp4_path>", file=sys.stderr)
        sys.exit(1)
    result = measure(sys.argv[1])
    sys.stdout.write("\n" + MANIFEST_MARKER + "\n" + json.dumps(result) + "\n")


if __name__ == "__main__":
    main()
