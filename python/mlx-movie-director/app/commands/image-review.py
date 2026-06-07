"""image-review — 3-mode review sub-action for 'run.py image review'.

Modes (dispatched by image.py):
  angle       — generate all camera-angle views from a reference image → HTML grid
  generation  — run T2I generation (optional A/B test) → HTML manifest review
  manifest    — render HTML review from existing .manifest.json files (default)

Public API:
  add_review_args(parser)          — register all review CLI arguments
  run_review(args, sub)            — dispatcher → angle / generation / manifest
  run_review_angle(args)           — angle grid mode
  run_review_generation(args)      — T2I generation + manifest review
  run_review_manifest(args)        — manifest HTML review (restored from review-image.py)
"""

import copy
import importlib
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone

from app import config as cfg
from app.commands._shared import execute_generation
from app.run_config import RunConfig

_angle_mod = importlib.import_module("app.commands.image-angle")

# ---------------------------------------------------------------------------
# Angle grid constants
# ---------------------------------------------------------------------------

ANGLE_GRID = [
    ("front-center",  0),
    ("front-right",  45),
    ("right",        90),
    ("back-right",  135),
    ("back-center", 180),
    ("back-left",   225),
    ("left",        270),
    ("front-left",  315),
]

ELEVATION_MAP = {"up": 30, "normal": 0, "down": -30}
_REVIEW_DEFAULT_STEPS = 6
_PIPELINE_DEFAULT_STEPS = {"zimage": 9, "flux2-klein": 4}

# ---------------------------------------------------------------------------
# Manifest review constants
# ---------------------------------------------------------------------------

_PARAM_KEYS = [
    "pipeline", "steps", "width", "height", "seed",
    "denoise_strength", "lora_path", "lora_scale",
    "latent_upscale", "upscale", "upscale_method",
    # ControlNet-specific
    "controlnet_type", "controlnet_strength", "skip_preprocess", "blur_ref",
    "remove_outlines",
]


# ---------------------------------------------------------------------------
# Argument registration
# ---------------------------------------------------------------------------

def add_review_args(parser):
    """Register all review-mode arguments. --input (single) shared with add_angle_args."""
    # Angle grid args
    parser.add_argument(
        "--elevations",
        type=str,
        default="normal",
        metavar="LEVELS",
        help=(
            "Angle review: elevation levels — normal (default), up, down, all, "
            "or comma-separated e.g. 'up,normal'. normal=8 images, all=24 (3×8)."
        ),
    )
    # Manifest review args
    parser.add_argument(
        "--inputs", nargs="+", metavar="MANIFEST_JSON",
        help="Manifest review: .manifest.json paths (auto-finds paired .run.json + .png)",
    )
    parser.add_argument(
        "--labels", type=str, default=None,
        help="Manifest review: comma-separated card labels (default: A, B, C, …)",
    )
    parser.add_argument(
        "--last", type=int, default=None, metavar="N",
        help="Manifest review: use the last N image generation runs automatically",
    )
    parser.add_argument(
        "--output", type=str, default=None, metavar="PATH",
        help="Manifest review: output HTML path (default: auto-named in output/)",
    )


# ---------------------------------------------------------------------------
# Dispatcher
# ---------------------------------------------------------------------------

def run_review(args, sub: str = "manifest"):
    """Dispatch to angle / generation / manifest mode."""
    if sub == "angle":
        run_review_angle(args)
    elif sub == "generation":
        run_review_generation(args)
    else:
        run_review_manifest(args)


# ---------------------------------------------------------------------------
# Mode 1: Angle grid
# ---------------------------------------------------------------------------

def _parse_elevations(elevation_arg: str) -> list:
    if elevation_arg.strip().lower() == "all":
        return [("up", 30), ("normal", 0), ("down", -30)]
    order = {"up": 0, "normal": 1, "down": 2}
    names = [e.strip().lower() for e in elevation_arg.split(",")]
    result = []
    seen = set()
    for name in names:
        if name in ELEVATION_MAP and name not in seen:
            seen.add(name)
            result.append((name, ELEVATION_MAP[name]))
        elif name not in ELEVATION_MAP:
            print(f"WARNING: unknown elevation '{name}' (valid: up, normal, down, all)",
                  file=sys.stderr)
    if not result:
        result = [("normal", 0)]
    return sorted(result, key=lambda x: order.get(x[0], 99))


def run_review_angle(args):
    """Generate all angle views from --input reference image, then open HTML grid."""
    if not getattr(args, "input", None):
        print("ERROR: 'image review angle' requires --input IMAGE_PATH", file=sys.stderr)
        sys.exit(1)
    if not os.path.exists(args.input):
        print(f"ERROR: Input file not found: {args.input}", file=sys.stderr)
        sys.exit(1)

    steps = args.steps if args.steps is not None else _REVIEW_DEFAULT_STEPS
    seed = args.seed % (2 ** 32)
    elevations = _parse_elevations(getattr(args, "elevations", "normal"))

    user_prompt = getattr(args, "prompt", None)
    if getattr(args, "prompt_file", None):
        with open(args.prompt_file, "r") as f:
            user_prompt = f.read().strip()

    total = len(ANGLE_GRID) * len(elevations)
    print(f"Input:      {args.input}")
    print(f"Elevations: {', '.join(e[0] for e in elevations)}")
    print(f"Grid:       {len(ANGLE_GRID)} × {len(elevations)} = {total} images")
    print(f"Settings:   steps={steps}  seed={seed}  size={args.width}×{args.height}")

    ts = time.strftime("%Y%m%d_%H%M%S")
    review_dir = os.path.join(cfg.OUTPUT_DIR, f"image-review-angle-{ts}")
    os.makedirs(review_dir, exist_ok=True)

    from app.flux2_pipeline import Flux2KleinPipeline

    pipeline = Flux2KleinPipeline(
        model_path=getattr(args, "flux2_model_path", None),
        quantize=getattr(args, "quantize", None),
        variant=getattr(args, "variant", "9b"),
    )

    results = []
    done = 0

    for elev_name, elev_deg in elevations:
        for horiz_name, azimuth in ANGLE_GRID:
            done += 1
            angle_text = _angle_mod._angle_to_text(azimuth, elev_deg)
            prompt = _angle_mod._build_angle_prompt(user_prompt, angle_text)
            print(f"\n[{done}/{total}] {horiz_name} / {elev_name}  → {angle_text}")

            result = pipeline.generate(
                seed=seed,
                prompt=prompt,
                reference_images=[args.input],
                width=args.width,
                height=args.height,
                steps=steps,
            )

            fname = f"{horiz_name}_{elev_name}.png"
            out_path = os.path.join(review_dir, fname)
            result.image.save(out_path)
            print(f"  Saved: {fname}")

            results.append({
                "horizontal": horiz_name,
                "elevation": elev_name,
                "elevation_deg": elev_deg,
                "azimuth": azimuth,
                "angle_text": angle_text,
                "prompt": prompt,
                "rel_path": fname,
            })

    rel_dir = f"image-review-angle-{ts}"
    html_path = os.path.join(cfg.OUTPUT_DIR, f"image-review-angle-{ts}.html")
    html = _render_angle_html(results, elevations, args.input, rel_dir, ts)
    with open(html_path, "w", encoding="utf-8") as f:
        f.write(html)

    print(f"\nReview dir: {review_dir}/")
    print(f"HTML:       {html_path}")
    print(f"Total:      {total} images")
    subprocess.Popen(["open", html_path])


# ---------------------------------------------------------------------------
# Mode 2: Generation review
# ---------------------------------------------------------------------------

