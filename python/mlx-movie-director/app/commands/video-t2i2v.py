"""video-t2i2v — Text → Image → Video pipeline.

Chains three stages in a single command:
  Stage 1 (T2I)  — ZImage (moody-pro-mix) generates a high-quality image
  Stage 2 (VLM)  — Qwen3-VL reads the image + user action intent → LTX-optimized I2V prompt
  Stage 3 (I2V)  — LTX-2.3 (dasiwa) animates the image with the VLM prompt

Stage 2 is skipped when --action is omitted (raw --prompt used for video).

Usage:
  run.py video t2i2v --prompt "a woman in a garden"
  run.py video t2i2v --prompt "a woman" --action "她微笑走向鏡頭"
  run.py video t2i2v --prompt "a woman" --action "她跳舞" --video-transformer dasiwa --frames 49
"""

import glob
import json
import os
import subprocess
import sys
import time

from app.commands._shared import build_run_py_cmd
from app import config as cfg

PARSER_META = {
    "help": "T2I2V: ZImage T2I → VLM prompt assistant → LTX I2V in one command",
    "description": (
        "Three-stage pipeline: ZImage generates an image, optionally a VLM assistant "
        "reads the image and expands the user's action intent into an LTX-optimized I2V "
        "prompt (with voice in zh-TW), then LTX-2.3 animates the image.\n\n"
        "Examples:\n"
        "  run.py video t2i2v --prompt 'a woman in a garden'\n"
        "  run.py video t2i2v --prompt 'a woman' --action '她微笑走向鏡頭'\n"
        "  run.py video t2i2v --prompt 'a woman' --action '她跳舞' --frames 49\n"
    ),
}


def add_t2i2v_args(parser):
    # --- T2I stage ---
    parser.add_argument("--t2i-transformer", type=str, default="moody-pro-mix",
                        metavar="NAME",
                        help="ZImage transformer for T2I stage (default: moody-pro-mix)")
    parser.add_argument("--t2i-steps", type=int, default=9,
                        help="T2I denoising steps (default: 9)")
    parser.add_argument("--t2i-seed", type=int, default=None,
                        help="T2I seed (default: same as --seed)")
    parser.add_argument("--t2i-width", type=int, default=640,
                        help="T2I image width (default: 640)")
    parser.add_argument("--t2i-height", type=int, default=960,
                        help="T2I image height (default: 960)")
    parser.add_argument("--t2i-lora-path", type=str, default=None, metavar="PATH",
                        help="LoRA path for T2I stage")
    parser.add_argument("--t2i-lora-scale", type=float, default=1.0,
                        help="LoRA scale for T2I stage (default: 1.0)")

    # --- VLM stage ---
    parser.add_argument("--action", type=str, default=None, metavar="TEXT",
                        help="Action intent (zh-TW supported). VLM expands to full LTX I2V "
                             "prompt with motion + voice. Omit to skip VLM stage.")
    parser.add_argument("--vlm-api-url", type=str, default=None, metavar="URL",
                        help="VLM API base URL override (default: http://localhost:1234/v1)")


