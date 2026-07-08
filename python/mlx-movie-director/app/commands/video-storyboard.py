"""video-storyboard — bridge: --story → character-locked panels → multi-shot video.

Composes three already-verified pieces into the OpenMontage-shaped deliverable
that neither alone provides (see "Storyboard→video bridge" in
docs/openmontage-capability-matrix.md):

  1. the storyline → SceneSpec decomposition + character-lock storyboard loop
     (`image storyboard`, PR #366) — produces N character-consistent panels,
     each with a 5-layer cinematography prompt (subject/motion/scene/framing/
     camera baked in by `shot_prompt_builder`);
  2. the multi-segment Prompt-Relay video pipeline (`video relay`) — chains N
     I2V segments into one concatenated (optionally audio-scored) mp4.

Each storyboard panel becomes one relay segment: the panel's already-baked
prompt is the segment prompt (no separate camera-vocabulary wiring needed —
SceneSpec's shot_language is already text in that prompt), and the panel's
generated image is that segment's I2V starting frame (a hard per-panel
anchor, not a chained relay-frame — the storyboard's character-lock already
guarantees identity continuity panel-to-panel, so each segment restarts from
its own certified frame rather than drifting off the previous segment's last
frame).

One command from story to video:
    run.py video storyboard --story "..." --num-panels 4 --character hero.png \
        --relay-duration 3 --relay-audio narration.mp3

Two-step equivalent (reuse an existing storyboard.json from `image storyboard`,
skip panel regeneration):
    run.py video storyboard --storyboard-json out/storyboard_.../storyboard.json
"""
from __future__ import annotations

import argparse
import importlib
import json
from typing import Any

from app.commands._shared import _arg_registered

_img_storyboard = importlib.import_module("app.commands.image-storyboard")
_relay = importlib.import_module("app.commands.video-relay")


def add_storyboard_video_args(parser: argparse.ArgumentParser) -> None:
    """Register video-storyboard args: the panel-source args + the relay pass-through.

    Relay args (--relay-audio, --relay-duration, --relay-output, etc.) are already
    registered on the shared `video` parser by video.py's `_relay.add_relay_args`
    call; --relay-prompts/--relay-images are deliberately NOT set by the user here
    — this command derives them from the storyboard panels.
    """
    if not _arg_registered(parser, "storyboard_json"):
        parser.add_argument(
            "--storyboard-json", type=str, default=None, dest="storyboard_json",
            help="Path to an existing storyboard.json (from `image storyboard`) to "
                 "video-ify directly, skipping panel (re)generation.",
        )
    # Panel-source args (--story, --scenes, --num-panels, --style-hint,
    # --style-context, --character, --judge) — reused verbatim from image
    # storyboard so a single --story flag drives the whole story→video path.
    if not _arg_registered(parser, "story"):
        _img_storyboard.add_storyboard_args(parser)


def _load_shots_from_json(path: str) -> dict[str, Any]:
    with open(path, "r") as f:
        return json.load(f)


def run_storyboard_video(args: argparse.Namespace) -> None:
    if getattr(args, "storyboard_json", None):
        print(f"[storyboard→video] loading existing storyboard: {args.storyboard_json}", flush=True)
        payload = _load_shots_from_json(args.storyboard_json)
    else:
        print("[storyboard→video] generating storyboard panels…", flush=True)
        payload = _img_storyboard.run_storyboard(args)

    shots = payload.get("shots", [])
    if not shots:
        raise RuntimeError("storyboard produced no shots — nothing to video-ify")

    for s in shots:
        if not s.get("image"):
            raise RuntimeError(f"shot {s.get('scene_id')} has no image — cannot use as I2V anchor")

    print(f"[storyboard→video] {len(shots)} panel(s) → {len(shots)} relay segment(s)", flush=True)

    # Each panel is a hard I2V anchor (not a chained relay-frame): the
    # character-lock already guarantees cross-panel identity, so segment N+1
    # starts from its OWN certified panel rather than drifting off segment N's
    # last generated frame.
    args.relay_prompts = [s["prompt"] for s in shots]
    args.relay_images = [s["image"] for s in shots]
    args.relay_prompt_file = None  # mutually exclusive with relay_prompts

    _relay.run_relay(args)
