"""video-compare — Pipeline A/B comparison in a single flow.

Flow:
  1. Generate reference image with Z-Image (or use --source-image)
  2. Auto-caption it to get a video prompt (or use --prompt)
  3. Generate video with multiple LTX pipeline modes sequentially
  4. Launch video review for side-by-side comparison

Exports: add_compare_args(), run_compare()
"""

import glob
import importlib
import json
import os
import subprocess
import sys
import types

from app import config as cfg
from app.commands._shared import build_run_py_cmd

_RUN_PY = os.path.normpath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "run.py")
)

# ---------------------------------------------------------------------------
# Pipeline matrix
# ---------------------------------------------------------------------------

PIPELINE_MATRIX = {
    "i2v": {
        "flags": [],
        "cfg_scale": 5.0,
        "stg_scale": 1.0,
        "stage1_steps_override": None,  # inherit from --stage1-steps
        "use_image": True,
        "label": "I2V",
        "description": "Standard I2V — dev + CFG + spatial 2x",
        "color": "blue",
    },
    "distilled-i2v": {
        "flags": ["--distilled"],
        "cfg_scale": 1.0,
        "stg_scale": 0.0,
        "stage1_steps_override": 8,
        "use_image": True,
        "label": "Distilled-I2V",
        "description": "Distilled I2V — fast, 8 steps, no CFG",
        "color": "purple",
    },
    "hq-i2v": {
        "flags": ["--hq"],
        "cfg_scale": 5.0,
        "stg_scale": 1.0,
        "stage1_steps_override": None,
        "use_image": True,
        "label": "HQ-I2V",
        "description": "HQ I2V — res_2s + CFG (slowest, best quality)",
        "color": "gold",
    },
    "t2v": {
        "flags": [],
        "cfg_scale": 5.0,
        "stg_scale": 1.0,
        "stage1_steps_override": None,
        "use_image": False,
        "label": "T2V",
        "description": "Standard T2V — text only, no reference image",
        "color": "gray",
    },
    "distilled-t2v": {
        "flags": ["--distilled"],
        "cfg_scale": 1.0,
        "stg_scale": 0.0,
        "stage1_steps_override": 8,
        "use_image": False,
        "label": "Distilled-T2V",
        "description": "Distilled T2V — fast, 8 steps, no CFG",
        "color": "purple",
    },
    "hq-t2v": {
        "flags": ["--hq"],
        "cfg_scale": 5.0,
        "stg_scale": 1.0,
        "stage1_steps_override": None,
        "use_image": False,
        "label": "HQ-T2V",
        "description": "HQ T2V — res_2s + CFG, text only",
        "color": "gold",
    },
}

DEFAULT_PIPELINES = "i2v,distilled-i2v,hq-i2v"


# ---------------------------------------------------------------------------
# Argument registration
# ---------------------------------------------------------------------------

def add_compare_args(parser):
    """Register compare-specific CLI arguments.

    NOTE: --prompt, --prompt-file, --frames, --seed, --width, --height,
    --stage1-steps, --labels, --no-open are already registered by
    video-generate / video-review — do NOT re-register them here.
    """
    # Source image
    parser.add_argument(
        "--source-image", type=str, default=None, metavar="PATH",
        help="Reference image for I2V pipelines. If omitted, Z-Image generates one.",
    )

    # Z-Image generation (only used when --source-image is omitted)
    parser.add_argument(
        "--image-prompt", type=str, default=None, metavar="TEXT",
        help="Prompt for Z-Image generation (default: uses --prompt or generic portrait)",
    )
    parser.add_argument(
        "--image-width", type=int, default=640, metavar="W",
        help="Z-Image output width (default: 640)",
    )
    parser.add_argument(
        "--image-height", type=int, default=960, metavar="H",
        help="Z-Image output height (default: 960)",
    )
    parser.add_argument(
        "--image-steps", type=int, default=None, metavar="N",
        help="Z-Image denoising steps (default: pipeline default ~9)",
    )

    # Caption
    parser.add_argument(
        "--skip-caption", action="store_true", default=False,
        help="Skip auto-captioning; use --prompt as-is",
    )
    parser.add_argument(
        "--caption-style",
        choices=["default", "photography", "prompt", "profile", "style",
                 "score", "compare", "review"],
        default=None,
        help="Caption style for auto-captioning / --caption. Shared across the `video` "
             "sub-actions (generate defaults to 'default', compare to 'prompt' when unset). "
             "'review' yields structured scores for the comparison HTML.",
    )

    # Pipeline selection
    parser.add_argument(
        "--pipelines", type=str, default=DEFAULT_PIPELINES, metavar="LIST",
        help=(
            f"Comma-separated pipeline names (default: {DEFAULT_PIPELINES}). "
            "Run --list-pipelines to see all options."
        ),
    )
    parser.add_argument(
        "--list-pipelines", action="store_true", default=False,
        help="List available pipeline names and exit",
    )

    # Compare-only flags
    parser.add_argument(
        "--dry-run", action="store_true", default=False,
        help="Print the comparison plan without generating anything",
    )


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def run_compare(args):
    """Execute pipeline compare flow."""
    if getattr(args, "list_pipelines", False):
        _print_pipelines()
        return

    selected = _parse_pipelines(getattr(args, "pipelines", DEFAULT_PIPELINES))
    video_prompt_raw = _resolve_text_prompt(args)

    _print_plan(args, selected, video_prompt_raw)

    if getattr(args, "dry_run", False):
        print("\n[compare] Dry run — no generation performed.")
        return

    # Step 1: Get or generate source image
    image_path = _get_or_generate_image(args, video_prompt_raw, selected)

    # Step 2: Get video prompt (auto-caption if needed)
    video_prompt = _get_or_caption_prompt(args, image_path, video_prompt_raw)

    # Step 3: Generate videos sequentially
    manifest_paths = []
    labels = []
    total = len(selected)
    for i, (name, pcfg) in enumerate(selected, start=1):
        manifest = _run_pipeline_subprocess(
            args, name, pcfg, video_prompt, image_path, step=i, total=total
        )
        if manifest:
            manifest_paths.append(manifest)
            labels.append(pcfg["label"])
        else:
            print(f"[compare] SKIPPED: {name} (generation failed)", file=sys.stderr)

    if not manifest_paths:
        print("[compare] ERROR: no videos generated — nothing to review", file=sys.stderr)
        sys.exit(1)

    # Step 4: Launch video review
    print(f"\n[compare] All done — launching review for {len(manifest_paths)} videos")
    _launch_review(args, manifest_paths, labels)


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _print_pipelines():
    print("\nAvailable pipeline names for --pipelines:\n")
    for name, pcfg in PIPELINE_MATRIX.items():
        img_tag = " [I2V]" if pcfg["use_image"] else " [T2V]"
        print(f"  {name:<20}{img_tag}  —  {pcfg['description']}")
    print(f"\nDefault: {DEFAULT_PIPELINES}\n")


