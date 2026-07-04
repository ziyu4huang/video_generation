"""Dump a REAL `app.video_utils.detect_scenes`/`scenes_to_timestamps`
reference for VideoSceneDetectorTests' native Swift port
(VideoSceneDetector.swift).

Uses a small synthetic fixture (three solid-color 1s segments — red, blue,
green — concatenated, checked into test_refs/) rather than a real generated
clip: scene-cut detection is a deterministic CV algorithm over pixel
statistics, not a model-quality question, so a synthetic fixture with
unambiguous, exactly-known cut points is a cleaner and more portable
regression test than depending on a specific real output clip.

Run from repo root (requires opencv-python + numpy — already a
mlx-movie-director dependency):
    python/venv/bin/python swift/ltx-video-director/scripts/dump_video_scene_detect_reference.py
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "python", "mlx-movie-director"))

import cv2
from app.video_utils import detect_scenes, scenes_to_timestamps

VIDEO = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "test_refs", "video_scene_detect", "three_color_scenes.mp4")
OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "test_refs", "video_scene_detect")

if __name__ == "__main__":
    os.makedirs(OUT_DIR, exist_ok=True)

    cap = cv2.VideoCapture(VIDEO)
    fps = cap.get(cv2.CAP_PROP_FPS)
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    cap.release()

    scenes = detect_scenes(VIDEO, threshold=0.4, min_scene_frames=8)
    timestamps = scenes_to_timestamps(scenes, fps)

    print("fps:", fps, "total_frames:", total_frames)
    print("scenes:", scenes)
    print("timestamps:", timestamps)

    meta = {
        "video": "three_color_scenes.mp4",
        "fps": fps,
        "total_frames": total_frames,
        "threshold": 0.4,
        "min_frames": 8,
        "scenes": [{"start": s, "end": e} for s, e in scenes],
        "timestamps": timestamps,
    }
    out_path = os.path.join(OUT_DIR, "video_scene_detect.json")
    with open(out_path, "w") as f:
        json.dump(meta, f, indent=2, ensure_ascii=False)
    print("done ->", out_path)