def run_review_generation(args):
    """Run T2I generation (optionally A/B test) then open manifest HTML review."""
    pipeline_type = getattr(args, "pipeline", "zimage")
    do_ab = getattr(args, "ab_test", False)

    if do_ab:
        # Generate with zimage
        args_z = copy.copy(args)
        if args_z.steps is None:
            args_z.steps = _PIPELINE_DEFAULT_STEPS["zimage"]
        print("\n" + "=" * 60)
        print("Generation Review — A/B Test: ZImage")
        print("=" * 60)
        manifest_z = execute_generation(RunConfig.from_args(args_z, "image"), "zimage")

        # Generate with flux2-klein
        args_f = copy.copy(args)
        if args_f.steps is None:
            args_f.steps = _PIPELINE_DEFAULT_STEPS["flux2-klein"]
        print("\n" + "=" * 60)
        print("Generation Review — A/B Test: Flux2 Klein")
        print("=" * 60)
        manifest_f = execute_generation(RunConfig.from_args(args_f, "image"), "flux2-klein")

        _open_manifest_review(
            [manifest_z, manifest_f],
            labels=["ZImage Turbo", "Flux2 Klein 9B"],
        )
    else:
        if args.steps is None:
            args.steps = _PIPELINE_DEFAULT_STEPS.get(pipeline_type, 9)
        manifest = execute_generation(RunConfig.from_args(args, "image"), pipeline_type)
        _open_manifest_review([manifest], labels=None)


# ---------------------------------------------------------------------------
# Mode 3: Manifest review (restored from review-image.py)
# ---------------------------------------------------------------------------

def run_review_manifest(args):
    """Build HTML review from existing .manifest.json files."""
    files = _resolve_files(args)
    if not files:
        print(
            "ERROR: no .manifest.json files found. "
            "Pass --inputs or use --last N.",
            file=sys.stderr,
        )
        sys.exit(1)

    labels = _make_labels(getattr(args, "labels", None), len(files))
    out_path = getattr(args, "output", None)
    _open_manifest_review(files, labels=labels, output=out_path)


# ---------------------------------------------------------------------------
# Shared manifest HTML helper
# ---------------------------------------------------------------------------

def _open_manifest_review(manifest_paths: list, labels=None, output=None,
                           auto_open: bool = True):
    """Load manifests → render HTML → open in browser."""
    tests = [_load_test(f) for f in manifest_paths]
    if isinstance(labels, list):
        for t, label in zip(tests, labels):
            t["label"] = label
    else:
        effective_labels = _make_labels(labels, len(tests))
        for t, label in zip(tests, effective_labels):
            t["label"] = label

    model_name = _detect_model(tests)
    out_dir = cfg.OUTPUT_DIR
    if not output:
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        output = os.path.join(out_dir, f"generation-review-{ts}.html")
    os.makedirs(os.path.dirname(os.path.abspath(output)), exist_ok=True)

    html = _render_manifest_html(tests, model_name, out_dir)
    with open(output, "w", encoding="utf-8") as f:
        f.write(html)

    print(f"[review] Generated: {output}")
    print(f"[review] Tests:     {len(tests)}")
    for t in tests:
        status = "✓" if t["status"] == "success" else "✗"
        img_name = os.path.basename(t["image_file"]) if t["image_file"] else "(no image)"
        print(f"  [{t['label']}] {status}  {img_name}")

    if auto_open:
        subprocess.Popen(["open", output])


def _resolve_files(args) -> list:
    if getattr(args, "last", None):
        candidates = sorted([
            os.path.join(cfg.OUTPUT_DIR, f)
            for f in os.listdir(cfg.OUTPUT_DIR)
            if f.endswith(".manifest.json")
        ])
        image_candidates = []
        for c in candidates:
            base = c.replace(".manifest.json", "")
            has_image = any(os.path.exists(base + ext) for ext in (".png", ".jpg", ".jpeg"))
            has_video = os.path.exists(base + ".mp4")
            if has_image and not has_video:
                image_candidates.append(c)
        return image_candidates[-args.last:]

    inputs = getattr(args, "inputs", None)
    if not inputs:
        return []

    result = []
    for f in inputs:
        if f.endswith(".manifest.json"):
            result.append(f)
        elif f.endswith(".run.json"):
            result.append(f.replace(".run.json", ".manifest.json"))
        else:
            result.append(f.rstrip("/") + ".manifest.json")
    return result


def _load_test(manifest_file: str) -> dict:
    base = manifest_file.replace(".manifest.json", "")
    run_file = base + ".run.json"

    run_data = {}
    manifest_data = {}

    if os.path.exists(manifest_file):
        with open(manifest_file) as f:
            manifest_data = json.load(f)
    else:
        print(f"  WARNING: not found: {manifest_file}", file=sys.stderr)

    if os.path.exists(run_file):
        with open(run_file) as f:
            run_data = json.load(f)

    image_file = None
    for of in manifest_data.get("output_files", []):
        p = of.get("path", "")
        if p.endswith((".png", ".jpg", ".jpeg")) and os.path.exists(p):
            image_file = p
            break
    if not image_file:
        for ext in (".png", ".jpg", ".jpeg"):
            if os.path.exists(base + ext):
                image_file = base + ext
                break

    image_rel = None
    if image_file:
        image_rel = os.path.relpath(image_file, cfg.OUTPUT_DIR)

    caption_file = base + ".caption.json"
    caption_data = None
    if os.path.exists(caption_file):
        try:
            with open(caption_file) as f:
                caption_data = json.load(f)
        except (json.JSONDecodeError, OSError):
            pass

    return {
        "run_file": run_file,
        "manifest_file": manifest_file,
        "run": run_data,
        "manifest": manifest_data,
        "image_file": image_file,
        "image_rel": image_rel,
        "caption": caption_data,
        "status": manifest_data.get("status", "unknown"),
        "elapsed": manifest_data.get("elapsed_seconds"),
        "memory_mb": manifest_data.get("memory_peak_mb"),
    }


def _make_labels(labels_arg, n: int) -> list:
    if labels_arg and isinstance(labels_arg, str):
        parts = [p.strip() for p in labels_arg.split(",")]
        if len(parts) >= n:
            return parts[:n]
    if isinstance(labels_arg, list) and len(labels_arg) >= n:
        return labels_arg[:n]
    return [chr(65 + i) for i in range(n)]


def _detect_model(tests: list) -> str:
    for t in tests:
        r = t["run"]
        pipeline = r.get("pipeline", "")
        if pipeline:
            return pipeline
        if r.get("command") in ("generate", "t2i", "image"):
            return "zimage"
    return "unknown"


# ---------------------------------------------------------------------------
# HTML renderer: angle grid
# ---------------------------------------------------------------------------

