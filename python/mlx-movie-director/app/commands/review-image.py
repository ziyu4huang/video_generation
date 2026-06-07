"""review-image — A/B test review HTML generator for image generation outputs.

Takes .manifest.json files from previous ``run.py generate`` runs, auto-finds
the paired .run.json + .png, and builds a self-contained HTML page with
side-by-side image comparison, star ratings, comments, winner selection, and
structured feedback export (plain text for Claude Code paste, or JSON).

Examples:
  run.py review-image --inputs output/test1.manifest.json output/test2.manifest.json
  run.py review-image --inputs output/*.manifest.json --labels 'steps=4,steps=6'
  run.py review-image --last 4
"""

import json
import os
import subprocess
import sys
from datetime import datetime

from app import config as cfg

PARSER_META = {
    "help": "Generate A/B review HTML for image generation outputs",
    "description": (
        "Build a self-contained HTML page to compare multiple image generation runs.\n\n"
        "Each run shows: image, parameters, timing, star rating, comment box.\n"
        "Feedback generator exports plain text or JSON.\n\n"
        "Examples:\n"
        "  run.py review-image --inputs output/test1.manifest.json output/test2.manifest.json\n"
        "  run.py review-image --inputs output/*.manifest.json --labels 'A,B,C,D'\n"
        "  run.py review-image --last 4\n"
    ),
}


def add_args(parser):
    parser.add_argument(
        "--inputs", nargs="+", metavar="MANIFEST_JSON",
        help=".manifest.json paths (auto-finds paired .run.json + .png)",
    )
    parser.add_argument(
        "--labels", type=str, default=None,
        help="Comma-separated labels (default: A, B, C, …)",
    )
    parser.add_argument(
        "--output", type=str, default=None, metavar="PATH",
        help="Output HTML path (default: output/finetune-review-generation-<pipeline>.html)",
    )
    parser.add_argument(
        "--last", type=int, default=None, metavar="N",
        help="Pick the last N image generation runs",
    )
    parser.add_argument(
        "--open", action="store_true", default=True,
        help="Open HTML in browser (default: True)",
    )


def run(args):
    files = _resolve_files(args)
    if not files:
        print("ERROR: no .manifest.json files found. "
              "Pass --inputs or use --last N.", file=sys.stderr)
        sys.exit(1)

    tests = [_load_test(f) for f in files]
    labels = _make_labels(args.labels, len(tests))
    for t, label in zip(tests, labels):
        t["label"] = label

    model_name = _detect_model(tests)
    out_dir = cfg.OUTPUT_DIR
    out_path = args.output
    if not out_path:
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        out_path = os.path.join(out_dir, f"finetune-review-{ts}.html")
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)

    html = _render_html(tests, model_name, out_dir)
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(html)

    print(f"[review-image] Generated: {out_path}")
    print(f"[review-image] Tests:     {len(tests)}")
    for t in tests:
        status = "✓" if t["status"] == "success" else "✗"
        img_name = os.path.basename(t["image_file"]) if t["image_file"] else "(no image)"
        caption_info = " +caption" if t["caption"] else ""
        print(f"  [{t['label']}] {status}  {img_name}{caption_info}")

    if args.open:
        subprocess.Popen(["open", out_path])


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _resolve_files(args) -> list[str]:
    """Resolve manifest.json file paths from --inputs or --last."""
    if args.last:
        candidates = sorted([
            os.path.join(cfg.OUTPUT_DIR, f)
            for f in os.listdir(cfg.OUTPUT_DIR)
            if f.endswith(".manifest.json")
        ])
        # Filter to image generation runs (have .png, not .mp4)
        image_candidates = []
        for c in candidates:
            base = c.replace(".manifest.json", "")
            has_image = any(os.path.exists(base + ext) for ext in (".png", ".jpg", ".jpeg"))
            has_video = os.path.exists(base + ".mp4")
            if has_image and not has_video:
                image_candidates.append(c)
        return image_candidates[-args.last:]

    if not args.inputs:
        return []

    result = []
    for f in args.inputs:
        if f.endswith(".manifest.json"):
            result.append(f)
        elif f.endswith(".run.json"):
            result.append(f.replace(".run.json", ".manifest.json"))
        else:
            candidate = f.rstrip("/") + ".manifest.json"
            result.append(candidate)
    return result


