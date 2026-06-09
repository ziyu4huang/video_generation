"""image-review — multi-mode review sub-action for 'run.py image review'.

Modes (dispatched by image.py):
  angle       — generate all camera-angle views from a reference image → HTML grid
  generation  — run T2I generation (optional A/B test) → HTML manifest review
  manifest    — render HTML review from existing .manifest.json files (default)
  vae         — generate with multiple VAE variants, analyze quality, render HTML
  lora        — LoRA A/B test: multi-seed paired comparison with HTML voting review
  anime2real  — anime2real Ref+LoRA self-test with cross-pipeline HTML review

Public API:
  add_review_args(parser)          — register all review CLI arguments
  run_review(args, sub)            — dispatcher → angle / generation / manifest / vae / lora / anime2real
  run_review_angle(args)           — angle grid mode
  run_review_generation(args)      — T2I generation + manifest review
  run_review_manifest(args)        — manifest HTML review
  run_review_vae(args)             — VAE comparison: generate + quality + HTML
  run_review_lora(args)            — LoRA A/B: baseline vs adapter, multi-seed HTML review
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
    parser.add_argument(
        "--auto-score", action="store_true", default=False,
        help=(
            "Auto-generate VLM quality scores for images lacking .caption.json "
            "(requires Qwen3-VL API at localhost:1234; silently skipped if unavailable)"
        ),
    )
    # LoRA review args
    parser.add_argument(
        "--seeds", type=str, default=None,
        help="LoRA review: comma-separated seed list (e.g. '42,123,777,999'; "
             "default: from test config or '42,123,777,999')",
    )
    parser.add_argument(
        "--no-quality", action="store_true", default=False,
        help="LoRA review: skip image quality analysis (on by default; use this flag to opt-out)",
    )


# ---------------------------------------------------------------------------
# Dispatcher
# ---------------------------------------------------------------------------

def run_review(args, sub: str = "manifest"):
    """Dispatch to angle / generation / manifest / vae / selftest mode."""
    # Any --self-test value on the review action routes to the unified dispatcher,
    # unless the explicit sub-action is vae/angle/generation (which handle it themselves).
    self_test = getattr(args, "self_test", None)
    if isinstance(self_test, str) and sub not in ("vae", "angle", "generation"):
        run_review_selftest(args)
        return

    if sub == "angle":
        run_review_angle(args)
    elif sub == "generation":
        run_review_generation(args)
    elif sub == "vae":
        run_review_vae(args)
    elif sub == "lora":
        run_review_lora(args)
    elif sub == "selftest":
        run_review_selftest(args)
    elif sub == "anime2real":
        run_review_selftest(args)
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
        transformer_name=getattr(args, "transformer", "klein-9b"),
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
    auto_score = getattr(args, "auto_score", False)
    _open_manifest_review(files, labels=labels, output=out_path, auto_score=auto_score)


# ---------------------------------------------------------------------------
# Shared manifest HTML helper
# ---------------------------------------------------------------------------

def _open_manifest_review(manifest_paths: list, labels=None, output=None,
                           auto_open: bool = True, auto_score: bool = False):
    """Load manifests → optionally auto-score → render HTML → open in browser."""
    tests = [_load_test(f) for f in manifest_paths]
    if isinstance(labels, list):
        for t, label in zip(tests, labels):
            t["label"] = label
    else:
        effective_labels = _make_labels(labels, len(tests))
        for t, label in zip(tests, effective_labels):
            t["label"] = label

    # Auto-score images that lack a .caption.json
    if auto_score:
        for t in tests:
            if t["caption"] is None and t["image_file"]:
                scored = _auto_score_image(t["image_file"])
                if scored:
                    t["caption"] = scored
                    # Re-parse scores immediately
                    t["caption_scores"] = _parse_caption_scores(scored)

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
        score_tag = f" score={t['caption_scores']['overall']}" if t.get("caption_scores") else ""
        print(f"  [{t['label']}] {status}  {img_name}{score_tag}")

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

    caption_scores = _parse_caption_scores(caption_data)

    return {
        "run_file": run_file,
        "manifest_file": manifest_file,
        "run": run_data,
        "manifest": manifest_data,
        "image_file": image_file,
        "image_rel": image_rel,
        "caption": caption_data,
        "caption_scores": caption_scores,
        "status": manifest_data.get("status", "unknown"),
        "elapsed": manifest_data.get("elapsed_seconds"),
        "memory_mb": manifest_data.get("memory_peak_mb"),
    }


def _parse_caption_scores(caption_data: dict | None) -> dict | None:
    """Extract structured score dict from caption data.

    Handles two styles:
      style="score"          — standard quality scoring (6 numeric dimensions)
      style="profile-verify" — view-angle verification (4 booleans + score)
    """
    if not caption_data:
        return None
    style = caption_data.get("style")
    if style == "score":
        raw = caption_data.get("caption", "")
        try:
            parsed = json.loads(raw) if isinstance(raw, str) else raw
            if isinstance(parsed, dict) and "overall" in parsed:
                return parsed
        except (json.JSONDecodeError, TypeError):
            pass
    elif style == "profile-verify":
        raw = caption_data.get("caption", {})
        if isinstance(raw, dict) and "view_correct" in raw:
            return {
                "overall": raw.get("score", 0),
                "view_correct": raw.get("view_correct"),
                "full_body": raw.get("full_body"),
                "apose": raw.get("apose"),
                "clean_bg": raw.get("clean_bg"),
                "issues": raw.get("issues", []),
                "summary": raw.get("summary", ""),
                "_style": "profile-verify",
            }
    return None


def _auto_score_image(image_file: str) -> dict | None:
    """Call Qwen3-VL with style=score, save .caption.json, return data dict.

    Silently skips if the VLM API is unavailable (connection refused / timeout).
    """
    try:
        from app.commands.caption import _image_to_base64, _call_vlm, _STYLE_PROMPTS, _LANG_INSTRUCTIONS
        print(f"  [auto-score] scoring {os.path.basename(image_file)}...", end=" ", flush=True)
        b64 = _image_to_base64(image_file)
        prompt = _STYLE_PROMPTS["score"] + "\n" + _LANG_INSTRUCTIONS["en"]
        raw = _call_vlm("http://localhost:1234/v1", "qwen/qwen3-vl-4b", b64, prompt)
        data = {
            "image": image_file,
            "style": "score",
            "model": "qwen/qwen3-vl-4b",
            "caption": raw,
        }
        caption_path = os.path.splitext(image_file)[0] + ".caption.json"
        with open(caption_path, "w") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        print("done")
        return data
    except Exception as e:
        print(f"skipped ({type(e).__name__})")
        return None


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
            raw_cap = t["caption"].get("caption", "")
            # For score-style captions, show the summary line instead of raw JSON
            scores = t.get("caption_scores")
            if scores and isinstance(scores, dict):
                caption_text = scores.get("summary", raw_cap)
            else:
                caption_text = raw_cap

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
            "caption_scores": t.get("caption_scores"),
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
  .score-section {{ padding: 8px 14px; border-bottom: 1px solid var(--border); }}
  .sc-title {{ font-size: 11px; font-weight: 600; color: var(--muted); text-transform: uppercase;
               letter-spacing: .05em; margin-bottom: 6px; }}
  .sc-row {{ display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }}
  .sc-lbl {{ font-size: 11px; color: var(--muted); width: 90px; flex-shrink: 0; }}
  .sc-bar {{ flex: 1; height: 6px; background: var(--bg3); border-radius: 3px; overflow: hidden; }}
  .sc-bar div {{ height: 100%; border-radius: 3px; transition: width .3s; }}
  .sc-val {{ font-size: 11px; font-weight: 600; color: var(--text); width: 28px; text-align: right; }}
  .sc-issues {{ font-size: 11px; color: var(--muted); margin-top: 4px; font-style: italic; }}
  .vc-section {{ padding: 8px 14px; border-bottom: 1px solid var(--border); }}
  .vc-row {{ display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 4px; }}
  .vc-badge {{ font-size: 11px; font-weight: 600; padding: 2px 7px; border-radius: 3px; }}
  .vc-ok  {{ background: #1b3a1b; color: #4caf50; }}
  .vc-err {{ background: #3a1b1b; color: #f44336; }}
  .vc-unk {{ background: #2a2a2a; color: #888; }}
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
  if (t.caption_scores && t.caption_scores.overall != null) {{
    if (t.caption_scores._style === 'profile-verify') {{
      const checks=[['view_correct','View angle'],['full_body','Full body'],['apose','A-pose'],['clean_bg','Clean BG']];
      const badges=checks.map(([k,lbl])=>{{
        const ok=t.caption_scores[k];
        const icon=ok===true?'✓':ok===false?'✗':'?';
        const cls=ok===true?'vc-ok':ok===false?'vc-err':'vc-unk';
        return `<span class="vc-badge ${{cls}}">${{icon}} ${{lbl}}</span>`;
      }}).join('');
      const score=t.caption_scores.overall??'';
      const scoreTag=score?`<span class="vc-badge" style="background:#1a2a3a;color:#4a9eff">Score: ${{score}}/10</span>`:'';
      const issues=(t.caption_scores.issues||[]).join(' · ');
      card.appendChild(div('vc-section',`<div class="vc-row">${{badges}}${{scoreTag}}</div>${{issues?`<p class="sc-issues">${{escapeHtml(issues)}}</p>`:''}}` ));
    }} else {{
      const dims=[['overall','Overall'],['detail','Detail'],['sharpness','Sharpness'],['composition','Composition'],['artifacts','Artifacts']];
      const bars=dims.map(([k,lbl])=>{{
        const v=t.caption_scores[k]??0; const pct=typeof v==='number'?v*10:0;
        const col=v>=8?'var(--green)':v>=6?'var(--accent)':'var(--red)';
        return `<div class="sc-row"><span class="sc-lbl">${{lbl}}</span><div class="sc-bar"><div style="width:${{pct}}%;background:${{col}}"></div></div><span class="sc-val">${{v}}/10</span></div>`;
      }}).join('');
      const issues=(t.caption_scores.issues||[]).join(' · ');
      card.appendChild(div('score-section',`<div class="sc-title">VLM Score</div>${{bars}}${{issues?`<p class="sc-issues">${{escapeHtml(issues)}}</p>`:''}}` ));
    }}
  }}
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


# ---------------------------------------------------------------------------
# Mode 4: Unified self-test dispatcher
# ---------------------------------------------------------------------------

def run_review_selftest(args):
    """Unified dispatcher for all named self-tests (--self-test <name>).

    Routes to the correct runner based on test type in the registry.
    Always ends with HTML review generation.

    Usage:
      run.py image review --self-test portrait-full
      run.py image review --self-test ultraflux
      run.py image review --self-test portrait-seeds
      run.py image t2i --self-test portrait-full   (also routed here)
    """
    from app.test_prompts_image import get_test, list_test_names, _ALL_TESTS

    test_name = getattr(args, "self_test", None)

    # Special value "list" → print all available tests
    if not test_name or test_name == "list":
        print("[selftest] Available tests:")
        print(f"  {'Name':<26} {'Type':<10} Description")
        print(f"  {'─'*26} {'─'*10} {'─'*40}")
        for name, tcfg in _ALL_TESTS.items():
            print(f"  {name:<26} [{tcfg['type']:<8}] {tcfg['description']}")
        return

    try:
        test_cfg = get_test(test_name)
    except ValueError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)

    test_type = test_cfg["type"]
    print(f"[selftest] ═══ {test_name} ({test_type}) ═══")
    print(f"[selftest] {test_cfg['description']}")

    if test_type == "nomodel":
        _run_selftest_nomodel(test_name, test_cfg)
    elif test_type == "vae":
        run_review_vae(args)
    elif test_type == "lora":
        run_review_lora(args)
    elif test_type == "workflow":
        _run_selftest_workflow(args, test_name, test_cfg)
    elif test_type == "t2i":
        _run_selftest_t2i(args, test_name, test_cfg)
    elif test_type == "video":
        _run_selftest_video(args, test_name, test_cfg)
    elif test_type == "profile":
        _run_selftest_profile(args, test_name, test_cfg)
    elif test_type == "lora-i2i":
        _run_lora_i2i_selftest(args, test_name, test_cfg)
    elif test_type == "lora-sweep":
        _run_lora_sweep(args, test_name, test_cfg)
    elif test_type == "lora-ref":
        _run_lora_ref_selftest(args, test_name, test_cfg)
    elif test_type == "controlnet-i2i":
        _run_selftest_controlnet_i2i(args, test_name, test_cfg)
    elif test_type == "flf2v":
        _run_selftest_flf2v(args, test_name, test_cfg)
    elif test_type == "faceswap":
        _run_selftest_faceswap(args, test_name, test_cfg)
    elif test_type == "swap":
        _run_selftest_swap(args, test_name, test_cfg)
    elif test_type == "expansion":
        _run_selftest_expansion(args, test_name, test_cfg)
    else:
        print(f"ERROR: unknown test type '{test_type}'", file=sys.stderr)
        sys.exit(1)


def _run_selftest_controlnet_i2i(args, test_name: str, test_cfg: dict):
    """Run I2I + ControlNet self-test by delegating to image-i2i._run_self_test().

    mode="debug"       → _I2I_DEBUG_VARIATIONS (1 variation, ~3 min)
    mode="cnet-sweep"  → _I2I_CNET_SWEEP_VARIATIONS (6 variations, ~20 min)
    mode="cnet-sweep2" → _I2I_CNET_SWEEP2_VARIATIONS (4 variations, ~15 min)
    mode="cnet-pose"   → _I2I_CNET_POSE_VARIATIONS (5 variations, ~20 min)
    mode="cnet-pose2"  → _I2I_CNET_POSE2_VARIATIONS (4 variations, ~15 min)
    mode="cnet-pose3"  → _I2I_CNET_POSE3_VARIATIONS (4 variations, ~18 min)
    mode="cnet-pose4"  → _I2I_CNET_POSE4_VARIATIONS (4 variations, ~15 min)
    mode="seed-sweep"  → _I2I_CNET_SEED_SWEEP_VARIATIONS (8 seeds, ~25 min)
    mode="full"        → _I2I_SELF_TEST_VARIATIONS (8 variations, ~25 min)
    After generation: VLM-captions all outputs and generates interactive HTML review.
    """
    import importlib
    import base64
    import json as _json
    from app import config as cfg
    _i2i = importlib.import_module("app.commands.image-i2i")
    cap = importlib.import_module("app.commands.caption")

    mode = test_cfg.get("mode", "debug")
    seed = getattr(args, "seed", 42)
    args.self_test = mode
    args.skip_inner_html = True  # image-review generates a better HTML; skip the inner one
    _i2i._run_self_test(args)

    # --- Determine which images to review ---
    if mode == "debug":
        variations = _i2i._I2I_DEBUG_VARIATIONS
    elif mode == "cnet-sweep":
        variations = _i2i._I2I_CNET_SWEEP_VARIATIONS
    elif mode == "cnet-sweep2":
        variations = _i2i._I2I_CNET_SWEEP2_VARIATIONS
    elif mode == "cnet-pose":
        variations = _i2i._I2I_CNET_POSE_VARIATIONS
    elif mode == "cnet-pose2":
        variations = _i2i._I2I_CNET_POSE2_VARIATIONS
    elif mode == "cnet-pose3":
        variations = _i2i._I2I_CNET_POSE3_VARIATIONS
    elif mode == "cnet-pose4":
        variations = _i2i._I2I_CNET_POSE4_VARIATIONS
    elif mode == "seed-sweep":
        variations = _i2i._I2I_CNET_SEED_SWEEP_VARIATIONS
    else:
        variations = _i2i._I2I_SELF_TEST_VARIATIONS

    # Build image list: source + ref + all variation outputs
    images = [
        ("source",   f"i2i_selftest_source-s{seed}.png",   "SOURCE",    "Source image"),
        ("ref_pose", f"i2i_selftest_ref-pose-s{seed + 1}.png", "REFERENCE", "Reference pose (V-pose)"),
    ]
    for var in variations:
        label = var[0]
        dn    = var[1]
        ctrl  = var[2]
        cnet  = var[4] if len(var) > 4 else None
        steps = var[5] if len(var) > 5 else 9
        var_seed = var[8] if len(var) > 8 else seed  # seed_override for seed-sweep mode
        param_str = f"denoise={dn}"
        if ctrl is not None:
            param_str += f" ctrl={ctrl}"
        if cnet is not None:
            param_str += f" cnet_act={cnet}"
        else:
            param_str += " cnet_act=ALL"
        param_str += f" steps={steps} seed={var_seed}"
        images.append((label, f"i2i_selftest_{label}-s{var_seed}.png", label, param_str))

    # --- VLM caption all images ---
    pose_prompt = (
        "Describe this image. Focus on: "
        "(1) person pose — arm position, leg position, overall body shape; "
        "(2) quality issues — deformed hands, extra limbs, double body, anatomy errors, pixelation; "
        "(3) overall quality score 1-10. "
        "Be specific. Answer in English."
    )

    print(f"\n{'─' * 60}")
    print("[review] VLM-captioning all outputs...")
    results = []
    for key, fname, label, params in images:
        path = os.path.join(cfg.OUTPUT_DIR, fname)
        if not os.path.exists(path):
            results.append((key, fname, label, params, None, None))
            continue
        try:
            b64_vlm = cap._image_to_base64(path)
            caption = cap._call_vlm("http://localhost:1234/v1", "qwen/qwen3-vl-4b", b64_vlm, pose_prompt)
            img_data = base64.b64encode(open(path, "rb").read()).decode()
            ext = "jpeg" if fname.endswith(".jpg") else "png"
            img_src = f"data:image/{ext};base64,{img_data}"
            results.append((key, fname, label, params, caption, img_src))
            print(f"  [review] captioned: {label}")
        except Exception as e:
            results.append((key, fname, label, params, f"VLM error: {e}", None))
            print(f"  [review] WARN: {label} — {e}")

    # --- Generate interactive HTML review ---
    out_html = os.path.join(cfg.OUTPUT_DIR, f"i2i_cnet_{mode}_review.html")
    _generate_cnet_vlm_review_html(results, out_html, mode=mode, seed=seed)
    print(f"\n[review] Saved: {out_html}")

    # Simple VLM PASS/FAIL on the smoking-gun image (cnet_active=ALL, denoise=1.0)
    if mode == "debug":
        _vlm_verify_controlnet_pose(os.path.join(cfg.OUTPUT_DIR, f"i2i_selftest_debug-dn10-cnet-canny-15st-s{seed}.png"))

    subprocess.Popen(["open", out_html])


def _generate_cnet_vlm_review_html(results, output_path: str, mode: str = "debug", seed: int = 42):
    """Generate a self-contained interactive HTML review with VLM captions and feedback buttons.

    Each card includes:
      - Inlined base64 image
      - VLM-detected issue flags (auto-detected from caption text)
      - Interactive issue toggles: 👥 Double body, ✋ Bad hands, 🔲 Pixelation, ✅ V-pose OK, etc.
      - Verdict buttons: PASS / PARTIAL / FAIL
      - Notes textarea
      - localStorage auto-save and "Copy Feedback JSON" export
    """
    import html as _html

    def _score_color(text):
        import re
        m = re.search(r"(\d+)/10", text or "")
        if not m:
            return "#888"
        n = int(m.group(1))
        if n >= 8:
            return "#22c55e"
        if n >= 5:
            return "#f59e0b"
        return "#ef4444"

    def _auto_flags(caption):
        if not caption:
            return []
        cl = caption.lower()
        flags = []
        if "double" in cl or "duplicate" in cl or "second" in cl or "ghost" in cl or "extra" in cl:
            flags.append(("👥 Double body", "#7c3aed"))
        if "deform" in cl or "fused" in cl or "melted" in cl or "smudg" in cl or "bad hand" in cl:
            flags.append(("✋ Bad hands", "#dc2626"))
        if "pixelat" in cl or "grainy" in cl:
            flags.append(("🔲 Pixelation", "#ea580c"))
        if "v-pose" in cl or "v shape" in cl or ("arms raised" in cl and "v" in cl):
            flags.append(("✅ V-pose", "#16a34a"))
        elif "arms raised" in cl or "arms high" in cl:
            flags.append(("🎯 Arms up (partial)", "#2563eb"))
        elif "arms hanging" in cl or "arms at" in cl or "arms relaxed" in cl or "arms down" in cl:
            flags.append(("➡️ No pose transfer", "#6b7280"))
        return flags

    cards_html = ""
    ids_js = []
    for key, fname, label, params, caption, img_src in results:
        is_ref = key in ("source", "ref_pose")
        safe_key = key.replace("-", "_")
        ids_js.append(f'"{safe_key}"')
        auto_flags = _auto_flags(caption)
        flags_html = " ".join(
            f'<span class="flag" style="background:{c}">{t}</span>'
            for t, c in auto_flags
        )
        caption_safe = _html.escape(caption or "Image not found").replace("\n", "<br>")
        img_html = (
            f'<img src="{img_src}" loading="lazy" onclick="zoom(this.src)">'
            if img_src else '<div class="no-img">Image not found</div>'
        )
        card_cls = "card ref-card" if is_ref else "card"
        cards_html += f"""
<div class="{card_cls}" id="card-{safe_key}">
  <div class="card-header">
    <span class="card-label">{_html.escape(label)}</span>
    <span class="card-params">{_html.escape(params)}</span>
  </div>
  <div class="img-wrap">{img_html}</div>
  <div class="auto-flags">{flags_html}</div>
  <div class="caption-box">
    <div class="caption-text">{caption_safe}</div>
  </div>
  <div class="issue-strip-label">問題標記 / Issue tags <span class="tip">(可複選 / multi-select)</span></div>
  <div class="issue-strip">
    <button class="issue-btn" data-id="{safe_key}" data-key="double_body"
            title="幽靈重影：圖中出現多餘肢體或重複身體輪廓&#10;Ghost limbs or duplicate body contours in the image">
      👥 幽靈重影 / Double body</button>
    <button class="issue-btn" data-id="{safe_key}" data-key="bad_hands"
            title="手部變形：手指融合、多指、模糊變形&#10;Fused fingers, extra digits, or deformed hands">
      ✋ 手部變形 / Bad hands</button>
    <button class="issue-btn" data-id="{safe_key}" data-key="pixelation"
            title="像素化：圖像品質低，出現方塊或雜訊&#10;Low quality with blocky or noisy artifacts">
      🔲 像素化 / Pixelation</button>
    <button class="issue-btn" data-id="{safe_key}" data-key="v_pose_ok"
            title="V字姿勢成功：雙臂完整舉起呈 V 形，接近參考圖姿勢&#10;Both arms fully raised in V-shape matching reference pose">
      ✅ V字姿勢 / V-pose OK</button>
    <button class="issue-btn" data-id="{safe_key}" data-key="partial_pose"
            title="姿勢部分達成：手臂有上舉但未完成完整 V 形&#10;Arms partially raised but not fully completing the V-shape">
      🎯 姿勢部分 / Partial pose</button>
    <button class="issue-btn" data-id="{safe_key}" data-key="no_pose"
            title="無姿勢轉移：輸出與源圖姿勢相同，ControlNet 無效&#10;Output retains source pose; ControlNet had no effect">
      ➡️ 無姿勢 / No pose</button>
  </div>
  <div class="verdict-label">整體評分 / Verdict</div>
  <div class="verdict-row">
    <button class="verdict-btn vpass"    data-id="{safe_key}" data-v="pass"
            title="通過：V字姿勢正確達成，外觀保留可接受&#10;Pass: V-pose achieved, identity acceptably preserved">
      ✅ 通過 PASS</button>
    <button class="verdict-btn vpartial" data-id="{safe_key}" data-v="partial"
            title="部分：姿勢或外觀有問題但結果仍有參考價值&#10;Partial: some issues but result has value">
      ⚠️ 部分 PARTIAL</button>
    <button class="verdict-btn vfail"    data-id="{safe_key}" data-v="fail"
            title="失敗：姿勢錯誤、外觀完全不符或圖像損壞&#10;Fail: wrong pose, broken identity, or corrupted image">
      ❌ 失敗 FAIL</button>
  </div>
  <textarea class="notes" data-id="{safe_key}" placeholder="備註 / Notes..." rows="2"
            oninput="setNote(this.dataset.id, this.value)"></textarea>