def _render_angle_html(results: list, elevations: list, input_path: str,
                       rel_dir: str, ts: str) -> str:
    horiz_positions = [h for h, _ in ANGLE_GRID]
    elev_names = [e[0] for e in elevations]

    cells_data = [{
        "horizontal": r["horizontal"],
        "elevation": r["elevation"],
        "azimuth": r["azimuth"],
        "elevation_deg": r["elevation_deg"],
        "angle_text": r["angle_text"],
        "prompt": r["prompt"],
        "src": f"{rel_dir}/{r['rel_path']}",
    } for r in results]

    cells_json = json.dumps(cells_data, ensure_ascii=False, indent=2)
    horiz_json = json.dumps(horiz_positions)
    elev_json = json.dumps(elev_names)
    input_name_json = json.dumps(os.path.basename(input_path))
    ts_json = json.dumps(ts)
    now = datetime.now().strftime("%Y-%m-%d %H:%M")
    input_name = os.path.basename(input_path)
    total = len(results)

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Angle Review — {input_name}</title>
<style>
  *, *::before, *::after {{ box-sizing: border-box; margin: 0; padding: 0; }}
  :root {{
    --bg: #0f0f0f; --bg2: #1a1a1a; --bg3: #242424;
    --border: #333; --text: #e0e0e0; --muted: #888;
    --accent: #4a9eff; --gold: #f5c842; --green: #4caf50; --red: #f44336;
    --radius: 6px;
  }}
  body {{ background: var(--bg); color: var(--text); font-family: system-ui, sans-serif;
         font-size: 13px; line-height: 1.4; padding-bottom: 180px; }}
  header {{ background: var(--bg2); border-bottom: 1px solid var(--border);
            padding: 14px 20px; position: sticky; top: 0; z-index: 100; }}
  header h1 {{ font-size: 16px; font-weight: 600; color: var(--accent); margin-bottom: 3px; }}
  header .meta {{ color: var(--muted); font-size: 12px; }}
  header .hint {{ color: #555; font-size: 11px; margin-top: 4px; }}
  .grid-wrap {{ overflow-x: auto; padding: 16px 20px; }}
  .grid-wrap th {{ cursor: grab; }}
  .grid-wrap.panning, .grid-wrap.panning * {{ cursor: grabbing !important; }}
  table {{ border-collapse: separate; border-spacing: 6px; }}
  th {{ color: var(--muted); font-size: 11px; font-weight: 600; text-align: center;
        padding: 4px 8px; white-space: nowrap; }}
  th.row-label {{ text-align: right; color: var(--accent); font-size: 12px; padding-right: 10px; }}
  .cell {{ position: relative; width: 176px; background: var(--bg2);
           border: 2px solid var(--border); border-radius: var(--radius);
           cursor: pointer; transition: border-color .15s; user-select: none; }}
  .cell:hover {{ border-color: var(--accent); }}
  .cell.selected {{ border-color: var(--gold); }}
  .cell-img {{ position: relative; overflow: hidden; }}
  .cell img {{ width: 100%; display: block; }}
  .cell-label {{ position: absolute; bottom: 0; left: 0; right: 0;
                 background: rgba(0,0,0,.72); color: #ccc; font-size: 10px;
                 padding: 3px 6px; text-align: center; pointer-events: none; }}
  .cell.selected .cell-label {{ background: rgba(160,120,0,.85); color: #fff; font-weight: 600; }}
  .comment-badge {{ position: absolute; top: 4px; right: 4px; font-size: 11px; pointer-events: none; }}
  .cell-stars {{ display: flex; justify-content: center; gap: 3px; padding: 4px 0 3px;
                 background: var(--bg3); border-top: 1px solid var(--border); }}
  .cell-stars .star {{ cursor: pointer; font-size: 13px; line-height: 1; color: #444;
                       transition: color .1s; user-select: none; }}
  .cell-stars .star.filled {{ color: var(--gold); }}
  .cell-comment-btn {{ width: 100%; padding: 3px 8px; background: var(--bg3);
                       border: none; border-top: 1px solid var(--border); color: #555;
                       font-size: 10px; cursor: pointer; text-align: left;
                       overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
                       transition: color .15s, background .15s; font-family: inherit; }}
  .cell-comment-btn:hover {{ color: var(--accent); background: var(--bg2); }}
  .cell-comment-btn.has-comment {{ color: #aaa; }}
  #comment-modal {{ display: none; position: fixed; inset: 0; z-index: 2000;
                    background: rgba(0,0,0,.75); align-items: center; justify-content: center; }}
  #comment-modal.open {{ display: flex; }}
  #comment-dialog {{ background: var(--bg2); border: 1px solid var(--border); border-radius: 10px;
                     padding: 20px; width: 420px; max-width: 90vw; box-shadow: 0 8px 40px rgba(0,0,0,.7); }}
  #comment-dialog-title {{ font-size: 13px; font-weight: 600; color: var(--accent); margin-bottom: 10px; }}
  #comment-input {{ width: 100%; height: 80px; background: var(--bg3); border: 1px solid var(--border);
                    border-radius: var(--radius); color: var(--text); font-size: 13px;
                    font-family: inherit; padding: 8px 10px; resize: vertical; }}
  #comment-input::placeholder {{ color: #555; }}
  #comment-dialog-btns {{ display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px; }}
  #lightbox {{ display: none; position: fixed; inset: 0; z-index: 1000;
               background: rgba(0,0,0,.93); flex-direction: column; }}
  #lightbox.open {{ display: flex; }}
  #lb-header {{ padding: 10px 20px; display: flex; align-items: center; gap: 16px;
                border-bottom: 1px solid var(--border); flex-shrink: 0; }}
  #lb-angle {{ font-size: 14px; font-weight: 600; color: var(--accent); }}
  #lb-prompt {{ font-size: 11px; color: var(--muted); max-width: 600px;
                overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-top: 2px; }}
  .zoom-controls {{ display: flex; gap: 4px; margin-left: auto; }}
  .zoom-btn {{ padding: 4px 12px; border-radius: 4px; background: var(--bg3);
               border: 1px solid var(--border); color: var(--muted); cursor: pointer;
               font-size: 12px; font-weight: 600; transition: all .15s; }}
  .zoom-btn.active {{ background: var(--accent); border-color: var(--accent); color: #fff; }}
  .close-btn {{ padding: 4px 12px; border-radius: 4px; background: transparent;
                border: 1px solid var(--border); color: var(--muted); cursor: pointer; font-size: 18px; line-height: 1; }}
  .close-btn:hover {{ border-color: var(--red); color: var(--red); }}
  #lb-body {{ flex: 1; overflow: auto; cursor: grab; min-height: 0; }}
  #lb-body.dragging {{ cursor: grabbing; }}
  #lb-inner {{ display: inline-flex; min-width: 100%; min-height: 100%;
               align-items: center; justify-content: center; }}
  #lb-img {{ display: block; }}
  #lb-feedback {{ padding: 10px 20px; border-top: 1px solid var(--border);
                  display: flex; gap: 12px; align-items: center; flex-shrink: 0;
                  background: var(--bg2); }}
  #lb-stars {{ display: flex; gap: 6px; }}
  #lb-stars .star {{ font-size: 24px; line-height: 1; color: #444; cursor: pointer;
                     transition: color .1s; user-select: none; }}
  #lb-stars .star.filled {{ color: var(--gold); }}
  #lb-comment {{ flex: 1; height: 48px; background: var(--bg3); border: 1px solid var(--border);
                 border-radius: var(--radius); color: var(--text); font-size: 12px;
                 font-family: inherit; padding: 6px 10px; resize: none; }}
  #lb-comment::placeholder {{ color: #555; }}
  #bottom {{ position: fixed; bottom: 0; left: 0; right: 0; background: var(--bg2);
             border-top: 1px solid var(--border); z-index: 200; }}
  #ft-bar {{ display: flex; align-items: center; gap: 12px; padding: 7px 20px;
             cursor: pointer; user-select: none; transition: background .15s; }}
  #ft-bar:hover {{ background: var(--bg3); }}
  #bottom.open #ft-bar {{ border-bottom: 1px solid var(--border); }}
  #ft-label {{ font-size: 12px; font-weight: 600; color: var(--accent); }}
  #ft-summary {{ font-size: 12px; color: var(--muted); }}
  #ft-arrow {{ margin-left: auto; font-size: 11px; color: var(--muted); }}
  #feedback-content {{ display: none; padding: 10px 20px 14px; }}
  #bottom.open #feedback-content {{ display: block; }}
  .row1 {{ display: flex; gap: 10px; align-items: center; }}
  #notes {{ flex: 1; height: 38px; background: var(--bg3); border: 1px solid var(--border);
            border-radius: var(--radius); color: var(--text); font-size: 12px;
            font-family: inherit; padding: 6px 10px; resize: none; }}
  #notes::placeholder {{ color: #555; }}
  .btn {{ padding: 7px 14px; border-radius: var(--radius); border: none; cursor: pointer;
          font-size: 12px; font-weight: 500; transition: opacity .15s; white-space: nowrap; }}
  .btn:hover {{ opacity: .85; }}
  .btn-primary {{ background: var(--accent); color: #fff; }}
  .btn-outline {{ background: transparent; border: 1px solid var(--border); color: var(--text); }}
  #selected-info {{ font-size: 12px; color: var(--muted); white-space: nowrap; min-width: 140px; }}
  #output-panel {{ display: none; margin-top: 10px; }}
  #output-panel.visible {{ display: block; }}
  #output-text {{ width: 100%; height: 110px; background: var(--bg3); border: 1px solid var(--border);
                  border-radius: var(--radius); color: var(--text); font-size: 12px;
                  font-family: 'SF Mono', 'Menlo', monospace; padding: 8px 10px; resize: vertical; }}
  .copy-row {{ display: flex; gap: 8px; margin-top: 6px; align-items: center; }}
  .copy-status {{ font-size: 12px; color: var(--green); opacity: 0; transition: opacity .3s; }}
  .copy-status.show {{ opacity: 1; }}