def _load_test(manifest_file: str) -> dict:
    """Load a single test run from its manifest.json."""
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

    # Find image file (.png/.jpg) from manifest output_files
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

    # Relative path from output dir for HTML <img src>
    image_rel = None
    if image_file:
        image_rel = os.path.relpath(image_file, cfg.OUTPUT_DIR)

    # Check for .caption.json
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


def _make_labels(labels_arg: str | None, n: int) -> list[str]:
    if labels_arg:
        parts = [p.strip() for p in labels_arg.split(",")]
        if len(parts) >= n:
            return parts[:n]
    return [chr(65 + i) for i in range(n)]  # A, B, C, D, …


def _detect_model(tests: list[dict]) -> str:
    for t in tests:
        r = t["run"]
        pipeline = r.get("pipeline", "")
        if pipeline:
            return pipeline  # "flux2-klein" or "zimage"
        if r.get("command") in ("generate", "t2i"):
            return "zimage"
    return "unknown"


# ---------------------------------------------------------------------------
# Image-generation specific param keys
# ---------------------------------------------------------------------------

_PARAM_KEYS = [
    "pipeline", "steps", "width", "height", "seed",
    "denoise_strength", "lora_path", "lora_scale",
    "latent_upscale", "upscale", "upscale_method",
]


# ---------------------------------------------------------------------------
# HTML renderer
# ---------------------------------------------------------------------------

def _render_html(tests: list[dict], model_name: str, out_dir: str) -> str:
    tests_js = []
    for t in tests:
        run = t["run"]
        mf = t["manifest"]
        out_files = mf.get("output_files", [])
        of = out_files[0] if out_files else {}

        # Key params to display
        params = {}
        for key in _PARAM_KEYS:
            if key in run and run[key] is not None:
                params[key] = run[key]

        # Actual output dims
        if of.get("width"):
            params["out_width"] = of["width"]
        if of.get("height"):
            params["out_height"] = of["height"]

        timings = mf.get("timings", {})

        # Caption data (if available)
        caption_text = ""
        if t["caption"]:
            caption_text = t["caption"].get("caption", "")

        # Resolve prompt text: direct prompt > prompt_file contents > fallback
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
                # File no longer exists (e.g. temp file); show path as hint
                prompt_text = f"(prompt file not found: {pf})"

        tests_js.append({
            "label": t["label"],
            "status": t["status"],
            "image": t["image_rel"],
            "prompt": prompt_text,
            "command": run.get("command", ""),
            "params": params,
            "elapsed": t["elapsed"],
            "memory_mb": t["memory_mb"],
            "timings": timings,
            "caption": caption_text,
            "run_file": os.path.relpath(t["run_file"], out_dir),
            "manifest_file": (os.path.relpath(t["manifest_file"], out_dir)
                              if os.path.exists(t["manifest_file"]) else None),
        })

    tests_json = json.dumps(tests_js, indent=2, ensure_ascii=False)
    model_json = json.dumps(model_name)
    now = datetime.now().strftime("%Y-%m-%d %H:%M")

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Image Review: {model_name}</title>
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

  /* lightbox */
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

  /* bottom bar */
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

  /* output panel */
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
  <h1>&#127912; Image Review — {model_name}</h1>
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
  <div id="lb-body">
    <div id="lb-inner">
      <img id="lb-img" src="" />
    </div>
  </div>
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
const STORAGE_KEY = 'review_image_' + MODEL + '_' + TESTS.map(t=>t.label).join('');

let state = {{ ratings: {{}}, comments: {{}}, winner: null, notes: '' }};
let currentTab = 'plain';