def run_t2i2v(args):
    # --- Resolve shared seed ---
    base_seed = getattr(args, "seed", 99) or 99
    t2i_seed = getattr(args, "t2i_seed", None) or base_seed
    video_seed = base_seed

    # --- Create dedicated output subfolder ---
    base_dir = getattr(args, "gen_output_dir", None) or cfg.OUTPUT_DIR
    run_name = f"t2i2v_{time.strftime('%Y%m%d_%H%M%S')}"
    out_dir = os.path.join(base_dir, run_name)
    os.makedirs(out_dir, exist_ok=True)
    print(f"[t2i2v] Output dir: {out_dir}")

    # =========================================================
    # Stage 1 — T2I: ZImage generates base image
    # =========================================================
    print(f"\n[t2i2v] ── Stage 1/3: T2I (ZImage) ──")
    prompt = args.prompt
    t2i_transformer = getattr(args, "t2i_transformer", "moody-pro-mix")
    t2i_steps = getattr(args, "t2i_steps", 9)
    t2i_width = getattr(args, "t2i_width", 640)
    t2i_height = getattr(args, "t2i_height", 960)
    t2i_lora_path = getattr(args, "t2i_lora_path", None)
    t2i_lora_scale = getattr(args, "t2i_lora_scale", 1.0)

    t2i_cmd = build_run_py_cmd(
        "image", "t2i",
        "--prompt", prompt,
        "--transformer", t2i_transformer,
        "--steps", str(t2i_steps),
        "--seed", str(t2i_seed),
        "--width", str(t2i_width),
        "--height", str(t2i_height),
        "--gen-output-dir", out_dir,
    )
    if t2i_lora_path:
        t2i_cmd += ["--lora-path", t2i_lora_path,
                    "--lora-scale", str(t2i_lora_scale)]

    try:
        # Stream (no capture): T2I runs minutes-to-tens-of-minutes, and capturing
        # would swallow MLX's live step progress. timeout still guards a hang.
        result = subprocess.run(t2i_cmd, cwd=os.path.dirname(t2i_cmd[1]), timeout=7200)
    except subprocess.TimeoutExpired:
        print("[t2i2v] ERROR: T2I stage timed out after 7200s", file=sys.stderr)
        sys.exit(124)
    if result.returncode != 0:
        # Child stderr already streamed live; just surface the exit summary.
        print(f"[t2i2v] ERROR: T2I stage failed (exit {result.returncode})", file=sys.stderr)
        sys.exit(result.returncode)

    # Find the generated image via its manifest
    manifests = glob.glob(os.path.join(out_dir, "*.manifest.json"))
    if not manifests:
        print("[t2i2v] ERROR: no manifest found after T2I stage", file=sys.stderr)
        sys.exit(1)
    try:
        with open(sorted(manifests)[0]) as f:
            t2i_manifest = json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        print(f"[t2i2v] ERROR: cannot read T2I manifest ({e})", file=sys.stderr)
        sys.exit(1)
    output_files = t2i_manifest.get("output_files", [])
    if not output_files:
        print("[t2i2v] ERROR: T2I manifest has no output_files", file=sys.stderr)
        sys.exit(1)
    image_path = output_files[0]["path"]
    print(f"[t2i2v] T2I image: {image_path}")

    # =========================================================
    # Stage 2 — VLM: generate LTX-optimized I2V prompt
    # =========================================================
    action = getattr(args, "action", None)
    video_prompt = prompt  # fallback: use raw T2I prompt

    if action:
        print(f"\n[t2i2v] ── Stage 2/3: VLM prompt assistant ──")
        vlm_output = os.path.join(out_dir, "vlm_prompt.json")
        vlm_cmd = build_run_py_cmd(
            "caption", image_path,
            "--style", "ltx_i2v",
            "--action", action,
            "--lang", "en",  # VLM output language for LTX prompt (voice stays zh-TW per style)
            "--output", vlm_output,
            force=False,  # caption is CPU-bound (VLM), no GPU lock needed
        )
        if getattr(args, "vlm_api_url", None):
            vlm_cmd += ["--api-url", args.vlm_api_url]

        try:
            result = subprocess.run(vlm_cmd, cwd=os.path.dirname(vlm_cmd[1]), timeout=7200)
        except subprocess.TimeoutExpired:
            print("[t2i2v] WARNING: VLM stage timed out after 7200s — falling back to raw prompt",
                  file=sys.stderr)
            result = None
        if result is None:
            pass  # timed out — already warned, fall back to raw prompt
        elif result.returncode != 0:
            print(f"[t2i2v] WARNING: VLM stage failed — falling back to raw prompt",
                  file=sys.stderr)
        else:
            try:
                vlm_data = json.load(open(vlm_output))
                # ltx_i2v returns JSON inside caption; parse it
                ltx_caption = vlm_data.get("styles", {}).get("ltx_i2v", {}).get("caption", "")
                if isinstance(ltx_caption, str):
                    # VLM may return JSON string or already-parsed dict
                    try:
                        ltx_obj = json.loads(ltx_caption)
                    except (json.JSONDecodeError, TypeError):
                        ltx_obj = {}
                elif isinstance(ltx_caption, dict):
                    ltx_obj = ltx_caption
                else:
                    ltx_obj = {}
                generated_prompt = ltx_obj.get("prompt", "")
                if generated_prompt:
                    video_prompt = generated_prompt
                    motion_summary = ltx_obj.get("motion_summary", "")
                    print(f"[t2i2v] VLM prompt: {video_prompt[:120]}...")
                    if motion_summary:
                        print(f"[t2i2v] Motion: {motion_summary}")
                else:
                    print("[t2i2v] WARNING: VLM returned empty prompt — using raw prompt",
                          file=sys.stderr)
            except (OSError, json.JSONDecodeError, KeyError) as e:
                print(f"[t2i2v] WARNING: failed to parse VLM output ({e}) — using raw prompt",
                      file=sys.stderr)
    else:
        print(f"\n[t2i2v] ── Stage 2/3: VLM skipped (no --action) ──")

    # =========================================================
    # Stage 3 — I2V: LTX animates the image
    # =========================================================
    print(f"\n[t2i2v] ── Stage 3/3: I2V (LTX-2.3) ──")

    # Resolve LTX transformer: use --transformer if explicitly passed, else dasiwa
    ltx_transformer = getattr(args, "transformer", None) or "dasiwa"
    frames = getattr(args, "frames", 97) or 97
    fps = getattr(args, "fps", 24) or 24
    cfg_scale = getattr(args, "cfg_scale", None)
    stg_scale = getattr(args, "stg_scale", None)
    stage1_steps = getattr(args, "stage1_steps", None)
    stage2_steps = getattr(args, "stage2_steps", None)
    hq = getattr(args, "hq", False)
    distilled = getattr(args, "distilled", False)
    teacache = getattr(args, "teacache", False)
    lora_path = getattr(args, "lora_path", None)
    lora_scale = getattr(args, "lora_scale", 1.0)

    video_cmd = build_run_py_cmd(
        "video", "generate",
        "--input-image", image_path,
        "--prompt", video_prompt,
        "--transformer", ltx_transformer,
        "--frames", str(frames),
        "--fps", str(fps),
        "--seed", str(video_seed),
        "--gen-output-dir", out_dir,
    )
    if cfg_scale is not None:
        video_cmd += ["--cfg-scale", str(cfg_scale)]
    if stg_scale is not None:
        video_cmd += ["--stg-scale", str(stg_scale)]
    if stage1_steps is not None:
        video_cmd += ["--stage1-steps", str(stage1_steps)]
    if stage2_steps is not None:
        video_cmd += ["--stage2-steps", str(stage2_steps)]
    if hq:
        video_cmd.append("--hq")
    if distilled:
        video_cmd.append("--distilled")
    if teacache:
        video_cmd.append("--teacache")
    if lora_path:
        video_cmd += ["--lora-path", lora_path, "--lora-scale", str(lora_scale)]

    try:
        # Stream (no capture): I2V is the longest stage; capturing would hide MLX
        # progress for tens of minutes. timeout guards a hang.
        result = subprocess.run(video_cmd, cwd=os.path.dirname(video_cmd[1]), timeout=7200)
    except subprocess.TimeoutExpired:
        print("[t2i2v] ERROR: I2V stage timed out after 7200s", file=sys.stderr)
        sys.exit(124)
    if result.returncode != 0:
        print(f"[t2i2v] ERROR: I2V stage failed (exit {result.returncode})", file=sys.stderr)
        sys.exit(result.returncode)

    # =========================================================
    # Write combined manifest
    # =========================================================
    combined_manifest = {
        "pipeline": "t2i2v",
        "output_dir": out_dir,
        "stages": {
            "t2i": {
                "transformer": t2i_transformer,
                "prompt": prompt,
                "steps": t2i_steps,
                "seed": t2i_seed,
                "width": t2i_width,
                "height": t2i_height,
                "image_path": image_path,
            },
            "vlm": {
                "action": action,
                "generated_prompt": video_prompt if action else None,
                "skipped": action is None,
            },
            "i2v": {
                "transformer": ltx_transformer,
                "prompt": video_prompt,
                "frames": frames,
                "fps": fps,
                "seed": video_seed,
            },
        },
    }
    manifest_path = os.path.join(out_dir, "t2i2v_manifest.json")
    with open(manifest_path, "w") as f:
        json.dump(combined_manifest, f, indent=2, ensure_ascii=False)

    print(f"\n[t2i2v] ✓ Done → {out_dir}")
    print(f"[t2i2v]   manifest: {manifest_path}")