</div>"""

    ids_js_str = "[" + ", ".join(ids_js) + "]"
    storage_key = f"i2i_cnet_{mode}_feedback_v1"

    html_content = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>I2I ControlNet {_html.escape(mode)} Review · seed={seed}</title>
<style>
  *{{box-sizing:border-box;margin:0;padding:0}}
  body{{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
        background:#0f172a;color:#e2e8f0;padding:20px}}
  h1{{font-size:1.3rem;margin-bottom:4px;color:#f8fafc}}
  .subtitle{{font-size:0.78rem;color:#64748b;margin-bottom:16px}}
  .grid{{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:14px}}
  .card{{background:#1e293b;border-radius:10px;overflow:hidden;
         border:1px solid #334155;display:flex;flex-direction:column}}
  .ref-card{{border-color:#3b82f6}}
  .card-header{{padding:9px 11px;background:#0f172a;border-bottom:1px solid #1e293b}}
  .card-label{{font-weight:700;font-size:0.85rem;color:#f1f5f9;display:block}}
  .card-params{{font-size:0.68rem;color:#64748b;font-family:monospace;display:block;margin-top:2px}}
  .img-wrap{{background:#000;display:flex;align-items:center;justify-content:center}}
  .img-wrap img{{width:100%;height:auto;display:block;max-height:380px;
                 object-fit:contain;cursor:zoom-in}}
  .no-img{{height:160px;display:flex;align-items:center;justify-content:center;
            color:#475569;font-size:0.8rem}}
  .auto-flags{{display:flex;flex-wrap:wrap;gap:4px;padding:6px 10px;
               border-bottom:1px solid #1e293b;min-height:28px}}
  .flag{{font-size:0.66rem;padding:2px 7px;border-radius:999px;color:#fff;font-weight:500}}
  .caption-box{{padding:8px 11px;border-bottom:1px solid #1e293b}}
  .caption-text{{font-size:0.70rem;color:#94a3b8;line-height:1.5;
                 max-height:180px;overflow-y:auto}}
  .caption-text::-webkit-scrollbar{{width:3px}}
  .caption-text::-webkit-scrollbar-thumb{{background:#475569;border-radius:2px}}
  .issue-strip{{display:flex;flex-wrap:wrap;gap:4px;padding:8px 10px;
                border-bottom:1px solid #1e293b}}
  .issue-btn{{font-size:0.68rem;padding:3px 8px;border-radius:999px;cursor:pointer;
              border:1px solid #475569;background:#1e293b;color:#94a3b8;
              transition:all .15s}}
  .issue-btn.active{{background:#334155;color:#f1f5f9;border-color:#64748b}}
  .verdict-row{{display:flex;gap:6px;padding:7px 10px;border-bottom:1px solid #1e293b}}
  .verdict-btn{{flex:1;font-size:0.72rem;font-weight:700;padding:5px 4px;
                border-radius:6px;cursor:pointer;border:none;
                background:#1e293b;color:#64748b;transition:all .15s}}
  .verdict-btn.active.vpass{{background:#16a34a;color:#fff}}
  .verdict-btn.active.vpartial{{background:#d97706;color:#fff}}
  .verdict-btn.active.vfail{{background:#dc2626;color:#fff}}
  .verdict-btn:not(.active){{border:1px solid #334155}}
  .issue-strip-label,.verdict-label{{font-size:0.62rem;color:#475569;
    padding:4px 10px 0;font-weight:600;letter-spacing:.04em;text-transform:uppercase}}
  .tip{{font-size:0.58rem;color:#334155;font-weight:400;text-transform:none;letter-spacing:0}}
  .notes{{width:100%;background:#0f172a;border:none;color:#94a3b8;
          padding:7px 11px;font-size:0.70rem;font-family:inherit;
          resize:vertical;outline:none}}
  .notes:focus{{background:#1e293b;color:#e2e8f0}}
  .guide{{background:#1e293b;border:1px solid #334155;border-radius:8px;
          padding:12px 16px;margin-bottom:16px;font-size:0.76rem;line-height:1.7}}
  .guide summary{{cursor:pointer;font-weight:700;color:#94a3b8;font-size:0.78rem;
                  list-style:none;user-select:none}}
  .guide summary::before{{content:"▶ "}}
  details[open] .guide summary::before{{content:"▼ "}}
  .guide-grid{{display:grid;grid-template-columns:1fr 1fr;gap:8px 24px;margin-top:10px}}
  .guide-item{{display:flex;flex-direction:column;gap:2px}}
  .guide-item .tag{{font-weight:700;color:#e2e8f0}}
  .guide-item .desc{{color:#64748b;font-size:0.70rem}}
  .bottom-bar{{position:sticky;bottom:0;background:#0f172a;border-top:1px solid #334155;
               padding:10px 20px;display:flex;align-items:center;gap:12px;margin-top:20px}}
  .bottom-bar button{{padding:7px 16px;border-radius:7px;cursor:pointer;
                       font-size:0.8rem;font-weight:600;border:none}}
  .btn-export{{background:#3b82f6;color:#fff}}
  .btn-reset{{background:#334155;color:#94a3b8}}
  .saved-hint{{font-size:0.70rem;color:#64748b}}
  .overlay{{display:none;position:fixed;inset:0;background:rgba(0,0,0,.92);
            z-index:100;align-items:center;justify-content:center;cursor:zoom-out}}
  .overlay.show{{display:flex}}
  .overlay img{{max-width:90vw;max-height:90vh;object-fit:contain;border-radius:6px}}
</style>
</head>
<body>
<h1>I2I ControlNet Review — <code>{_html.escape(mode)}</code> · seed={seed}</h1>
<p class="subtitle">Qwen3-VL-4B captions · 點擊按鈕標記問題 · 自動儲存 / click to tag issues · auto-saved</p>
<details>
<div class="guide">
  <summary>評分說明 / Rating Guide</summary>
  <div class="guide-grid">
    <div class="guide-item">
      <span class="tag">🎯 目標 / Goal</span>
      <span class="desc">源圖人物（亞洲女性，黑髮，白T恤，牛仔褲）做出 V 字勝利姿勢（雙臂高舉呈 V 形）。<br>Source person (Asian woman, black hair, white t-shirt, jeans) in V-pose (both arms raised).</span>
    </div>
    <div class="guide-item">
      <span class="tag">👥 幽靈重影 / Double body</span>
      <span class="desc">出現多餘肢體或重複身體輪廓。Extra ghost limbs or duplicate body outlines.</span>
    </div>
    <div class="guide-item">
      <span class="tag">✋ 手部變形 / Bad hands</span>
      <span class="desc">手指融合、多指或嚴重變形。Fused, extra, or badly deformed fingers.</span>
    </div>
    <div class="guide-item">
      <span class="tag">🔲 像素化 / Pixelation</span>
      <span class="desc">圖像出現方塊或雜訊。Blocky or noisy image artifacts.</span>
    </div>
    <div class="guide-item">
      <span class="tag">✅ V字姿勢 / V-pose OK</span>
      <span class="desc">雙臂完整舉起呈 V 形。Both arms fully raised forming a V-shape.</span>
    </div>
    <div class="guide-item">
      <span class="tag">🎯 姿勢部分 / Partial pose</span>
      <span class="desc">手臂有上舉但未完成完整 V 形。Arms partially raised, not full V-shape.</span>
    </div>
    <div class="guide-item">
      <span class="tag">➡️ 無姿勢 / No pose</span>
      <span class="desc">輸出與源圖相同，ControlNet 無效。Output retains source pose unchanged.</span>
    </div>
    <div class="guide-item">
      <span class="tag">✅通過 / PASS</span>
      <span class="desc">姿勢正確，外觀保留。Pose achieved, identity preserved.</span>
    </div>
    <div class="guide-item">
      <span class="tag">⚠️部分 / PARTIAL</span>
      <span class="desc">有問題但仍有參考價值。Issues present but result has value.</span>
    </div>
    <div class="guide-item">
      <span class="tag">❌失敗 / FAIL</span>
      <span class="desc">姿勢錯誤或圖像損壞。Wrong pose or corrupted image.</span>
    </div>
  </div>
</div>
</details>
<div class="grid" id="grid">{cards_html}</div>
<div class="bottom-bar">
  <button class="btn-export" onclick="exportJSON()">📋 複製 JSON / Copy Feedback JSON</button>
  <button class="btn-reset" onclick="resetAll()">🔄 重置 / Reset All</button>
  <span class="saved-hint" id="saved-hint">自動儲存 / Auto-saved</span>
</div>
<div class="overlay" id="overlay" onclick="this.classList.remove('show')">
  <img id="overlay-img" src="">
</div>
<script>
const STORAGE_KEY = '{storage_key}';
const IDS = {ids_js_str};
let fb = {{}};

function initFeedback() {{
  IDS.forEach(id => fb[id] = {{issues: {{}}, verdict: null, notes: ''}});
  try {{
    const s = localStorage.getItem(STORAGE_KEY);
    if (s) {{ const saved = JSON.parse(s); IDS.forEach(id => {{ if (saved[id]) fb[id] = {{...fb[id], ...saved[id]}}; }}); }}
  }} catch(e) {{}}
  render();
  // restore note textareas
  document.querySelectorAll('.notes').forEach(ta => {{
    const id = ta.dataset.id;
    if (fb[id]) ta.value = fb[id].notes || '';
  }});
}}

function save() {{
  try {{ localStorage.setItem(STORAGE_KEY, JSON.stringify(fb)); }} catch(e) {{}}
  const hint = document.getElementById('saved-hint');
  hint.textContent = 'Saved ✓';
  setTimeout(() => hint.textContent = 'Auto-saved to localStorage', 1200);
}}

function toggleIssue(id, key) {{
  if (!fb[id]) fb[id] = {{issues: {{}}, verdict: null, notes: ''}};
  fb[id].issues[key] = !fb[id].issues[key];
  save(); render();
}}

function setVerdict(id, v) {{
  if (!fb[id]) fb[id] = {{issues: {{}}, verdict: null, notes: ''}};
  fb[id].verdict = fb[id].verdict === v ? null : v;
  save(); render();
}}

function setNote(id, val) {{
  if (!fb[id]) fb[id] = {{issues: {{}}, verdict: null, notes: ''}};
  fb[id].notes = val;
  save();
}}

function render() {{
  IDS.forEach(id => {{
    const state = fb[id] || {{}};
    document.querySelectorAll(`.issue-btn[data-id="${{id}}"]`).forEach(btn => {{
      btn.classList.toggle('active', !!(state.issues || {{}})[btn.dataset.key]);
    }});
    document.querySelectorAll(`.verdict-btn[data-id="${{id}}"]`).forEach(btn => {{
      btn.classList.toggle('active', btn.dataset.v === state.verdict);
    }});
  }});
}}

function exportJSON() {{
  const text = JSON.stringify(fb, null, 2);
  navigator.clipboard.writeText(text).then(() => {{
    const hint = document.getElementById('saved-hint');
    hint.textContent = 'Copied to clipboard!';
    setTimeout(() => hint.textContent = 'Auto-saved to localStorage', 2000);
  }});
}}

function resetAll() {{
  if (!confirm('Reset all feedback?')) return;
  IDS.forEach(id => fb[id] = {{issues: {{}}, verdict: null, notes: ''}});
  document.querySelectorAll('.notes').forEach(ta => ta.value = '');
  localStorage.removeItem(STORAGE_KEY);
  render();
}}

function zoom(src) {{
  document.getElementById('overlay-img').src = src;
  document.getElementById('overlay').classList.add('show');
}}

// wire up issue buttons and verdict buttons
document.querySelectorAll('.issue-btn').forEach(btn => {{
  btn.onclick = () => toggleIssue(btn.dataset.id, btn.dataset.key);
}});
document.querySelectorAll('.verdict-btn').forEach(btn => {{
  btn.onclick = () => setVerdict(btn.dataset.id, btn.dataset.v);
}});

initFeedback();
</script>
</body>
</html>"""

    with open(output_path, "w", encoding="utf-8") as f:
        f.write(html_content)


def _vlm_verify_controlnet_pose(image_path: str):
    """Use Qwen3-VL to verify the ControlNet output shows a V-pose (arms raised).

    Prints a PASS/FAIL verdict to stdout. Silently skips if VLM API is unavailable.
    """
    import json as _json
    print(f"\n{'─' * 60}")
    print(f"[verify] VLM pose check: {os.path.basename(image_path)}")
    if not os.path.exists(image_path):
        print(f"[verify] SKIP — image not found: {image_path}", file=sys.stderr)
        return
    try:
        from app.commands.caption import _image_to_base64, _call_vlm, get_controlnet_verify_prompt
        b64 = _image_to_base64(image_path)
        prompt = get_controlnet_verify_prompt()
        raw = _call_vlm("http://localhost:1234/v1", "qwen/qwen3-vl-4b", b64, prompt)
        try:
            result = _json.loads(raw) if isinstance(raw, str) else raw
        except Exception:
            result = {"summary": raw}
        arms = result.get("arms_raised")
        v_pose = result.get("v_pose")
        score = result.get("score", "?")
        summary = result.get("summary", "")
        passed = bool(arms or v_pose)
        verdict = "✓ PASS — ControlNet is working" if passed else "✗ FAIL — ControlNet not producing V-pose"
        print(f"[verify] {verdict}")
        print(f"[verify] arms_raised={arms}  v_pose={v_pose}  score={score}")
        print(f"[verify] {summary}")
        issues = result.get("issues", [])
        if issues and not passed:
            print(f"[verify] Issues: {issues}")
    except Exception as e:
        print(f"[verify] VLM unavailable ({e.__class__.__name__}: {e})")
        print("[verify] Start LM Studio with Qwen3-VL to enable automatic pose verification")


def _run_selftest_nomodel(test_name: str, test_cfg: dict):
    """Run an in-process smoke test that requires no model loading."""
    if test_name == "workflow-postprocess":
        _selftest_postprocess_smoke()
    else:
        print(f"ERROR: no handler for nomodel test '{test_name}'", file=sys.stderr)
        sys.exit(1)


def _selftest_postprocess_smoke():
    """Test PostProcessChain on a synthetic PIL image — no model, <1s."""
    import numpy as np
    from PIL import Image
    from app.postprocess import PostProcessChain

    print("[selftest] PostProcessChain smoke test...")
    rng = np.random.default_rng(42)
    arr = rng.integers(80, 200, (64, 64, 3), dtype=np.uint8)
    img = Image.fromarray(arr)

    # Test 1: chain applies and changes pixels
    chain = PostProcessChain.from_config({"sharpening": 0.2, "film_grain": 0.02})
    result, timings = chain.apply(img, seed=42)
    assert result.size == img.size, "Output size must match input"
    assert not np.array_equal(np.array(result), arr), "Pixels must change"

    # Test 2: film_grain is last in order
    chain2 = PostProcessChain.from_config({"sharpening": 0.1, "film_grain": 0.01})
    assert [f.name for f in chain2.filters][-1] == "film_grain", "film_grain must be last"

    # Test 3: timings keys match filter names
    _, timings2 = chain2.apply(img, seed=0)
    assert set(timings2.keys()) == {f.name for f in chain2.filters}

    print("[selftest] PostProcessChain smoke test PASSED")


def _run_selftest_workflow(args, test_name: str, test_cfg: dict):
    """Run WorkflowOrchestrator for each variation, then generate HTML review."""
    import gc
    import mlx.core as mx
    from app.workflow import WorkflowOrchestrator
    from app.run_config import RunConfig
    from app.test_prompts_image import get_test_prompt
    from app import config as cfg

    tp_name = test_cfg["test_prompt"]
    seed = getattr(args, "seed", None) or test_cfg.get("seed", 42)
    steps = getattr(args, "steps", None) or test_cfg.get("steps", 9)

    tp = get_test_prompt(tp_name)
    prompt = tp["prompt"]
    width = tp["width"]
    height = tp["height"]

    variations = test_cfg["variations"]
    print(f"[selftest] {len(variations)} variation(s) | {width}×{height} | {steps} steps | seed={seed}")

    ts = time.strftime("%Y%m%d_%H%M%S")
    manifest_paths = []
    labels = []

    for i, var in enumerate(variations):
        label = var.get("label", chr(65 + i))
        labels.append(label)
        print(f"\n[selftest] {'─'*50}")
        print(f"[selftest] Running variation: {label}")

        rc = RunConfig(
            prompt=prompt,
            width=width,
            height=height,
            steps=steps,
            seed=seed,
            face_detail=var.get("face_detail", False),
            face_detail_denoise=var.get("face_detail_denoise", 0.15),
            face_detail_steps=var.get("face_detail_steps", 9),
            film_grain=var.get("film_grain", 0.0),
            sharpening=var.get("sharpening", 0.0),
            skin_contrast=var.get("skin_contrast", False),
            noise_clean=var.get("noise_clean", False),
            upscale=var.get("upscale", False),
            upscale_method=var.get("upscale_method", "esrgan"),
        )

        safe_label = label.lower().replace(" ", "_").replace("-", "_")
        run_name = f"selftest_{test_name}_{ts}_{safe_label}"

        orchestrator = WorkflowOrchestrator(rc)
        wf_result = orchestrator.execute()
        out_dir = WorkflowOrchestrator.save_outputs(wf_result, rc, base_name=run_name)

        mx.clear_cache()
        gc.collect()

        # Look for manifest or config.json in output dir
        manifest_path = os.path.join(out_dir, "config.json")
        if os.path.exists(manifest_path):
            manifest_paths.append(manifest_path)
        else:
            # Fallback: find any json in the dir
            for f in sorted(os.listdir(out_dir)):
                if f.endswith(".json"):
                    manifest_paths.append(os.path.join(out_dir, f))
                    break

    if manifest_paths:
        html_path = os.path.join(cfg.OUTPUT_DIR, f"selftest-{test_name}-{ts}.html")
        _open_manifest_review(manifest_paths, labels=labels, output=html_path, auto_score=True)
    else:
        print("[selftest] WARNING: no manifests found; skipping HTML review", file=sys.stderr)


def _run_selftest_t2i(args, test_name: str, test_cfg: dict):
    """Generate T2I images across multiple seeds, then open HTML review."""
    import gc
    import mlx.core as mx
    from app.pipeline import ZImagePipeline
    from app.test_prompts_image import get_test_prompt
    from app.commands._shared import execute_generation
    from app import config as cfg

    tp_name = test_cfg["test_prompt"]
    steps = getattr(args, "steps", None) or test_cfg.get("steps", 9)
    seeds = test_cfg.get("seeds", [42])

    tp = get_test_prompt(tp_name)
    prompt = tp["prompt"]
    width = tp["width"]
    height = tp["height"]

    print(f"[selftest] {len(seeds)} seed(s) | {width}×{height} | {steps} steps")

    ts = time.strftime("%Y%m%d_%H%M%S")
    manifest_paths = []
    labels = []

    for seed in seeds:
        label = f"seed={seed}"
        labels.append(label)
        print(f"\n[selftest] Generating seed={seed}...")

        pipeline = ZImagePipeline()
        result = pipeline.generate(
            prompt=prompt,
            width=width,
            height=height,
            steps=steps,
            seed=seed,
        )

        base_name = f"selftest_{test_name}_{ts}_seed{seed}"
        out_path = os.path.join(cfg.OUTPUT_DIR, base_name + ".png")
        result.image.save(out_path)
        print(f"[selftest] Saved: {out_path}")

        # Write run.json + manifest.json
        run_file = os.path.join(cfg.OUTPUT_DIR, base_name + ".run.json")
        manifest_file = os.path.join(cfg.OUTPUT_DIR, base_name + ".manifest.json")
        import json as _json
        from datetime import datetime as _dt, timezone as _tz
        from app.manifest import Manifest, collect_model_fingerprint
        run_data = {
            "command": "image",
            "action": "review",
            "prompt": prompt,
            "width": width,
            "height": height,
            "steps": steps,
            "seed": seed,
            "pipeline": "zimage",
        }
        with open(run_file, "w") as f:
            _json.dump(run_data, f, indent=2)
        now = _dt.now(_tz.utc).isoformat()
        mf = Manifest.from_success(
            run_file=run_file,
            start_time=now,
            end_time=now,
            timings=getattr(result, "timings", {}),
            output_files=[{"path": out_path, "seed": seed,
                           "width": width, "height": height}],
            models=collect_model_fingerprint(),
        )
        mf.to_json(manifest_file)
        manifest_paths.append(manifest_file)

        del pipeline, result
        mx.clear_cache()
        gc.collect()

    if manifest_paths:
        html_path = os.path.join(cfg.OUTPUT_DIR, f"selftest-{test_name}-{ts}.html")
        _open_manifest_review(manifest_paths, labels=labels, output=html_path, auto_score=True)


def _run_selftest_video(args, test_name: str, test_cfg: dict):
    """Delegate to the video-generate pipeline, then open HTML review."""
    _video_gen = importlib.import_module("app.commands.video-generate")

    # Inject test_cfg params into args
    for k in ("prompt", "width", "height", "seed", "steps"):
        if k in test_cfg and not getattr(args, k, None):
            setattr(args, k, test_cfg[k])
    if "duration_frames" in test_cfg:
        setattr(args, "frames", test_cfg["duration_frames"])

    print(f"[selftest] Running video generation: {test_name}")
    _video_gen.run_generate(args)


def _run_selftest_profile(args, test_name: str, test_cfg: dict):
    """Generate multi-view character profiles, run VLM view-angle verification, open HTML review."""
    import gc
    import json as _json
    import mlx.core as mx
    from datetime import datetime as _dt, timezone as _tz
    from app.pipeline import ZImagePipeline
    from app.flux2_pipeline import Flux2KleinPipeline
    from app.manifest import Manifest, collect_model_fingerprint
    from app.test_prompts_image import get_test_prompt
    from app.commands.caption import _image_to_base64, _call_vlm, get_profile_verify_prompt
    from app import config as cfg
    _profile_mod = importlib.import_module("app.commands.image-profile")

    views = test_cfg.get("views", ["front", "back", "side"])
    steps = getattr(args, "steps", None) or test_cfg.get("steps", 6)
    seed = test_cfg.get("seed", 42)
    ratio_key = test_cfg.get("ratio", "standing")
    width, height = _profile_mod.RATIO_PRESETS[ratio_key]
    prompt_variants = test_cfg.get("prompt_variants", None)
    pipeline_type = test_cfg.get("pipeline", "zimage")

    # For tests without explicit prompt_variants, fall back to default view prompts
    if prompt_variants is None:
        prompt_variants = [{"label": "default", "prompts": None}]

    ts = time.strftime("%Y%m%d_%H%M%S")
    manifest_paths = []
    labels = []

    vlm_api_url = "http://localhost:1234/v1"
    vlm_model = "qwen/qwen3-vl-4b"

    # For Flux2-Klein selftests: generate a reference portrait first (ZImage T2I → reference)
    # so that the profile views have a real character to condition on.
    generate_reference = test_cfg.get("generate_reference", False)
    ref_image_path = None
    if generate_reference and pipeline_type == "flux2-klein":
        tp = get_test_prompt(test_cfg.get("test_prompt", "portrait"))
        ref_steps = test_cfg.get("steps_ref", 9)
        print(f"\n[selftest] Generating reference portrait ({tp['width']}×{tp['height']}, {ref_steps} steps)...")
        ref_pipeline = ZImagePipeline()
        ref_result = ref_pipeline.generate(
            prompt=tp["prompt"],
            width=tp["width"],
            height=tp["height"],
            steps=ref_steps,
            seed=seed,
        )
        ref_image_path = os.path.join(cfg.OUTPUT_DIR, f"selftest_{test_name}_{ts}_reference.png")
        ref_result.image.save(ref_image_path)
        print(f"[selftest] Reference saved: {ref_image_path}")
        del ref_pipeline
        mx.clear_cache()
        gc.collect()

    for variant in prompt_variants:
        var_label = variant["label"]
        custom_prompts = variant.get("prompts")

        print(f"\n[selftest] ── Variant: {var_label} ──")
        print(f"[selftest] {width}×{height} | {steps} steps | views: {' '.join(views)}")

        if pipeline_type == "flux2-klein":
            pipeline = Flux2KleinPipeline()
        else:
            pipeline = ZImagePipeline()

        for view in [v for v in _profile_mod.VIEW_ORDER if v in views]:
            # Pick prompt: custom override, then pipeline-appropriate default
            if custom_prompts is not None and custom_prompts.get(view):
                prompt = custom_prompts[view]
            elif pipeline_type == "flux2-klein":
                prompt = _profile_mod.VIEW_PROMPTS_FLUX2[view]
            else:
                prompt = _profile_mod.VIEW_PROMPTS[view]

            view_seed = seed % (2 ** 32)
            print(f"\n  [{view}] {prompt[:80]}...")

            if pipeline_type == "flux2-klein" and ref_image_path:
                result = pipeline.generate(
                    prompt=prompt,
                    width=width,
                    height=height,
                    steps=steps,
                    seed=view_seed,
                    reference_images=[ref_image_path],
                )
            else:
                result = pipeline.generate(
                    prompt=prompt,
                    width=width,
                    height=height,
                    steps=steps,
                    seed=view_seed,
                )

            base_name = f"selftest_{test_name}_{ts}_{var_label}_{view}"
            out_path = os.path.join(cfg.OUTPUT_DIR, base_name + ".png")
            result.image.save(out_path)
            print(f"  Saved: {out_path}")

            # VLM view verification
            print(f"  [view-verify] {view}...", end=" ", flush=True)
            try:
                b64 = _image_to_base64(out_path)
                vp = get_profile_verify_prompt(view)
                raw_verify = _call_vlm(vlm_api_url, vlm_model, b64, vp)
                verify_result = _json.loads(raw_verify) if isinstance(raw_verify, str) else raw_verify
                if isinstance(verify_result, dict) and "view_correct" in verify_result:
                    ok_str = "✓" if verify_result.get("view_correct") else "✗"
                    print(f"{ok_str} score={verify_result.get('score', '?')}")
                    caption_data = {
                        "image": out_path,
                        "style": "profile-verify",
                        "view": view,
                        "model": vlm_model,
                        "caption": verify_result,
                    }
                    with open(os.path.splitext(out_path)[0] + ".caption.json", "w") as _f:
                        _json.dump(caption_data, _f, indent=2, ensure_ascii=False)
                else:
                    print("done (unrecognized format)")
            except Exception as e:
                print(f"skipped ({type(e).__name__})")

            # Write run.json + manifest.json
            run_file = os.path.join(cfg.OUTPUT_DIR, base_name + ".run.json")
            manifest_file = os.path.join(cfg.OUTPUT_DIR, base_name + ".manifest.json")
            run_data = {
                "command": "image",
                "action": "profile",
                "prompt": prompt,
                "width": width,
                "height": height,
                "steps": steps,
                "seed": view_seed,
                "pipeline": pipeline_type,
                "view": view,
                "variant": var_label,
            }
            with open(run_file, "w") as _f:
                _json.dump(run_data, _f, indent=2)
            now = _dt.now(_tz.utc).isoformat()
            mf = Manifest.from_success(
                run_file=run_file,
                start_time=now,
                end_time=now,
                timings=getattr(result, "timings", {}),
                output_files=[{"path": out_path, "seed": view_seed,
                               "width": width, "height": height}],
                models=collect_model_fingerprint(),
            )
            mf.to_json(manifest_file)
            manifest_paths.append(manifest_file)
            labels.append(f"{var_label}/{view}")

        del pipeline
        mx.clear_cache()
        gc.collect()

    if manifest_paths:
        html_path = os.path.join(cfg.OUTPUT_DIR, f"selftest-{test_name}-{ts}.html")
        _open_manifest_review(manifest_paths, labels=labels, output=html_path, auto_score=False)


# ---------------------------------------------------------------------------
# FLF2V self-test handler (type="flf2v" in _ALL_TESTS)
# ---------------------------------------------------------------------------