def _parse_pipelines(pipelines_str: str) -> list[tuple[str, dict]]:
    """Parse comma-separated pipeline names and return [(name, config), ...]."""
    names = [n.strip() for n in pipelines_str.split(",") if n.strip()]
    result = []
    for name in names:
        if name not in PIPELINE_MATRIX:
            print(
                f"ERROR: unknown pipeline '{name}'. "
                f"Valid: {', '.join(PIPELINE_MATRIX)}",
                file=sys.stderr,
            )
            sys.exit(1)
        result.append((name, PIPELINE_MATRIX[name]))
    if not result:
        print("ERROR: --pipelines is empty", file=sys.stderr)
        sys.exit(1)
    return result


def _resolve_text_prompt(args) -> str | None:
    """Return the raw text prompt from args, or None if none given."""
    if getattr(args, "prompt", None):
        return args.prompt
    pf = getattr(args, "prompt_file", None)
    if pf:
        if not os.path.exists(pf):
            print(f"ERROR: prompt file not found: {pf}", file=sys.stderr)
            sys.exit(1)
        return open(pf).read().strip()
    return None


def _print_plan(args, selected, video_prompt_raw):
    print("\n[compare] Pipeline comparison plan:")
    needs_img = any(c["use_image"] for _, c in selected)
    source = getattr(args, "source_image", None)
    if source:
        print(f"  Source image:  {source}")
    elif needs_img:
        print(f"  Source image:  (generate with Z-Image)")
    if video_prompt_raw:
        print(f"  Video prompt:  {video_prompt_raw[:80]}")
    else:
        print(f"  Video prompt:  (auto-caption from source image)")
    print(f"  Frames:        {args.frames}")
    print(f"  Resolution:    {args.width}x{args.height}")
    print(f"\n  Pipelines ({len(selected)}):")
    for name, pcfg in selected:
        steps = pcfg["stage1_steps_override"] or args.stage1_steps
        img_tag = " + image" if pcfg["use_image"] and (source or needs_img) else ""
        print(f"    [{pcfg['label']}] {pcfg['description']}{img_tag}  (stage1={steps}, cfg={pcfg['cfg_scale']})")
    print()