function loadState() {{
  try {{
    const s = localStorage.getItem(STORAGE_KEY);
    if (s) state = {{ ...state, ...JSON.parse(s) }};
  }} catch(e) {{}}
}}

function saveState() {{
  try {{ localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }} catch(e) {{}}
}}

// --- Render ---

function renderAll() {{
  document.getElementById('test-count').textContent = TESTS.length;

  const prompt = TESTS.map(t=>t.prompt).find(p=>p) || '(no prompt)';
  document.getElementById('shared-prompt').textContent = prompt;

  const grid = document.getElementById('grid');
  grid.innerHTML = '';
  TESTS.forEach((t, i) => grid.appendChild(makeCard(t, i)));

  document.getElementById('overall-notes').value = state.notes || '';
  document.getElementById('overall-notes').addEventListener('input', e => {{
    state.notes = e.target.value; saveState();
  }});
}}

function makeCard(t, i) {{
  const card = document.createElement('div');
  card.className = 'card' + (state.winner === t.label ? ' winner' : '');
  card.id = 'card-' + i;

  // Header
  const hdr = div('card-header', `
    <div class="label">${{t.label}}</div>
    <div class="badge ${{t.status}}">${{t.status}}</div>
    <button class="winner-btn" onclick="toggleWinner('${{t.label}}', ${{i}})">★ Best</button>
  `);
  card.appendChild(hdr);

  // Image
  const wrap = document.createElement('div');
  wrap.className = 'image-wrap';
  if (t.image) {{
    const img = document.createElement('img');
    img.src = t.image;
    img.alt = 'Test ' + t.label;
    img.loading = 'lazy';
    img.addEventListener('click', () => openLightbox(t.image, t.label));
    wrap.appendChild(img);
  }} else {{
    wrap.innerHTML = '<div class="no-image">No image file</div>';
  }}
  card.appendChild(wrap);

  // Prompt (always shown below image)
  const promptDiv = div('card-prompt');
  promptDiv.innerHTML = '<span class="prompt-label">Prompt:</span> ' + escapeHtml(t.prompt || '(no prompt)');
  card.appendChild(promptDiv);

  // Caption (collapsible)
  if (t.caption) {{
    const details = document.createElement('details');
    details.className = 'caption-section';
    details.innerHTML = `<summary>VLM Caption</summary><p>${{escapeHtml(t.caption)}}</p>`;
    card.appendChild(details);
  }}

  // Params (diff against test 0)
  const ref = TESTS[0].params;
  const rows = Object.entries(t.params).map(([k, v]) => {{
    const isDiff = i > 0 && JSON.stringify(ref[k]) !== JSON.stringify(v);
    return `<tr><td>${{k}}</td><td class="${{isDiff ? 'diff' : ''}}">${{v}}</td></tr>`;
  }}).join('');
  card.appendChild(div('params', `<table>${{rows}}</table>`));

  // Timing
  const elapsed = t.elapsed ? `${{t.elapsed.toFixed(1)}}s` : '—';
  const mem = t.memory_mb ? `${{(t.memory_mb/1024).toFixed(1)}} GB` : '—';
  const sizeText = t.params.out_width && t.params.out_height
    ? `<span>Size <b>${{t.params.out_width}}×${{t.params.out_height}}</b></span>`
    : '';
  card.appendChild(div('timing',
    `<span>Time <b>${{elapsed}}</b></span><span>Peak RAM <b>${{mem}}</b></span>${{sizeText}}`));

  // Stars
  const ratingRow = document.createElement('div');
  ratingRow.className = 'rating-row';
  const stars = document.createElement('div');
  stars.className = 'stars';
  stars.id = 'stars-' + i;
  for (let s = 1; s <= 5; s++) {{
    const star = document.createElement('span');
    star.className = 'star' + (s <= (state.ratings[t.label] || 0) ? ' on' : '');
    star.textContent = '★';
    star.dataset.s = s;
    star.addEventListener('click', () => setRating(t.label, i, s));
    stars.appendChild(star);
  }}
  const rl = document.createElement('span');
  rl.className = 'rating-label'; rl.id = 'rating-label-' + i;
  rl.textContent = ratingLabel(state.ratings[t.label] || 0);
  ratingRow.append(stars, rl);
  card.appendChild(ratingRow);

  // Comment
  const cmtWrap = div('comment');
  const cmt = document.createElement('textarea');
  cmt.placeholder = 'Notes for test ' + t.label + '…';
  cmt.value = state.comments[t.label] || '';
  cmt.addEventListener('input', e => {{ state.comments[t.label] = e.target.value; saveState(); }});
  cmtWrap.appendChild(cmt);
  card.appendChild(cmtWrap);

  return card;
}}