</style>
</head>
<body>
<header>
  <h1>Angle Review — {input_name}</h1>
  <div class="meta">{total} images &nbsp;·&nbsp; {now}</div>
  <div class="hint">Click → zoom &amp; rate &nbsp;·&nbsp; Double-click → mark preferred &nbsp;·&nbsp; 💬 button → add comment &nbsp;·&nbsp; Ctrl+Enter → save</div>
</header>
<div class="grid-wrap"><table id="grid-table"></table></div>
<div id="lightbox">
  <div id="lb-header">
    <div>
      <div id="lb-angle"></div>
      <div id="lb-prompt"></div>
    </div>
    <div class="zoom-controls">
      <button class="zoom-btn active" data-zoom="1" onclick="setZoom(1)">1×</button>
      <button class="zoom-btn" data-zoom="2" onclick="setZoom(2)">2×</button>
      <button class="zoom-btn" data-zoom="4" onclick="setZoom(4)">4×</button>
    </div>
    <button class="close-btn" onclick="closeLightbox()">✕</button>
  </div>
  <div id="lb-body"><div id="lb-inner"><img id="lb-img" src="" /></div></div>
  <div id="lb-feedback">
    <div id="lb-stars"></div>
    <textarea id="lb-comment" placeholder="Comment for this angle…"></textarea>
  </div>
</div>
<div id="comment-modal">
  <div id="comment-dialog">
    <div id="comment-dialog-title">Comment</div>
    <textarea id="comment-input" placeholder="Add a comment for this angle… (Ctrl+Enter to save)"></textarea>
    <div id="comment-dialog-btns">
      <button class="btn btn-outline" onclick="closeCommentModal()">Cancel</button>
      <button class="btn btn-primary" onclick="saveComment()">Save</button>
    </div>
  </div>
</div>
<div id="bottom">
  <div id="ft-bar" onclick="toggleFeedback()">
    <span id="ft-label">Feedback</span>
    <span id="ft-summary">0 selected</span>
    <span id="ft-arrow">▲</span>
  </div>
  <div id="feedback-content">
    <div class="row1">
      <span id="selected-info">0 selected</span>
      <textarea id="notes" placeholder="Overall notes (optional)…"></textarea>
      <button class="btn btn-primary" onclick="showExport('text')">Export Text</button>
      <button class="btn btn-outline" onclick="showExport('json')">Export JSON</button>
      <button class="btn btn-outline" onclick="clearAll()">Clear All</button>
    </div>
    <div id="output-panel">
      <textarea id="output-text" readonly></textarea>
      <div class="copy-row">
        <button class="btn btn-outline" onclick="copyOutput()">Copy</button>
        <span class="copy-status" id="copy-status">Copied!</span>
      </div>
    </div>
  </div>
</div>
<script>
const CELLS = {cells_json};
const HORIZ = {horiz_json};
const ELEV  = {elev_json};
const INPUT = {input_name_json};
const TS    = {ts_json};
const STORAGE_KEY = 'image-review-angle-' + TS;

let selected = new Set();
let ratings = {{}};
let comments = {{}};
const cellDivs = {{}};

try {{
  const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
  if (stored) {{
    if (Array.isArray(stored)) {{ stored.forEach(k => selected.add(k)); }}
    else {{
      if (stored.selected) stored.selected.forEach(k => selected.add(k));
      if (stored.ratings) ratings = stored.ratings;
      if (stored.comments) comments = stored.comments;
    }}
  }}
}} catch(e) {{}}

function save() {{
  try {{
    localStorage.setItem(STORAGE_KEY, JSON.stringify({{ selected: [...selected], ratings, comments }}));
  }} catch(e) {{}}
}}

function buildGrid() {{
  const table = document.getElementById('grid-table');
  const thead = document.createElement('thead');
  const hrow = document.createElement('tr');
  const c0 = document.createElement('th'); c0.className='row-label'; c0.textContent='↕ \\ ↔'; hrow.appendChild(c0);
  HORIZ.forEach(h => {{ const th=document.createElement('th'); th.textContent=h.replace(/-/g,'·'); hrow.appendChild(th); }});
  thead.appendChild(hrow); table.appendChild(thead);
  const tbody = document.createElement('tbody');
  ELEV.forEach(elev => {{
    const tr = document.createElement('tr');
    const labelTd = document.createElement('td');
    const lth = document.createElement('th'); lth.className='row-label'; lth.textContent=elev; labelTd.appendChild(lth); tr.appendChild(labelTd);
    HORIZ.forEach(horiz => {{
      const cell = CELLS.find(c => c.horizontal===horiz && c.elevation===elev);
      const td = document.createElement('td');
      if (cell) {{
        const key = horiz+'/'+elev;
        const div = document.createElement('div');
        div.className = 'cell'+(selected.has(key)?' selected':'');
        div.title = cell.angle_text;
        div.dataset.key = key;
        cellDivs[key] = div;

        const imgWrap = document.createElement('div');
        imgWrap.className = 'cell-img';
        const img = document.createElement('img');
        img.src = cell.src; img.loading = 'lazy'; img.alt = cell.angle_text;
        img.addEventListener('click', e => {{ if (e.shiftKey) toggleSelect(key,div); else openLightbox(cell, key); }});
        imgWrap.appendChild(img);
        const lbl = document.createElement('div');
        lbl.className = 'cell-label'; lbl.textContent = horiz+' · '+elev;
        imgWrap.appendChild(lbl);
        if ((comments[key]||'').trim()) {{
          const badge = document.createElement('span');
          badge.className = 'comment-badge'; badge.textContent = '💬';
          imgWrap.appendChild(badge);
        }}
        div.appendChild(imgWrap);

        const strip = document.createElement('div');
        strip.className = 'cell-stars'; strip.dataset.key = key;
        strip.addEventListener('dblclick', e => e.stopPropagation());
        for (let i=1; i<=5; i++) {{
          const s = document.createElement('span');
          s.className = 'star'+(ratings[key]>=i?' filled':'');
          s.textContent = '★';
          s.addEventListener('click', e => {{ e.stopPropagation(); setRating(key, i); }});
          strip.appendChild(s);
        }}
        div.appendChild(strip);

        const cBtn = document.createElement('button');
        cBtn.className = 'cell-comment-btn'+(( comments[key]||'').trim()?' has-comment':'');
        cBtn.dataset.key = key;
        cBtn.textContent = _commentBtnText(key);
        cBtn.addEventListener('click', e => {{ e.stopPropagation(); openCommentModal(key); }});
        cBtn.addEventListener('dblclick', e => e.stopPropagation());
        div.appendChild(cBtn);

        div.addEventListener('dblclick', () => toggleSelect(key,div));
        td.appendChild(div);
      }}
      tr.appendChild(td);
    }});
    tbody.appendChild(tr);
  }});
  table.appendChild(tbody); updateInfo();
}}

function toggleSelect(key,div) {{
  if (selected.has(key)) {{ selected.delete(key); div.classList.remove('selected'); }}
  else {{ selected.add(key); div.classList.add('selected'); }}
  updateInfo(); save();
}}

function setRating(key, n) {{
  ratings[key] = ratings[key]===n ? 0 : n;
  refreshCellStars(key);
  if (lbCurrentKey===key) refreshLbStars(key);
  updateInfo(); save();
}}

function refreshCellStars(key) {{
  const r = ratings[key]||0;
  const strip = document.querySelector('.cell-stars[data-key="'+key+'"]');
  if (strip) strip.querySelectorAll('.star').forEach((s,i) => s.classList.toggle('filled', r>=i+1));
}}

function refreshCommentBadge(key) {{
  const cellDiv = cellDivs[key]; if (!cellDiv) return;
  const imgWrap = cellDiv.querySelector('.cell-img'); if (!imgWrap) return;
  let badge = imgWrap.querySelector('.comment-badge');
  const has = (comments[key]||'').trim().length>0;
  if (has && !badge) {{
    badge = document.createElement('span'); badge.className='comment-badge'; badge.textContent='💬';
    imgWrap.appendChild(badge);
  }} else if (!has && badge) {{ badge.remove(); }}
  refreshCellCommentBtn(key);
}}