def _get_or_generate_image(args, video_prompt_raw: str | None, selected) -> str | None:
    """Return absolute path to source image, generating one if needed."""
    source = getattr(args, "source_image", None)
    if source:
        if not os.path.exists(source):
            print(f"ERROR: --source-image not found: {source}", file=sys.stderr)
            sys.exit(1)
        return os.path.abspath(source)

    needs_image = any(c["use_image"] for _, c in selected)
    if not needs_image:
        return None

    # Generate with Z-Image
    img_prompt = (
        getattr(args, "image_prompt", None)
        or video_prompt_raw
        or "cinematic portrait, photorealistic, detailed face"
    )
    print(f"[compare] Step 1/4: Generating reference image with Z-Image")
    print(f"[compare] Image prompt: {img_prompt[:100]}")

    os.makedirs(cfg.OUTPUT_DIR, exist_ok=True)
    before_pngs = set(glob.glob(os.path.join(cfg.OUTPUT_DIR, "output_*.png")))

    cmd = build_run_py_cmd("image", "t2i",
           "--prompt", img_prompt,
           "--pipeline", "zimage",
           "--seed", str(getattr(args, "seed", 42)),
           "--width", str(getattr(args, "image_width", 640)),
           "--height", str(getattr(args, "image_height", 960)))
    steps = getattr(args, "image_steps", None)
    if steps:
        cmd += ["--steps", str(steps)]

    result = subprocess.run(cmd, cwd=os.path.dirname(_RUN_PY))
    if result.returncode != 0:
        print("[compare] WARNING: Z-Image generation failed — I2V pipelines will be skipped",
              file=sys.stderr)
        return None

    after_pngs = set(glob.glob(os.path.join(cfg.OUTPUT_DIR, "output_*.png")))
    new_pngs = sorted(after_pngs - before_pngs, key=os.path.getmtime)
    if not new_pngs:
        print("[compare] WARNING: no PNG found after Z-Image generation", file=sys.stderr)
        return None

    image_path = os.path.abspath(new_pngs[-1])
    print(f"[compare] Generated: {os.path.basename(image_path)}")
    return image_path


def _get_or_caption_prompt(args, image_path: str | None, video_prompt_raw: str | None) -> str:
    """Return the video prompt, auto-captioning if needed."""
    if video_prompt_raw and getattr(args, "skip_caption", False):
        return video_prompt_raw

    if video_prompt_raw:
        return video_prompt_raw

    if image_path:
        print(f"[compare] Step 2/4: Auto-captioning reference image")
        caption_path = os.path.splitext(image_path)[0] + ".caption.json"
        style = getattr(args, "caption_style", None) or "prompt"
        cmd = build_run_py_cmd("caption", image_path,
               "--style", style, "--lang", "en")
        result = subprocess.run(cmd, cwd=os.path.dirname(_RUN_PY))
        if result.returncode == 0 and os.path.exists(caption_path):
            try:
                with open(caption_path) as f:
                    caption = json.load(f).get("caption", "").strip()
                if caption:
                    print(f"[compare] Video prompt: {caption[:100]}...")
                    return caption
            except Exception:
                pass
        print("[compare] WARNING: caption failed — using generic prompt", file=sys.stderr)

    return "A cinematic scene with smooth natural motion"


def _run_pipeline_subprocess(
    args, name: str, pcfg: dict, prompt: str, image_path: str | None,
    step: int = 1, total: int = 1,
) -> str | None:
    """Run one video pipeline via subprocess, return new manifest path or None."""
    label = pcfg["label"]
    stage1_steps = pcfg["stage1_steps_override"] or getattr(args, "stage1_steps", 8)
    needs_image = pcfg["use_image"] and image_path

    n = step
    total = total
    print(f"\n[compare] Pipeline {n}/{total} [{label}]: {pcfg['description']}")

    before = set(glob.glob(os.path.join(cfg.OUTPUT_DIR, "*.manifest.json")))

    cmd = build_run_py_cmd(
        "video", "generate",
        "--prompt", prompt,
        "--frames", str(getattr(args, "frames", 49)),
        "--stage1-steps", str(stage1_steps),
        "--seed", str(getattr(args, "seed", 42)),
        "--width", str(getattr(args, "width", 704)),
        "--height", str(getattr(args, "height", 448)),
        "--cfg-scale", str(pcfg["cfg_scale"]),
        "--stg-scale", str(pcfg["stg_scale"]),
        "--first-frame",
        "--caption",
        "--yes",
    ) + pcfg["flags"]

    if needs_image:
        cmd += ["--input-image", image_path]

    result = subprocess.run(cmd, cwd=os.path.dirname(_RUN_PY))

    after = set(glob.glob(os.path.join(cfg.OUTPUT_DIR, "*.manifest.json")))
    new_manifests = sorted(after - before, key=os.path.getmtime)

    if result.returncode != 0 or not new_manifests:
        print(f"[compare] [{label}] FAILED (returncode={result.returncode})", file=sys.stderr)
        return None

    manifest = os.path.abspath(new_manifests[-1])
    print(f"[compare] [{label}] OK — {os.path.basename(manifest)}")
    return manifest


def _launch_review(args, manifest_paths: list, labels: list):
    """Launch video review for the collected manifests."""
    _review = importlib.import_module("app.commands.video-review")

    custom_labels = getattr(args, "labels", None)
    label_str = custom_labels if custom_labels else ",".join(labels)

    review_args = types.SimpleNamespace(
        inputs=manifest_paths,
        labels=label_str,
        output=cfg.OUTPUT_DIR,
        no_open=getattr(args, "no_open", False),
    )
    _review.run_review_from_manifests(review_args)