function div(cls, html='') {{
  const el = document.createElement('div');
  el.className = cls; el.innerHTML = html; return el;
}}

function escapeHtml(s) {{
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}}

// --- Lightbox ---

let currentZoom = 1, naturalW = 0, naturalH = 0;
const lbBody = () => document.getElementById('lb-body');

function openLightbox(src, label) {{
  document.getElementById('lb-label').textContent = 'Test ' + label;
  const img = document.getElementById('lb-img');
  img.src = src;
  img.onload = () => {{
    naturalW = img.naturalWidth;
    naturalH = img.naturalHeight;
    setZoom(1);
  }};
  document.getElementById('lightbox').classList.add('open');
  document.body.style.overflow = 'hidden';
}}

function closeLightbox() {{
  document.getElementById('lightbox').classList.remove('open');
  document.body.style.overflow = '';
}}

function setZoom(level) {{
  currentZoom = level;
  const img = document.getElementById('lb-img');
  if (naturalW && naturalH) {{
    img.style.width = Math.round(naturalW * level) + 'px';
    img.style.height = Math.round(naturalH * level) + 'px';
  }}
  document.querySelectorAll('.zoom-btn').forEach(b => {{
    b.classList.toggle('active', parseFloat(b.dataset.zoom) === level);
  }});
}}

// Close on backdrop click or Escape
document.getElementById('lightbox').addEventListener('click', e => {{
  if (e.target.id === 'lightbox' || e.target.id === 'lb-body') closeLightbox();
}});
document.addEventListener('keydown', e => {{
  if (e.key === 'Escape') closeLightbox();
}});

// Drag-to-pan (always active when lightbox is open)
(function() {{
  let dragging = false, startX, startY, scrollLeft, scrollTop;
  document.addEventListener('mousedown', e => {{
    const body = lbBody();
    if (!body) return;
    if (!body.contains(e.target) && e.target !== body) return;
    dragging = true;
    body.classList.add('dragging');
    startX = e.clientX; startY = e.clientY;
    scrollLeft = body.scrollLeft; scrollTop = body.scrollTop;
    e.preventDefault();
  }});
  document.addEventListener('mousemove', e => {{
    if (!dragging) return;
    const body = lbBody();
    body.scrollLeft = scrollLeft - (e.clientX - startX);
    body.scrollTop = scrollTop - (e.clientY - startY);
  }});
  document.addEventListener('mouseup', () => {{
    if (!dragging) return;
    dragging = false;
    const body = lbBody();
    if (body) body.classList.remove('dragging');
  }});
}})();

// --- Interactions ---

function setRating(label, i, stars) {{
  state.ratings[label] = stars; saveState();
  const starsEl = document.getElementById('stars-' + i);
  starsEl.querySelectorAll('.star').forEach((s, idx) => {{
    s.classList.toggle('on', idx < stars);
  }});
  document.getElementById('rating-label-' + i).textContent = ratingLabel(stars);
}}

function ratingLabel(n) {{
  return ['', 'Poor', 'Fair', 'Good', 'Great', 'Perfect'][n] || '';
}}

function toggleWinner(label, i) {{
  state.winner = state.winner === label ? null : label;
  saveState();
  document.querySelectorAll('.card').forEach((c, idx) => {{
    c.classList.toggle('winner', TESTS[idx].label === state.winner);
  }});
}}