def _run_selftest_flf2v(args, test_name: str, test_cfg: dict):
    """Run a 3-step FLF2V self-test: T2I begin → T2I end (with reference) → FLF2V.

    Best practice (from docs and proven across experiments):
      1. Generate begin frame: same seed, free T2I generation
      2. Generate end frame:   same seed, DIFFERENT prompt, input_image=<begin_frame>
         for background consistency
      3. Run FLF2V:            cfg_scale=3.0, stage1_steps=20 (auto-set by pipeline)

    If the test config has a ``configs`` dict, step 3 runs once per config
    (reusing the same begin/end keyframes), producing A/B comparison videos.

    After generation, renders an HTML review with a 3-column layout:
      begin frame | video player | end frame
    """
    import argparse as _argparse
    import base64
    import gc
    import json as _json
    import time as _time
    import mlx.core as mx
    from PIL import Image
    from datetime import datetime as _dt, timezone as _tz
    from app.pipeline import ZImagePipeline
    from app.ltx_pipeline import LTXVideoPipeline
    from app.manifest import Manifest, collect_model_fingerprint
    from app.commands.caption import _image_to_base64
    from app import config as _cfg
    from app.test_prompts_flf2v import get_flf2v_test
    _vid_gen = importlib.import_module("app.commands.video-generate")

    # --- Resolve test config ---
    flf2v_name = test_cfg["flf2v_test"]
    ft = get_flf2v_test(flf2v_name)

    seed = ft.get("seed", 42) % (2 ** 32)
    width = ft.get("width", 704)
    height = ft.get("height", 480)
    t2i_steps = ft.get("t2i_steps", 9)
    frames = ft.get("frames", 97)
    fps = ft.get("fps", 24.0)
    cfg_scale = ft.get("cfg_scale", 3.0)
    stg_scale = ft.get("stg_scale", 1.0)

    begin_prompt = ft["begin_prompt"]
    end_prompt = ft["end_prompt"]
    motion_prompt = ft["motion_prompt"]

    ts = _time.strftime("%Y%m%d_%H%M%S")
    base = f"selftest_{test_name}_{ts}"
    os.makedirs(_cfg.OUTPUT_DIR, exist_ok=True)

    print(f"\n{'=' * 60}")
    print(f"FLF2V Self-Test — {test_name}")
    print(f"{'=' * 60}")
    print(f"  Seed:        {seed}")
    print(f"  Size:        {width}×{height}")
    print(f"  Frames:      {frames} @ {fps}fps = {frames / fps:.1f}s")
    print(f"  T2I steps:   {t2i_steps}")
    print(f"  FLF2V cfg:   {cfg_scale}  stg_scale: {stg_scale}")
    print(f"  Pipeline:    T2I begin → T2I end (ref) → FLF2V")
    print()

    timings = {}

    # === STEP 1: Generate begin frame (free T2I, same seed) ===
    print(f"[selftest] Step 1/3: Generating begin frame...")
    print(f"  Prompt: {begin_prompt[:80]}...")
    t0 = _time.time()

    img_pipeline = ZImagePipeline()
    begin_result = img_pipeline.generate(
        prompt=begin_prompt,
        width=width,
        height=height,
        steps=t2i_steps,
        seed=seed,
    )
    begin_path = os.path.join(_cfg.OUTPUT_DIR, f"{base}_begin.png")
    begin_result.image.save(begin_path)
    timings["t2i_begin"] = _time.time() - t0
    print(f"  Saved: {begin_path} ({timings['t2i_begin']:.1f}s)")

    # === STEP 2: Generate end frame (same seed, different prompt,
    #             input_image=begin for background consistency) ===
    print(f"\n[selftest] Step 2/3: Generating end frame (reference=begin)...")
    print(f"  Prompt: {end_prompt[:80]}...")
    t0 = _time.time()

    begin_pil = Image.open(begin_path).convert("RGB")
    end_result = img_pipeline.generate(
        prompt=end_prompt,
        width=width,
        height=height,
        steps=t2i_steps,
        seed=seed,
        input_image=begin_pil,
    )
    end_path = os.path.join(_cfg.OUTPUT_DIR, f"{base}_end.png")
    end_result.image.save(end_path)
    timings["t2i_end"] = _time.time() - t0
    print(f"  Saved: {end_path} ({timings['t2i_end']:.1f}s)")

    # Free image pipeline to reclaim memory before loading video pipeline
    del img_pipeline, begin_result, end_result, begin_pil
    mx.clear_cache()
    gc.collect()
    print("[selftest] Image pipeline freed, memory cleared.")

    # === STEP 3: Run FLF2V interpolation ===
    # Auto-adjust resolution and frames for pipeline constraints
    vid_width, vid_height = _vid_gen._adjust_resolution(width, height)
    vid_frames = _vid_gen._adjust_frames(frames)

    # Determine FLF2V configs (single run or A/B variations)
    flf2v_configs = ft.get("configs", None)
    if flf2v_configs is None:
        flf2v_configs = {"default": {
            "label": f"cfg={cfg_scale}, s1={ft.get('stage1_steps', 20)}",
            "cfg_scale": cfg_scale,
            "stg_scale": stg_scale,
            "stage1_steps": ft.get("stage1_steps", 20),
            "stage2_steps": ft.get("stage2_steps", 3),
        }}

    video_paths = []
    config_labels = []
    video_timings_list = []

    video_pipeline = LTXVideoPipeline()

    for config_key, config_vals in flf2v_configs.items():
        config_label = config_vals.get("label", config_key)
        config_labels.append(config_label)

        s1 = config_vals.get("stage1_steps", ft.get("stage1_steps", 20))
        s2 = config_vals.get("stage2_steps", ft.get("stage2_steps", 3))
        c_cfg = config_vals.get("cfg_scale", cfg_scale)
        c_stg = config_vals.get("stg_scale", stg_scale)

        suffix = f"_{config_key}" if len(flf2v_configs) > 1 else ""
        video_path = os.path.join(_cfg.OUTPUT_DIR, f"{base}{suffix}.mp4")
        video_run_file = os.path.join(_cfg.OUTPUT_DIR, f"{base}{suffix}.run.json")
        video_manifest_file = os.path.join(_cfg.OUTPUT_DIR, f"{base}{suffix}.manifest.json")

        print(f"\n[selftest] Step 3/3: FLF2V interpolation [{config_label}]...")
        print(f"  Motion:  {motion_prompt[:80]}...")
        print(f"  Params:  stage1={s1}, stage2={s2}, cfg={c_cfg}, stg={c_stg}")
        t0 = _time.time()

        video_timings = video_pipeline.generate_flf2v(
            prompt=motion_prompt,
            output_path=video_path,
            begin_image=begin_path,
            end_image=end_path,
            height=vid_height,
            width=vid_width,
            num_frames=vid_frames,
            frame_rate=fps,
            seed=seed,
            stage1_steps=s1,
            stage2_steps=s2,
            cfg_scale=c_cfg,
            stg_scale=c_stg,
        )

        elapsed = _time.time() - t0
        timings[f"flf2v_{config_key}"] = elapsed
        video_timings_list.append(video_timings)
        video_paths.append(video_path)
        print(f"  Saved: {video_path} ({elapsed:.1f}s)")

        # Write video manifest
        run_data = {
            "command": "video",
            "action": "generate",
            "prompt": motion_prompt,
            "width": vid_width,
            "height": vid_height,
            "frames": vid_frames,
            "fps": fps,
            "seed": seed,
            "stage1_steps": s1,
            "stage2_steps": s2,
            "cfg_scale": c_cfg,
            "stg_scale": c_stg,
            "pipeline": "ltx-flf2v",
            "begin_image": begin_path,
            "end_image": end_path,
        }
        with open(video_run_file, "w") as _f:
            _json.dump(run_data, _f, indent=2)

        fp_args = _argparse.Namespace(distilled=False, temporal_upscale=False)
        models = _vid_gen._collect_model_fingerprints(video_pipeline._model_dir, args=fp_args)
        now = _dt.now(_tz.utc).isoformat()
        mf = Manifest.from_success(
            run_file=video_run_file,
            start_time=now,
            end_time=now,
            timings=video_timings,
            output_files=[{
                "path": video_path,
                "seed": seed,
                "width": vid_width,
                "height": vid_height,
                "frames": vid_frames,
                "fps": fps,
                "size_bytes": os.path.getsize(video_path) if os.path.exists(video_path) else 0,
            }],
            models=models,
        )
        mf.to_json(video_manifest_file)

    # Free video pipeline
    del video_pipeline
    mx.clear_cache()
    gc.collect()

    # === RENDER HTML REVIEW ===
    html_path = _render_flf2v_html(
        test_name=test_name,
        test_cfg=ft,
        begin_path=begin_path,
        end_path=end_path,
        video_paths=video_paths,
        config_labels=config_labels,
        timings=timings,
        seed=seed,
        width=vid_width,
        height=vid_height,
        frames=vid_frames,
        fps=fps,
        ts=ts,
        output_dir=_cfg.OUTPUT_DIR,
    )

    total_time = sum(v for v in timings.values() if isinstance(v, (int, float)))
    print(f"\n{'=' * 60}")
    print(f"FLF2V Self-Test Complete — {test_name}")
    print(f"{'=' * 60}")
    print(f"  Begin frame: {begin_path}")
    print(f"  End frame:   {end_path}")
    for i, vp in enumerate(video_paths):
        print(f"  Video:       {vp}")
    print(f"  HTML review: {html_path}")
    print(f"  Timing:      T2I-begin {timings['t2i_begin']:.0f}s + "
          f"T2I-end {timings['t2i_end']:.0f}s + "
          f"FLF2V {sum(v for k, v in timings.items() if k.startswith('flf2v') and isinstance(v, (int, float))):.0f}s = "
          f"{total_time:.0f}s total")

    subprocess.Popen(["open", html_path])


def _run_selftest_faceswap(args, test_name: str, test_cfg: dict):
    """Run a BFS faceswap self-test: generate body + face images, then swap.

    Delegates to image-faceswap._generate_body_zimage(),
    image-faceswap._generate_face_flux2(), and
    image-faceswap._run_faceswap_core() for the actual pipeline work.

    Test config fields (from _ALL_TESTS):
        body_prompt  — prompt for body image (ZImage pipeline)
        face_prompt  — prompt for face image (Flux2 T2I pipeline)
        mode         — "head" or "face" (default: "head")
        body_seed    — seed for body generation (default: 42)
        face_seed    — seed for face generation (default: 100)
    """
    import importlib
    import time as _time

    _fs = importlib.import_module("app.commands.image-faceswap")

    body_prompt = test_cfg["body_prompt"]
    face_prompt = test_cfg["face_prompt"]
    swap_mode = test_cfg.get("mode", "head")
    body_seed = test_cfg.get("body_seed", 42)
    face_seed = test_cfg.get("face_seed", 100)

    os.makedirs(cfg.OUTPUT_DIR, exist_ok=True)
    ts = _time.strftime("%Y%m%d_%H%M%S")
    base_prefix = f"selftest_{test_name}_{ts}"

    print(f"\n{'#'*60}")
    print(f" FaceSwap Self-Test: {test_name}")
    print(f" Mode: {swap_mode}")
    print(f"{'#'*60}")

    # Override mode for the swap (e.g. cross-gender requires "head")
    args.mode = swap_mode

    # Phase 1: Generate body image (ZImage pipeline)
    body_path, body_manifest = _fs._generate_body_zimage(
        prompt=body_prompt,
        seed=body_seed,
        label="body",
        base=f"{base_prefix}_body",
    )

    # Phase 2: Generate face image (Flux2 T2I pipeline)
    face_path, face_manifest = _fs._generate_face_flux2(
        prompt=face_prompt,
        seed=face_seed,
        label="face",
        base=f"{base_prefix}_face",
    )

    # Phase 3: Run faceswap (Flux2 Klein Edit + BFS LoRA)
    print(f"\n{'='*60}")
    print(f"[selftest] Running faceswap (mode={swap_mode})")
    print(f"{'='*60}")

    result_path, result_manifest = _fs._run_faceswap_core(
        body_path, face_path, args
    )

    # Phase 4: Optional VLM quality scoring
    print(f"\n{'='*60}")
    print(f"[selftest] VLM quality scoring (optional)")
    print(f"{'='*60}")

    scores = {}
    for img_path, lbl in [(body_path, "body"), (face_path, "face"),
                           (result_path, "result")]:
        score = _fs._score_with_vlm(img_path, lbl)
        if score:
            scores[lbl] = score

    if scores:
        print(f"[VLM] Scored {len(scores)}/3 images")
    else:
        print("[VLM] Server not available — start LM Studio with Qwen3-VL to enable scoring")

    # Phase 5: Open HTML review with all 3 results
    print(f"\n{'='*60}")
    print(f"[selftest] Generating review HTML")
    print(f"{'='*60}")

    manifest_files = [body_manifest, face_manifest, result_manifest]

    labels = []
    for lbl, name in [
        (f"1-Body (ZImage, {swap_mode} mode)", "body"),
        (f"2-Face (Flux2 T2I)", "face"),
        (f"3-FaceSwap Result ({swap_mode} mode)", "result"),
    ]:
        if name in scores:
            s = scores[name]
            labels.append(f"{lbl} — score {s.get('overall', '?')}/10")
        else:
            labels.append(lbl)

    _open_manifest_review(manifest_files, labels=labels)


def _run_selftest_swap(args, test_name: str, test_cfg: dict):
    """Run a SAM3 text-prompted swap self-test.

    Generates source + reference images via ZImagePipeline, runs SAM3
    segmentation and compositing, then opens an HTML review.

    Test config fields (from _ALL_TESTS):
        source_prompt     — prompt for source image (ZImage pipeline)
        reference_prompt  — prompt for reference image (ZImage pipeline)
        sam_prompt        — SAM3 text prompt for segmentation
        sam_threshold     — detection score threshold (default: 0.3)
        feather           — mask edge feathering radius (default: 15)
        source_seed       — seed for source generation (default: 42)
        reference_seed    — seed for reference generation (default: 100)
        source_width      — source image width (default: 640)
        source_height     — source image height (default: 960)
        reference_width   — reference image width (default: 640)
        reference_height  — reference image height (default: 960)
    """
    import importlib
    import time as _time

    _swap = importlib.import_module("app.commands.image-swap")

    source_prompt = test_cfg["source_prompt"]
    reference_prompt = test_cfg["reference_prompt"]
    sam_prompt = test_cfg["sam_prompt"]
    sam_threshold = test_cfg.get("sam_threshold", 0.3)
    feather = test_cfg.get("feather", 15)
    source_seed = test_cfg.get("source_seed", 42)
    reference_seed = test_cfg.get("reference_seed", 100)
    source_w = test_cfg.get("source_width", 640)
    source_h = test_cfg.get("source_height", 960)
    ref_w = test_cfg.get("reference_width", 640)
    ref_h = test_cfg.get("reference_height", 960)

    os.makedirs(cfg.OUTPUT_DIR, exist_ok=True)
    ts = _time.strftime("%Y%m%d_%H%M%S")
    base_prefix = f"selftest_{test_name}_{ts}"

    print(f"\n{'#'*60}")
    print(f" SAM3 Swap Self-Test: {test_name}")
    print(f" SAM prompt: '{sam_prompt}' (threshold={sam_threshold})")
    print(f"{'#'*60}")

    # Phase 1: Generate source image (ZImage pipeline)
    source_path, source_manifest = _swap._generate_test_image(
        prompt=source_prompt,
        seed=source_seed,
        label="source",
        base=f"{base_prefix}_source",
        width=source_w,
        height=source_h,
        write_manifest=True,
    )

    # Phase 2: Generate reference image (ZImage pipeline)
    ref_path, ref_manifest = _swap._generate_test_image(
        prompt=reference_prompt,
        seed=reference_seed,
        label="reference",
        base=f"{base_prefix}_ref",
        width=ref_w,
        height=ref_h,
        write_manifest=True,
    )

    # Phase 3: Run SAM3 swap pipeline
    swap_mode = test_cfg.get("mode", "composite")
    print(f"\n{'='*60}")
    print(f"[selftest] Running SAM3 swap — mode={swap_mode} "
          f"(prompt='{sam_prompt}', feather={feather})")
    print(f"{'='*60}")

    # Set swap args for _run_swap_core
    args.sam_prompt = sam_prompt
    args.ref_sam_prompt = test_cfg.get("ref_sam_prompt", None)
    args.sam_threshold = sam_threshold
    args.feather = feather
    args.save_mask = True
    args.seed = source_seed
    args.steps = getattr(args, "steps", None) or 9

    if swap_mode == "inpaint":
        args.inpaint = True
        args.inpaint_prompt = test_cfg.get("inpaint_prompt")
        args.inpaint_strength = test_cfg.get("inpaint_strength", 0.7)
        args.blend = False
    else:
        args.inpaint = False
        args.blend = test_cfg.get("blend", False)
        args.blend_strength = test_cfg.get("blend_strength", 0.4)
        args.blend_prompt = test_cfg.get("blend_prompt", None)
        args.preserve_aspect_ratio = test_cfg.get("preserve_aspect_ratio", False)
        args.mask_dilate = test_cfg.get("mask_dilate", 0)

    out = _swap._run_swap_core(source_path, ref_path, args)

    # Phase 4: Write manifests for result images
    mask_path = out.get("mask")
    overlay_path = out.get("overlay")
    inpaint_path = out.get("inpaint")
    composite_path = out.get("composite")
    blend_path = out.get("blend")
    blend_manifest = None

    from app.manifest import Manifest, collect_model_fingerprint

    now_start = datetime.now(timezone.utc).isoformat()
    now_end = datetime.now(timezone.utc).isoformat()
    models = collect_model_fingerprint()
    result_manifest = None

    if swap_mode == "inpaint" and inpaint_path and os.path.exists(inpaint_path):
        run_file = out.get("run")
        manifest_file = out.get("manifest")

        run_data = {
            "command": "image",
            "action": "swap-inpaint",
            "sam_prompt": sam_prompt,
            "sam_threshold": sam_threshold,
            "feather": feather,
            "inpaint_prompt": test_cfg.get("inpaint_prompt", ""),
            "inpaint_strength": test_cfg.get("inpaint_strength", 0.7),
            "source_image": source_path,
            "reference_image": ref_path,
            "pipeline": "sam3-inpaint",
        }
        with open(run_file, "w") as f:
            json.dump(run_data, f, indent=2, ensure_ascii=False)
            f.write("\n")

        manifest = Manifest.from_success(
            run_file, now_start, now_end, {},
            [{
                "path": inpaint_path,
                "seed": source_seed,
                "size_bytes": os.path.getsize(inpaint_path),
                "width": source_w,
                "height": source_h,
            }],
            models,
        )
        manifest.to_json(manifest_file)
        result_manifest = manifest_file

    elif composite_path and os.path.exists(composite_path):
        run_file = out.get("run")
        manifest_file = out.get("manifest")

        run_data = {
            "command": "image",
            "action": "swap",
            "sam_prompt": sam_prompt,
            "sam_threshold": sam_threshold,
            "feather": feather,
            "source_image": source_path,
            "reference_image": ref_path,
            "pipeline": "sam3-composite",
        }
        if blend_path:
            run_data["blend"] = True
            run_data["blend_strength"] = test_cfg.get("blend_strength", 0.4)
        with open(run_file, "w") as f:
            json.dump(run_data, f, indent=2, ensure_ascii=False)
            f.write("\n")

        manifest = Manifest.from_success(
            run_file, now_start, now_end, {},
            [{
                "path": composite_path,
                "seed": source_seed,
                "size_bytes": os.path.getsize(composite_path),
                "width": source_w,
                "height": source_h,
            }],
            models,
        )
        manifest.to_json(manifest_file)
        result_manifest = manifest_file

        # Separate manifest for blend result (shows as 4th review item)
        if blend_path and os.path.exists(blend_path):
            blend_base = blend_path.replace(".png", "")
            blend_run_file = f"{blend_base}.run.json"
            blend_manifest_file = f"{blend_base}.manifest.json"

            blend_run_data = {
                "command": "image",
                "action": "swap-blend",
                "sam_prompt": sam_prompt,
                "feather": feather,
                "composite_image": composite_path,
                "blend_strength": test_cfg.get("blend_strength", 0.4),
                "pipeline": "flux2-klein-i2i",
            }
            with open(blend_run_file, "w") as f:
                json.dump(blend_run_data, f, indent=2, ensure_ascii=False)
                f.write("\n")

            b_manifest = Manifest.from_success(
                blend_run_file, now_start, now_end, {},
                [{
                    "path": blend_path,
                    "seed": source_seed,
                    "size_bytes": os.path.getsize(blend_path),
                    "width": source_w,
                    "height": source_h,
                }],
                models,
            )
            b_manifest.to_json(blend_manifest_file)
            blend_manifest = blend_manifest_file

        # Separate manifest for final (mask-blended) result
        final_path = out.get("final")
        final_manifest = None
        if final_path and os.path.exists(final_path):
            final_base = final_path.replace(".png", "")
            final_run_file = f"{final_base}.run.json"
            final_manifest_file = f"{final_base}.manifest.json"

            final_run_data = {
                "command": "image",
                "action": "swap-final",
                "sam_prompt": sam_prompt,
                "feather": feather,
                "composite_image": composite_path,
                "blend_strength": test_cfg.get("blend_strength", 0.4),
                "preserve_aspect_ratio": test_cfg.get("preserve_aspect_ratio", False),
                "pipeline": "sam3-composite-blend-maskblend",
            }
            with open(final_run_file, "w") as f:
                json.dump(final_run_data, f, indent=2, ensure_ascii=False)
                f.write("\n")

            f_manifest = Manifest.from_success(
                final_run_file, now_start, now_end, {},
                [{
                    "path": final_path,
                    "seed": source_seed,
                    "size_bytes": os.path.getsize(final_path),
                    "width": source_w,
                    "height": source_h,
                }],
                models,
            )
            f_manifest.to_json(final_manifest_file)
            final_manifest = final_manifest_file

    # Handle no-result case
    if not result_manifest:
        print(f"\n[selftest] No result generated — skipping review.")
        print(f"  Source:      {source_path}")
        print(f"  Reference:   {ref_path}")
        if mask_path:
            print(f"  Mask:        {mask_path}")
        return

    # Phase 5: Optional VLM quality scoring
    print(f"\n{'='*60}")
    print(f"[selftest] VLM quality scoring (optional)")
    print(f"{'='*60}")

    _fs = importlib.import_module("app.commands.image-faceswap")
    scores = {}
    images_to_score = [(source_path, "source"), (ref_path, "reference")]
    if inpaint_path and os.path.exists(inpaint_path):
        images_to_score.append((inpaint_path, "inpaint"))
    if composite_path and os.path.exists(composite_path):
        images_to_score.append((composite_path, "composite"))
    if blend_path and os.path.exists(blend_path):
        images_to_score.append((blend_path, "blend"))
    final_path = out.get("final")
    if final_path and os.path.exists(final_path):
        images_to_score.append((final_path, "final"))
    for img_path, lbl in images_to_score:
        score = _fs._score_with_vlm(img_path, lbl)
        if score:
            scores[lbl] = score

    if scores:
        print(f"[VLM] Scored {len(scores)}/{len(images_to_score)} images")
    else:
        print("[VLM] Server not available — start LM Studio with Qwen3-VL to enable scoring")

    # Phase 6: Open HTML review with all results
    print(f"\n{'='*60}")
    print(f"[selftest] Generating review HTML")
    print(f"{'='*60}")

    manifest_files = [source_manifest, ref_manifest]
    if result_manifest:
        manifest_files.append(result_manifest)
    if blend_manifest:
        manifest_files.append(blend_manifest)
    if final_manifest:
        manifest_files.append(final_manifest)

    review_entries = [
        (f"1-Source (ZImage)", "source"),
        (f"2-Reference (ZImage)", "reference"),
    ]
    if swap_mode == "inpaint":
        inpaint_strength = test_cfg.get("inpaint_strength", 0.7)
        review_entries.append(
            (f"3-Inpaint (Flux Klein I2I, strength={inpaint_strength})", "inpaint")
        )
    else:
        review_entries.append(
            (f"3-Composite (SAM3: '{sam_prompt}')", "composite")
        )
        if blend_path and os.path.exists(blend_path):
            blend_strength = test_cfg.get("blend_strength", 0.4)
            review_entries.append(
                (f"4-Blend (Flux Klein I2I, strength={blend_strength})", "blend")
            )
        if final_path and os.path.exists(final_path):
            review_entries.append(
                (f"5-Final (mask-blended: source outside, I2I inside)", "final")
            )

    labels = []
    for lbl, name in review_entries:
        if name in scores:
            s = scores[name]
            labels.append(f"{lbl} — score {s.get('overall', '?')}/10")
        else:
            labels.append(lbl)

    _open_manifest_review(manifest_files, labels=labels)


def _run_selftest_expansion(args, test_name: str, test_cfg: dict):
    """Run a Flux2 Klein outpaint (image expansion) self-test.

    Generates a square source image, then expands it across the configured
    variants (directional --expand and/or --ratio) with a single shared model
    load, VLM-scores each result, and opens a side-by-side HTML review.

    Test config fields (from _ALL_TESTS):
        source_prompt  — prompt for the source image
        source_seed    — seed for source generation (default: 42)
        source_width   — source width  (default: 1024)
        source_height  — source height (default: 1024)
        feather        — mask feather px (default: 64)
        steps          — denoise steps (default: 4)
        longest        — scale source longest side to (default: 1024)
        configs        — list of {label, mode('expand'|'ratio'), dirs/pixels or
                         ratio, seed, prompt}
    """
    import gc
    import time as _time
    import webbrowser

    import mlx.core as mx
    from PIL import Image

    from app.flux2_outpaint_pipeline import Flux2OutpaintPipeline

    _exp = importlib.import_module("app.commands.image-expansion")
    _swap = importlib.import_module("app.commands.image-swap")
    _fs = importlib.import_module("app.commands.image-faceswap")

    source_prompt = test_cfg["source_prompt"]
    source_seed = test_cfg.get("source_seed", 42)
    src_w = test_cfg.get("source_width", 1024)
    src_h = test_cfg.get("source_height", 1024)
    feather = test_cfg.get("feather", 96)
    overlap = test_cfg.get("overlap", 96)
    longest = test_cfg.get("longest", 1024)
    steps = getattr(args, "steps", None) or test_cfg.get("steps", 4)
    configs = test_cfg.get("configs", [])

    os.makedirs(cfg.OUTPUT_DIR, exist_ok=True)
    ts = _time.strftime("%Y%m%d_%H%M%S")
    base_prefix = f"selftest_{test_name}_{ts}"

    print(f"\n{'#'*60}")
    print(f" Flux2 Klein Outpaint Self-Test: {test_name}")
    print(f" variants: {len(configs)} | steps: {steps} | feather: {feather} | overlap: {overlap}")
    print(f"{'#'*60}")

    # Phase 1: Generate a square source image (ZImage pipeline)
    source_path = _swap._generate_test_image(
        prompt=source_prompt,
        seed=source_seed,
        label="source",
        base=f"{base_prefix}_source",
        width=src_w,
        height=src_h,
    )
    source = Image.open(source_path).convert("RGB")
    src_ow, src_oh = source.size

    # Phase 2: Load the outpaint pipeline ONCE, run all variants
    print(f"\n{'='*60}")
    print(f"[selftest] Loading Flux2 Klein outpaint pipeline (shared across variants)")
    print(f"{'='*60}")
    pipeline = Flux2OutpaintPipeline()
    results = []  # list of (label, path, (cw, ch))
    try:
        for c in configs:
            label = c.get("label", "variant")
            mode = c.get("mode", "expand")
            if mode == "ratio":
                sw, sh, left, top, cw, ch = _exp.compute_canvas(
                    src_ow, src_oh, expand_dirs=None, pixels=0,
                    ratio=c["ratio"], longest=longest,
                )
            else:
                dirs = {d.strip().lower() for d in c.get("dirs", "left,right").split(",")}
                sw, sh, left, top, cw, ch = _exp.compute_canvas(
                    src_ow, src_oh, expand_dirs=dirs,
                    pixels=c.get("pixels", 512), ratio=None, longest=longest,
                )
            padded, mask = _exp.build_padded_and_mask(
                source, sw, sh, left, top, cw, ch, feather, overlap=overlap,
            )
            print(f"\n[selftest] Variant '{label}': {mode} → canvas {cw}x{ch}")
            res = pipeline.expand(
                padded_image=padded,
                mask_image=mask,
                width=cw,
                height=ch,
                prompt=c.get("prompt", _exp._DEFAULT_PROMPT),
                steps=steps,
                seed=c.get("seed", source_seed),
            )
            out_path = os.path.join(cfg.OUTPUT_DIR, f"{base_prefix}_{label}.png")
            res.image.save(out_path)
            print(f"  Saved: {out_path}")
            results.append((label, out_path, (cw, ch)))
    finally:
        del pipeline
        mx.clear_cache()
        gc.collect()

    if not results:
        print(f"\n[selftest] No expansion variants produced — skipping review.")
        return

    # Phase 3: Optional VLM quality scoring
    print(f"\n{'='*60}")
    print(f"[selftest] VLM quality scoring (optional)")
    print(f"{'='*60}")
    scores = {}
    s = _fs._score_with_vlm(source_path, "source")
    if s:
        scores["source"] = s
    for label, path, _ in results:
        s = _fs._score_with_vlm(path, label)
        if s:
            scores[label] = s
    if scores:
        print(f"[VLM] Scored {len(scores)} image(s)")
    else:
        print("[VLM] Server not available — start LM Studio with Qwen3-VL to enable scoring")

    # Phase 4: Side-by-side HTML review
    html_path = os.path.join(cfg.OUTPUT_DIR, f"selftest-{test_name}-{ts}.html")
    _render_expansion_html(
        html_path=html_path,
        test_name=test_name,
        description=test_cfg.get("description", ""),
        source_path=source_path,
        results=results,
        scores=scores,
    )
    print(f"\n[selftest] Review HTML: {html_path}")
    webbrowser.open(f"file://{os.path.abspath(html_path)}")