function _commentBtnText(key) {{
  const c = (comments[key]||'').trim();
  return c ? '💬 '+c.slice(0,28)+(c.length>28?'…':'') : '💬 Add comment';
}}

function refreshCellCommentBtn(key) {{
  const btn = document.querySelector('.cell-comment-btn[data-key="'+key+'"]');
  if (!btn) return;
  const c = (comments[key]||'').trim();
  btn.textContent = _commentBtnText(key);
  btn.classList.toggle('has-comment', c.length>0);
}}

let modalKey = null;

function openCommentModal(key) {{
  modalKey = key;
  const cell = CELLS.find(c => c.horizontal+'/'+c.elevation===key);
  document.getElementById('comment-dialog-title').textContent =
    (cell ? cell.angle_text : key) + ' — Comment';
  document.getElementById('comment-input').value = comments[key]||'';
  document.getElementById('comment-modal').classList.add('open');
  setTimeout(() => document.getElementById('comment-input').focus(), 50);
}}

function closeCommentModal() {{
  document.getElementById('comment-modal').classList.remove('open');
  modalKey = null;
}}

function saveComment() {{
  if (modalKey) {{
    comments[modalKey] = document.getElementById('comment-input').value;
    refreshCommentBadge(modalKey);
    if (lbCurrentKey===modalKey) document.getElementById('lb-comment').value = comments[modalKey]||'';
    save();
  }}
  closeCommentModal();
}}

document.getElementById('comment-input').addEventListener('keydown', e => {{
  if (e.key==='Escape') {{ e.preventDefault(); closeCommentModal(); }}
  if (e.key==='Enter' && e.ctrlKey) {{ e.preventDefault(); saveComment(); }}
}});
document.getElementById('comment-modal').addEventListener('click', e => {{
  if (e.target.id==='comment-modal') closeCommentModal();
}});

function updateInfo() {{
  const nSel = selected.size;
  const nRated = Object.keys(ratings).filter(k=>ratings[k]>0).length;
  let info = nSel===0?'0 selected':nSel+' selected';
  if (nRated>0) info += ' · '+nRated+' rated';
  document.getElementById('selected-info').textContent = info;
  document.getElementById('ft-summary').textContent = info;
}}

function toggleFeedback() {{
  const bottom = document.getElementById('bottom');
  bottom.classList.toggle('open');
  document.getElementById('ft-arrow').textContent = bottom.classList.contains('open') ? '▼' : '▲';
}}

function clearAll() {{
  selected.clear(); ratings={{}}; comments={{}};
  document.querySelectorAll('.cell.selected').forEach(el=>el.classList.remove('selected'));
  document.querySelectorAll('.cell-stars .star').forEach(s=>s.classList.remove('filled'));
  document.querySelectorAll('.comment-badge').forEach(b=>b.remove());
  document.querySelectorAll('.cell-comment-btn').forEach(b=>{{ b.textContent='💬 Add comment'; b.classList.remove('has-comment'); }});
  document.getElementById('lb-comment').value='';
  refreshLbStars(null);
  updateInfo(); save();
}}

let lbZoom=1, lbCurrentKey=null;

function openLightbox(cell, key) {{
  lbCurrentKey = key;
  document.getElementById('lb-angle').textContent = cell.angle_text;
  document.getElementById('lb-prompt').textContent = cell.prompt;
  const img=document.getElementById('lb-img'); img.src=cell.src; img.onload=()=>setZoom(1);
  refreshLbStars(key);
  document.getElementById('lb-comment').value = comments[key]||'';
  document.getElementById('lightbox').classList.add('open'); document.body.style.overflow='hidden';
}}

function refreshLbStars(key) {{
  const r = key ? (ratings[key]||0) : 0;
  document.querySelectorAll('#lb-stars .star').forEach((s,i) => s.classList.toggle('filled', r>=i+1));
}}

function closeLightbox() {{
  document.getElementById('lightbox').classList.remove('open'); document.body.style.overflow='';
}}

function setZoom(level) {{
  lbZoom=level; const img=document.getElementById('lb-img');
  if (img.naturalWidth) {{ img.style.width=Math.round(img.naturalWidth*level)+'px'; img.style.height=Math.round(img.naturalHeight*level)+'px'; }}
  document.querySelectorAll('.zoom-btn').forEach(b=>b.classList.toggle('active',parseFloat(b.dataset.zoom)===level));
}}

(function() {{
  const lbStarsEl = document.getElementById('lb-stars');
  for (let i=1; i<=5; i++) {{
    const s = document.createElement('span'); s.className='star'; s.textContent='★';
    s.addEventListener('mouseover', () => document.querySelectorAll('#lb-stars .star').forEach((el,j)=>el.classList.toggle('filled',j<i)));
    s.addEventListener('mouseout', () => refreshLbStars(lbCurrentKey));
    s.addEventListener('click', () => {{ if (lbCurrentKey) setRating(lbCurrentKey, i); }});
    lbStarsEl.appendChild(s);
  }}
}})();

document.getElementById('lb-comment').addEventListener('input', e => {{
  if (lbCurrentKey) {{
    comments[lbCurrentKey] = e.target.value;
    refreshCommentBadge(lbCurrentKey); save();
  }}
}});

document.getElementById('lightbox').addEventListener('click', e=>{{ if (['lightbox','lb-body','lb-inner'].includes(e.target.id)) closeLightbox(); }});
document.addEventListener('keydown', e=>{{ if (e.key==='Escape') closeLightbox(); }});

(function() {{
  let drag=false,sx,sy,sl,st;
  const body=()=>document.getElementById('lb-body');
  document.addEventListener('mousedown',e=>{{ const b=body(); if (!b||!b.contains(e.target)) return; drag=true; b.classList.add('dragging'); sx=e.clientX; sy=e.clientY; sl=b.scrollLeft; st=b.scrollTop; e.preventDefault(); }});
  document.addEventListener('mousemove',e=>{{ if (!drag) return; const b=body(); b.scrollLeft=sl-(e.clientX-sx); b.scrollTop=st-(e.clientY-sy); }});
  document.addEventListener('mouseup',()=>{{ if (!drag) return; drag=false; const b=body(); if(b) b.classList.remove('dragging'); }});
}})();

function showExport(format) {{
  const notes = document.getElementById('notes').value.trim();
  let output;
  if (format==='json') {{
    const cards = CELLS.map(cell => {{
      const key = cell.horizontal+'/'+cell.elevation;
      return {{
        key, angle: cell.angle_text,
        horizontal: cell.horizontal, elevation: cell.elevation,
        azimuth: cell.azimuth, elevation_deg: cell.elevation_deg,
        rating: ratings[key]||0, preferred: selected.has(key),
        comment: (comments[key]||'').trim(),
      }};
    }});
    output = JSON.stringify({{
      input: INPUT, timestamp: TS, total: CELLS.length,
      cards, overall_notes: notes,
    }}, null, 2);
  }} else {{
    const lines=['## Angle Review: '+INPUT,'Timestamp: '+TS,'Total: '+CELLS.length+' images',''];
    lines.push('### Card Feedback');
    CELLS.forEach(cell => {{
      const key = cell.horizontal+'/'+cell.elevation;
      const r = ratings[key]||0;
      const stars = '★'.repeat(r)+'☆'.repeat(5-r);
      const c = (comments[key]||'').trim();
      const sel = selected.has(key)?' [preferred]':'';
      lines.push('  '+key+sel+': '+stars+(c?'  "'+c+'"':''));
    }});
    if (notes) {{ lines.push('','### Overall Notes',notes); }}
    output = lines.join('\\n');
  }}
  document.getElementById('output-text').value=output;
  document.getElementById('output-panel').classList.add('visible');
  const bottom=document.getElementById('bottom');
  if (!bottom.classList.contains('open')) {{
    bottom.classList.add('open'); document.getElementById('ft-arrow').textContent='▼';
  }}
}}

function copyOutput() {{
  navigator.clipboard.writeText(document.getElementById('output-text').value).then(()=>{{
    const s=document.getElementById('copy-status'); s.classList.add('show'); setTimeout(()=>s.classList.remove('show'),2000);
  }});
}}

