"""image-sda-test — A/B test for Z-Image-Turbo-SDA LoKr adapter.

Generates paired images (baseline vs SDA LoKr) across multiple seeds,
then produces a self-contained HTML review page with base64-embedded
images for human side-by-side comparison.

Exports: add_sda_test_args(), run_sda_test()
"""

import base64
import json
import os
import sys
import time
from datetime import datetime, timezone

from app import config as cfg
from app.commands._shared import generate_base_name, resolve_lora_path


# ---------------------------------------------------------------------------
# Default SDA LoRA short name (resolved via resolve_lora_path)
# ---------------------------------------------------------------------------

_SDA_LORA_NAME = "zit-sda-v1"

# ---------------------------------------------------------------------------
# Argument registration
# ---------------------------------------------------------------------------


def _arg_exists(parser, dest):
    """Check if an argument with the given dest is already registered."""
    return any(getattr(a, 'dest', None) == dest for a in parser._actions)


def add_sda_test_args(parser):
    """Register sda-test-specific CLI arguments."""
    # --prompt, --steps, --width, --height, --lora-scale are already registered
    # by t2i/common args — only add sda-test-unique args here.
    if not _arg_exists(parser, "seeds"):
        parser.add_argument(
            "--seeds", type=str, default="42,123,777,999",
            help="Comma-separated seed list (default: 42,123,777,999)",
        )
    parser.add_argument(
        "--no-open", action="store_true", default=False,
        help="Write HTML but don't open in browser",
    )


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def run_sda_test(args):
    """Execute SDA A/B test and generate HTML review."""
    seeds = _parse_seeds(args.seeds)
    prompt = args.prompt
    lora_scale = args.lora_scale
    steps = args.steps
    width = args.width
    height = args.height

    # Resolve SDA LoRA path
    sda_lora_path = resolve_lora_path(_SDA_LORA_NAME)

    print(f"\n{'='*60}")
    print(f"SDA A/B Test — Z-Image-Turbo-SDA Diversity Comparison")
    print(f"{'='*60}")
    print(f"  Prompt:     {prompt[:80]}{'…' if len(prompt) > 80 else ''}")
    print(f"  Seeds:      {seeds}")
    print(f"  Steps:      {steps}")
    print(f"  Size:       {width}×{height}")
    print(f"  SDA LoRA:   {os.path.basename(sda_lora_path)} (scale={lora_scale})")
    print(f"  Pairs:      {len(seeds)} ({len(seeds)*2} images total)")
    print()

    os.makedirs(cfg.OUTPUT_DIR, exist_ok=True)
    base_name = generate_base_name() + "_sda-ab"

    # Load pipeline once — reuse across all seeds
    from app.pipeline import ZImagePipeline

    pipeline = ZImagePipeline()

    pairs = []  # [{seed, baseline_path, sda_path, baseline_time, sda_time}, ...]

    for i, seed in enumerate(seeds, start=1):
        print(f"\n--- Seed {seed} ({i}/{len(seeds)}) ---")

        # A: Baseline (no LoRA)
        print(f"  [A] Generating baseline (no LoRA)…")
        t0 = time.time()
        result_base = pipeline.generate(
            prompt=prompt,
            width=width,
            height=height,
            steps=steps,
            seed=seed,
            lora_path=None,
            lora_scale=1.0,
        )
        baseline_time = time.time() - t0
        baseline_path = os.path.join(cfg.OUTPUT_DIR, f"{base_name}_s{seed}_baseline.png")
        result_base.image.save(baseline_path)
        print(f"  [A] Saved: {os.path.basename(baseline_path)} ({baseline_time:.1f}s)")

        # B: SDA LoKr
        print(f"  [B] Generating SDA (LoKr scale={lora_scale})…")
        t0 = time.time()
        result_sda = pipeline.generate(
            prompt=prompt,
            width=width,
            height=height,
            steps=steps,
            seed=seed,
            lora_path=sda_lora_path,
            lora_scale=lora_scale,
        )
        sda_time = time.time() - t0
        sda_path = os.path.join(cfg.OUTPUT_DIR, f"{base_name}_s{seed}_sda.png")
        result_sda.image.save(sda_path)
        print(f"  [B] Saved: {os.path.basename(sda_path)} ({sda_time:.1f}s)")

        pairs.append({
            "seed": seed,
            "baseline_path": baseline_path,
            "sda_path": sda_path,
            "baseline_time": round(baseline_time, 1),
            "sda_time": round(sda_time, 1),
        })

    # Generate HTML review
    html_path = _generate_html(
        output_dir=cfg.OUTPUT_DIR,
        base_name=base_name,
        prompt=prompt,
        steps=steps,
        width=width,
        height=height,
        lora_scale=lora_scale,
        pairs=pairs,
    )

    print(f"\n{'='*60}")
    print(f"SDA A/B Test Complete")
    print(f"{'='*60}")
    print(f"  HTML review: {html_path}")
    print(f"  Images:      {len(pairs)*2} ({len(pairs)} pairs)")

    if not args.no_open:
        _open_html(html_path)