def _render_expansion_html(*, html_path, test_name, description, source_path, results, scores):
    """Write a simple side-by-side HTML review for an expansion self-test."""
    import base64

    def _img_b64(path):
        with open(path, "rb") as f:
            return "data:image/png;base64," + base64.b64encode(f.read()).decode()

    def _score_card(label):
        s = scores.get(label)
        if not s:
            return "<p class='noscore'>VLM score: n/a</p>"
        dims = ["overall", "detail", "sharpness", "composition", "prompt_adherence", "artifacts"]
        cells = "".join(
            f"<span class='dim'><b>{d}</b> {s.get(d, '?')}</span>" for d in dims if d in s
        )
        return f"<p class='score'>VLM overall <b>{s.get('overall', '?')}/10</b></p><div class='dims'>{cells}</div>"

    cards = []
    src_head = description.split("—")[0].strip() if "—" in description else "original"
    cards.append(
        f"<div class='card'><h3>Source ({src_head})</h3>"
        f"<img src='{_img_b64(source_path)}'/>{_score_card('source')}</div>"
    )
    for label, path, (cw, ch) in results:
        cards.append(
            f"<div class='card'><h3>{label} <small>({cw}×{ch})</small></h3>"
            f"<img src='{_img_b64(path)}'/>{_score_card(label)}</div>"
        )

    html = f"""<!doctype html><html><head><meta charset="utf-8"/>
<title>Expansion self-test — {test_name}</title>
<style>
 body {{ font-family: -apple-system, sans-serif; background: #1a1a1a; color: #eee; margin: 24px; }}
 h1 {{ font-size: 20px; }} p.desc {{ color: #aaa; max-width: 900px; }}
 .row {{ display: flex; flex-wrap: wrap; gap: 20px; align-items: flex-start; }}
 .card {{ background: #262626; border-radius: 10px; padding: 12px; max-width: 520px; }}
 .card h3 {{ margin: 4px 0 8px; font-size: 15px; }} .card h3 small {{ color: #888; font-weight: normal; }}
 .card img {{ max-width: 100%; border-radius: 6px; display: block; }}
 .score {{ margin: 8px 0 4px; color: #6f6; }} .noscore {{ margin: 8px 0; color: #888; }}
 .dims {{ display: flex; flex-wrap: wrap; gap: 8px; }} .dim {{ background:#333; padding:3px 8px; border-radius:4px; font-size:12px; }}
</style></head><body>
<h1>Flux2 Klein Outpaint — {test_name}</h1>
<p class="desc">{description}</p>
<div class="row">
{''.join(cards)}
</div></body></html>"""
    with open(html_path, "w") as f:
        f.write(html)


def _render_flf2v_html(*, test_name, test_cfg, begin_path, end_path,
                        video_paths, config_labels, timings, seed, width, height,
                        frames, fps, ts, output_dir) -> str:
    """Render a self-contained HTML review page for FLF2V self-test results.

    Layout: 3-column — begin frame | video player(s) | end frame.
    For A/B configs, multiple video columns are shown side-by-side.
    """
    import base64
    from app.commands.caption import _image_to_base64

    begin_b64 = _image_to_base64(begin_path, max_size=512)
    end_b64 = _image_to_base64(end_path, max_size=512)

    # Embed videos as base64 data URIs
    video_b64s = []
    for vp in video_paths:
        with open(vp, "rb") as _f:
            video_b64s.append(base64.b64encode(_f.read()).decode("ascii"))

    # Build video columns
    video_columns_html = ""
    for i, (v_b64, label) in enumerate(zip(video_b64s, config_labels)):
        video_columns_html += f"""
        <div class="video-col">
            <h3>Video: {label}</h3>
            <video controls autoplay loop muted playsinline width="100%">
                <source src="data:video/mp4;base64,{v_b64}" type="video/mp4">
            </video>
        </div>"""

    # Timing rows
    timing_rows = ""
    timing_keys = [
        ("t2i_begin", "T2I Begin Frame"),
        ("t2i_end", "T2I End Frame (ref)"),
    ]
    for key, label in timing_keys:
        if key in timings:
            timing_rows += f"<tr><td>{label}</td><td>{timings[key]:.1f}s</td></tr>\n"
    for i, label in enumerate(config_labels):
        flf2v_key = None
        for k in timings:
            if k.startswith("flf2v_") and timings[k] is not None:
                # Match by index for multiple configs
                flf2v_keys = [k2 for k2 in timings if k2.startswith("flf2v_") and isinstance(timings[k2], (int, float))]
                if i < len(flf2v_keys):
                    flf2v_key = flf2v_keys[i]
                break
        if flf2v_key and flf2v_key in timings:
            timing_rows += f"<tr><td>FLF2V [{label}]</td><td>{timings[flf2v_key]:.1f}s</td></tr>\n"
    total = sum(v for v in timings.values() if isinstance(v, (int, float)))
    timing_rows += f'<tr class="total"><td><strong>Total</strong></td><td><strong>{total:.1f}s</strong></td></tr>\n'

    # Compute FLF2V estimated minutes per run
    est_min = total / 60

    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>FLF2V Self-Test — {test_name}</title>