(function() {{
  let drag=false, sx, sl;
  const wrap = document.querySelector('.grid-wrap');
  wrap.addEventListener('mousedown', e => {{
    if (e.button!==0) return;
    if (e.target.closest('.cell')) return;
    drag=true; sx=e.clientX; sl=wrap.scrollLeft;
    wrap.classList.add('panning'); e.preventDefault();
  }});
  document.addEventListener('mousemove', e => {{
    if (!drag) return; wrap.scrollLeft = sl-(e.clientX-sx);
  }});
  document.addEventListener('mouseup', () => {{
    if (!drag) return; drag=false; wrap.classList.remove('panning');
  }});
}})();

buildGrid();
</script>
</body>
</html>"""


# ---------------------------------------------------------------------------
# HTML renderer: manifest cards (restored from review-image.py)
# ---------------------------------------------------------------------------

def _render_manifest_html(tests: list, model_name: str, out_dir: str) -> str:
    tests_js = []
    for t in tests:
        run = t["run"]
        mf = t["manifest"]
        out_files = mf.get("output_files", [])
        of = out_files[0] if out_files else {}

        params = {}
        for key in _PARAM_KEYS:
            if key in run and run[key] is not None:
                params[key] = run[key]
        if of.get("width"):
            params["out_width"] = of["width"]
        if of.get("height"):
            params["out_height"] = of["height"]

        timings = mf.get("timings", {})
        caption_text = ""
        if t["caption"]:
            caption_text = t["caption"].get("caption", "")

        prompt_text = run.get("prompt") or ""
        if not prompt_text:
            pf = run.get("prompt_file")
            if pf and os.path.isfile(pf):
                try:
                    with open(pf, "r") as f:
                        prompt_text = f.read().strip()
                except OSError:
                    pass
            elif pf:
                prompt_text = f"(prompt file not found: {pf})"

        tests_js.append({
            "label": t["label"],
            "status": t["status"],
            "image": t["image_rel"],
            "prompt": prompt_text,
            "command": run.get("command", ""),
            "action": run.get("action", ""),
            "params": params,
            "elapsed": t["elapsed"],
            "memory_mb": t["memory_mb"],
            "timings": timings,
            "caption": caption_text,
            "run_file": os.path.relpath(t["run_file"], out_dir),
            "manifest_file": (
                os.path.relpath(t["manifest_file"], out_dir)
                if os.path.exists(t["manifest_file"]) else None
            ),
        })

    tests_json = json.dumps(tests_js, indent=2, ensure_ascii=False)
    model_json = json.dumps(model_name)
    now = datetime.now().strftime("%Y-%m-%d %H:%M")

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Generation Review: {model_name}</title>
<style>
  *, *::before, *::after {{ box-sizing: border-box; margin: 0; padding: 0; }}
  :root {{
    --bg: #0f0f0f; --bg2: #1a1a1a; --bg3: #242424;
    --border: #333; --text: #e0e0e0; --muted: #888;
    --accent: #4a9eff; --gold: #f5c842; --green: #4caf50; --red: #f44336;
    --radius: 8px; --gap: 16px;
  }}
  body {{ background: var(--bg); color: var(--text); font-family: system-ui, sans-serif;
         font-size: 14px; line-height: 1.5; padding-bottom: 220px; }}
  header {{ background: var(--bg2); border-bottom: 1px solid var(--border);
            padding: 16px 24px; position: sticky; top: 0; z-index: 100; }}
  header h1 {{ font-size: 18px; font-weight: 600; color: var(--accent); }}
  header .meta {{ color: var(--muted); font-size: 12px; margin-top: 4px; }}
  header .prompt-box {{ margin-top: 10px; background: var(--bg3); border: 1px solid var(--border);
                        border-radius: var(--radius); padding: 10px 14px; font-size: 13px;
                        color: #ccc; max-height: 80px; overflow-y: auto; }}
  #grid {{ display: flex; gap: var(--gap); padding: var(--gap) 20px;
           overflow-x: auto; align-items: flex-start; }}
  .card {{ flex: 0 0 360px; background: var(--bg2); border: 2px solid var(--border);
           border-radius: var(--radius); overflow: hidden; transition: border-color .2s; }}
  .card.winner {{ border-color: var(--gold); }}
  .card-header {{ display: flex; align-items: center; gap: 10px;
                  padding: 10px 14px; background: var(--bg3); border-bottom: 1px solid var(--border); }}
  .card-header .label {{ font-size: 20px; font-weight: 700; color: var(--accent); width: 28px; }}
  .card-header .badge {{ font-size: 11px; padding: 2px 8px; border-radius: 12px;
                         background: var(--bg); border: 1px solid var(--border); color: var(--muted); }}
  .card-header .badge.success {{ border-color: var(--green); color: var(--green); }}
  .card-header .badge.error {{ border-color: var(--red); color: var(--red); }}
  .winner-btn {{ margin-left: auto; font-size: 11px; padding: 3px 10px; border-radius: 12px;
                 background: transparent; border: 1px solid var(--border); color: var(--muted);
                 cursor: pointer; transition: all .15s; }}
  .winner-btn:hover {{ border-color: var(--gold); color: var(--gold); }}
  .card.winner .winner-btn {{ background: var(--gold); color: #000; border-color: var(--gold); }}
  .image-wrap {{ position: relative; background: #111; cursor: zoom-in; }}
  .image-wrap img {{ width: 100%; display: block; max-height: 480px; object-fit: contain; }}
  .no-image {{ height: 200px; display: flex; align-items: center; justify-content: center;
               color: var(--muted); font-size: 13px; }}
  #lightbox {{ display: none; position: fixed; inset: 0; z-index: 1000;
               background: rgba(0,0,0,.92); flex-direction: column; }}
  #lightbox.open {{ display: flex; }}
  #lb-header {{ padding: 10px 20px; display: flex; align-items: center; gap: 16px;
                border-bottom: 1px solid var(--border); flex-shrink: 0; }}
  #lb-header .lb-label {{ font-size: 16px; font-weight: 700; color: var(--accent); }}
  .zoom-controls {{ display: flex; gap: 4px; margin-left: auto; }}
  .zoom-btn {{ padding: 4px 14px; border-radius: 4px; background: var(--bg3);
               border: 1px solid var(--border); color: var(--muted); cursor: pointer;
               font-size: 13px; font-weight: 600; transition: all .15s; }}
  .zoom-btn:hover {{ border-color: var(--text); color: var(--text); }}
  .zoom-btn.active {{ background: var(--accent); border-color: var(--accent); color: #fff; }}
  .close-btn {{ padding: 4px 12px; border-radius: 4px; background: transparent;
                border: 1px solid var(--border); color: var(--muted); cursor: pointer;
                font-size: 18px; line-height: 1; }}
  .close-btn:hover {{ border-color: var(--red); color: var(--red); }}
  #lb-body {{ flex: 1; overflow: auto; cursor: grab; }}
  #lb-body.dragging {{ cursor: grabbing; }}
  #lb-inner {{ display: inline-flex; min-width: 100%; min-height: 100%;
               align-items: center; justify-content: center; }}
  #lb-img {{ display: block; }}
  .card-prompt {{ padding: 8px 14px; border-bottom: 1px solid var(--border);
                  font-size: 12px; color: #aaa; line-height: 1.4;
                  max-height: 80px; overflow-y: auto; word-break: break-word; }}
  .card-prompt .prompt-label {{ color: var(--muted); font-weight: 600; margin-right: 4px; }}
  .caption-section {{ border-bottom: 1px solid var(--border); }}
  .caption-section summary {{ padding: 8px 14px; font-size: 12px; color: var(--muted);
                               cursor: pointer; user-select: none; }}
  .caption-section summary:hover {{ color: var(--text); }}
  .caption-section p {{ padding: 0 14px 10px; font-size: 12px; color: #aaa; line-height: 1.4; }}
  .params {{ padding: 10px 14px; border-bottom: 1px solid var(--border); }}
  .params table {{ width: 100%; border-collapse: collapse; }}
  .params td {{ padding: 2px 0; vertical-align: top; }}
  .params td:first-child {{ color: var(--muted); width: 50%; padding-right: 8px; }}
  .params td.diff {{ color: var(--gold); font-weight: 600; }}
  .timing {{ padding: 6px 14px; border-bottom: 1px solid var(--border);
             font-size: 12px; color: var(--muted); display: flex; gap: 16px; flex-wrap: wrap; }}
  .timing span b {{ color: var(--text); }}
  .rating-row {{ padding: 10px 14px; display: flex; align-items: center; gap: 10px;
                 border-bottom: 1px solid var(--border); }}
  .stars {{ display: flex; gap: 3px; cursor: pointer; }}
  .star {{ font-size: 22px; color: #444; transition: color .1s; user-select: none; }}
  .star.on {{ color: var(--gold); }}
  .rating-label {{ font-size: 12px; color: var(--muted); }}
  .comment {{ padding: 10px 14px; }}
  .comment textarea {{ width: 100%; height: 72px; background: var(--bg3);
                       border: 1px solid var(--border); border-radius: 4px;
                       color: var(--text); font-size: 12px; font-family: inherit;
                       padding: 6px 8px; resize: vertical; }}
  .comment textarea:focus {{ outline: none; border-color: var(--accent); }}
  .comment textarea::placeholder {{ color: #555; }}
  #bottom {{ position: fixed; bottom: 0; left: 0; right: 0; background: var(--bg2);
             border-top: 1px solid var(--border); padding: 14px 20px; z-index: 200; }}
  #bottom .row1 {{ display: flex; gap: 10px; align-items: flex-start; }}
  #bottom textarea {{ flex: 1; height: 56px; background: var(--bg3); border: 1px solid var(--border);
                      border-radius: var(--radius); color: var(--text); font-size: 13px;
                      font-family: inherit; padding: 8px 12px; resize: none; }}
  #bottom textarea::placeholder {{ color: #555; }}
  .btn {{ padding: 8px 16px; border-radius: var(--radius); border: none; cursor: pointer;
          font-size: 13px; font-weight: 500; transition: opacity .15s; }}
  .btn:hover {{ opacity: .85; }}
  .btn-primary {{ background: var(--accent); color: #fff; }}
  .btn-outline {{ background: transparent; border: 1px solid var(--border); color: var(--text); }}
  .btn-group {{ display: flex; flex-direction: column; gap: 6px; }}
  #output-panel {{ display: none; margin-top: 12px; }}
  #output-panel.visible {{ display: block; }}
  #output-tabs {{ display: flex; gap: 4px; margin-bottom: 8px; }}
  .tab {{ padding: 5px 14px; border-radius: 4px; background: var(--bg3);
          border: 1px solid var(--border); cursor: pointer; font-size: 12px; color: var(--muted); }}
  .tab.active {{ background: var(--accent); border-color: var(--accent); color: #fff; }}
  #output-text {{ width: 100%; height: 140px; background: var(--bg3); border: 1px solid var(--border);
                  border-radius: var(--radius); color: var(--text); font-size: 12px;
                  font-family: 'SF Mono', 'Menlo', monospace; padding: 10px 12px;
                  resize: vertical; }}
  .copy-row {{ display: flex; gap: 8px; margin-top: 8px; align-items: center; }}
  .copy-status {{ font-size: 12px; color: var(--green); opacity: 0; transition: opacity .3s; }}
  .copy-status.show {{ opacity: 1; }}
</style>
</head>
<body>
<header>
  <h1>&#127912; Generation Review — {model_name}</h1>
  <div class="meta">Generated {now} &nbsp;·&nbsp; <span id="test-count"></span> tests</div>
  <div class="prompt-box" id="shared-prompt"></div>
</header>
<div id="grid"></div>
<div id="lightbox">
  <div id="lb-header">
    <span class="lb-label" id="lb-label"></span>
    <div class="zoom-controls">
      <button class="zoom-btn active" data-zoom="1" onclick="setZoom(1)">1×</button>
      <button class="zoom-btn" data-zoom="2" onclick="setZoom(2)">2×</button>
      <button class="zoom-btn" data-zoom="4" onclick="setZoom(4)">4×</button>
    </div>
    <button class="close-btn" onclick="closeLightbox()">✕</button>
  </div>
  <div id="lb-body"><div id="lb-inner"><img id="lb-img" src="" /></div></div>
</div>
<div id="bottom">
  <div class="row1">
    <textarea id="overall-notes" placeholder="Overall notes (optional) — appears in generated feedback…"></textarea>
    <div class="btn-group">
      <button class="btn btn-primary" onclick="showOutput('plain')">Generate Feedback</button>
      <button class="btn btn-outline" onclick="showOutput('json')">JSON</button>
    </div>
  </div>
  <div id="output-panel">
    <div id="output-tabs">
      <div class="tab active" onclick="switchTab('plain')">Plain Text</div>
      <div class="tab" onclick="switchTab('json')">JSON</div>
    </div>
    <textarea id="output-text" readonly></textarea>
    <div class="copy-row">
      <button class="btn btn-outline" onclick="copyOutput()">Copy</button>
      <button class="btn btn-outline" onclick="downloadOutput()">Download</button>
      <span class="copy-status" id="copy-status">Copied!</span>
    </div>
  </div>
</div>
<script>
const TESTS = {tests_json};
const MODEL = {model_json};
const STORAGE_KEY = 'review_gen_' + MODEL + '_' + TESTS.map(t=>t.label).join('');
let state = {{ ratings: {{}}, comments: {{}}, winner: null, notes: '' }};
let currentTab = 'plain';
function loadState() {{ try {{ const s=localStorage.getItem(STORAGE_KEY); if(s) state={{...state,...JSON.parse(s)}}; }} catch(e) {{}} }}
function saveState() {{ try {{ localStorage.setItem(STORAGE_KEY,JSON.stringify(state)); }} catch(e) {{}} }}

function renderAll() {{
  document.getElementById('test-count').textContent=TESTS.length;
  const prompt=TESTS.map(t=>t.prompt).find(p=>p)||'(no prompt)';
  document.getElementById('shared-prompt').textContent=prompt;
  const grid=document.getElementById('grid'); grid.innerHTML='';
  TESTS.forEach((t,i)=>grid.appendChild(makeCard(t,i)));
  document.getElementById('overall-notes').value=state.notes||'';
  document.getElementById('overall-notes').addEventListener('input',e=>{{ state.notes=e.target.value; saveState(); }});
}}

function makeCard(t,i) {{
  const card=document.createElement('div');
  card.className='card'+(state.winner===t.label?' winner':'');
  card.id='card-'+i;
  card.appendChild(div('card-header',`<div class="label">${{t.label}}</div><div class="badge ${{t.status}}">${{t.status}}</div><button class="winner-btn" onclick="toggleWinner('${{t.label}}',${{i}})">★ Best</button>`));
  const wrap=document.createElement('div'); wrap.className='image-wrap';
  if (t.image) {{
    const img=document.createElement('img'); img.src=t.image; img.alt='Test '+t.label; img.loading='lazy';
    img.addEventListener('click',()=>openLightbox(t.image,t.label)); wrap.appendChild(img);
  }} else {{ wrap.innerHTML='<div class="no-image">No image file</div>'; }}
  card.appendChild(wrap);
  const pd=div('card-prompt'); pd.innerHTML='<span class="prompt-label">Prompt:</span> '+escapeHtml(t.prompt||'(no prompt)'); card.appendChild(pd);
  if (t.caption) {{ const det=document.createElement('details'); det.className='caption-section'; det.innerHTML=`<summary>VLM Caption</summary><p>${{escapeHtml(t.caption)}}</p>`; card.appendChild(det); }}
  const ref=TESTS[0].params;
  const rows=Object.entries(t.params).map(([k,v])=>{{ const isDiff=i>0&&JSON.stringify(ref[k])!==JSON.stringify(v); return `<tr><td>${{k}}</td><td class="${{isDiff?'diff':''}}">${{v}}</td></tr>`; }}).join('');
  card.appendChild(div('params','<table>'+rows+'</table>'));
  const elapsed=t.elapsed?t.elapsed.toFixed(1)+'s':'—';
  const mem=t.memory_mb?(t.memory_mb/1024).toFixed(1)+' GB':'—';
  const pipeline=(t.action||t.command||'').replace(/^(image|video)$/,t.params.pipeline||'$1');
  const pipelineText=pipeline?`<span>Pipeline <b>${{pipeline}}</b></span>`:'';
  const sizeText=t.params.out_width&&t.params.out_height?`<span>Size <b>${{t.params.out_width}}×${{t.params.out_height}}</b></span>`:'';
  card.appendChild(div('timing',`${{pipelineText}}<span>Time <b>${{elapsed}}</b></span><span>Peak RAM <b>${{mem}}</b></span>${{sizeText}}`));
  const ratingRow=document.createElement('div'); ratingRow.className='rating-row';
  const stars=document.createElement('div'); stars.className='stars'; stars.id='stars-'+i;
  for (let s=1;s<=5;s++) {{
    const star=document.createElement('span'); star.className='star'+(s<=(state.ratings[t.label]||0)?' on':''); star.textContent='★'; star.dataset.s=s;
    star.addEventListener('click',()=>setRating(t.label,i,s)); stars.appendChild(star);
  }}
  const rl=document.createElement('span'); rl.className='rating-label'; rl.id='rating-label-'+i; rl.textContent=ratingLabel(state.ratings[t.label]||0);
  ratingRow.append(stars,rl); card.appendChild(ratingRow);
  const cmtWrap=div('comment'); const cmt=document.createElement('textarea');
  cmt.placeholder='Notes for test '+t.label+'…'; cmt.value=state.comments[t.label]||'';
  cmt.addEventListener('input',e=>{{ state.comments[t.label]=e.target.value; saveState(); }}); cmtWrap.appendChild(cmt); card.appendChild(cmtWrap);
  return card;
}}
function div(cls,html='') {{ const el=document.createElement('div'); el.className=cls; el.innerHTML=html; return el; }}
function escapeHtml(s) {{ return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }}

let currentZoom=1;
function openLightbox(src,label) {{
  document.getElementById('lb-label').textContent='Test '+label;
  const img=document.getElementById('lb-img'); img.src=src;
  img.onload=()=>setZoom(1);
  document.getElementById('lightbox').classList.add('open'); document.body.style.overflow='hidden';
}}
function closeLightbox() {{ document.getElementById('lightbox').classList.remove('open'); document.body.style.overflow=''; }}
function setZoom(level) {{
  currentZoom=level; const img=document.getElementById('lb-img');
  if (img.naturalWidth) {{ img.style.width=Math.round(img.naturalWidth*level)+'px'; img.style.height=Math.round(img.naturalHeight*level)+'px'; }}
  document.querySelectorAll('.zoom-btn').forEach(b=>b.classList.toggle('active',parseFloat(b.dataset.zoom)===level));
}}
document.getElementById('lightbox').addEventListener('click',e=>{{ if (e.target.id==='lightbox'||e.target.id==='lb-body') closeLightbox(); }});
document.addEventListener('keydown',e=>{{ if (e.key==='Escape') closeLightbox(); }});
(function() {{
  let dragging=false,startX,startY,scrollLeft,scrollTop;
  document.addEventListener('mousedown',e=>{{ const body=document.getElementById('lb-body'); if (!body) return; if (!body.contains(e.target)&&e.target!==body) return; dragging=true; body.classList.add('dragging'); startX=e.clientX; startY=e.clientY; scrollLeft=body.scrollLeft; scrollTop=body.scrollTop; e.preventDefault(); }});
  document.addEventListener('mousemove',e=>{{ if (!dragging) return; const body=document.getElementById('lb-body'); body.scrollLeft=scrollLeft-(e.clientX-startX); body.scrollTop=scrollTop-(e.clientY-startY); }});
  document.addEventListener('mouseup',()=>{{ if (!dragging) return; dragging=false; const body=document.getElementById('lb-body'); if(body) body.classList.remove('dragging'); }});
}})();

function setRating(label,i,stars) {{
  state.ratings[label]=stars; saveState();
  document.getElementById('stars-'+i).querySelectorAll('.star').forEach((s,idx)=>s.classList.toggle('on',idx<stars));
  document.getElementById('rating-label-'+i).textContent=ratingLabel(stars);
}}
function ratingLabel(n) {{ return ['','Poor','Fair','Good','Great','Perfect'][n]||''; }}
function toggleWinner(label,i) {{
  state.winner=state.winner===label?null:label; saveState();
  document.querySelectorAll('.card').forEach((c,idx)=>c.classList.toggle('winner',TESTS[idx].label===state.winner));
}}

function generatePlain() {{
  const lines=['## Generation Review: '+MODEL,'Date: '+new Date().toISOString().slice(0,16).replace('T',' ')];
  const prompt=TESTS.map(t=>t.prompt).find(p=>p)||'';
  if (prompt) lines.push('Prompt: "'+prompt+'"');
  lines.push(TESTS.length+' tests compared');
  if (state.winner) lines.push('Winner: Test '+state.winner);
  lines.push('');
  TESTS.forEach(t=>{{
    const r=state.ratings[t.label]||0;
    const stars='★'.repeat(r)+'☆'.repeat(5-r);
    const winner=state.winner===t.label?' ← WINNER':'';
    lines.push(`[${{t.label}}] ${{stars}}${{winner}}`);
    const pStr=Object.entries(t.params).filter(([k])=>!k.startsWith('out_')).map(([k,v])=>`${{k}}=${{v}}`).join(', ');
    lines.push('Params: '+pStr);
    if (t.elapsed) lines.push('Time: '+t.elapsed.toFixed(1)+'s');
    const c=state.comments[t.label]; if (c&&c.trim()) lines.push('Notes: '+c.trim());
    lines.push('');
  }});
  if (state.winner) {{ const w=TESTS.find(t=>t.label===state.winner); if(w) {{ lines.push('### Recommended Parameters'); Object.entries(w.params).forEach(([k,v])=>lines.push(k+': '+v)); lines.push(''); }} }}
  if (state.notes&&state.notes.trim()) {{ lines.push('### Overall Notes'); lines.push(state.notes.trim()); lines.push(''); }}
  return lines.join('\\n');
}}
function generateJSON() {{
  return JSON.stringify({{
    review_type:'generation-review',model:MODEL,date:new Date().toISOString(),
    prompt:TESTS.map(t=>t.prompt).find(p=>p)||'',winner:state.winner,
    tests:TESTS.map(t=>({{label:t.label,status:t.status,params:t.params,elapsed_seconds:t.elapsed,rating:state.ratings[t.label]||0,comment:state.comments[t.label]||'',is_winner:t.label===state.winner}})),
    overall_notes:state.notes||'',recommended_params:state.winner?(TESTS.find(t=>t.label===state.winner)||{{}}).params||{{}}:{{}},
  }},null,2);
}}
function showOutput(tab) {{ currentTab=tab; document.getElementById('output-panel').classList.add('visible'); updateOutput(); }}
function switchTab(tab) {{
  currentTab=tab;
  document.querySelectorAll('.tab').forEach(el=>el.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(el=>{{ if (el.textContent.toLowerCase().includes(tab)) el.classList.add('active'); }});
  updateOutput();
}}
function updateOutput() {{ document.getElementById('output-text').value=currentTab==='json'?generateJSON():generatePlain(); }}
function copyOutput() {{
  navigator.clipboard.writeText(document.getElementById('output-text').value).then(()=>{{
    const s=document.getElementById('copy-status'); s.classList.add('show'); setTimeout(()=>s.classList.remove('show'),2000);
  }});
}}
function downloadOutput() {{
  const text=document.getElementById('output-text').value;
  const ext=currentTab==='json'?'json':'txt';
  const fname='generation-review-'+MODEL+'-'+new Date().toISOString().slice(0,10)+'.'+ext;
  const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([text],{{type:'text/plain'}})); a.download=fname; a.click();
}}
loadState(); renderAll();
</script>
</body>
</html>"""
