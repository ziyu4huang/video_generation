"""review-video — Generate a self-contained Bun video reviewer for A/B test sessions."""

import json
import os
import shutil
import subprocess
import sys
from datetime import datetime, timezone

from app import config as cfg

PARSER_META = {
    "help": "Generate A/B video reviewer (Bun HTTP server, proper Range support)",
    "description": (
        "Reads manifest.json files from a test session and produces a single self-contained\n"
        "video-reviewer-<model>-<timestamp>.js. Run it with bun to start a local HTTP server\n"
        "with proper Range support so videos are fully seekable.\n\n"
        "Auto-detects aligned files for each test (same base name as manifest):\n"
        "  <base>.mp4             video\n"
        "  <base>.png             first-frame thumbnail (from: run.py video --first-frame)\n"
        "  <base>.caption.json   caption text       (from: run.py video --caption)\n\n"
        "Examples:\n"
        "  run.py review-video --inputs output/*.manifest.json\n"
        "  run.py review-video --inputs output/A.manifest.json output/B.manifest.json\n"
        "  run.py review-video --inputs output/*.manifest.json --labels 'cfg3,cfg5'\n"
    ),
}

_STATIC_TEMPLATE = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "scripts", "review-viewer-static.js",
)


def add_args(parser):
    parser.add_argument(
        "--inputs", nargs="+", required=True, metavar="MANIFEST",
        help="One or more manifest.json paths",
    )
    parser.add_argument(
        "--labels", type=str, default=None,
        help="Comma-separated labels, e.g. 'A,B,C,D' (auto A/B/C/D… if omitted)",
    )
    parser.add_argument(
        "--output", type=str, default=None, metavar="DIR",
        help="Output directory (default: same dir as first input)",
    )
    parser.add_argument(
        "--no-open", action="store_true", default=False,
        help="Write the .js file but do not launch it",
    )