// --- Feedback generation ---

function generatePlain() {{
  const lines = [];
  lines.push('## Image A/B Review: ' + MODEL);
  lines.push('Date: ' + new Date().toISOString().slice(0,16).replace('T',' '));
  const prompt = TESTS.map(t=>t.prompt).find(p=>p) || '';
  if (prompt) lines.push('Prompt: "' + prompt + '"');
  lines.push(TESTS.length + ' tests compared');
  if (state.winner) lines.push('Winner: Test ' + state.winner);
  lines.push('');

  TESTS.forEach(t => {{
    const r = state.ratings[t.label] || 0;
    const stars = '★'.repeat(r) + '☆'.repeat(5-r);
    const winner = state.winner === t.label ? ' ← WINNER' : '';
    lines.push(`[${{t.label}}] ${{stars}}${{winner}}`);

    const pStr = Object.entries(t.params)
      .filter(([k]) => !k.startsWith('out_'))
      .map(([k,v])=>`${{k}}=${{v}}`).join(', ');
    lines.push(`Params: ${{pStr}}`);
    if (t.elapsed) lines.push(`Time: ${{t.elapsed.toFixed(1)}}s`);
    const c = state.comments[t.label];
    if (c && c.trim()) lines.push(`Notes: ${{c.trim()}}`);
    lines.push('');
  }});

  if (state.winner) {{
    const w = TESTS.find(t=>t.label===state.winner);
    if (w) {{
      lines.push('### Recommended Parameters');
      Object.entries(w.params).forEach(([k,v]) => lines.push(`${{k}}: ${{v}}`));
      lines.push('');
    }}
  }}
  if (state.notes && state.notes.trim()) {{
    lines.push('### Overall Notes');
    lines.push(state.notes.trim());
    lines.push('');
  }}
  return lines.join('\\n');
}}

function generateJSON() {{
  const obj = {{
    review_type: 'image-ab-test',
    model: MODEL,
    date: new Date().toISOString(),
    prompt: TESTS.map(t=>t.prompt).find(p=>p) || '',
    winner: state.winner,
    tests: TESTS.map(t => ({{
      label: t.label,
      status: t.status,
      params: t.params,
      elapsed_seconds: t.elapsed,
      rating: state.ratings[t.label] || 0,
      comment: state.comments[t.label] || '',
      is_winner: t.label === state.winner,
    }})),
    overall_notes: state.notes || '',
    recommended_params: state.winner
      ? (TESTS.find(t=>t.label===state.winner)||{{}}).params || {{}}
      : {{}},
  }};
  return JSON.stringify(obj, null, 2);
}}

// --- Output panel ---

function showOutput(tab) {{
  currentTab = tab;
  document.getElementById('output-panel').classList.add('visible');
  updateOutput();
}}

function switchTab(tab) {{
  currentTab = tab;
  document.querySelectorAll('.tab').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(el => {{
    if (el.textContent.toLowerCase().includes(tab)) el.classList.add('active');
  }});
  updateOutput();
}}

function updateOutput() {{
  const text = currentTab === 'json' ? generateJSON() : generatePlain();
  document.getElementById('output-text').value = text;
}}

function copyOutput() {{
  const text = document.getElementById('output-text').value;
  navigator.clipboard.writeText(text).then(() => {{
    const s = document.getElementById('copy-status');
    s.classList.add('show');
    setTimeout(() => s.classList.remove('show'), 2000);
  }});
}}

function downloadOutput() {{
  const text = document.getElementById('output-text').value;
  const ext = currentTab === 'json' ? 'json' : 'txt';
  const fname = `review-image-${{MODEL}}-${{new Date().toISOString().slice(0,10)}}.${{ext}}`;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], {{type: 'text/plain'}}));
  a.download = fname; a.click();
}}

// --- Boot ---
loadState();
renderAll();
</script>
</body>
</html>"""