<style>
  body {{ font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         margin: 0; padding: 20px; background: #1a1a2e; color: #e0e0e0; }}
  .container {{ max-width: 1400px; margin: 0 auto; }}
  h1 {{ color: #e94560; border-bottom: 2px solid #e94560; padding-bottom: 8px; }}
  h2 {{ color: #0f3460; background: #16213e; padding: 8px 12px; border-radius: 4px; }}
  h3 {{ color: #a8d8ea; margin: 8px 0; }}
  .meta {{ background: #16213e; padding: 12px 16px; border-radius: 6px; margin: 12px 0;
           display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 8px; }}
  .meta dt {{ color: #a8d8ea; font-size: 0.85em; }}
  .meta dd {{ margin: 0 0 8px 0; font-weight: bold; }}
  .keyframes {{ display: flex; gap: 12px; margin: 16px 0; align-items: flex-start; }}
  .frame-col, .video-col {{ flex: 1; text-align: center; }}
  .frame-col img, .video-col video {{
      border: 2px solid #0f3460; border-radius: 6px; max-width: 100%;
      box-shadow: 0 4px 12px rgba(0,0,0,0.4); }}
  .prompt {{ background: #16213e; padding: 12px 16px; border-radius: 6px;
             margin: 12px 0; font-size: 0.9em; line-height: 1.5;
             border-left: 4px solid #e94560; }}
  .prompt strong {{ color: #e94560; }}
  table {{ border-collapse: collapse; width: 100%; margin: 12px 0; }}
  th, td {{ padding: 8px 12px; text-align: left; border-bottom: 1px solid #333; }}
  th {{ background: #16213e; color: #a8d8ea; }}
  .total {{ border-top: 2px solid #e94560; }}
  .rating {{ display: flex; gap: 4px; margin: 8px 0; }}
  .rating .star {{ font-size: 24px; cursor: pointer; color: #555; transition: color 0.15s; }}
  .rating .star:hover, .rating .star.active {{ color: #ffd700; }}
  .comment {{ width: 100%; min-height: 60px; background: #16213e; color: #e0e0e0;
              border: 1px solid #333; border-radius: 4px; padding: 8px; font-size: 0.9em;
              resize: vertical; box-sizing: border-box; }}
  .actions {{ margin: 16px 0; }}
  .actions button {{ background: #e94560; color: white; border: none; padding: 8px 20px;
                     border-radius: 4px; cursor: pointer; font-size: 0.95em; margin-right: 8px; }}
  .actions button:hover {{ background: #c73652; }}
</style>
</head>
<body>
<div class="container">
  <h1>FLF2V Self-Test — {test_name}</h1>

  <div class="meta">
    <div><dt>Description</dt><dd>{test_cfg.get('description', '')}</dd></div>
    <div><dt>Seed</dt><dd>{seed}</dd></div>
    <div><dt>Resolution</dt><dd>{width}×{height}</dd></div>
    <div><dt>Frames</dt><dd>{frames} @ {fps}fps = {frames / fps:.1f}s</dd></div>
    <div><dt>Cfg Scale</dt><dd>{test_cfg.get('cfg_scale', 3.0)}</dd></div>
    <div><dt>T2I Steps</dt><dd>{test_cfg.get('t2i_steps', 9)}</dd></div>
    <div><dt>Total Time</dt><dd>{est_min:.1f} min</dd></div>
  </div>

  <h2>Keyframes &amp; Video</h2>
  <div class="keyframes">
    <div class="frame-col">
      <h3>Begin Frame (t=0)</h3>
      <img src="data:image/png;base64,{begin_b64}" alt="Begin frame">
    </div>
    {video_columns_html}
    <div class="frame-col">
      <h3>End Frame (t={frames / fps:.1f}s)</h3>
      <img src="data:image/png;base64,{end_b64}" alt="End frame">
    </div>
  </div>

  <h2>Prompts</h2>
  <div class="prompt"><strong>Begin:</strong> {test_cfg.get('begin_prompt', '')}</div>
  <div class="prompt"><strong>End:</strong> {test_cfg.get('end_prompt', '')}</div>
  <div class="prompt"><strong>Motion:</strong> {test_cfg.get('motion_prompt', '')}</div>

  <h2>Timing</h2>
  <table>
    <tr><th>Step</th><th>Elapsed</th></tr>
    {timing_rows}
  </table>

  <h2>Rating</h2>
  <div class="rating" id="rating">
    <span class="star" data-value="1">★</span>
    <span class="star" data-value="2">★</span>
    <span class="star" data-value="3">★</span>
    <span class="star" data-value="4">★</span>
    <span class="star" data-value="5">★</span>
  </div>
  <textarea class="comment" id="comment" placeholder="Comments on interpolation quality, character consistency, motion naturalness..."></textarea>

  <div class="actions">
    <button onclick="exportResults()">Export Results (JSON)</button>
    <button onclick="copyResults()">Copy to Clipboard</button>
  </div>
</div>

<script>
// Star rating interaction
document.querySelectorAll('.rating .star').forEach(star => {{
    star.addEventListener('click', function() {{
        document.querySelectorAll('.rating .star').forEach(s => s.classList.remove('active'));
        const val = parseInt(this.dataset.value);
        for (let i = 0; i < val; i++) {{
            document.querySelectorAll('.rating .star')[i].classList.add('active');
        }}
    }});
}});

function getRating() {{
    return document.querySelectorAll('.rating .star.active').length;
}}

function exportResults() {{
    const data = {{
        test_name: "{test_name}",
        seed: {seed},
        width: {width},
        height: {height},
        frames: {frames},
        fps: {fps},
        rating: getRating(),
        comment: document.getElementById('comment').value,
        timings: {json.dumps({k: v for k, v in timings.items() if isinstance(v, (int, float))})},
        timestamp: new Date().toISOString(),
    }};
    const blob = new Blob([JSON.stringify(data, null, 2)], {{type: "application/json"}});
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "flf2v_review_" + "{test_name}" + ".json";
    a.click();
    URL.revokeObjectURL(url);
}}

function copyResults() {{
    const text = "FLF2V Self-Test: {test_name}\\n" +
        "Rating: " + getRating() + "/5\\n" +
        "Comment: " + document.getElementById('comment').value + "\\n" +
        "Seed: {seed}, {width}x{height}, {frames}f@{fps}fps\\n" +
        "Total: {total:.1f}s";
    navigator.clipboard.writeText(text).then(() => {{
        const btn = event.target;
        btn.textContent = "Copied!";
        setTimeout(() => btn.textContent = "Copy to Clipboard", 2000);
    }});
}}
</script>
</body>
</html>"""

    html_path = os.path.join(output_dir, f"selftest-{test_name}-{ts}.html")
    with open(html_path, "w") as _f:
        _f.write(html)
    return html_path


# ---------------------------------------------------------------------------
# Mode 5: VAE comparison review
# ---------------------------------------------------------------------------

def run_review_vae(args):
    """Generate images with each VAE variant, analyze quality, and render HTML review."""
    import base64
    import gc
    import mlx.core as mx
    from app.pipeline import ZImagePipeline
    from app.test_prompts_image import get_vae_test, get_test_prompt
    from app.commands._shared import resolve_vae_path
    _quality_mod = importlib.import_module("app.commands.image-quality")

    test_name_raw = getattr(args, "self_test", None)
    test_name = test_name_raw if isinstance(test_name_raw, str) else "ultraflux"

    try:
        test_cfg = get_vae_test(test_name)
    except ValueError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)

    tp_name = test_cfg["test_prompt"]
    seed = getattr(args, "seed", None) or test_cfg["seed"]
    steps = getattr(args, "steps", None) or test_cfg["steps"]

    tp = get_test_prompt(tp_name)
    prompt = tp["prompt"]
    width = tp["width"]
    height = tp["height"]

    os.makedirs(cfg.OUTPUT_DIR, exist_ok=True)
    ts = time.strftime("%Y%m%d_%H%M%S")
    base = f"vae-review-{ts}"

    print(f"[review vae] ═══ VAE Review: {test_name} ═══")
    print(f"[review vae] Prompt: {tp_name!r} | seed={seed} | {width}×{height} | {steps} steps")
    print(f"[review vae] Variants: {', '.join(v['label'] for v in test_cfg['variants'])}")

    image_paths = []
    labels = []
    timings_map = {}

    for vcfg in test_cfg["variants"]:
        label = vcfg["label"]
        raw_vae = vcfg["vae_path"]
        vae_dir = resolve_vae_path(raw_vae) if raw_vae else None
        safe_label = label.lower().replace(" ", "_")
        out_path = os.path.join(cfg.OUTPUT_DIR, f"{base}_{safe_label}.png")

        print(f"\n[review vae] {'─'*50}")
        print(f"[review vae] Generating: {label}")
        if vae_dir:
            print(f"[review vae] VAE:        {os.path.basename(vae_dir)}")
        print(f"[review vae] {'─'*50}")

        pipeline = ZImagePipeline()
        result = pipeline.generate(
            prompt=prompt,
            width=width,
            height=height,
            steps=steps,
            seed=seed,
            vae_dir=vae_dir,
        )
        result.image.save(out_path)
        print(f"[review vae] Saved: {out_path}")
        image_paths.append(out_path)
        labels.append(label)
        timings_map[label] = getattr(result, "timings", {})

        del pipeline, result
        mx.clear_cache()
        gc.collect()

    # Analyze quality
    metrics_list = []
    for path, label in zip(image_paths, labels):
        print(f"\n[review vae] Analyzing {label}: {os.path.basename(path)}")
        report = _quality_mod.analyze_image(path)
        report["label"] = label
        report["timings"] = timings_map.get(label, {})
        metrics_list.append(report)
        _quality_mod._print_single_report(report)

    _quality_mod._print_comparison(metrics_list)

    # Render HTML
    html_path = os.path.join(cfg.OUTPUT_DIR, f"{base}.html")
    html = _render_vae_html(
        test_name=test_name,
        test_cfg=test_cfg,
        image_paths=image_paths,
        labels=labels,
        metrics_list=metrics_list,
        ts=ts,
        tp_name=tp_name,
        seed=seed,
        steps=steps,
        width=width,
        height=height,
        prompt=prompt,
    )
    with open(html_path, "w", encoding="utf-8") as f:
        f.write(html)

    print(f"\n[review vae] HTML generated:")
    print(f"             {html_path}")
    print(f"\n  open {html_path}")
    subprocess.Popen(["open", html_path])


def _render_vae_html(test_name, test_cfg, image_paths, labels, metrics_list,
                     ts, tp_name, seed, steps, width, height, prompt) -> str:
    """Render a self-contained HTML page for VAE comparison."""
    import base64

    # Embed images as base64
    cards_html_parts = []
    for path, label in zip(image_paths, labels):
        with open(path, "rb") as f:
            img_b64 = base64.b64encode(f.read()).decode()
        fname = os.path.basename(path)
        cards_html_parts.append(
            f'<div class="img-card">'
            f'<h3>{label}</h3>'
            f'<img src="data:image/png;base64,{img_b64}" alt="{label}" '
            f'onclick="openLb(this.src)"/>'
            f'<div class="fname">{fname}</div>'
            f'</div>'
        )
    cards_html = "\n    ".join(cards_html_parts)

    # Quality metrics table
    metrics_defs = [
        ("Sharpness (Laplacian σ²)", "sharpness",     "higher"),
        ("Edge density (Sobel mean)", "edge_density",  "higher"),
        ("Contrast (luminance σ)",   "contrast",       "higher"),
        ("Noise (MAD σ)",            "noise_mad",      "lower"),
        ("Saturation σ",             "saturation_std", "—"),
    ]

    header_cols = "".join(f"<th>{l}</th>" for l in labels)

    rows_html_parts = []
    for metric_name, key, direction in metrics_defs:
        values = [r["metrics"][key] for r in metrics_list]

        if direction == "higher":
            best_idx = int(max(range(len(values)), key=lambda i: values[i]))
        elif direction == "lower":
            best_idx = int(min(range(len(values)), key=lambda i: values[i]))
        else:
            best_idx = -1

        row = f"<tr><td class='metric-name'>{metric_name}</td>"
        for i, v in enumerate(values):
            is_best = (best_idx >= 0 and i == best_idx)
            cls = "win" if is_best else "lose"
            fmt = f"{v:.1f}" if abs(v) >= 10 else f"{v:.2f}"
            row += f'<td class="{cls}">{fmt}</td>'

        if len(values) == 2 and direction in ("higher", "lower") and best_idx >= 0:
            base_v, comp_v = values[0], values[1]
            if base_v != 0:
                delta = (comp_v - base_v) / base_v * 100
                sign = "+" if delta > 0 else ""
                dcls = "delta-pos" if delta > 0 else "delta-neg"
                row += (f'<td><span class="{dcls}">{sign}{delta:.0f}%</span> '
                        f'<span class="winner-label">{labels[best_idx]}</span> ✓</td>')
            else:
                row += f'<td><span class="winner-label">{labels[best_idx]}</span> ✓</td>'
        else:
            row += "<td>—</td>"

        row += "</tr>"
        rows_html_parts.append(row)

    rows_html = "\n      ".join(rows_html_parts)

    desc = test_cfg.get("description", "")
    prompt_short = (prompt[:120] + "…") if len(prompt) > 120 else prompt

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>VAE Review — {test_name}</title>
<style>
*{{box-sizing:border-box;margin:0;padding:0}}
body{{background:#181818;color:#ddd;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:2rem;line-height:1.5}}
h1{{color:#fff;font-size:1.35rem;margin-bottom:.3rem}}
h2{{color:#aaa;font-size:.8rem;text-transform:uppercase;letter-spacing:.08em;margin:1.5rem 0 .6rem}}
.desc{{color:#666;font-size:.82rem;margin-bottom:.25rem}}
.meta{{color:#555;font-size:.8rem;margin-bottom:.25rem}}
.prompt{{color:#777;font-size:.8rem;font-style:italic;margin-bottom:1.5rem;border-left:2px solid #333;padding-left:.75rem}}
.images{{display:flex;gap:1.5rem;flex-wrap:wrap;margin-bottom:1.5rem}}
.img-card{{flex:1;min-width:260px;background:#222;border-radius:8px;padding:1rem;border:1px solid #2e2e2e}}
.img-card h3{{font-size:.88rem;color:#ccc;margin-bottom:.65rem;font-weight:500}}
.img-card img{{width:100%;border-radius:4px;display:block;cursor:zoom-in;transition:opacity .15s}}
.img-card img:hover{{opacity:.9}}
.fname{{font-size:.7rem;color:#444;margin-top:.5rem}}
table{{width:100%;border-collapse:collapse;background:#1e1e1e;border-radius:8px;overflow:hidden;border:1px solid #2a2a2a}}
th{{text-align:left;padding:.55rem 1rem;background:#242424;color:#666;font-size:.72rem;text-transform:uppercase;letter-spacing:.06em}}
td{{padding:.5rem 1rem;border-bottom:1px solid #252525;font-size:.88rem}}
tr:last-child td{{border-bottom:none}}
.metric-name{{color:#999}}
.win{{color:#6cbe6c;font-weight:600}}
.lose{{color:#444}}
.delta-pos{{color:#6cbe6c}}
.delta-neg{{color:#c96;}}
.winner-label{{color:#aae;font-size:.82rem}}
.lb{{display:none;position:fixed;inset:0;background:rgba(0,0,0,.92);z-index:999;align-items:center;justify-content:center;cursor:zoom-out}}
.lb.open{{display:flex}}
.lb img{{max-width:90vw;max-height:90vh;object-fit:contain;border-radius:4px}}
</style>
</head>
<body>
<h1>VAE Review — {test_name}</h1>
<p class="desc">{desc}</p>
<p class="meta">Test prompt: <b>{tp_name}</b> | Seed: <b>{seed}</b> | Steps: <b>{steps}</b> | {width}×{height} | {ts}</p>
<p class="prompt">"{prompt_short}"</p>

<h2>Generated Images</h2>
<div class="images">
    {cards_html}
</div>

<h2>Quality Metrics</h2>
<table>
<thead><tr><th>Metric</th>{header_cols}<th>Δ / Winner</th></tr></thead>
<tbody>
      {rows_html}
</tbody>
</table>

<div class="lb" id="lb" onclick="this.classList.remove('open')">
  <img id="lb-img" src="" alt=""/>
</div>
<script>
function openLb(src){{
  document.getElementById('lb-img').src=src;
  document.getElementById('lb').classList.add('open');
}}
</script>
</body>
</html>"""


# ---------------------------------------------------------------------------
# Mode 5b: LoRA I2I self-test (T2I → I2I pipeline with LoRA)
# ---------------------------------------------------------------------------

def _run_lora_i2i_selftest(args, test_name: str, test_cfg: dict):
    """Run LoRA I2I self-test: T2I anime baseline → I2I with LoRA.

    Generates paired images (anime baseline vs I2I+LoRA output) across seeds,
    captions both via Qwen3-VL, then renders HTML review with voting.
    """
    import time as _time
    from app.test_prompts_image import get_test_prompt
    from app.commands._shared import resolve_lora_path, execute_generation
    from app.run_config import RunConfig

    # Resolve config
    tp_name = test_cfg["test_prompt"]
    tp = get_test_prompt(tp_name)
    t2i_prompt = getattr(args, "prompt", None) or tp["prompt"]
    i2i_prompt = test_cfg["i2i_prompt"]
    width = test_cfg.get("width", tp["width"])
    height = test_cfg.get("height", tp["height"])
    steps = getattr(args, "steps", None) or test_cfg.get("steps", 4)
    denoise_strength = test_cfg.get("denoise_strength", 0.6)
    lora_path_raw = test_cfg.get("lora_path")
    lora_path = resolve_lora_path(lora_path_raw) if lora_path_raw else None
    lora_scale = test_cfg.get("lora_scale", 0.8)
    pipeline_type = test_cfg.get("pipeline", "flux2-klein")
    seeds = test_cfg.get("seeds", [42, 123])

    os.makedirs(cfg.OUTPUT_DIR, exist_ok=True)
    ts = _time.strftime("%Y%m%d_%H%M%S")
    base_name = f"lora-i2i-{ts}"

    label_a = "T2I Anime Baseline"
    label_b = f"I2I + LoRA (dn={denoise_strength}, scale={lora_scale})"

    print(f"\n{'='*60}")
    print(f"LoRA I2I Self-Test — {test_name}")
    print(f"{'='*60}")
    print(f"  T2I prompt: {t2i_prompt[:80]}{'…' if len(t2i_prompt) > 80 else ''}")
    print(f"  I2I prompt: {i2i_prompt[:80]}{'…' if len(i2i_prompt) > 80 else ''}")
    print(f"  Pipeline:   {pipeline_type}")
    print(f"  Seeds:      {seeds}")
    print(f"  Steps:      {steps}")
    print(f"  Size:       {width}×{height}")
    print(f"  Denoise:    {denoise_strength}")
    print(f"  LoRA:       {os.path.basename(lora_path) if lora_path else 'None'} (scale={lora_scale})")
    print(f"  Pairs:      {len(seeds)} ({len(seeds)*2} images total)")
    print()

    pairs = []  # [{seed, paths: [str, str], timings: [float, float]}, ...]

    for i, seed in enumerate(seeds, start=1):
        print(f"\n--- Seed {seed} ({i}/{len(seeds)}) ---")

        # --- A: T2I anime baseline (no LoRA) ---
        print(f"  [A] Generating T2I baseline…")
        t0 = _time.time()
        args_a = _make_run_config_args(
            prompt=t2i_prompt, width=width, height=height,
            steps=steps, seed=seed, pipeline=pipeline_type,
        )
        rc_a = RunConfig.from_args(args_a, command="image t2i")
        mf_a = execute_generation(rc_a, pipeline_type=pipeline_type)
        elapsed_a = _time.time() - t0
        # Find the output image
        path_a = _find_output_image(mf_a)
        print(f"  [A] Saved: {os.path.basename(path_a)} ({elapsed_a:.1f}s)")

        # Unload model to free memory
        import mlx.core as mx
        mx.clear_cache()
        import gc
        gc.collect()

        # --- B: I2I with LoRA ---
        print(f"  [B] Generating I2I + LoRA…")
        t0 = _time.time()
        args_b = _make_run_config_args(
            prompt=i2i_prompt, width=width, height=height,
            steps=steps, seed=seed, pipeline=pipeline_type,
            lora_path=lora_path, lora_scale=lora_scale,
            input_image=path_a, denoise_strength=denoise_strength,
        )
        rc_b = RunConfig.from_args(args_b, command="image i2i")
        rc_b.denoise_strength = denoise_strength
        mf_b = execute_generation(rc_b, pipeline_type=pipeline_type)
        elapsed_b = _time.time() - t0
        path_b = _find_output_image(mf_b)
        print(f"  [B] Saved: {os.path.basename(path_b)} ({elapsed_b:.1f}s)")

        mx.clear_cache()
        gc.collect()

        pairs.append({
            "seed": seed,
            "paths": [path_a, path_b],
            "timings": [round(elapsed_a, 1), round(elapsed_b, 1)],
        })

    # --- Caption both images via Qwen3-VL ---
    print(f"\n{'─'*40}")
    print(f"Caption Analysis")
    print(f"{'─'*40}")
    captions_by_pair = []
    for i, p in enumerate(pairs):
        print(f"\n  Seed {p['seed']} ({i+1}/{len(pairs)})")
        cap_a = _caption_image(p["paths"][0], style="photography", lang="en")
        cap_b = _caption_image(p["paths"][1], style="photography", lang="en")
        print(f"  [A] {cap_a[:120]}{'…' if len(cap_a) > 120 else ''}")
        print(f"  [B] {cap_b[:120]}{'…' if len(cap_b) > 120 else ''}")
        captions_by_pair.append({"caption_a": cap_a, "caption_b": cap_b})

    # --- Quality analysis (default on, opt-out via --no-quality) ---
    metrics_by_pair = []
    if not getattr(args, "no_quality", False):
        _quality_mod = importlib.import_module("app.commands.image-quality")
        print(f"\n{'─'*40}")
        print(f"Quality Analysis")
        print(f"{'─'*40}")
        for i, p in enumerate(pairs):
            print(f"\n  Seed {p['seed']} ({i+1}/{len(pairs)})")
            report_a = _quality_mod.analyze_image(p["paths"][0])
            report_b = _quality_mod.analyze_image(p["paths"][1])
            report_a["label"] = label_a
            report_b["label"] = label_b
            _quality_mod._print_single_report(report_a)
            _quality_mod._print_single_report(report_b)
            metrics_by_pair.append({
                "metrics_a": report_a["metrics"],
                "metrics_b": report_b["metrics"],
            })

    # --- Generate HTML review ---
    html_path = _render_lora_i2i_html(
        output_dir=cfg.OUTPUT_DIR,
        base_name=base_name,
        test_name=test_name,
        test_cfg=test_cfg,
        t2i_prompt=t2i_prompt,
        i2i_prompt=i2i_prompt,
        steps=steps,
        width=width,
        height=height,
        denoise_strength=denoise_strength,
        lora_scale=lora_scale,
        lora_path=lora_path,
        label_a=label_a,
        label_b=label_b,
        pairs=pairs,
        captions_by_pair=captions_by_pair,
        metrics_by_pair=metrics_by_pair or None,
        ts=ts,
    )

    print(f"\n{'='*60}")
    print(f"LoRA I2I Self-Test Complete")
    print(f"{'='*60}")
    print(f"  HTML review: {html_path}")
    print(f"  Images:      {len(pairs)*2} ({len(pairs)} pairs)")

    import webbrowser
    webbrowser.open(f"file://{os.path.abspath(html_path)}")
    print(f"  Opened in browser")


def _make_run_config_args(**kwargs):
    """Create a simple namespace object for RunConfig.from_args()."""
    import argparse
    ns = argparse.Namespace()
    for k, v in kwargs.items():
        setattr(ns, k, v)
    # Set defaults for fields RunConfig expects
    for field in ("prompt_file", "vae_path",
                   "seed_start",
                   "upscale", "upscale_model", "upscale_method",
                   "face_detail", "film_grain", "sharpening", "skin_contrast",
                   "noise_clean", "latent_upscale", "draft", "control_image"):
        if not hasattr(ns, field):
            setattr(ns, field, None)
    # String defaults (must not be None)
    if not hasattr(ns, "transformer") or getattr(ns, "transformer") is None:
        setattr(ns, "transformer", "klein-9b")
    if not hasattr(ns, "variant") or getattr(ns, "variant") is None:
        setattr(ns, "variant", "9b")
    for field in ("lora_scale", "denoise_strength"):
        if not hasattr(ns, field):
            setattr(ns, field, 1.0)
    if not hasattr(ns, "count"):
        setattr(ns, "count", 1)
    if not hasattr(ns, "seed"):
        setattr(ns, "seed", 42)
    if not hasattr(ns, "pipeline"):
        setattr(ns, "pipeline", "flux2-klein")
    return ns


def _find_output_image(manifest_path: str) -> str:
    """Read a manifest JSON and return the path to the first output image."""
    import json as _json
    with open(manifest_path) as f:
        data = _json.load(f)
    outputs = data.get("outputs", [])
    if outputs:
        return outputs[0]["path"]
    # Fallback: look for .png with same base name
    base = manifest_path.replace(".manifest.json", "")
    for ext in (".png", ".jpg"):
        candidate = base + ext
        if os.path.exists(candidate):
            return candidate
    raise FileNotFoundError(f"No output image found for manifest {manifest_path}")


def _caption_image(image_path: str, style: str = "photography", lang: str = "en") -> str:
    """Caption an image using Qwen3-VL. Reusable wrapper around caption.caption_image()."""
    try:
        _caption_mod = importlib.import_module("app.commands.caption")
        return _caption_mod.caption_image(image_path, style=style, lang=lang)
    except Exception as e:
        return f"(caption failed: {e})"


def _render_lora_i2i_html(*, output_dir, base_name, test_name, test_cfg,
                          t2i_prompt, i2i_prompt, steps, width, height,
                          denoise_strength, lora_scale, lora_path,
                          label_a, label_b, pairs, captions_by_pair,
                          metrics_by_pair, ts):
    """Generate bilingual HTML review for LoRA I2I self-test."""
    import html as html_mod
    import json as _json

    lora_name = os.path.basename(os.path.dirname(lora_path)) if lora_path else "unknown"

    # Build pair cards
    pair_cards = []
    for i, p in enumerate(pairs):
        captions = captions_by_pair[i] if captions_by_pair else {}
        cap_a = html_mod.escape(captions.get("caption_a", ""))
        cap_b = html_mod.escape(captions.get("caption_b", ""))

        metrics_html = ""
        if metrics_by_pair:
            m = metrics_by_pair[i]
            metrics_html = _build_metrics_rows(
                m["metrics_a"], m["metrics_b"], label_a, label_b
            )

        pair_cards.append({
            "seed": p["seed"],
            "img_a": os.path.basename(p["paths"][0]),
            "img_b": os.path.basename(p["paths"][1]),
            "timing_a": p["timings"][0],
            "timing_b": p["timings"][1],
            "cap_a": cap_a[:500],
            "cap_b": cap_b[:500],
            "metrics_html": metrics_html,
        })

    cards_json = _json.dumps(pair_cards, ensure_ascii=False)

    html_content = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>LoRA I2I Review — {html_mod.escape(test_name)}</title>
<style>
  :root {{ --bg: #1a1a2e; --card: #16213e; --border: #0f3460; --accent: #e94560;
           --text: #eee; --muted: #999; --success: #4ecca3; }}
  * {{ box-sizing: border-box; margin: 0; padding: 0; }}
  body {{ background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 20px; padding-bottom: 80px; }}
  .header {{ text-align: center; margin-bottom: 20px; }}
  .header h1 {{ font-size: 1.6em; margin-bottom: 4px; }}
  .header .subtitle {{ color: var(--muted); font-size: 0.9em; }}
  .meta {{ background: var(--card); border-radius: 12px; padding: 12px 16px; margin-bottom: 20px; border: 1px solid var(--border); font-size: 0.82em; }}
  .meta table {{ border-collapse: collapse; width: 100%; }}
  .meta td {{ padding: 3px 8px; }}
  .meta td:first-child {{ color: var(--muted); white-space: nowrap; }}
  .grid {{ display: grid; grid-template-columns: 1fr; gap: 24px; }}
  .pair {{ background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 16px; }}
  .pair-title {{ font-weight: 700; font-size: 1.1em; margin-bottom: 12px; }}
  .pair-images {{ display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }}
  .img-card {{ text-align: center; }}
  .img-card img {{ max-width: 100%; border-radius: 8px; cursor: zoom-in; border: 2px solid var(--border); }}
  .img-card img:hover {{ border-color: var(--accent); }}
  .img-label {{ font-weight: 700; margin-bottom: 6px; font-size: 0.9em; }}
  .img-label.a {{ color: var(--success); }}
  .img-label.b {{ color: var(--accent); }}
  .caption {{ font-size: 0.78em; color: #bbb; margin-top: 6px; text-align: left; line-height: 1.5;
               background: rgba(255,255,255,0.04); padding: 8px; border-radius: 6px; max-height: 120px; overflow-y: auto; }}
  .metrics {{ margin-top: 12px; font-size: 0.78em; }}
  .metrics table {{ width: 100%; border-collapse: collapse; }}
  .metrics th, .metrics td {{ padding: 4px 8px; text-align: center; }}
  .metrics th {{ background: var(--border); }}
  .metrics .win {{ color: var(--success); font-weight: 700; }}
  .metrics .lose {{ color: var(--muted); }}
  .vote-row {{ display: flex; gap: 8px; margin-top: 10px; justify-content: center; }}
  .vote-btn {{ padding: 6px 16px; border-radius: 6px; border: 1px solid var(--border); background: transparent;
               color: var(--muted); cursor: pointer; font-size: 0.85em; transition: all 0.2s; }}
  .vote-btn:hover {{ border-color: var(--success); color: var(--success); }}
  .vote-btn.selected {{ background: var(--success); color: #1a1a2e; border-color: var(--success); font-weight: 700; }}
  .bottom-bar {{ position: fixed; bottom: 0; left: 0; right: 0; background: var(--card); border-top: 1px solid var(--border);
                 padding: 12px 24px; display: flex; justify-content: space-between; align-items: center; z-index: 100; }}
  .btn {{ padding: 8px 20px; border-radius: 8px; border: none; font-size: 0.9em; cursor: pointer; font-weight: 600; }}
  .btn-primary {{ background: var(--accent); color: #fff; }}
  .btn-secondary {{ background: var(--border); color: var(--text); }}
  .overlay {{ display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.92); z-index: 200;
              cursor: zoom-out; justify-content: center; align-items: center; }}
  .overlay.show {{ display: flex; }}
  .overlay img {{ max-width: 95vw; max-height: 95vh; object-fit: contain; border-radius: 8px; }}
</style>
</head>
<body>

<div class="header">
  <h1>🎨 LoRA I2I Self-Test: {html_mod.escape(test_name)}</h1>
  <p class="subtitle">T2I anime baseline → I2I with LoRA style transfer · Click images to zoom · Vote per pair</p>
</div>

<div class="meta">
  <table>
    <tr><td>Pipeline</td><td>{html_mod.escape(test_cfg.get('pipeline', 'flux2-klein'))}</td></tr>
    <tr><td>LoRA</td><td>{html_mod.escape(lora_name)} (scale={lora_scale})</td></tr>
    <tr><td>Denoise</td><td>{denoise_strength}</td></tr>
    <tr><td>Steps / Size</td><td>{steps} / {width}×{height}</td></tr>
    <tr><td>T2I Prompt</td><td>{html_mod.escape(t2i_prompt[:120])}{'…' if len(t2i_prompt) > 120 else ''}</td></tr>
    <tr><td>I2I Prompt</td><td>{html_mod.escape(i2i_prompt[:120])}{'…' if len(i2i_prompt) > 120 else ''}</td></tr>
    <tr><td>Seeds</td><td>{', '.join(str(s) for s in test_cfg.get('seeds', []))}</td></tr>
  </table>
</div>

<div class="grid" id="grid"></div>

<div class="bottom-bar">
  <span id="voteCount" style="font-size:0.85em;color:var(--muted);">0 votes cast</span>
  <div>
    <button class="btn btn-secondary" onclick="resetVotes()" style="margin-right:8px">Reset</button>
    <button class="btn btn-primary" onclick="exportResults()">📋 Export JSON</button>
  </div>
</div>

<div class="overlay" id="overlay" onclick="this.classList.remove('show')">
  <img id="overlayImg" src="">
</div>

<script>
const CARDS = {cards_json};
const votes = {{}};

function render() {{
  const grid = document.getElementById('grid');
  grid.innerHTML = CARDS.map((c, i) => `
    <div class="pair">
      <div class="pair-title">Seed ${{c.seed}}</div>
      <div class="pair-images">
        <div class="img-card">
          <div class="img-label a">[A] T2I Baseline (${{c.timing_a}}s)</div>
          <img src="${{c.img_a}}" onclick="zoom('${{c.img_a}}')">
          <div class="caption">${{c.cap_a}}</div>
        </div>
        <div class="img-card">
          <div class="img-label b">[B] I2I + LoRA (${{c.timing_b}}s)</div>
          <img src="${{c.img_b}}" onclick="zoom('${{c.img_b}}')">
          <div class="caption">${{c.cap_b}}</div>
        </div>
      </div>
      ${{c.metrics_html ? '<div class="metrics"><table><tr><th>Metric</th><th>[A] Baseline</th><th>[B] I2I+LoRA</th></tr>' + c.metrics_html + '</table></div>' : ''}}
      <div class="vote-row">
        <button class="vote-btn ${{votes[i]==='A'?'selected':''}}" onclick="vote(${{i}},'A')">✅ LoRA Effective</button>
        <button class="vote-btn ${{votes[i]==='B'?'selected':''}}" onclick="vote(${{i}},'B')">❌ No Effect</button>
        <button class="vote-btn ${{votes[i]==='skip'?'selected':''}}" onclick="vote(${{i}},'skip')">⏭️ Skip</button>
      </div>
    </div>
  `).join('');
  updateCount();
}}

function vote(idx, choice) {{ votes[idx] = choice; render(); }}
function resetVotes() {{ Object.keys(votes).forEach(k => delete votes[k]); render(); }}
function updateCount() {{ document.getElementById('voteCount').textContent = Object.keys(votes).length + ' votes cast'; }}
function zoom(src) {{ document.getElementById('overlayImg').src = src; document.getElementById('overlay').classList.add('show'); }}

function exportResults() {{
  const results = CARDS.map((c, i) => ({{
    seed: c.seed,
    images: {{ baseline: c.img_a, lora_i2i: c.img_b }},
    timings: {{ baseline: c.timing_a, lora_i2i: c.timing_b }},
    vote: votes[i] || null,
  }}));
  const blob = new Blob([JSON.stringify(results, null, 2)], {{type: 'application/json'}});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'lora_i2i_review_' + new Date().toISOString().slice(0,10) + '.json';
  a.click();
  URL.revokeObjectURL(url);
}}

render();
</script>
</body>
</html>"""

    html_path = os.path.join(output_dir, f"{base_name}_review.html")
    with open(html_path, "w", encoding="utf-8") as f:
        f.write(html_content)
    return html_path


# ---------------------------------------------------------------------------
# Mode 6: LoRA A/B comparison review
# ---------------------------------------------------------------------------

def run_review_lora(args):
    """Generate paired images (baseline vs LoRA) across seeds, render HTML voting review."""
    import time as _time
    from app.pipeline import ZImagePipeline
    from app.test_prompts_image import get_lora_test, get_test_prompt
    from app.commands._shared import resolve_lora_path

    test_name_raw = getattr(args, "self_test", None)
    test_name = test_name_raw if isinstance(test_name_raw, str) else "zit-sda-v1"

    try:
        test_cfg = get_lora_test(test_name)
    except ValueError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)

    # Resolve config values, allowing CLI overrides
    tp_name = test_cfg["test_prompt"]
    tp = get_test_prompt(tp_name)
    prompt = getattr(args, "prompt", None) or tp["prompt"]
    width = getattr(args, "width", None) or tp["width"]
    height = getattr(args, "height", None) or tp["height"]
    steps = getattr(args, "steps", None) or test_cfg.get("steps", 9)
    lora_scale = (getattr(args, "lora_scale", None) or 1.0) or test_cfg.get("lora_scale", 1.0)

    # Seeds: CLI --seeds overrides config
    seeds_arg = getattr(args, "seeds", None)
    if seeds_arg:
        try:
            seeds = [int(s.strip()) for s in seeds_arg.split(",") if s.strip()]
        except ValueError:
            print(f"ERROR: invalid --seeds format: {seeds_arg}", file=sys.stderr)
            sys.exit(1)
    else:
        seeds = test_cfg.get("seeds", [42, 123, 777, 999])

    variants = test_cfg["variants"]
    if len(variants) != 2:
        print(f"ERROR: LoRA review expects exactly 2 variants, got {len(variants)}",
              file=sys.stderr)
        sys.exit(1)

    # Resolve LoRA paths for each variant
    lora_paths = []
    for vcfg in variants:
        raw = vcfg.get("lora_path")
        lora_paths.append(resolve_lora_path(raw) if raw else None)

    os.makedirs(cfg.OUTPUT_DIR, exist_ok=True)
    ts = time.strftime("%Y%m%d_%H%M%S")
    base_name = f"lora-review-{ts}"

    label_a = variants[0]["label"]
    label_b = variants[1]["label"]

    print(f"\n{'='*60}")
    print(f"LoRA Review — {test_name}")
    print(f"{'='*60}")
    print(f"  Prompt:     {prompt[:80]}{'…' if len(prompt) > 80 else ''}")
    print(f"  Seeds:      {seeds}")
    print(f"  Steps:      {steps}")
    print(f"  Size:       {width}×{height}")
    print(f"  LoRA scale: {lora_scale}")
    print(f"  A:          {label_a} (lora={lora_paths[0] is not None})")
    print(f"  B:          {label_b} (lora={os.path.basename(lora_paths[1]) if lora_paths[1] else 'None'})")
    print(f"  Pairs:      {len(seeds)} ({len(seeds)*2} images total)")
    print()

    # Load pipeline once — reuse across all seeds
    pipeline = ZImagePipeline()

    pairs = []  # [{seed, paths: [str, str], timings: [float, float]}, ...]

    for i, seed in enumerate(seeds, start=1):
        print(f"\n--- Seed {seed} ({i}/{len(seeds)}) ---")
        pair_paths = []
        pair_timings = []

        for vi, (vcfg, lora_path) in enumerate(zip(variants, lora_paths)):
            side = "A" if vi == 0 else "B"
            label = vcfg["label"]
            print(f"  [{side}] Generating {label}…")
            t0 = _time.time()
            result = pipeline.generate(
                prompt=prompt,
                width=width,
                height=height,
                steps=steps,
                seed=seed,
                lora_path=lora_path,
                lora_scale=lora_scale if lora_path else 1.0,
            )
            elapsed = _time.time() - t0
            safe_label = label.lower().replace(" ", "_")
            out_path = os.path.join(cfg.OUTPUT_DIR, f"{base_name}_s{seed}_{safe_label}.png")
            result.image.save(out_path)
            print(f"  [{side}] Saved: {os.path.basename(out_path)} ({elapsed:.1f}s)")
            pair_paths.append(out_path)
            pair_timings.append(round(elapsed, 1))

        pairs.append({
            "seed": seed,
            "paths": pair_paths,
            "timings": pair_timings,
        })

    # --- Quality analysis (default on, opt-out via --no-quality) ---
    metrics_by_pair = []
    if not getattr(args, "no_quality", False):
        _quality_mod = importlib.import_module("app.commands.image-quality")
        print(f"\n{'─'*40}")
        print(f"Quality Analysis")
        print(f"{'─'*40}")
        for i, p in enumerate(pairs):
            print(f"\n  Seed {p['seed']} ({i+1}/{len(pairs)})")
            report_a = _quality_mod.analyze_image(p["paths"][0])
            report_b = _quality_mod.analyze_image(p["paths"][1])
            report_a["label"] = label_a
            report_b["label"] = label_b
            _quality_mod._print_single_report(report_a)
            _quality_mod._print_single_report(report_b)
            metrics_by_pair.append({
                "metrics_a": report_a["metrics"],
                "metrics_b": report_b["metrics"],
            })

        # Aggregate averages across seeds and print comparison
        if metrics_by_pair:
            all_keys = list(metrics_by_pair[0]["metrics_a"].keys())
            agg_a = {k: sum(m["metrics_a"][k] for m in metrics_by_pair) / len(metrics_by_pair)
                     for k in all_keys}
            agg_b = {k: sum(m["metrics_b"][k] for m in metrics_by_pair) / len(metrics_by_pair)
                     for k in all_keys}
            agg_report_a = {"label": label_a, "metrics": agg_a, "resolution": [width, height]}
            agg_report_b = {"label": label_b, "metrics": agg_b, "resolution": [width, height]}
            print(f"\n  Average across {len(metrics_by_pair)} seeds:")
            _quality_mod._print_comparison([agg_report_a, agg_report_b])

    # Generate paired HTML review
    html_path = _render_lora_html(
        output_dir=cfg.OUTPUT_DIR,
        base_name=base_name,
        test_name=test_name,
        test_cfg=test_cfg,
        prompt=prompt,
        steps=steps,
        width=width,
        height=height,
        lora_scale=lora_scale,
        label_a=label_a,
        label_b=label_b,
        pairs=pairs,
        ts=ts,
        metrics_by_pair=metrics_by_pair or None,
    )

    print(f"\n{'='*60}")
    print(f"LoRA Review Complete")
    print(f"{'='*60}")
    print(f"  HTML review: {html_path}")
    print(f"  Images:      {len(pairs)*2} ({len(pairs)} pairs)")

    subprocess.Popen(["open", html_path])
    print(f"  Opened in browser")


def _build_metrics_rows(metrics_a, metrics_b, label_a, label_b):
    """Build HTML table rows for A/B quality metric comparison."""
    metrics_defs = [
        ("Sharpness (Laplacian σ²)", "sharpness",     "higher"),
        ("Edge density (Sobel mean)", "edge_density",  "higher"),
        ("Contrast (luminance σ)",    "contrast",      "higher"),
        ("Noise (MAD σ)",            "noise_sigma",    "lower"),
        ("SNR (dB)",                 "snr_db",         "higher"),
        ("Blockiness (8×8)",         "blockiness",     "lower"),
        ("Saturation σ",             "saturation_std", "—"),
    ]
    rows = []
    for metric_name, key, direction in metrics_defs:
        va, vb = metrics_a[key], metrics_b[key]
        values = [va, vb]

        if direction == "higher":
            best_idx = int(max(range(2), key=lambda i: values[i]))
        elif direction == "lower":
            best_idx = int(min(range(2), key=lambda i: values[i]))
        else:
            best_idx = -1

        row = f"<tr><td class='metric-name'>{metric_name}</td>"
        labels_local = [label_a, label_b]
        for i, v in enumerate(values):
            is_best = (best_idx >= 0 and i == best_idx)
            cls = "win" if is_best else "lose"
            fmt = f"{v:.1f}" if abs(v) >= 10 else f"{v:.2f}"
            row += f'<td class="{cls}">{fmt}</td>'

        if direction in ("higher", "lower") and best_idx >= 0:
            base_v, comp_v = va, vb
            if base_v != 0:
                delta = (comp_v - base_v) / base_v * 100
                sign = "+" if delta > 0 else ""
                dcls = "delta-pos" if delta > 0 else "delta-neg"
                row += (f'<td><span class="{dcls}">{sign}{delta:.0f}%</span> '
                        f'<span class="winner-label">{labels_local[best_idx]}</span> ✓</td>')
            else:
                row += f'<td><span class="winner-label">{labels_local[best_idx]}</span> ✓</td>'
        else:
            row += "<td>—</td>"

        row += "</tr>"
        rows.append(row)
    return "\n      ".join(rows)


def _build_per_pair_quality(idx, metrics_by_pair, label_a, label_b):
    """Build collapsible quality mini-table HTML for a single seed pair."""
    mp = metrics_by_pair[idx]
    rows = _build_metrics_rows(mp["metrics_a"], mp["metrics_b"], label_a, label_b)
    return f"""<div class="pair-quality">
          <button class="quality-toggle" onclick="toggleQuality({idx})" id="qtoggle-{idx}">▸ Quality Metrics</button>
          <table class="quality-table" id="quality-{idx}" style="display:none">
            <thead>
              <tr><th>Metric</th><th>A</th><th>B</th><th>Δ</th></tr>
            </thead>
            <tbody>
              {rows}
            </tbody>
          </table>
        </div>"""


def _render_lora_html(output_dir, base_name, test_name, test_cfg, prompt,
                       steps, width, height, lora_scale,
                       label_a, label_b, pairs, ts, metrics_by_pair=None) -> str:
    """Render a self-contained HTML page for LoRA paired comparison with voting."""
    import base64 as _b64

    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")

    def _img_to_data_uri(path):
        with open(path, "rb") as f:
            return f"data:image/png;base64,{_b64.b64encode(f.read()).decode('ascii')}"

    def _esc(s):
        return (s.replace("&", "&amp;").replace("<", "&lt;")
                 .replace(">", "&gt;").replace('"', "&quot;"))

    # Build pair rows
    pair_rows = []
    for i, p in enumerate(pairs):
        uri_a = _img_to_data_uri(p["paths"][0])
        uri_b = _img_to_data_uri(p["paths"][1])
        pair_rows.append(f"""
        <div class="pair" id="pair-{i}">
          <div class="pair-header">
            <span class="pair-label">Seed {p['seed']}</span>
            <span class="pair-timing">A: {p['timings'][0]}s | B: {p['timings'][1]}s</span>
          </div>
          <div class="pair-images">
            <div class="img-cell" onclick="openLightbox({i}, 'a')">
              <div class="img-badge badge-a">A — {_esc(label_a)}</div>
              <img src="{uri_a}" alt="{_esc(label_a)} seed={p['seed']}" loading="lazy" />
            </div>
            <div class="img-cell" onclick="openLightbox({i}, 'b')">
              <div class="img-badge badge-b">B — {_esc(label_b)}</div>
              <img src="{uri_b}" alt="{_esc(label_b)} seed={p['seed']}" loading="lazy" />
            </div>
          </div>
          {_build_per_pair_quality(i, metrics_by_pair, label_a, label_b) if metrics_by_pair and i < len(metrics_by_pair) else ''}
          <div class="pair-vote">
            <label class="vote-option">
              <input type="radio" name="vote-{i}" value="A" onchange="updateSummary()" />
              <span>Prefer A ({_esc(label_a)})</span>
            </label>
            <label class="vote-option">
              <input type="radio" name="vote-{i}" value="B" onchange="updateSummary()" />
              <span>Prefer B ({_esc(label_b)})</span>
            </label>
            <label class="vote-option">
              <input type="radio" name="vote-{i}" value="tie" onchange="updateSummary()" />
              <span>Tie</span>
            </label>
            <label class="vote-option">
              <input type="radio" name="vote-{i}" value="skip" onchange="updateSummary()" />
              <span>Skip</span>
            </label>
          </div>
          <div class="pair-comment">
            <input type="text" placeholder="Comment (optional)…"
                   id="comment-{i}" class="comment-input" />
          </div>
        </div>
        """)

    # Precompute lightbox data URIs as JS arrays
    all_a_uris = json.dumps([_img_to_data_uri(p["paths"][0]) for p in pairs])
    all_b_uris = json.dumps([_img_to_data_uri(p["paths"][1]) for p in pairs])
    all_seeds = json.dumps([p["seed"] for p in pairs])

    pair_rows_html = "\n".join(pair_rows)
    desc = test_cfg.get("description", "")

    # Aggregate quality table HTML (average across all seeds)
    agg_quality_html = ""
    quality_json = "null"
    if metrics_by_pair:
        all_keys = list(metrics_by_pair[0]["metrics_a"].keys())
        agg_a = {k: sum(m["metrics_a"][k] for m in metrics_by_pair) / len(metrics_by_pair)
                 for k in all_keys}
        agg_b = {k: sum(m["metrics_b"][k] for m in metrics_by_pair) / len(metrics_by_pair)
                 for k in all_keys}
        agg_rows = _build_metrics_rows(agg_a, agg_b, label_a, label_b)
        agg_quality_html = f"""
    <div class="agg-quality">
      <h2>Average Quality <span class="agg-subtitle">across {len(metrics_by_pair)} seeds</span></h2>
      <table class="quality-table">
        <thead>
          <tr><th>Metric</th><th>A — {_esc(label_a)}</th><th>B — {_esc(label_b)}</th><th>Δ / Winner</th></tr>
        </thead>
        <tbody>
          {agg_rows}
        </tbody>
      </table>
    </div>
    """
        quality_json = json.dumps(metrics_by_pair)

    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>LoRA Review — {test_name}</title>
<style>
*, *::before, *::after {{ box-sizing: border-box; margin: 0; padding: 0; }}
:root {{
  --bg: #0f0f0f; --bg2: #1a1a1a; --bg3: #242424;
  --border: #333; --text: #e0e0e0; --muted: #777;
  --accent: #4a9eff; --gold: #f5c518; --green: #4caf50;
  --red: #f44336; --purple: #a855f7;
  --radius: 8px;
}}
body {{ background: var(--bg); color: var(--text); font-family: system-ui, -apple-system, sans-serif;
       font-size: 14px; line-height: 1.5; }}

header {{ background: var(--bg2); border-bottom: 1px solid var(--border);
          padding: 16px 24px; position: sticky; top: 0; z-index: 100; }}
header h1 {{ font-size: 18px; font-weight: 600; color: var(--accent); }}
header .desc {{ font-size: 11px; color: var(--muted); margin-top: 2px; }}
header .meta {{ font-size: 11px; color: var(--muted); margin-top: 4px; }}
.prompt-box {{ margin-top: 10px; background: var(--bg3); border: 1px solid var(--border);
              border-radius: var(--radius); padding: 10px 14px; font-size: 13px; color: #bbb;
              max-height: 80px; overflow-y: auto; line-height: 1.6; }}

.params {{ display: flex; gap: 16px; margin-top: 10px; flex-wrap: wrap; }}
.param {{ background: var(--bg3); border: 1px solid var(--border); border-radius: 12px;
          padding: 3px 10px; font-size: 11px; color: var(--muted); }}
.param strong {{ color: var(--text); }}

#pairs {{ padding: 16px 24px; padding-bottom: 80px; }}

.pair {{ background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius);
         margin-bottom: 16px; overflow: hidden; }}
.pair-header {{ display: flex; justify-content: space-between; align-items: center;
                padding: 8px 14px; background: var(--bg3); border-bottom: 1px solid var(--border); }}
.pair-label {{ font-size: 15px; font-weight: 600; color: var(--accent); }}
.pair-timing {{ font-size: 11px; color: var(--muted); }}

.pair-images {{ display: grid; grid-template-columns: 1fr 1fr; gap: 0; }}
.img-cell {{ cursor: zoom-in; position: relative; border-right: 1px solid var(--border); }}
.img-cell:last-child {{ border-right: none; }}
.img-cell img {{ width: 100%; height: auto; display: block; }}
.img-badge {{ position: absolute; top: 8px; left: 8px; font-size: 11px; font-weight: 600;
              padding: 3px 10px; border-radius: 12px; z-index: 2; }}
.badge-a {{ background: rgba(74,158,255,0.85); color: #fff; }}
.badge-b {{ background: rgba(168,85,247,0.85); color: #fff; }}

.pair-vote {{ display: flex; gap: 12px; padding: 10px 14px; flex-wrap: wrap;
              border-top: 1px solid var(--border); background: var(--bg3); }}
.vote-option {{ display: flex; align-items: center; gap: 5px; cursor: pointer;
               font-size: 12px; color: var(--muted); transition: color .15s; }}
.vote-option:hover {{ color: var(--text); }}
.vote-option input[type="radio"] {{ accent-color: var(--accent); }}
.vote-option input[type="radio"]:checked + span {{ color: var(--text); font-weight: 500; }}

.pair-comment {{ padding: 8px 14px; border-top: 1px solid var(--border); }}
.comment-input {{ width: 100%; background: var(--bg); border: 1px solid var(--border);
                  border-radius: var(--radius); padding: 6px 10px; color: var(--text);
                  font-size: 12px; outline: none; }}
.comment-input:focus {{ border-color: var(--accent); }}
.comment-input::placeholder {{ color: var(--muted); }}

footer {{ position: fixed; bottom: 0; left: 0; right: 0; background: var(--bg2);
          border-top: 1px solid var(--border); padding: 10px 24px; z-index: 100;
          display: flex; align-items: center; gap: 16px; }}
#summary {{ font-size: 13px; color: var(--muted); }}
#summary strong {{ color: var(--gold); }}
.export-btn {{ margin-left: auto; padding: 6px 16px; border-radius: var(--radius);
               background: var(--accent); color: #fff; border: none; cursor: pointer;
               font-size: 12px; font-weight: 600; transition: opacity .15s; }}
.export-btn:hover {{ opacity: 0.85; }}

/* Quality metrics */
.agg-quality {{ padding: 16px 24px; }}
.agg-quality h2 {{ font-size: 15px; color: var(--accent); margin-bottom: 10px; }}
.agg-quality .agg-subtitle {{ font-size: 11px; color: var(--muted); font-weight: 400; }}
.quality-table {{ width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 4px; }}
.quality-table th {{ text-align: left; padding: 6px 10px; background: var(--bg3);
                    border-bottom: 1px solid var(--border); color: var(--muted);
                    font-weight: 500; font-size: 11px; text-transform: uppercase; letter-spacing: .03em; }}
.quality-table td {{ padding: 5px 10px; border-bottom: 1px solid rgba(255,255,255,0.04); }}
.quality-table .metric-name {{ color: var(--muted); font-size: 12px; }}
.win {{ color: #6cbe6c; font-weight: 600; }}
.lose {{ color: #555; }}
.delta-pos {{ color: #6cbe6c; }}
.delta-neg {{ color: #c96; }}
.winner-label {{ color: #aae; font-size: .82rem; }}
.pair-quality {{ border-top: 1px solid var(--border); padding: 6px 14px; }}
.quality-toggle {{ background: none; border: 1px solid var(--border); color: var(--muted);
                   font-size: 11px; padding: 3px 10px; border-radius: 12px; cursor: pointer;
                   transition: color .15s, border-color .15s; }}
.quality-toggle:hover {{ color: var(--text); border-color: var(--accent); }}

/* Lightbox */
#lightbox {{ display: none; position: fixed; inset: 0; z-index: 1000;
             background: rgba(0,0,0,0.92); cursor: zoom-out;
             align-items: center; justify-content: center; }}
#lightbox.open {{ display: flex; }}
#lightbox img {{ max-width: 95vw; max-height: 95vh; object-fit: contain;
                border-radius: 4px; }}
#lightbox .lb-label {{ position: absolute; top: 16px; left: 50%; transform: translateX(-50%);
                       font-size: 14px; color: var(--text); background: rgba(0,0,0,0.7);
                       padding: 6px 16px; border-radius: 20px; }}
#lightbox .lb-nav {{ position: absolute; top: 50%; transform: translateY(-50%);
                     font-size: 28px; color: #fff; background: rgba(0,0,0,0.5);
                     width: 48px; height: 48px; border-radius: 50%; border: none;
                     cursor: pointer; display: flex; align-items: center; justify-content: center; }}
#lightbox .lb-prev {{ left: 16px; }}
#lightbox .lb-next {{ right: 16px; }}
</style>
</head>
<body>

<header>
  <h1>LoRA Review — {test_name}</h1>
  <div class="desc">{_esc(desc)}</div>
  <div class="meta">Generated {now} | {len(pairs)} seed pairs | {len(pairs)*2} images | {ts}</div>
  <div class="prompt-box">{_esc(prompt)}</div>
  <div class="params">
    <span class="param"><strong>{steps}</strong> steps</span>
    <span class="param"><strong>{width}×{height}</strong></span>
    <span class="param">LoRA scale: <strong>{lora_scale}</strong></span>
    <span class="param">A: <strong>{_esc(label_a)}</strong></span>
    <span class="param">B: <strong>{_esc(label_b)}</strong></span>
  </div>
</header>

{agg_quality_html}
<div id="pairs">
  {pair_rows_html}
</div>

<footer>
  <div id="summary">Vote: 0/{len(pairs)} decided</div>
  <button class="export-btn" onclick="exportResults()">Export Results</button>
</footer>

<div id="lightbox" onclick="closeLightbox(event)">
  <div class="lb-label" id="lb-label"></div>
  <button class="lb-nav lb-prev" onclick="lbNav(event,-1)">◀</button>
  <img id="lb-img" src="" alt="Zoomed" />
  <button class="lb-nav lb-next" onclick="lbNav(event,1)">▶</button>
</div>

<script>
const IMGS_A = {all_a_uris};
const IMGS_B = {all_b_uris};
const SEEDS = {all_seeds};
const LABEL_A = {json.dumps(label_a)};
const LABEL_B = {json.dumps(label_b)};
const QUALITY = {quality_json};
let lbPair = 0, lbSide = 'a';

function openLightbox(pairIdx, side) {{
  lbPair = pairIdx; lbSide = side;
  renderLightbox();
  document.getElementById('lightbox').classList.add('open');
  document.body.style.overflow = 'hidden';
}}
function closeLightbox(e) {{
  if (e.target.tagName === 'IMG' || e.target.tagName === 'BUTTON') return;
  document.getElementById('lightbox').classList.remove('open');
  document.body.style.overflow = '';
}}
function renderLightbox() {{
  const srcs = lbSide === 'a' ? IMGS_A : IMGS_B;
  document.getElementById('lb-img').src = srcs[lbPair];
  const sideLabel = lbSide === 'a' ? 'A (' + LABEL_A + ')' : 'B (' + LABEL_B + ')';
  document.getElementById('lb-label').textContent =
    'Seed ' + SEEDS[lbPair] + ' — ' + sideLabel + ' (' + (lbPair+1) + '/' + SEEDS.length + ')';
}}
function lbNav(e, delta) {{
  e.stopPropagation();
  const arr = lbSide === 'a' ? IMGS_A : IMGS_B;
  lbPair = (lbPair + delta + arr.length) % arr.length;
  renderLightbox();
}}

function toggleQuality(idx) {{
  const tbl = document.getElementById('quality-' + idx);
  const btn = document.getElementById('qtoggle-' + idx);
  if (!tbl) return;
  const show = tbl.style.display === 'none';
  tbl.style.display = show ? '' : 'none';
  btn.textContent = show ? '▾ Quality Metrics' : '▸ Quality Metrics';
}}

// Vote summary
function updateSummary() {{
  const n = SEEDS.length;
  let a=0, b=0, tie=0;
  for (let i=0; i<n; i++) {{
    const v = document.querySelector('input[name="vote-'+i+'"]:checked');
    if (!v) continue;
    if (v.value === 'A') a++;
    else if (v.value === 'B') b++;
    else if (v.value === 'tie') tie++;
  }}
  const decided = a + b + tie;
  const el = document.getElementById('summary');
  el.innerHTML = 'Vote: <strong>' + decided + '/' + n + '</strong> decided' +
    (decided > 0 ? ' — A: ' + a + ' | B: ' + b + ' | Tie: ' + tie : '');
}}

function exportResults() {{
  const n = SEEDS.length;
  const results = {{
    test_name: {json.dumps(test_name)},
    prompt: {json.dumps(prompt)},
    params: {{ steps: {steps}, width: {width}, height: {height}, lora_scale: {lora_scale} }},
    variants: [
      {{ label: LABEL_A }},
      {{ label: LABEL_B }}
    ],
    generated_at: "{now}",
    pairs: []
  }};
  for (let i=0; i<n; i++) {{
    const v = document.querySelector('input[name="vote-'+i+'"]:checked');
    const c = document.getElementById('comment-'+i);
    results.pairs.push({{
      seed: SEEDS[i],
      vote: v ? v.value : null,
      comment: c ? c.value.trim() : '',
      quality: QUALITY ? QUALITY[i] || null : null
    }});
  }}
  const out = JSON.stringify(results, null, 2);
  navigator.clipboard.writeText(out).then(() => {{
    const btn = document.querySelector('.export-btn');
    btn.textContent = 'Copied!';
    setTimeout(() => {{ btn.textContent = 'Export Results'; }}, 1500);
  }});
}}

// Keyboard: ESC close, arrows navigate, Tab toggle A/B
document.addEventListener('keydown', (e) => {{
  const lb = document.getElementById('lightbox');
  if (!lb.classList.contains('open')) return;
  if (e.key === 'Escape') {{ lb.classList.remove('open'); document.body.style.overflow = ''; }}
  if (e.key === 'ArrowLeft') lbNav(e, -1);
  if (e.key === 'ArrowRight') lbNav(e, 1);
  if (e.key === 'Tab') {{
    e.preventDefault();
    lbSide = lbSide === 'a' ? 'b' : 'a';
    renderLightbox();
  }}
}});
</script>
</body>
</html>"""

    html_path = os.path.join(output_dir, f"{base_name}.html")
    with open(html_path, "w", encoding="utf-8") as f:
        f.write(html)

    size_mb = os.path.getsize(html_path) / (1024 * 1024)
    print(f"  HTML: {html_path} ({size_mb:.1f} MB)")

    return html_path


# ---------------------------------------------------------------------------
# LoRA Sweep — multi-prompt LoRA evaluator
# ---------------------------------------------------------------------------

def _run_lora_sweep(args, test_name: str, test_cfg: dict):
    """Run a LoRA across multiple prompt styles, collect quality metrics per style."""
    import time as _time
    import mlx.core as mx
    import gc

    from app.pipeline import ZImagePipeline
    from app.test_prompts_image import get_test_prompt
    from app.commands._shared import resolve_lora_path

    lora_scale = (getattr(args, "lora_scale", None) or 1.0) or test_cfg.get("lora_scale", 1.0)
    steps = getattr(args, "steps", None) or test_cfg.get("steps", 9)
    seeds = test_cfg.get("seeds", [42, 777])
    prompt_names = test_cfg.get("test_prompts", [])
    variants = test_cfg["variants"]

    if len(variants) != 2:
        print(f"ERROR: lora-sweep expects exactly 2 variants, got {len(variants)}",
              file=sys.stderr)
        sys.exit(1)

    lora_paths = []
    for vcfg in variants:
        raw = vcfg.get("lora_path")
        lora_paths.append(resolve_lora_path(raw) if raw else None)

    label_a = variants[0]["label"]
    label_b = variants[1]["label"]

    total_images = len(prompt_names) * len(seeds) * 2
    os.makedirs(cfg.OUTPUT_DIR, exist_ok=True)
    ts = time.strftime("%Y%m%d_%H%M%S")
    base_name = f"lora-sweep-{ts}"

    print(f"\n{'='*60}")
    print(f"LoRA Sweep — {test_name}")
    print(f"{'='*60}")
    print(f"  Styles:     {len(prompt_names)} ({', '.join(prompt_names)})")
    print(f"  Seeds:      {seeds}")
    print(f"  Steps:      {steps}")
    print(f"  LoRA scale: {lora_scale}")
    print(f"  A:          {label_a} (lora={lora_paths[0] is not None})")
    print(f"  B:          {label_b} (lora={os.path.basename(lora_paths[1]) if lora_paths[1] else 'None'})")
    print(f"  Total:      {total_images} images ({len(prompt_names)} styles × {len(seeds)} seeds × 2)")
    print()

    pipeline = ZImagePipeline()
    _quality_mod = importlib.import_module("app.commands.image-quality")

    groups = []  # [{prompt_name, prompt_text, width, height, pairs, metrics_by_pair}, ...]
    img_counter = 0

    for gi, pname in enumerate(prompt_names, start=1):
        tp = get_test_prompt(pname)
        prompt = tp["prompt"]
        width, height = tp["width"], tp["height"]

        print(f"\n{'─'*50}")
        print(f"  [{gi}/{len(prompt_names)}] Style: {pname} ({width}×{height})")
        print(f"  Prompt: {prompt[:70]}{'…' if len(prompt) > 70 else ''}")
        print(f"{'─'*50}")

        pairs = []
        for si, seed in enumerate(seeds, start=1):
            pair_paths = []
            pair_timings = []

            for vi, (vcfg, lora_path) in enumerate(zip(variants, lora_paths)):
                side = "A" if vi == 0 else "B"
                label = vcfg["label"]
                img_counter += 1
                print(f"  [{side}] Seed {seed} ({img_counter}/{total_images}) Generating {label}…")
                t0 = _time.time()
                result = pipeline.generate(
                    prompt=prompt,
                    width=width,
                    height=height,
                    steps=steps,
                    seed=seed,
                    lora_path=lora_path,
                    lora_scale=lora_scale if lora_path else 1.0,
                )
                elapsed = _time.time() - t0
                safe_label = label.lower().replace(" ", "_")
                out_path = os.path.join(
                    cfg.OUTPUT_DIR, f"{base_name}_{pname}_s{seed}_{safe_label}.png"
                )
                result.image.save(out_path)
                print(f"  [{side}] Saved: {os.path.basename(out_path)} ({elapsed:.1f}s)")
                pair_paths.append(out_path)
                pair_timings.append(round(elapsed, 1))

            pairs.append({
                "seed": seed,
                "paths": pair_paths,
                "timings": pair_timings,
            })

        # Quality analysis for this prompt group
        metrics_by_pair = []
        if not getattr(args, "no_quality", False):
            for i, p in enumerate(pairs):
                print(f"  [quality] Seed {p['seed']} ({i+1}/{len(pairs)})")
                report_a = _quality_mod.analyze_image(p["paths"][0])
                report_b = _quality_mod.analyze_image(p["paths"][1])
                metrics_by_pair.append({
                    "metrics_a": report_a["metrics"],
                    "metrics_b": report_b["metrics"],
                })

        # Aggregate for this group
        agg_a = {}
        agg_b = {}
        if metrics_by_pair:
            all_keys = list(metrics_by_pair[0]["metrics_a"].keys())
            n = len(metrics_by_pair)
            agg_a = {k: sum(m["metrics_a"][k] for m in metrics_by_pair) / n for k in all_keys}
            agg_b = {k: sum(m["metrics_b"][k] for m in metrics_by_pair) / n for k in all_keys}

        groups.append({
            "prompt_name": pname,
            "prompt_text": prompt,
            "width": width,
            "height": height,
            "pairs": pairs,
            "metrics_by_pair": metrics_by_pair,
            "agg_a": agg_a,
            "agg_b": agg_b,
        })

        # Brief per-style summary
        if agg_a:
            sharp_delta = ((agg_b["sharpness"] - agg_a["sharpness"]) / agg_a["sharpness"] * 100
                           if agg_a["sharpness"] != 0 else 0)
            print(f"  ── {pname} avg sharpness: {agg_a['sharpness']:.0f} vs {agg_b['sharpness']:.0f} ({sharp_delta:+.0f}%)")

        # Free memory between groups
        mx.clear_cache()
        gc.collect()

    # Render HTML
    html_path = _render_lora_sweep_html(
        output_dir=cfg.OUTPUT_DIR,
        base_name=base_name,
        test_name=test_name,
        test_cfg=test_cfg,
        groups=groups,
        steps=steps,
        lora_scale=lora_scale,
        label_a=label_a,
        label_b=label_b,
        ts=ts,
    )

    print(f"\n{'='*60}")
    print(f"LoRA Sweep Complete")
    print(f"{'='*60}")
    print(f"  HTML review: {html_path}")
    print(f"  Images:      {total_images} ({len(prompt_names)} styles × {len(seeds)} seeds × 2)")

    subprocess.Popen(["open", html_path])
    print(f"  Opened in browser")


def _render_lora_sweep_html(*, output_dir, base_name, test_name, test_cfg,
                             groups, steps, lora_scale, label_a, label_b, ts) -> str:
    """Render cross-prompt LoRA sweep HTML with summary table + per-style sections."""
    import json, base64
    from datetime import datetime

    now = datetime.now().strftime("%Y-%m-%d %H:%M")
    description = test_cfg.get("description", "")
    total_images = sum(len(g["pairs"]) * 2 for g in groups)
    total_pairs = sum(len(g["pairs"]) for g in groups)

    # --- Cross-prompt summary table ---
    summary_rows = []
    wins_b = 0
    wins_a = 0
    ties = 0

    metrics_defs = [
        ("Sharpness",       "sharpness",     "higher"),
        ("Edge density",    "edge_density",  "higher"),
        ("Contrast",        "contrast",      "higher"),
        ("Noise (MAD σ)",   "noise_sigma",   "lower"),
        ("SNR (dB)",        "snr_db",        "higher"),
        ("Blockiness",      "blockiness",    "lower"),
        ("Saturation σ",    "saturation_std", "neutral"),
    ]

    for g in groups:
        agg_a = g.get("agg_a", {})
        agg_b = g.get("agg_b", {})
        if not agg_a:
            summary_rows.append(f"<tr><td>{g['prompt_name']}</td>"
                                f"<td colspan='5' class='neutral'>no quality data</td></tr>")
            continue

        # Count wins across all 7 metrics
        group_wins_b = 0
        group_wins_a = 0
        group_ties = 0
        for _, key, direction in metrics_defs:
            va, vb = agg_a[key], agg_b[key]
            if direction == "higher":
                if vb > va:
                    group_wins_b += 1
                elif va > vb:
                    group_wins_a += 1
                else:
                    group_ties += 1
            elif direction == "lower":
                if vb < va:
                    group_wins_b += 1
                elif va < vb:
                    group_wins_a += 1
                else:
                    group_ties += 1
            else:
                group_ties += 1

        wins_b += group_wins_b
        wins_a += group_wins_a
        ties += group_ties

        # Key metric deltas for summary
        sharp_d = ((agg_b["sharpness"] - agg_a["sharpness"]) / agg_a["sharpness"] * 100
                   if agg_a["sharpness"] != 0 else 0)
        edge_d = ((agg_b["edge_density"] - agg_a["edge_density"]) / agg_a["edge_density"] * 100
                  if agg_a["edge_density"] != 0 else 0)
        block_d = ((agg_b["blockiness"] - agg_a["blockiness"]) / agg_a["blockiness"] * 100
                   if agg_a["blockiness"] != 0 else 0)

        def _delta_cell(delta, direction):
            sign = "+" if delta > 0 else ""
            dcls = "delta-pos" if (
                (direction == "higher" and delta > 0) or
                (direction == "lower" and delta < 0)
            ) else "delta-neg"
            return f'<span class="{dcls}">{sign}{delta:.0f}%</span>'

        winner_label = label_b if group_wins_b > group_wins_a else (
            label_a if group_wins_a > group_wins_b else "Tie")
        winner_cls = "winner-b" if group_wins_b > group_wins_a else (
            "winner-a" if group_wins_a > group_wins_b else "neutral")

        summary_rows.append(
            f"<tr>"
            f"<td>{g['prompt_name']}</td>"
            f"<td>{_delta_cell(sharp_d, 'higher')}</td>"
            f"<td>{_delta_cell(edge_d, 'higher')}</td>"
            f"<td>{_delta_cell(block_d, 'lower')}</td>"
            f"<td>{group_wins_b}–{group_wins_a}–{group_ties}</td>"
            f'<td class="{winner_cls}">{winner_label}</td>'
            f"</tr>"
        )

    summary_table = "\n      ".join(summary_rows)

    # --- Per-prompt sections ---
    group_sections = []
    for gi, g in enumerate(groups):
        pairs_html = []
        for pi, p in enumerate(g["pairs"]):
            imgs = []
            for path in p["paths"]:
                with open(path, "rb") as f:
                    b64 = base64.b64encode(f.read()).decode()
                imgs.append(f'<img src="data:image/png;base64,{b64}" '
                           f'alt="seed-{p["seed"]}" loading="lazy" '
                           f'onclick="this.classList.toggle(\'zoomed\')">')

            timing_str = " | ".join(f"{'AB'[vi]}: {t:.1f}s" for vi, t in enumerate(p["timings"]))

            # Per-seed quality mini-row
            quality_row = ""
            mp = g.get("metrics_by_pair", [])
            if mp and pi < len(mp):
                ma, mb = mp[pi]["metrics_a"], mp[pi]["metrics_b"]
                sharp_d = ((mb["sharpness"] - ma["sharpness"]) / ma["sharpness"] * 100
                          if ma["sharpness"] != 0 else 0)
                edge_d = ((mb["edge_density"] - ma["edge_density"]) / ma["edge_density"] * 100
                         if ma["edge_density"] != 0 else 0)
                dcls = "delta-pos" if sharp_d > 0 else "delta-neg"
                quality_row = (
                    f'<div class="seed-quality">'
                    f'Seed {p["seed"]}: '
                    f'sharp {ma["sharpness"]:.0f} → {mb["sharpness"]:.0f} '
                    f'<span class="{dcls}">({sharp_d:+.0f}%)</span>, '
                    f'edge {ma["edge_density"]:.1f} → {mb["edge_density"]:.1f} '
                    f'<span class="{"delta-pos" if edge_d > 0 else "delta-neg"}">({edge_d:+.0f}%)</span>'
                    f'</div>'
                )

            pairs_html.append(f"""
            <div class="pair">
              <div class="pair-header">
                <span class="pair-label">Seed {p["seed"]}</span>
                <span class="pair-timing">{timing_str}</span>
              </div>
              <div class="pair-images">
                <div class="img-cell"><div class="img-label">A — {label_a}</div>{imgs[0]}</div>
                <div class="img-cell"><div class="img-label">B — {label_b}</div>{imgs[1]}</div>
              </div>
              {quality_row}
            </div>""")

        # Collapsible quality table for this prompt
        quality_table = ""
        mp = g.get("metrics_by_pair", [])
        if mp and g.get("agg_a"):
            agg_rows = _build_metrics_rows(g["agg_a"], g["agg_b"], label_a, label_b)
            per_seed_tables = []
            for pi2, m in enumerate(mp):
                seed_val = g["pairs"][pi2]["seed"]
                seed_rows = _build_metrics_rows(m["metrics_a"], m["metrics_b"], label_a, label_b)
                per_seed_tables.append(
                    f'<div class="seed-quality-detail">'
                    f'<strong>Seed {seed_val}</strong>'
                    f'<table class="quality-table"><thead><tr>'
                    f'<th>Metric</th><th>A</th><th>B</th><th>Δ</th></tr>'
                    f'</thead><tbody>{seed_rows}</tbody></table></div>'
                )

            quality_table = f"""
            <details class="group-quality">
              <summary>Quality Metrics — {g["prompt_name"]}</summary>
              <h4>Average across {len(mp)} seed(s)</h4>
              <table class="quality-table agg-quality">
                <thead><tr><th>Metric</th><th>A</th><th>B</th><th>Δ</th></tr></thead>
                <tbody>{agg_rows}</tbody>
              </table>
              <h4>Per-seed</h4>
              {''.join(per_seed_tables)}
            </details>"""

        all_pairs = "\n".join(pairs_html)
        group_sections.append(f"""
        <div class="sweep-group" id="group-{gi}">
          <h2 class="group-title" onclick="toggleGroup({gi})">
            <span id="arrow-{gi}">▾</span> {g["prompt_name"].title()}
            <span class="group-meta">{g["width"]}×{g["height"]} | {len(g["pairs"])} seed(s)</span>
          </h2>
          <div class="group-body" id="group-body-{gi}">
            <div class="prompt-box">{g["prompt_text"]}</div>
            {all_pairs}
            {quality_table}
          </div>
        </div>""")

    all_groups = "\n".join(group_sections)

    # --- Quality data for JS export ---
    quality_js_data = []
    for g in groups:
        quality_js_data.append({
            "prompt_name": g["prompt_name"],
            "metrics_by_pair": g.get("metrics_by_pair", []),
        })
    quality_js = json.dumps(quality_js_data)

    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>LoRA Sweep — {test_name}</title>
<style>
  body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
         margin: 0; padding: 20px; background: #1a1a2e; color: #e0e0e0; }}
  header {{ text-align: center; padding: 20px; background: #16213e; border-radius: 12px; margin-bottom: 20px; }}
  h1 {{ color: #e94560; margin: 0 0 8px 0; }}
  h2 {{ color: #0f3460; margin: 0; cursor: pointer; padding: 12px 16px;
       background: #16213e; border-radius: 8px; display: flex; align-items: center; gap: 8px; }}
  h2:hover {{ background: #1a2744; }}
  h3 {{ color: #e94560; margin: 16px 0 8px 0; }}
  h4 {{ color: #a0a0c0; margin: 8px 0; }}
  .desc {{ color: #a0a0c0; margin: 4px 0; }}
  .meta {{ color: #707090; font-size: 0.85em; margin-top: 4px; }}
  .prompt-box {{ background: #0f3460; padding: 10px 14px; border-radius: 6px;
                margin: 10px 0; font-family: monospace; font-size: 0.85em; color: #c0c0d0;
                border-left: 3px solid #e94560; }}
  .params {{ display: flex; gap: 16px; justify-content: center; flex-wrap: wrap; margin-top: 12px; }}
  .param {{ background: #0f3460; padding: 4px 10px; border-radius: 4px; font-size: 0.85em; }}

  .summary-section {{ background: #16213e; border-radius: 12px; padding: 16px; margin-bottom: 24px; }}
  .summary-table {{ width: 100%; border-collapse: collapse; margin-top: 12px; }}
  .summary-table th {{ text-align: left; padding: 8px 12px; border-bottom: 2px solid #0f3460;
                      color: #a0a0c0; font-size: 0.85em; text-transform: uppercase; }}
  .summary-table td {{ padding: 8px 12px; border-bottom: 1px solid #1a2744; }}
  .summary-table tr:hover {{ background: #1a2744; }}
  .winner-b {{ color: #4ecca3; font-weight: bold; }}
  .winner-a {{ color: #e94560; font-weight: bold; }}
  .neutral {{ color: #707090; }}

  .winner-counts {{ display: flex; gap: 20px; justify-content: center; margin-top: 12px;
                  padding: 10px; background: #0f3460; border-radius: 6px; }}
  .winner-count {{ text-align: center; }}
  .winner-count .count {{ font-size: 1.8em; font-weight: bold; }}
  .winner-count .wlabel {{ font-size: 0.8em; color: #707090; }}
  .count-b {{ color: #4ecca3; }}
  .count-a {{ color: #e94560; }}
  .count-tie {{ color: #707090; }}

  .sweep-group {{ margin-bottom: 16px; }}
  .group-title {{ user-select: none; }}
  .group-meta {{ color: #707090; font-size: 0.75em; font-weight: normal; margin-left: auto; }}
  .group-body {{ padding: 0 12px 12px 12px; }}

  .pair {{ background: #16213e; border-radius: 8px; padding: 12px; margin: 8px 0; }}
  .pair-header {{ display: flex; justify-content: space-between; margin-bottom: 8px;
                 font-size: 0.85em; color: #707090; }}
  .pair-images {{ display: flex; gap: 12px; justify-content: center; flex-wrap: wrap; }}
  .img-cell {{ text-align: center; }}
  .img-cell img {{ max-width: 320px; max-height: 320px; border-radius: 6px;
                  cursor: pointer; transition: transform 0.2s; }}
  .img-cell img.zoomed {{ transform: scale(2); z-index: 10; position: relative; }}
  .img-label {{ font-size: 0.8em; color: #a0a0c0; margin-bottom: 4px; }}
  .seed-quality {{ font-size: 0.8em; color: #a0a0c0; margin-top: 6px; padding: 4px 8px;
                  background: #0f3460; border-radius: 4px; }}

  details.group-quality {{ margin-top: 10px; }}
  details.group-quality summary {{ cursor: pointer; color: #e94560; font-weight: bold;
                                    padding: 8px; background: #0f3460; border-radius: 4px; }}
  .quality-table {{ width: 100%; border-collapse: collapse; margin: 8px 0; font-size: 0.85em; }}
  .quality-table th {{ text-align: left; padding: 6px 10px; border-bottom: 1px solid #333; color: #a0a0c0; }}
  .quality-table td {{ padding: 6px 10px; border-bottom: 1px solid #1a2744; }}
  .win {{ color: #4ecca3; font-weight: bold; }}
  .lose {{ color: #707090; }}
  .delta-pos {{ color: #4ecca3; }}
  .delta-neg {{ color: #e94560; }}
  .winner-label {{ font-weight: bold; }}
  .seed-quality-detail {{ margin: 6px 0; padding: 6px; background: #0f3460; border-radius: 4px; }}
  .agg-quality {{ background: #1a2744; border-radius: 6px; }}

  footer {{ text-align: center; padding: 16px; margin-top: 20px; }}
  .export-btn {{ background: #0f3460; color: #e0e0e0; border: 1px solid #333;
                padding: 10px 24px; border-radius: 6px; cursor: pointer; font-size: 1em; }}
  .export-btn:hover {{ background: #1a2744; }}
</style>
</head>
<body>

<header>
  <h1>LoRA Sweep — {test_name}</h1>
  <div class="desc">{description}</div>
  <div class="meta">Generated {now} | {len(groups)} styles × {total_pairs} pairs = {total_images} images | {ts}</div>
  <div class="params">
    <span class="param"><strong>{steps}</strong> steps</span>
    <span class="param">LoRA scale: <strong>{lora_scale}</strong></span>
    <span class="param">A: <strong>{label_a}</strong></span>
    <span class="param">B: <strong>{label_b}</strong></span>
  </div>
</header>

<div class="summary-section">
  <h3>Cross-Prompt Summary</h3>
  <table class="summary-table">
    <thead>
      <tr><th>Style</th><th>Sharpness Δ</th><th>Edges Δ</th><th>Blockiness Δ</th>
          <th>Metric Wins (B–A–Tie)</th><th>Overall</th></tr>
    </thead>
    <tbody>
      {summary_table}
    </tbody>
  </table>
  <div class="winner-counts">
    <div class="winner-count"><div class="count count-b">{wins_b}</div><div class="wlabel">{label_b} wins</div></div>
    <div class="winner-count"><div class="count count-a">{wins_a}</div><div class="wlabel">{label_a} wins</div></div>
    <div class="winner-count"><div class="count count-tie">{ties}</div><div class="wlabel">Ties</div></div>
  </div>
</div>

{all_groups}

<footer>
  <button class="export-btn" onclick="exportResults()">Export Results (JSON)</button>
</footer>

<script>
const GROUPS = {quality_js};
const LABEL_A = "{label_a}";
const LABEL_B = "{label_b}";

function toggleGroup(gi) {{
  const body = document.getElementById('group-body-' + gi);
  const arrow = document.getElementById('arrow-' + gi);
  if (body.style.display === 'none') {{
    body.style.display = 'block';
    arrow.textContent = '▾';
  }} else {{
    body.style.display = 'none';
    arrow.textContent = '▸';
  }}
}}

function exportResults() {{
  const results = {{
    test_name: "{test_name}",
    lora_scale: {lora_scale},
    steps: {steps},
    groups: GROUPS.map((g) => ({{
      prompt_name: g.prompt_name,
      metrics_by_pair: g.metrics_by_pair,
    }})),
  }};
  const blob = new Blob([JSON.stringify(results, null, 2)], {{type: 'application/json'}});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = '{base_name}-results.json';
  a.click();
  URL.revokeObjectURL(url);
}}
</script>
</body>
</html>"""

    html_path = os.path.join(output_dir, f"{base_name}.html")
    with open(html_path, "w", encoding="utf-8") as f:
        f.write(html)

    size_mb = os.path.getsize(html_path) / (1024 * 1024)
    print(f"  HTML: {html_path} ({size_mb:.1f} MB)")

    return html_path


# ---------------------------------------------------------------------------
# LoRA Ref — Flux2KleinEdit reference conditioning + LoRA (identity-preserving)
# ---------------------------------------------------------------------------

def _run_lora_ref_selftest(args, test_name: str, test_cfg: dict):
    """Run anime2real Ref+LoRA self-test across multiple anime prompts.

    For each anime prompt x seed:
      A. T2I anime baseline (no LoRA)
      B. Ref+LoRA — Flux2KleinEdit reference conditioning + anime2real LoRA (NEW)
      C. Old I2I+LoRA — I2I noise mixing with high denoise (OLD, for comparison)
    """
    import time as _time
    import mlx.core as mx
    import gc
    from app.test_prompts_image import get_test_prompt
    from app.commands._shared import resolve_lora_path, execute_generation

    tp_names = test_cfg["test_prompts"]
    seeds = test_cfg.get("seeds", [42])
    width = test_cfg.get("width", 640)
    height = test_cfg.get("height", 960)
    ref_steps = test_cfg.get("ref_steps", 8)
    i2i_steps = test_cfg.get("i2i_steps", 4)
    lora_path_raw = test_cfg.get("lora_path")
    lora_path = resolve_lora_path(lora_path_raw) if lora_path_raw else None
    lora_scale = test_cfg.get("lora_scale", 1.0)
    ref_count = test_cfg.get("ref_count", 1)
    denoise_strength = test_cfg.get("denoise_strength", 0.6)
    ref_prompt = test_cfg.get("ref_prompt", "A photorealistic portrait photograph")
    i2i_prompt = test_cfg.get("i2i_prompt", "Preserve the subject's features")
    pipeline_type = "flux2-klein"
    review_only = test_cfg.get("review_only", False)
    style_variants = test_cfg.get("style_variants", [])

    os.makedirs(cfg.OUTPUT_DIR, exist_ok=True)
    ts = _time.strftime("%Y%m%d_%H%M%S")
    base_name = f"lora-ref-{ts}"

    label_a = "T2I Anime Baseline"
    label_b = f"Ref+LoRA (ref={ref_count}, {ref_steps}st, scale={lora_scale})"

    # Build dynamic column labels for extras (C, D, E, ...)
    # Style variants take priority; otherwise fall back to old I2I (C) + pipeline_compare (D)
    extra_labels = []
    if style_variants:
        extra_labels = [sv.get("label", f"Variant {i+1}") for i, sv in enumerate(style_variants)]
    else:
        extra_labels.append(f"I2I+LoRA (dn={denoise_strength}, {i2i_steps}st) [OLD]")
        # Optional extra column: cross-pipeline comparison
        pcfg = test_cfg.get("pipeline_compare")
        if pcfg:
            p_pipe = pcfg.get("pipeline", "zimage")
            p_lora_raw = pcfg.get("lora_path", "")
            p_dn = pcfg.get("denoise_strength", 0.4)
            p_steps = pcfg.get("steps", 9)
            p_lora_base = os.path.basename(p_lora_raw).split(".")[0] if p_lora_raw else "none"
            extra_labels.append(f"{p_pipe}+{p_lora_base} (dn={p_dn}, {p_steps}st)")

    # Legacy compat: label_c / label_d for functions that expect them
    label_c = extra_labels[0] if len(extra_labels) >= 1 else None
    label_d = extra_labels[1] if len(extra_labels) >= 2 else None
    # All column labels (including A, B)
    col_labels_all = [label_a, label_b] + extra_labels

    print(f"\n{'='*60}")
    print(f" LoRA Ref Self-Test — {test_name}")
    print(f"{'='*60}")
    print(f"  Prompts:    {tp_names}")
    print(f"  Seeds:      {seeds}")
    print(f"  Ref params: ref_count={ref_count}, steps={ref_steps}, scale={lora_scale}")
    print(f"  I2I params: denoise={denoise_strength}, steps={i2i_steps}")
    print(f"  LoRA:       {os.path.basename(lora_path) if lora_path else 'None'}")
    if label_d:
        print(f"  Pipeline:   {label_d}")
    n = len(tp_names) * len(seeds)
    cols = 4 if label_d else 3
    print(f"  Triples:    {n} ({len(tp_names)} prompts x {len(seeds)} seeds), {cols} columns")
    print()

    triples = []

    for tp_name in tp_names:
        tp = get_test_prompt(tp_name)
        anime_prompt = tp["prompt"]

        for seed in seeds:
            print(f"\n{'-'*50}")
            print(f"  Prompt: {tp_name} | Seed: {seed}")
            print(f"{'-'*50}")

            # --- A: T2I anime baseline ---
            print(f"  [A] T2I anime baseline...")
            t0 = _time.time()
            args_a = _make_run_config_args(
                prompt=anime_prompt, width=width, height=height,
                steps=i2i_steps, seed=seed, pipeline=pipeline_type,
            )
            rc_a = RunConfig.from_args(args_a, command="image t2i")
            mf_a = execute_generation(rc_a, pipeline_type=pipeline_type)
            path_a = _find_output_image(mf_a)
            elapsed_a = _time.time() - t0
            print(f"  [A] {os.path.basename(path_a)} ({elapsed_a:.1f}s)")
            mx.clear_cache(); gc.collect()

            # --- B: Ref+LoRA (NEW) ---
            print(f"  [B] Ref+LoRA (reference conditioning)...")
            t0 = _time.time()
            from PIL import Image as _PILImage
            from app.flux2_controlnet_pipeline import Flux2KleinControlnetPipeline
            pipeline_b = Flux2KleinControlnetPipeline(
                lora_paths=[lora_path], lora_scales=[lora_scale],
            )
            # Load raw image (skip_preprocess=True equivalent — pass image directly)
            ctrl_pil = _PILImage.open(path_a).convert("RGB").resize((width, height), _PILImage.LANCZOS)
            base_ref_strength = test_cfg.get("ref_strength", 1.0)
            result_b = pipeline_b.generate(
                prompt=ref_prompt, control_image=ctrl_pil,
                width=width, height=height, steps=ref_steps, seed=seed,
                controlnet_strength=1.0, ref_count=ref_count,
                ref_strength=base_ref_strength,
            )
            path_b = os.path.join(cfg.OUTPUT_DIR, f"ref-lora_{tp_name}_s{seed}_{ref_steps}st.png")
            result_b.image.save(path_b)
            elapsed_b = _time.time() - t0
            print(f"  [B] {os.path.basename(path_b)} ({elapsed_b:.1f}s)")
            del pipeline_b; mx.clear_cache(); gc.collect()

            # --- C & D (& E...): Only generate if not review_only ---
            extra_paths = []   # paths beyond B (C, D, E, ...)
            extra_timings = []
            if not review_only:
                if style_variants:
                    # --- Style variants: generate C (and D, E...) using Ref+LoRA with variant params ---
                    for si, sv in enumerate(style_variants):
                        col_letter = chr(67 + si)  # C, D, E, ...
                        sv_prompt = sv.get("ref_prompt", ref_prompt)
                        sv_scale = sv.get("lora_scale", lora_scale)
                        sv_steps = sv.get("ref_steps", ref_steps)
                        sv_ref_strength = sv.get("ref_strength", base_ref_strength)
                        sv_label = sv.get("label", f"Variant {si+1}")
                        print(f"  [{col_letter}] {sv_label} (scale={sv_scale}, {sv_steps}st, ref_str={sv_ref_strength})...")
                        t0 = _time.time()
                        from app.flux2_controlnet_pipeline import Flux2KleinControlnetPipeline as _FKCP
                        pipeline_sv = _FKCP(
                            lora_paths=[lora_path], lora_scales=[sv_scale],
                        )
                        result_sv = pipeline_sv.generate(
                            prompt=sv_prompt, control_image=ctrl_pil,
                            width=width, height=height, steps=sv_steps, seed=seed,
                            controlnet_strength=1.0, ref_count=ref_count,
                            ref_strength=sv_ref_strength,
                        )
                        path_sv = os.path.join(cfg.OUTPUT_DIR,
                            f"style_{sv_label.lower().replace(' ','-')}_{tp_name}_s{seed}_{sv_steps}st.png")
                        result_sv.image.save(path_sv)
                        elapsed_sv = _time.time() - t0
                        print(f"  [{col_letter}] {os.path.basename(path_sv)} ({elapsed_sv:.1f}s)")
                        del pipeline_sv; mx.clear_cache(); gc.collect()
                        extra_paths.append(path_sv)
                        extra_timings.append(round(elapsed_sv, 1))
                else:
                    # --- C: Old I2I+LoRA ---
                    print(f"  [C] I2I+LoRA (old approach, denoise={denoise_strength})...")
                    t0 = _time.time()
                    args_c = _make_run_config_args(
                        prompt=i2i_prompt, width=width, height=height,
                        steps=i2i_steps, seed=seed, pipeline=pipeline_type,
                        lora_path=lora_path, lora_scale=lora_scale,
                        input_image=path_a, denoise_strength=denoise_strength,
                    )
                    rc_c = RunConfig.from_args(args_c, command="image i2i")
                    rc_c.denoise_strength = denoise_strength
                    mf_c = execute_generation(rc_c, pipeline_type=pipeline_type)
                    path_c = _find_output_image(mf_c)
                    elapsed_c = _time.time() - t0
                    print(f"  [C] {os.path.basename(path_c)} ({elapsed_c:.1f}s)")
                    mx.clear_cache(); gc.collect()
                    extra_paths.append(path_c)
                    extra_timings.append(round(elapsed_c, 1))

                    # --- D: Pipeline comparison (optional, e.g. zimage + jib-mix LoRA) ---
                    pcfg = test_cfg.get("pipeline_compare")
                    if pcfg:
                        p_pipe = pcfg["pipeline"]
                        p_lora = resolve_lora_path(pcfg["lora_path"])
                        p_scale = pcfg.get("lora_scale", 0.8)
                        p_dn = pcfg.get("denoise_strength", 0.4)
                        p_steps = pcfg.get("steps", 9)
                        p_prompt = pcfg.get("prompt", ref_prompt)
                        print(f"  [D] {p_pipe} + {os.path.basename(p_lora)} (dn={p_dn}, {p_steps}st)...")
                        t0 = _time.time()
                        args_d = _make_run_config_args(
                            prompt=p_prompt, width=width, height=height,
                            steps=p_steps, seed=seed, pipeline=p_pipe,
                            lora_path=p_lora, lora_scale=p_scale,
                            input_image=path_a, denoise_strength=p_dn,
                            latent_upscale=1.0,
                        )
                        rc_d = RunConfig.from_args(args_d, command="image i2i")
                        rc_d.denoise_strength = p_dn
                        mf_d = execute_generation(rc_d, pipeline_type=p_pipe)
                        path_d = _find_output_image(mf_d)
                        elapsed_d = _time.time() - t0
                        print(f"  [D] {os.path.basename(path_d)} ({elapsed_d:.1f}s)")
                        mx.clear_cache(); gc.collect()
                        extra_paths.append(path_d)
                        extra_timings.append(round(elapsed_d, 1))

            paths = [path_a, path_b]
            timings_list = [round(elapsed_a, 1), round(elapsed_b, 1)]
            paths.extend(extra_paths)
            timings_list.extend(extra_timings)

            triples.append({
                "prompt_name": tp_name, "anime_prompt": anime_prompt, "seed": seed,
                "paths": paths,
                "timings": timings_list,
            })

    # --- Captions ---
    print(f"\n{'-'*40}\n Caption Analysis\n{'-'*40}")
    captions = []
    for i, t in enumerate(triples):
        print(f"\n  {t['prompt_name']} / seed={t['seed']} ({i+1}/{len(triples)})")
        cap_dict = {}
        for ci, path in enumerate(t["paths"]):
            col_letter = chr(65 + ci)  # A, B, C, ...
            cap = _caption_image(path, style="photography", lang="en")
            cap_dict[f"caption_{chr(97+ci)}"] = cap
            print(f"    [{col_letter}] {cap[:100]}...")
        style_b = _caption_image(t["paths"][1], style="style", lang="en")
        cap_dict["style_b"] = style_b
        captions.append(cap_dict)

    # --- Quality ---
    metrics = []
    if not getattr(args, "no_quality", False):
        _qm = importlib.import_module("app.commands.image-quality")
        print(f"\n{'-'*40}\n Quality Analysis\n{'-'*40}")
        for i, t in enumerate(triples):
            print(f"\n  {t['prompt_name']} / seed={t['seed']}")
            m_dict = {}
            for ci, path in enumerate(t["paths"]):
                r = _qm.analyze_image(path)
                r["label"] = col_labels_all[ci] if ci < len(col_labels_all) else f"Col {ci}"
                m_dict[f"metrics_{chr(97+ci)}"] = r["metrics"]
            metrics.append(m_dict)

    # --- HTML ---
    if style_variants:
        html_path = _render_style_ab_html(
            output_dir=cfg.OUTPUT_DIR, base_name=base_name, test_name=test_name,
            triples=triples, captions=captions, metrics=metrics or None,
            col_labels=col_labels_all,
            ts=ts,
        )
    elif review_only:
        html_path = _render_review_only_html(
            output_dir=cfg.OUTPUT_DIR, base_name=base_name, test_name=test_name,
            triples=triples, captions=captions, metrics=metrics,
            label_a=label_a, label_b=label_b, ts=ts,
        )
    else:
        html_path = _render_lora_ref_html(
            output_dir=cfg.OUTPUT_DIR, base_name=base_name, test_name=test_name,
            test_cfg=test_cfg, label_a=label_a, label_b=label_b, label_c=label_c,
            label_d=label_d,
            triples=triples, captions=captions, metrics=metrics or None,
            ref_steps=ref_steps, i2i_steps=i2i_steps, lora_scale=lora_scale,
            ref_count=ref_count, denoise_strength=denoise_strength,
            ref_prompt=ref_prompt, i2i_prompt=i2i_prompt, ts=ts,
            review_only=False,
        )
    total_images = sum(len(t["paths"]) for t in triples)
    print(f"\n{'='*60}\n LoRA Ref Self-Test Complete\n{'='*60}")
    print(f"  HTML review: {html_path}")
    print(f"  Images:      {total_images} ({len(triples)} rows)")
    import webbrowser
    webbrowser.open(f"file://{os.path.abspath(html_path)}")
    print(f"  Opened in browser")

def _render_style_ab_html(*, output_dir, base_name, test_name,
                           triples, captions, metrics,
                           col_labels,
                           ts):
    """Render multi-column A/B style comparison HTML with voting.

    Columns: A=anime baseline, B=default Ref+LoRA, C/D/E...=style variants.
    Each row has voting buttons + text comment + Copy/Save export.
    """
    import html as html_mod

    n_cols = len(col_labels)

    # Build per-row data as JSON
    rows = []
    for i, t in enumerate(triples):
        caps = captions[i] if captions else {}
        row = {
            "prompt": t["prompt_name"],
            "seed": t["seed"],
            "images": [os.path.basename(p) for p in t["paths"]],
            "timings": t["timings"],
            "captions": [],
        }
        for ci in range(n_cols):
            key = f"caption_{chr(97+ci)}"  # caption_a, caption_b, ...
            row["captions"].append(caps.get(key, ""))
        rows.append(row)

    rows_json = json.dumps(rows, ensure_ascii=False)
    labels_json = json.dumps(col_labels)
    n_cols_json = json.dumps(n_cols)

    html_content = f"""<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Style A/B Test</title>
<style>
:root{{--bg:#1a1a2e;--card:#16213e;--border:#0f3460;--accent:#e94560;--text:#eee;--muted:#999;--success:#4ecca3;--warn:#f0a500;--pipe:#6c5ce7}}
*{{box-sizing:border-box;margin:0;padding:0}}
body{{background:var(--bg);color:var(--text);font-family:-apple-system,sans-serif;padding:20px;padding-bottom:80px}}
.hd{{text-align:center;margin-bottom:24px}}.hd h1{{font-size:1.6em;margin-bottom:6px}}.hd p{{color:var(--muted);font-size:0.85em}}
.row{{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:20px;margin-bottom:20px}}
.row-hd{{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px}}
.row-hd h3{{font-size:1.05em}}.row-hd .sub{{font-size:0.75em;color:var(--muted)}}
.imgs{{display:grid;grid-template-columns:repeat({n_cols},1fr);gap:12px;margin-bottom:14px}}
.col{{text-align:center}}
.col .lb{{font-size:0.75em;font-weight:700;margin-bottom:6px;padding:3px 8px;border-radius:4px;display:inline-block}}
.col .lb.c0{{background:rgba(255,255,255,0.1)}}.col .lb.c1{{background:rgba(78,204,163,0.2);color:var(--success)}}
.col .lb.c2{{background:rgba(240,165,0,0.2);color:var(--warn)}}.col .lb.c3{{background:rgba(108,92,231,0.2);color:var(--pipe)}}
.col .lb.c4{{background:rgba(233,69,96,0.2);color:#e94560}}.col .lb.c5{{background:rgba(0,184,148,0.2);color:#00b894}}
.col img{{width:100%;border-radius:8px;cursor:zoom-in}}.col .tm{{font-size:0.7em;color:var(--muted);margin-top:4px}}
.cp{{background:rgba(255,255,255,0.03);border-radius:6px;padding:8px;margin-top:8px;font-size:0.72em;color:#aaa;line-height:1.5;text-align:left;max-height:80px;overflow-y:auto}}
.vt{{display:flex;gap:10px;margin-top:14px;padding-top:14px;border-top:1px solid rgba(255,255,255,0.06);align-items:center;flex-wrap:wrap}}
.vt label{{font-size:0.8em;color:var(--muted)}}
.vb{{padding:6px 16px;border-radius:6px;border:1px solid var(--border);background:transparent;color:var(--muted);cursor:pointer;font-size:0.85em;transition:all 0.2s}}
.vb:hover{{border-color:var(--success);color:var(--success)}}
.vb.sel{{background:var(--success);color:#1a1a2e;border-color:var(--success);font-weight:700}}
.nt{{flex:1;min-width:120px;background:rgba(255,255,255,0.05);border:1px solid var(--border);border-radius:6px;color:var(--text);padding:6px 8px;font-size:0.8em;resize:vertical;min-height:36px;font-family:inherit}}
.bb{{position:fixed;bottom:0;left:0;right:0;background:var(--card);border-top:1px solid var(--border);padding:12px 24px;display:flex;justify-content:space-between;align-items:center;z-index:100}}
.btn{{padding:8px 20px;border-radius:8px;border:none;cursor:pointer;font-weight:600}}
.bp{{background:var(--accent);color:#fff}}.bs{{background:var(--border);color:var(--text)}}
.ov{{display:none;position:fixed;inset:0;background:rgba(0,0,0,0.92);z-index:200;cursor:zoom-out;justify-content:center;align-items:center}}
.ov.show{{display:flex}}.ov img{{max-width:95vw;max-height:95vh;object-fit:contain;border-radius:8px}}
</style></head><body>
<div class="hd"><h1>Style A/B Test</h1>
<p>Compare realism styles — vote for the best result per prompt</p></div>
<div id="ct"></div>
<div class="bb">
<span id="stats" style="font-size:0.85em;color:var(--muted)">0 voted</span>
<div style="display:flex;gap:8px;align-items:center">
<button class="btn bs" onclick="resetAll()">Reset</button>
<button class="btn bp" onclick="copyFeedback()" title="Copy JSON to clipboard">📋 Copy JSON</button>
<button class="btn bp" onclick="saveFeedback()" title="Save JSON file">💾 Save File</button>
<span id="copied" style="color:var(--success);font-size:0.8em;opacity:0;transition:opacity .3s">Copied!</span>
</div>
</div>
<div class="ov" id="ov" onclick="this.classList.remove('show')"><img id="oi" src=""></div>
<script>
const R={rows_json};
const L={labels_json};
const N={n_cols_json};
const V={{}};  // {{index: 'a'|'b'|'c'|'d'}}
const Nt={{}}; // {{index: notes}}
function render(){{
const ct=document.getElementById('ct');
ct.innerHTML=R.map((r,i)=>{{
const v=V[i]||'';
const nt=Nt[i]||'';
let cols='';
for(let c=0;c<r.images.length;c++){{
  const cap=r.captions[c]||'';
  const cls='c'+c;
  const tm=(r.timings[c]||0)+'s';
  cols+=`<div class="col"><div class="lb ${{cls}}">${{L[c]||('Col '+c)}}</div>`
    +`<img src="${{r.images[c]}}" onclick="z('${{r.images[c]}}')" loading="lazy">`
    +`<div class="tm">${{tm}}</div>`
    +`<div class="cp"><b>Caption:</b> ${{cap.substring(0,200)}}${{cap.length>200?'...':''}}</div></div>`;
}}
let btns='';
for(let c=0;c<r.images.length;c++){{
  const k=String.fromCharCode(97+c);
  btns+=`<button class="vb ${{v===k?'sel':''}}" onclick="vote(${{i}},'${{k}}')">${{String.fromCharCode(65+c)}}: ${{L[c]||('Col '+c)}}</button>`;
}}
return `<div class="row"><div class="row-hd"><h3>${{r.prompt}} <span class="sub">(seed=${{r.seed}})</span></h3></div>`
+`<div class="imgs">${{cols}}</div>`
+`<div class="vt"><label>Best:</label>${{btns}}`
+`<textarea class="nt" placeholder="Notes..." oninput="note(${{i}},this.value)">${{nt}}</textarea></div></div>`;
}}).join('');
document.getElementById('stats').textContent=Object.keys(V).length+'/'+R.length+' voted';
}}
function vote(i,k){{if(V[i]===k)delete V[i];else V[i]=k;render();}}
function note(i,txt){{Nt[i]=txt;}}
function z(s){{document.getElementById('oi').src=s;document.getElementById('ov').classList.add('show');}}
function resetAll(){{Object.keys(V).forEach(k=>delete V[k]);Object.keys(Nt).forEach(k=>delete Nt[k]);render();}}
function _buildJSON(){{
return JSON.stringify({{
  test:"{test_name}",ts:"{ts}",
  results:R.map((r,i)=>({{
    prompt:r.prompt,seed:r.seed,
    images:r.images,timings:r.timings,
    captions:r.captions,
    vote:V[i]||null,notes:Nt[i]||''
  }}))
}},null,2);
}}
function copyFeedback(){{
const json=_buildJSON();
navigator.clipboard.writeText(json).then(()=>{{
  const el=document.getElementById('copied');el.style.opacity='1';setTimeout(()=>el.style.opacity='0',2000);
}}).catch(()=>{{
  const ta=document.createElement('textarea');ta.value=json;document.body.appendChild(ta);ta.select();document.execCommand('copy');document.body.removeChild(ta);
  const el=document.getElementById('copied');el.style.opacity='1';setTimeout(()=>el.style.opacity='0',2000);
}});
}}
function saveFeedback(){{
const json=_buildJSON();
const b=new Blob([json],{{type:'application/json'}});
const a=document.createElement('a');a.href=URL.createObjectURL(b);
a.download='style-ab-feedback-{ts}.json';a.click();
}}
render();
</script></body></html>"""

    html_path = os.path.join(output_dir, f"{base_name}_ab.html")
    with open(html_path, "w", encoding="utf-8") as f:
        f.write(html_content)
    size_mb = os.path.getsize(html_path) / (1024 * 1024)
    print(f"  HTML: {html_path} ({size_mb:.1f} MB)")
    return html_path



    """Render a simple 2-column review HTML: original vs anime2real result.

    Each pair has 👍/👎 feedback + text comment.
    """
    import html as html_mod

    cards = []
    for i, t in enumerate(triples):
        caps = captions[i] if captions else {}
        ca = html_mod.escape(caps.get("caption_a", ""))
        cb = html_mod.escape(caps.get("caption_b", ""))
        mh = ""
        if metrics:
            m = metrics[i]
            mh = _build_metrics_rows_n(
                [m["metrics_a"], m["metrics_b"]],
                [label_a, label_b],
            )
        cards.append({
            "prompt_name": t["prompt_name"],
            "anime_prompt": html_mod.escape(t["anime_prompt"][:200]),
            "seed": t["seed"],
            "img_a": os.path.basename(t["paths"][0]),
            "img_b": os.path.basename(t["paths"][1]),
            "timing_a": t["timings"][0],
            "timing_b": t["timings"][1],
            "cap_a": ca, "cap_b": cb,
            "metrics_html": mh,
        })

    cj = json.dumps(cards, ensure_ascii=False)

    html_content = f"""<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>anime2real Review</title>
<style>
:root{{--bg:#1a1a2e;--card:#16213e;--border:#0f3460;--accent:#e94560;--text:#eee;--muted:#999;--success:#4ecca3;--warn:#f0a500}}
*{{box-sizing:border-box;margin:0;padding:0}}
body{{background:var(--bg);color:var(--text);font-family:-apple-system,sans-serif;padding:20px;padding-bottom:80px}}
.hd{{text-align:center;margin-bottom:24px}}.hd h1{{font-size:1.6em;margin-bottom:6px}}.hd p{{color:var(--muted);font-size:0.85em}}
.row{{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:20px;margin-bottom:20px}}
.row-hd{{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px}}
.row-hd h3{{font-size:1.05em}}.row-hd .sub{{font-size:0.75em;color:var(--muted)}}
.imgs{{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:14px}}
.col{{text-align:center}}
.col .lb{{font-size:0.8em;font-weight:700;margin-bottom:8px;padding:4px 10px;border-radius:4px;display:inline-block}}
.col .lb.orig{{background:rgba(255,255,255,0.1)}}.col .lb.result{{background:rgba(78,204,163,0.2);color:var(--success)}}
.col img{{width:100%;border-radius:8px;cursor:zoom-in}}.col .tm{{font-size:0.7em;color:var(--muted);margin-top:4px}}
.cp{{background:rgba(255,255,255,0.03);border-radius:6px;padding:8px;margin-top:8px;font-size:0.75em;color:#aaa;line-height:1.5;text-align:left;max-height:100px;overflow-y:auto}}
.cp b{{color:var(--muted)}}
.tbl{{width:100%;border-collapse:collapse;font-size:0.75em;margin-top:12px}}
.tbl th,.tbl td{{padding:4px 8px;text-align:center;border-bottom:1px solid rgba(255,255,255,0.06)}}
.tbl th{{color:var(--muted);font-weight:600}}.tbl .best{{color:var(--success);font-weight:700}}
.fb{{display:flex;gap:12px;align-items:center;margin-top:14px;padding-top:14px;border-top:1px solid rgba(255,255,255,0.06)}}
.fb label{{font-size:0.8em;color:var(--muted)}}
.fb button{{padding:8px 18px;border-radius:6px;border:1px solid var(--border);background:transparent;color:var(--muted);cursor:pointer;font-size:0.85em;transition:all 0.2s}}
.fb button:hover{{border-color:var(--success);color:var(--success)}}
.fb button.good.sel{{background:#4ecca3;color:#1a1a2e;border-color:#4ecca3;font-weight:700}}
.fb button.bad.sel{{background:var(--warn);color:#1a1a2e;border-color:var(--warn);font-weight:700}}
.fb textarea{{flex:1;background:rgba(255,255,255,0.05);border:1px solid var(--border);border-radius:6px;color:var(--text);padding:8px;font-size:0.8em;resize:vertical;min-height:40px;font-family:inherit}}
.bb{{position:fixed;bottom:0;left:0;right:0;background:var(--card);border-top:1px solid var(--border);padding:12px 24px;display:flex;justify-content:space-between;align-items:center;z-index:100}}
.btn{{padding:8px 20px;border-radius:8px;border:none;cursor:pointer;font-weight:600}}
.bp{{background:var(--accent);color:#fff}}.bs{{background:var(--border);color:var(--text)}}
.ov{{display:none;position:fixed;inset:0;background:rgba(0,0,0,0.92);z-index:200;cursor:zoom-out;justify-content:center;align-items:center}}
.ov.show{{display:flex}}.ov img{{max-width:95vw;max-height:95vh;object-fit:contain;border-radius:8px}}
</style></head><body>
<div class="hd"><h1>🎨 anime2real Review</h1>
<p>Original anime vs Ref+LoRA realistic result — rate each conversion</p></div>
<div id="ct"></div>
<div class="bb">
<span id="stats" style="font-size:0.85em;color:var(--muted)">0 reviewed</span>
<div style="display:flex;gap:8px;align-items:center">
<button class="btn bs" onclick="resetAll()">Reset</button>
<button class="btn bp" onclick="copyFeedback()" title="Copy JSON to clipboard">📋 Copy JSON</button>
<button class="btn bp" onclick="saveFeedback()" title="Save JSON file to disk">💾 Save File</button>
<span id="copied" style="color:var(--success);font-size:0.8em;opacity:0;transition:opacity .3s">Copied!</span>
</div>
</div>
<div class="ov" id="ov" onclick="this.classList.remove('show')"><img id="oi" src=""></div>
<script>
const C={cj};
const FB={{}}; // {{index: {{good:bool, notes:str}}}}
function render(){{
const ct=document.getElementById('ct');
ct.innerHTML=C.map((c,i)=>{{
const fb=FB[i]||{{}};
return `<div class="row">
<div class="row-hd"><h3>${{c.prompt_name}} <span class="sub">(seed=${{c.seed}})</span></h3>
<div class="sub">${{c.anime_prompt}}</div></div>
<div class="imgs">
<div class="col"><div class="lb orig">Original (Anime)</div>
<img src="${{c.img_a}}" onclick="z('${{c.img_a}}')" loading="lazy">
<div class="tm">${{c.timing_a}}s</div>
<div class="cp"><b>Caption:</b> ${{c.cap_a.substring(0,300)}}${{c.cap_a.length>300?'...':''}}</div></div>
<div class="col"><div class="lb result">Result (Realistic)</div>
<img src="${{c.img_b}}" onclick="z('${{c.img_b}}')" loading="lazy">
<div class="tm">${{c.timing_b}}s</div>
<div class="cp"><b>Caption:</b> ${{c.cap_b.substring(0,300)}}${{c.cap_b.length>300?'...':''}}</div></div>
</div>${{c.metrics_html||''}}
<div class="fb">
<label>Feedback:</label>
<button class="good ${{fb.good===true?'sel':''}}" onclick="vote(${{i}},true)">👍 Good</button>
<button class="bad ${{fb.good===false?'sel':''}}" onclick="vote(${{i}},false)">👎 Bad</button>
<textarea placeholder="Notes..." oninput="note(${{i}},this.value)">${{fb.notes||''}}</textarea>
</div></div>`;
}}).join('');
document.getElementById('stats').textContent=Object.keys(FB).length+'/'+C.length+' reviewed';
}}
function vote(i,good){{FB[i]=FB[i]||{{}};FB[i].good=good;render();}}
function note(i,txt){{FB[i]=FB[i]||{{}};FB[i].notes=txt;}}
function z(s){{document.getElementById('oi').src=s;document.getElementById('ov').classList.add('show');}}
function resetAll(){{Object.keys(FB).forEach(k=>delete FB[k]);render();}}
function _buildFeedbackJSON(){{
const r=C.map((c,i)=>({{
prompt:c.prompt_name,seed:c.seed,
original:c.img_a,result:c.img_b,
timings:{{original:c.timing_a,result:c.timing_b}},
caption_original:c.cap_a,caption_result:c.cap_b,
feedback:FB[i]||{{}}
}}));
return JSON.stringify({{test:"{test_name}",ts:"{ts}",results:r}},null,2);
}}
function copyFeedback(){{
const json=_buildFeedbackJSON();
navigator.clipboard.writeText(json).then(()=>{{
const el=document.getElementById('copied');el.style.opacity='1';setTimeout(()=>el.style.opacity='0',2000);
}}).catch(()=>{{
// Fallback: select a temporary textarea
const ta=document.createElement('textarea');ta.value=json;document.body.appendChild(ta);ta.select();document.execCommand('copy');document.body.removeChild(ta);
const el=document.getElementById('copied');el.style.opacity='1';setTimeout(()=>el.style.opacity='0',2000);
}});
}}
function saveFeedback(){{
const json=_buildFeedbackJSON();
const b=new Blob([json],{{type:'application/json'}});
const a=document.createElement('a');a.href=URL.createObjectURL(b);
a.download='anime2real-feedback-{ts}.json';a.click();
}}
render();
</script></body></html>"""

    html_path = os.path.join(output_dir, f"{base_name}.html")
    with open(html_path, "w", encoding="utf-8") as f:
        f.write(html_content)
    size_mb = os.path.getsize(html_path) / (1024 * 1024)
    print(f"  HTML: {html_path} ({size_mb:.1f} MB)")
    return html_path


def _render_lora_ref_html(*, output_dir, base_name, test_name, test_cfg,
                           label_a, label_b, label_c, triples, captions, metrics,
                           ref_steps, i2i_steps, lora_scale, ref_count,
                           denoise_strength, ref_prompt, i2i_prompt, ts,
                           label_d=None, review_only=False):
    import html as html_mod

    # --- review_only: simple 2-column feedback HTML ---
    if review_only:
        return _render_review_only_html(
            output_dir=output_dir, base_name=base_name, test_name=test_name,
            triples=triples, captions=captions, metrics=metrics,
            label_a=label_a, label_b=label_b, ts=ts,
        )

    has_d = label_d is not None

    cards = []
    for i, t in enumerate(triples):
        caps = captions[i] if captions else {}
        ca = html_mod.escape(caps.get("caption_a", ""))
        cb = html_mod.escape(caps.get("caption_b", ""))
        cc = html_mod.escape(caps.get("caption_c", ""))
        sb = html_mod.escape(caps.get("style_b", ""))
        cd = html_mod.escape(caps.get("caption_d", "")) if has_d else ""
        mh = ""
        if metrics:
            m = metrics[i]
            if has_d and "metrics_d" in m:
                mh = _build_metrics_rows_n(
                    [m["metrics_a"], m["metrics_b"], m["metrics_c"], m["metrics_d"]],
                    [label_a, label_b, label_c, label_d],
                )
            else:
                mh = _build_metrics_rows_n(
                    [m["metrics_a"], m["metrics_b"], m["metrics_c"]],
                    [label_a, label_b, label_c],
                )
        card = {
            "prompt_name": t["prompt_name"],
            "anime_prompt": html_mod.escape(t["anime_prompt"][:200]),
            "seed": t["seed"],
            "img_a": os.path.basename(t["paths"][0]),
            "img_b": os.path.basename(t["paths"][1]),
            "img_c": os.path.basename(t["paths"][2]),
            "timing_a": t["timings"][0],
            "timing_b": t["timings"][1],
            "timing_c": t["timings"][2],
            "cap_a": ca, "cap_b": cb, "cap_c": cc,
            "style_b": sb, "metrics_html": mh,
            "has_d": has_d,
        }
        if has_d and len(t["paths"]) > 3:
            card["img_d"] = os.path.basename(t["paths"][3])
            card["timing_d"] = t["timings"][3]
            card["cap_d"] = cd
            card["label_d"] = label_d
        cards.append(card)

    cj = json.dumps(cards, ensure_ascii=False)

    # Dynamic CSS grid columns
    grid_cols = "1fr 1fr 1fr 1fr" if has_d else "1fr 1fr 1fr"
    # How-it-works: extra panel for column D if present
    panel_d_html = ""
    if has_d:
        panel_d_html = (
            '<div class="ap" style="border-left:3px solid #6c5ce7">'
            '<h4 style="color:#6c5ce7">Pipeline Compare (Column D)</h4><ul>'
            '<li>ZImage pipeline I2I with jib-mix-realistic LoRA</li>'
            '<li>Tests cross-pipeline anime→realistic conversion</li>'
            '<li>Compares a different model architecture + LoRA combination</li>'
            '</ul></div>'
        )
    how_grid = "1fr 1fr 1fr" if has_d else "1fr 1fr"

    html_content = (
        f"""<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Anime2Real Ref+LoRA Review</title>
<style>
:root{{--bg:#1a1a2e;--card:#16213e;--border:#0f3460;--accent:#e94560;--text:#eee;--muted:#999;--success:#4ecca3;--warn:#f0a500;--pipe:#6c5ce7}}
*{{box-sizing:border-box;margin:0;padding:0}}
body{{background:var(--bg);color:var(--text);font-family:-apple-system,sans-serif;padding:20px;padding-bottom:80px}}
.hd{{text-align:center;margin-bottom:20px}}.hd h1{{font-size:1.5em;margin-bottom:4px}}.hd p{{color:var(--muted);font-size:0.85em}}
.hw{{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:16px;margin-bottom:20px}}
.hw h3{{color:var(--success);margin-bottom:8px}}.hw p{{font-size:0.82em;line-height:1.7;color:#ccc;margin-bottom:8px}}
.hw .g2{{display:grid;grid-template-columns:{how_grid};gap:12px;margin-top:10px}}
.hw .ap{{background:rgba(255,255,255,0.03);border-radius:8px;padding:10px}}
.hw .ap h4{{font-size:0.85em;margin-bottom:6px}}
.hw .ap.gd h4{{color:var(--success)}}.hw .ap.bd h4{{color:var(--warn)}}
.hw .ap ul{{padding-left:16px;font-size:0.78em;color:#bbb;line-height:1.6}}
.tr{{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:16px;margin-bottom:20px}}
.th{{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}}
.th h3{{font-size:1em}}.th .mt2{{font-size:0.75em;color:var(--muted)}}
.im{{display:grid;grid-template-columns:{grid_cols};gap:12px;margin-bottom:12px}}
.cl{{text-align:center}}
.cl .lb{{font-size:0.78em;font-weight:700;margin-bottom:6px;padding:3px 8px;border-radius:4px;display:inline-block}}
.cl .lb.a{{background:rgba(255,255,255,0.1)}}.cl .lb.b{{background:rgba(78,204,163,0.2);color:var(--success)}}.cl .lb.c{{background:rgba(240,165,0,0.2);color:var(--warn)}}.cl .lb.d{{background:rgba(108,92,231,0.2);color:var(--pipe)}}
.cl img{{width:100%;border-radius:8px;cursor:zoom-in}}.cl .tm{{font-size:0.7em;color:var(--muted);margin-top:4px}}
.cp{{background:rgba(255,255,255,0.03);border-radius:6px;padding:8px;margin-top:8px;font-size:0.75em;color:#aaa;line-height:1.5;text-align:left;max-height:100px;overflow-y:auto}}
.cp b{{color:var(--muted)}}
.tbl{{width:100%;border-collapse:collapse;font-size:0.75em;margin-top:12px}}
.tbl th,.tbl td{{padding:4px 8px;text-align:center;border-bottom:1px solid rgba(255,255,255,0.06)}}
.tbl th{{color:var(--muted);font-weight:600}}.tbl .best{{color:var(--success);font-weight:700}}
.vr{{display:flex;gap:8px;margin-top:10px;justify-content:center;align-items:center}}
.vb{{padding:6px 16px;border-radius:6px;border:1px solid var(--border);background:transparent;color:var(--muted);cursor:pointer;font-size:0.8em}}
.vb:hover{{border-color:var(--success);color:var(--success)}}
.vb.sel{{background:var(--success);color:#1a1a2e;border-color:var(--success);font-weight:700}}
.bb{{position:fixed;bottom:0;left:0;right:0;background:var(--card);border-top:1px solid var(--border);padding:12px 24px;display:flex;justify-content:space-between;align-items:center;z-index:100}}
.btn{{padding:8px 20px;border-radius:8px;border:none;cursor:pointer;font-weight:600}}
.bp{{background:var(--accent);color:#fff}}.bs{{background:var(--border);color:var(--text)}}
.ov{{display:none;position:fixed;inset:0;background:rgba(0,0,0,0.92);z-index:200;cursor:zoom-out;justify-content:center;align-items:center}}
.ov.show{{display:flex}}.ov img{{max-width:95vw;max-height:95vh;object-fit:contain;border-radius:8px}}
</style></head><body>
<div class="hd"><h1>Anime to Realistic: Ref+LoRA vs I2I</h1>
<p>Flux2KleinEdit reference conditioning preserves identity while converting anime to photorealistic</p></div>
<div class="hw"><h3>How and Why It Works</h3>
<p>The anime input is VAE-encoded into <b>reference latent tokens</b> and <b>concatenated</b> with noise latents (NOT mixed).
The model sees the original character at every denoising step, preserving identity.
The anime2real LoRA biases the transformer toward realistic output.</p>
<div class="g2">
<div class="ap gd"><h4>NEW: Ref+LoRA (Column B)</h4><ul>
<li>Reference tokens preserve structure and identity</li><li>LoRA converts anime to realistic style</li>
<li>No high-denoise requirement (starts from pure noise)</li><li>Output looks like a real cosplayer</li></ul></div>
<div class="ap bd"><h4>OLD: I2I+LoRA (Column C)</h4><ul>
<li>Mixes clean latent with noise: 80% noise at denoise=0.6</li>
<li>LoRA needs high noise to activate, but noise destroys identity</li>
<li>Output: completely different person</li><li>LoRA only works at denoise &gt;= 0.6</li></ul></div>
{panel_d_html}
</div></div>
<div id="ct"></div>
<div class="bb"><span id="vc" style="font-size:0.85em;color:var(--muted)">0 Ref+LoRA wins</span>
<div><button class="btn bs" onclick="resetAll()" style="margin-right:8px">Reset</button>
<button class="btn bp" onclick="exportJSON()">Export JSON</button></div></div>
<div class="ov" id="ov" onclick="this.classList.remove('show')"><img id="oi" src=""></div>
<script>
const C={cj};const V={{}};
function render(){{
document.getElementById('ct').innerHTML=C.map((c,i)=>{{
let html=`<div class="tr"><div class="th"><h3>${{c.prompt_name}} <span style="font-size:0.75em;color:var(--muted)">(seed=${{c.seed}})</span></h3>
<div class="mt2">${{c.anime_prompt}}</div></div><div class="im">`
+`<div class="cl"><div class="lb a">A: Anime Baseline</div><img src="${{c.img_a}}" onclick="z('${{c.img_a}}')" loading="lazy">
<div class="tm">${{c.timing_a}}s</div><div class="cp"><b>Caption:</b> ${{c.cap_a.substring(0,300)}}${{c.cap_a.length>300?'...':''}}</div></div>`
+`<div class="cl"><div class="lb b">B: Ref+LoRA (NEW)</div><img src="${{c.img_b}}" onclick="z('${{c.img_b}}')" loading="lazy">
<div class="tm">${{c.timing_b}}s</div><div class="cp"><b>Caption:</b> ${{c.cap_b.substring(0,300)}}${{c.cap_b.length>300?'...':''}}</div>
<div class="cp" style="margin-top:4px"><b>Style:</b> ${{c.style_b}}</div></div>`
+`<div class="cl"><div class="lb c">C: I2I+LoRA (OLD)</div><img src="${{c.img_c}}" onclick="z('${{c.img_c}}')" loading="lazy">
<div class="tm">${{c.timing_c}}s</div><div class="cp"><b>Caption:</b> ${{c.cap_c.substring(0,300)}}${{c.cap_c.length>300?'...':''}}</div></div>`"""
    )

    # Add column D dynamically
    if has_d:
        html_content += (
            """`+(()=>{
if(!c.has_d||!c.img_d)return '';
return `<div class="cl"><div class="lb d">D: ${{c.label_d||'Pipeline'}}</div><img src="${{c.img_d}}" onclick="z('${{c.img_d}}')" loading="lazy">
<div class="tm">${{c.timing_d}}s</div><div class="cp"><b>Caption:</b> ${{(c.cap_d||'').substring(0,300)}}${{(c.cap_d||'').length>300?'...':''}}</div></div>`;
})()+`"""
        )
    html_content += (
        """</div>${{c.metrics_html||''}}
<div class="vr"><span style="font-size:0.8em;color:var(--muted)">Winner:</span>
<button class="vb ${{V[i]===\\"a\\"?\\"sel\\":\\"\\"}}" onclick="v(${{i}},\\"a\\")">A</button>
<button class="vb ${{V[i]===\\"b\\"?\\"sel\\":\\"\\"}}" onclick="v(${{i}},\\"b\\")">B: Ref+LoRA</button>
<button class="vb ${{V[i]===\\"c\\"?\\"sel\\":\\"\\"}}" onclick="v(${{i}},\\"c\\")">C</button>"""
    )
    if has_d:
        html_content += (
            """<button class="vb ${{V[i]===\\"d\\"?\\"sel\\":\\"\\"}}" onclick="v(${{i}},\\"d\\")">D: Pipeline</button>"""
        )
    html_content += (
        """<button class="vb" onclick="v(${{i}},null)">Skip</button></div></div>`;return html;}}).join('');
document.getElementById('vc').textContent=Object.values(V).filter(x=>x==='b').length+' Ref+LoRA wins';}}
function v(i,c){{if(c)V[i]=c;else delete V[i];render();}}
function z(s){{document.getElementById('oi').src=s;document.getElementById('ov').classList.add('show');}}
function resetAll(){{Object.keys(V).forEach(k=>delete V[k]);render();}}
function exportJSON(){{
const r=C.map((c,i)=>{{
const imgs={{baseline:c.img_a,ref_lora:c.img_b,i2i_lora:c.img_c}};"""
    )
    if has_d:
        html_content += (
            """if(c.has_d&&c.img_d)imgs.pipeline=c.img_d;"""
        )
    html_content += (
        f"""const tms={{a:c.timing_a,b:c.timing_b,c:c.timing_c}};"""
    )
    if has_d:
        html_content += (
            """if(c.has_d&&c.timing_d)tms.d=c.timing_d;"""
        )
    html_content += (
        """return{{prompt:c.prompt_name,seed:c.seed,anime_prompt:c.anime_prompt,images:imgs,timings:tms,vote:V[i]||null}};}});"""
        f"""const b=new Blob([JSON.stringify({{test:"{test_name}",ts:"{ts}",results:r}},null,2)],{{type:'application/json'}});"""
        """const a=document.createElement('a');a.href=URL.createObjectURL(b);a.download='anime2real-votes.json';a.click();}}
render();
</script></body></html>"""
    )

    html_path = os.path.join(output_dir, f"{base_name}_review.html")
    with open(html_path, "w", encoding="utf-8") as f:
        f.write(html_content)
    print(f"  HTML: {html_path} ({os.path.getsize(html_path)/(1024*1024):.1f} MB)")
    return html_path


def _build_metrics_rows_n(metrics_list, labels):
    """Build an HTML metrics comparison table for N columns."""
    import html as html_mod
    if not metrics_list or not metrics_list[0]:
        return ""
    keys = list(metrics_list[0].keys())
    if not keys:
        return ""
    col_idx = "ABCDEFGHIJ"
    header = "<tr><th>Metric</th>" + "".join(f"<th>{html_mod.escape(l)}</th>" for l in labels) + "</tr>"
    rows = ""
    for k in keys:
        vals = [m.get(k, 0) for m in metrics_list]
        mx2 = max(vals) if vals else 0
        row = "<tr><td>" + html_mod.escape(k) + "</td>"
        for v in vals:
            cls = ' class="best"' if v == mx2 else ""
            row += f"<td{cls}>{v:.3f}</td>"
        row += "</tr>\n"
        rows += row
    return '<table class="tbl">' + header + rows + '</table>'


def _build_metrics_rows_3(m_a, m_b, m_c, label_a, label_b, label_c):
    """Backward-compatible wrapper for 3-column metrics."""
    return _build_metrics_rows_n([m_a, m_b, m_c], [label_a, label_b, label_c])