# ---------------------------------------------------------------------------
# HTML generation
# ---------------------------------------------------------------------------


def _img_to_data_uri(path: str) -> str:
    """Read a PNG file and return a base64 data URI."""
    with open(path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode("ascii")
    return f"data:image/png;base64,{b64}"


def _generate_html(output_dir, base_name, prompt, steps, width, height, lora_scale, pairs):
    """Generate a self-contained HTML review page with embedded images."""
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")

    # Build pair rows
    pair_rows = []
    for i, p in enumerate(pairs):
        baseline_uri = _img_to_data_uri(p["baseline_path"])
        sda_uri = _img_to_data_uri(p["sda_path"])
        pair_rows.append(f"""
        <div class="pair" id="pair-{i}">
          <div class="pair-header">
            <span class="pair-label">Seed {p['seed']}</span>
            <span class="pair-timing">A: {p['baseline_time']}s | B: {p['sda_time']}s</span>
          </div>
          <div class="pair-images">
            <div class="img-cell" onclick="openLightbox({i}, 'baseline')">
              <div class="img-badge badge-a">A — Baseline</div>
              <img src="{baseline_uri}" alt="Baseline seed={p['seed']}" loading="lazy" />
            </div>
            <div class="img-cell" onclick="openLightbox({i}, 'sda')">
              <div class="img-badge badge-b">B — SDA v1</div>
              <img src="{sda_uri}" alt="SDA seed={p['seed']}" loading="lazy" />
            </div>
          </div>
          <div class="pair-vote">
            <label class="vote-option">
              <input type="radio" name="vote-{i}" value="A" onchange="updateSummary()" />
              <span>Prefer A (Baseline)</span>
            </label>
            <label class="vote-option">
              <input type="radio" name="vote-{i}" value="B" onchange="updateSummary()" />
              <span>Prefer B (SDA)</span>
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
    all_baseline_uris = json.dumps([_img_to_data_uri(p["baseline_path"]) for p in pairs])
    all_sda_uris = json.dumps([_img_to_data_uri(p["sda_path"]) for p in pairs])
    all_seeds = json.dumps([p["seed"] for p in pairs])

    pair_rows_html = "\n".join(pair_rows)

    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>SDA A/B Test — Z-Image Turbo</title>
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
header .meta {{ font-size: 11px; color: var(--muted); margin-top: 4px; }}
.prompt-box {{ margin-top: 10px; background: var(--bg3); border: 1px solid var(--border);
              border-radius: var(--radius); padding: 10px 14px; font-size: 13px; color: #bbb;
              max-height: 80px; overflow-y: auto; line-height: 1.6; }}

.params {{ display: flex; gap: 16px; margin-top: 10px; flex-wrap: wrap; }}
.param {{ background: var(--bg3); border: 1px solid var(--border); border-radius: 12px;
          padding: 3px 10px; font-size: 11px; color: var(--muted); }}
.param strong {{ color: var(--text); }}

#pairs {{ padding: 16px 24px; }}

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

/* Lightbox */
#lightbox {{ display: none; position: fixed; inset: 0; z-index: 1000;
             background: rgba(0,0,0,0.92); cursor: zoom-out;
             display: none; align-items: center; justify-content: center; }}
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
  <h1>SDA A/B Test — Z-Image Turbo</h1>
  <div class="meta">Generated {now} | {len(pairs)} seed pairs | {len(pairs)*2} images</div>
  <div class="prompt-box">{_esc_html(prompt)}</div>
  <div class="params">
    <span class="param"><strong>{steps}</strong> steps</span>
    <span class="param"><strong>{width}×{height}</strong></span>
    <span class="param">SDA scale: <strong>{lora_scale}</strong></span>
    <span class="param">LoRA: <strong>zit-sda-v1</strong> (LoKr)</span>
  </div>
</header>

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
// Image data for lightbox navigation
const BASELINE = {all_baseline_uris};
const SDA = {all_sda_uris};
const SEEDS = {all_seeds};
let lbPair = 0, lbSide = 'baseline';

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
  const srcs = lbSide === 'baseline' ? BASELINE : SDA;
  document.getElementById('lb-img').src = srcs[lbPair];
  const sideLabel = lbSide === 'baseline' ? 'A (Baseline)' : 'B (SDA)';
  document.getElementById('lb-label').textContent =
    'Seed ' + SEEDS[lbPair] + ' — ' + sideLabel + ' (' + (lbPair+1) + '/' + SEEDS.length + ')';
}}
function lbNav(e, delta) {{
  e.stopPropagation();
  const arr = lbSide === 'baseline' ? BASELINE : SDA;
  lbPair = (lbPair + delta + arr.length) % arr.length;
  renderLightbox();
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
    prompt: {_json.dumps(prompt)},
    params: {{ steps: {steps}, width: {width}, height: {height}, lora_scale: {lora_scale} }},
    generated_at: "{now}",
    pairs: []
  }};
  for (let i=0; i<n; i++) {{
    const v = document.querySelector('input[name="vote-'+i+'"]:checked');
    const c = document.getElementById('comment-'+i);
    results.pairs.push({{
      seed: SEEDS[i],
      vote: v ? v.value : null,
      comment: c ? c.value.trim() : ''
    }});
  }}
  const json = JSON.stringify(results, null, 2);
  navigator.clipboard.writeText(json).then(() => {{
    const btn = document.querySelector('.export-btn');
    btn.textContent = 'Copied!';
    setTimeout(() => {{ btn.textContent = 'Export Results'; }}, 1500);
  }});
}}

// Keyboard: ESC to close lightbox, arrows to navigate
document.addEventListener('keydown', (e) => {{
  const lb = document.getElementById('lightbox');
  if (!lb.classList.contains('open')) return;
  if (e.key === 'Escape') {{ lb.classList.remove('open'); document.body.style.overflow = ''; }}
  if (e.key === 'ArrowLeft') lbNav(e, -1);
  if (e.key === 'ArrowRight') lbNav(e, 1);
  if (e.key === 'Tab') {{
    e.preventDefault();
    lbSide = lbSide === 'baseline' ? 'sda' : 'baseline';
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
# Helpers
# ---------------------------------------------------------------------------


def _parse_seeds(seeds_str: str) -> list[int]:
    """Parse comma-separated seed string."""
    try:
        seeds = [int(s.strip()) for s in seeds_str.split(",") if s.strip()]
    except ValueError:
        print(f"ERROR: invalid seeds format: {seeds_str}", file=sys.stderr)
        print("  Expected: comma-separated integers, e.g. '42,123,777,999'", file=sys.stderr)
        sys.exit(1)
    if not seeds:
        print("ERROR: no seeds provided", file=sys.stderr)
        sys.exit(1)
    return seeds


def _esc_html(s: str) -> str:
    """Escape HTML special characters."""
    return (s.replace("&", "&amp;")
             .replace("<", "&lt;")
             .replace(">", "&gt;")
             .replace('"', "&quot;"))


def _open_html(path: str) -> None:
    """Open HTML file in default browser."""
    import subprocess
    subprocess.Popen(["open", path])
    print(f"  Opened in browser: {path}")