def run(args):
    manifests = [
        f if f.endswith(".manifest.json") else f + ".manifest.json"
        for f in args.inputs
    ]

    tests = [_load_test(m) for m in manifests]
    labels = _make_labels(args.labels, len(tests))
    for t, label in zip(tests, labels):
        t["label"] = label

    model = _detect_model(tests)
    out_dir = args.output or os.path.dirname(os.path.abspath(manifests[0]))
    os.makedirs(out_dir, exist_ok=True)

    slug = model.replace(" ", "-").replace("/", "-").lower()
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    out_js = os.path.join(out_dir, f"video-reviewer-{slug}-{ts}.js")

    config_js = _render_config_js(tests, model)
    static_js = _read_static()
    with open(out_js, "w", encoding="utf-8") as f:
        f.write(config_js)
        f.write("\n\n")
        f.write(static_js)

    total_mb = sum(
        os.path.getsize(t["video_file"]) for t in tests if t.get("video_file")
    ) / 1_048_576
    n_thumb = sum(1 for t in tests if t.get("thumbnail_file"))
    n_cap = sum(1 for t in tests if t.get("caption_text"))
    print(f"[review-video] Written: {out_js}")
    print(f"[review-video] Tests:   {len(tests)}  ({total_mb:.1f} MB video on disk"
          f"{f', {n_thumb} thumbnails' if n_thumb else ''}"
          f"{f', {n_cap} captions' if n_cap else ''})")

    if not args.no_open:
        bun = shutil.which("bun")
        if not bun:
            print("ERROR: bun not found. Install from https://bun.sh, then run:")
            print(f"  bun run {out_js}")
            sys.exit(1)
        # Start Bun server; read stdout via a temp file to avoid pipe-break kills
        import tempfile
        log_fd, log_path = tempfile.mkstemp(prefix="review-video-", suffix=".log")
        os.close(log_fd)
        proc = subprocess.Popen(
            [bun, "run", out_js],
            stdout=open(log_path, "w"),
            stderr=subprocess.STDOUT,
        )
        # Wait briefly for the "Serving at" line
        url = None
        for _ in range(50):  # up to 5 seconds
            import time; time.sleep(0.1)
            with open(log_path) as f:
                for line in f:
                    if "Serving at" in line:
                        url = line.strip().split()[-1]
                        break
            if url:
                break
        if url:
            subprocess.Popen(["open", url])
            print(f"[review-video] Opened {url}")
            print(f"[review-video] Log: {log_path}  (PID: {proc.pid})")
        else:
            print("[review-video] Server started but could not detect URL")
            print(f"[review-video] Log: {log_path}  (PID: {proc.pid})")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _load_test(manifest_path: str) -> dict:
    base = manifest_path.replace(".manifest.json", "")
    run_path = base + ".run.json"

    manifest, run = {}, {}
    if os.path.exists(manifest_path):
        with open(manifest_path) as f:
            manifest = json.load(f)
    else:
        print(f"  WARNING: not found: {manifest_path}", file=sys.stderr)
    if os.path.exists(run_path):
        with open(run_path) as f:
            run = json.load(f)

    # Find video file
    video_file = None
    for of in manifest.get("output_files", []):
        p = of.get("path", "")
        if p.endswith(".mp4") and os.path.exists(p):
            video_file = p
            break
    if not video_file:
        mp4 = base + ".mp4"
        if os.path.exists(mp4):
            video_file = mp4

    # Report video file
    if video_file:
        mb = os.path.getsize(video_file) / 1_048_576
        print(f"  Video      {os.path.basename(video_file)} ({mb:.1f} MB)")

    # Detect aligned first-frame PNG
    thumbnail_path = None
    png_path = base + ".png"
    if os.path.exists(png_path):
        thumbnail_path = os.path.abspath(png_path)
        print(f"  Thumbnail  {os.path.basename(png_path)}")

    # Detect aligned caption.json
    caption_text = None
    caption_path = base + ".caption.json"
    if os.path.exists(caption_path):
        with open(caption_path) as f:
            caption_text = json.load(f).get("caption", "")
        preview = (caption_text or "")[:60].replace("\n", " ")
        print(f"  Caption    {os.path.basename(caption_path)}: {preview}…")

    # Key params to display
    params = {}
    for key in ["cfg_scale", "stg_scale", "steps", "stage1_steps", "stage2_steps",
                "seed", "width", "height", "frames", "fps", "lora_scale",
                "denoise_strength", "low_ram"]:
        v = run.get(key)
        if v is not None:
            params[key] = v

    return {
        "video_file": os.path.abspath(video_file) if video_file else None,
        "thumbnail_file": thumbnail_path,
        "caption_text": caption_text,
        "status": manifest.get("status", "unknown"),
        "prompt": run.get("prompt") or run.get("prompt_file") or "",
        "params": params,
        "elapsed": manifest.get("elapsed_seconds"),
        "memory_mb": manifest.get("memory_peak_mb"),
        "models": manifest.get("models", {}),
    }


def _make_labels(labels_arg: str | None, n: int) -> list[str]:
    if labels_arg:
        parts = [p.strip() for p in labels_arg.split(",")]
        if len(parts) >= n:
            return parts[:n]
    return [chr(65 + i) for i in range(n)]


def _detect_model(tests: list[dict]) -> str:
    for t in tests:
        for key in t.get("models", {}):
            if "ltx" in key.lower():
                return "ltx-2.3"
            if "flux" in key.lower():
                return "flux2"
            if "zimage" in key.lower() or "moody" in key.lower():
                return "zimage"
    return "video"


def _render_config_js(tests: list[dict], model: str) -> str:
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    tests_data = [
        {
            "label": t["label"],
            "status": t["status"],
            "prompt": t["prompt"],
            "params": t["params"],
            "elapsed": t["elapsed"],
            "memory_mb": t["memory_mb"],
            "mime": "video/mp4",
            "videoPath": t["video_file"] or "",
            "thumbnailPath": t["thumbnail_file"] or "",
            "caption": t["caption_text"] or "",
        }
        for t in tests
    ]
    config_json = json.dumps({"model": model, "generatedAt": now, "tests": tests_data},
                             ensure_ascii=False)
    return (
        f"// AUTO-GENERATED — regenerate with: run.py review-video --inputs ...\n"
        f"// Model: {model}  |  Generated: {now}\n"
        f"const CONFIG = {config_json};\n"
    )


def _read_static() -> str:
    if not os.path.exists(_STATIC_TEMPLATE):
        print(f"ERROR: static template not found: {_STATIC_TEMPLATE}", file=sys.stderr)
        sys.exit(1)
    with open(_STATIC_TEMPLATE, encoding="utf-8") as f:
        return f.read()
