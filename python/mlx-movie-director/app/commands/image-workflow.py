"""image-workflow — Multi-stage workflow sub-action for 'run.py image workflow'.

Chains: base generation → face detailer → post-processing → upscale
into a single CLI invocation with per-generation subfolder output.

Public API:
  add_workflow_args(parser)  — register workflow-specific CLI arguments
  run_workflow(args)         — execute the full workflow

Named self-tests (--self-test <id>):
  workflow-postprocess       Tests PostProcessChain on a synthetic image (no model)
  workflow-basic             Full pipeline at 4 steps / 512×512 (model required)
  portrait-full              A/B/C: base → detail+post → full pipeline with upscale
  grain-sweep                Film grain intensity sweep: 0 / 0.008 / 0.015 / 0.025
  face-detail-ab             Face detailer denoise strength: off / 0.10 / 0.15 / 0.25
  landscape-post             Post-processing chain comparison on landscape

Bare --self-test defaults to portrait-full.
"""

import base64
import gc
import json
import os
import subprocess
import sys
import time

from app.commands._shared import resolve_lora_path, resolve_prompt
from app.run_config import RunConfig


PARSER_META = {
    "help": "Multi-stage workflow: generate → face detail → post-process → upscale",
    "description": (
        "Run the full Z-Image workflow pipeline: base generation (T2I or I2I), "
        "optional face detailing, post-processing (film grain, sharpening, LUT, "
        "skin contrast), and upscaling (ESRGAN or SeedVR2). All stage outputs "
        "are saved to a per-generation subfolder.\n\n"
        "Named self-tests (--self-test <id>):\n"
        "  workflow-postprocess  — PostProcessChain on synthetic image (no model)\n"
        "  workflow-basic        — Full pipeline at 4 steps / 512×512\n"
        "  portrait-full         — A/B/C: base → detail+post → full+upscale\n"
        "  grain-sweep           — Film grain intensity sweep\n"
        "  face-detail-ab        — Face detailer denoise strength A/B\n"
        "  landscape-post        — Post-processing chain on landscape"
    ),
}


def add_workflow_args(parser):
    """Register workflow-specific arguments on an argparse parser.

    NOTE: --self-test is registered by add_common_generation_args() in _shared.py.
    NOTE: --width, --height, --steps, --seed, --prompt, --input, --denoise-strength,
    --latent-upscale, --draft, --lora-path, --lora-scale, --upscale, --upscale-model,
    --upscale-method, --count are already registered by add_t2i_args() and
    add_common_generation_args(). Only workflow-unique args are registered here.
    """
    # Face detailer
    parser.add_argument("--face-detail", action="store_true", default=False,
                        help="Enable face detailer (mediapipe detect + re-denoise)")
    parser.add_argument("--face-detail-denoise", type=float, default=0.15,
                        help="Face detailer denoise strength (default: 0.15)")
    parser.add_argument("--face-detail-steps", type=int, default=9,
                        help="Face detailer denoising steps (default: 9)")
    parser.add_argument("--face-detail-lora", type=str, default=None,
                        help="Optional LoRA for face detail enhancement")

    # Post-processing
    parser.add_argument("--film-grain", type=float, default=0.0,
                        help="Film grain intensity (0.0–0.03, 0 = off)")
    parser.add_argument("--sharpening", type=float, default=0.0,
                        help="CAS sharpening strength (0.0–1.0, 0 = off)")
    parser.add_argument("--lut", type=str, default=None,
                        help="Path to .cube LUT file for color grading")
    parser.add_argument("--lut-strength", type=float, default=0.3,
                        help="LUT blend strength (0.0–1.0, default: 0.3)")
    parser.add_argument("--skin-contrast", action="store_true", default=False,
                        help="Apply selective skin contrast enhancement (CLAHE)")
    parser.add_argument("--noise-clean", action="store_true", default=False,
                        help="Apply noise/JPEG artifact cleanup")

    # Seed variance
    parser.add_argument("--seed-variance", action="store_true", default=False,
                        help="Enable seed variance enhancer (perturb text embeddings)")
    parser.add_argument("--seed-variance-percent", type=float, default=50.0,
                        help="Percentage of embedding values to perturb (default: 50)")
    parser.add_argument("--seed-variance-strength", type=float, default=20.0,
                        help="Noise scale for seed variance (default: 20)")
    parser.add_argument("--seed-variance-switchover", type=float, default=20.0,
                        help="Use noisy embedding for first N%% of steps (default: 20)")


def _open_in_browser(path):
    """Open a file/URL in the default browser, guarded for platform and headless.

    Falls back silently (no GUI / SSH / CI) so HTML generation results are not
    spoiled by a launch failure.
    """
    try:
        if sys.platform == "darwin":
            subprocess.Popen(["open", path])
        elif os.name == "posix":
            subprocess.Popen(["xdg-open", path])
    except (FileNotFoundError, OSError):
        pass  # headless / no GUI — user opens manually


# ---------------------------------------------------------------------------
# Legacy self-tests (no registry)
# ---------------------------------------------------------------------------

def _self_test_postprocess() -> None:
    """Test PostProcessChain on a synthetic PIL image — no model loading needed."""
    from PIL import Image
    from app.postprocess import PostProcessChain

    print("[self-test: workflow-postprocess]")

    # Create a synthetic 64×64 test image with some color variation
    import numpy as np
    rng = np.random.default_rng(42)
    arr = rng.integers(80, 200, (64, 64, 3), dtype=np.uint8)
    # Add a skin-tone patch for SkinContrast testing
    arr[20:44, 20:44] = [200, 150, 120]
    img = Image.fromarray(arr)

    chain = PostProcessChain.from_config({
        "noise_clean": False,   # skip: requires cv2 (optional dep)
        "skin_contrast": False,  # skip: requires cv2 (optional dep)
        "sharpening": 0.2,
        "film_grain": 0.02,
    })
    result, timings = chain.apply(img, seed=42)

    assert result.size == img.size, "Output size must match input"
    result_arr = np.array(result)
    assert not np.array_equal(result_arr, arr), "PostProcessChain must modify pixel values"

    print(f"  Input  mean: {arr.mean():.1f}")
    print(f"  Output mean: {result_arr.mean():.1f}")
    for name, t in timings.items():
        print(f"  {name}: {t*1000:.1f}ms")
    print("[PASS] PostProcessChain produces non-identity output")

    # Test chain ordering: noise_clean first, film_grain last
    chain2 = PostProcessChain.from_config({
        "noise_clean": False,
        "sharpening": 0.1,
        "film_grain": 0.01,
    })
    filter_names = [f.name for f in chain2.filters]
    assert filter_names[-1] == "film_grain", "FilmGrain must be last in chain"
    assert "sharpening" in filter_names, "Sharpening must be present"
    print(f"  Filter order: {filter_names}")
    print("[PASS] PostProcessChain filter ordering correct")


def _self_test_basic() -> None:
    """Quick full-pipeline test at 4 steps / 512×512."""
    from app.workflow import WorkflowOrchestrator

    print("[self-test: workflow-basic] 4 steps, 512×512, film_grain=0.02, sharpening=0.1")
    rc = RunConfig(
        schema_version=RunConfig.__dataclass_fields__["schema_version"].default,
        command="image workflow",
        pipeline="zimage",
        prompt="a portrait of a person, photorealistic, high quality",
        width=512,
        height=512,
        steps=4,
        seed=42,
        film_grain=0.02,
        sharpening=0.1,
    )
    orchestrator = WorkflowOrchestrator(rc)
    result = orchestrator.execute()
    out_dir = WorkflowOrchestrator.save_outputs(result, rc, base_name="self_test_workflow_basic")
    print(f"\n[PASS] workflow-basic self-test complete → {out_dir}")


# ---------------------------------------------------------------------------
# Registry-based self-tests (from test_prompts_image._WORKFLOW_TESTS)
# ---------------------------------------------------------------------------

# Legacy test names that bypass the registry
_LEGACY_TESTS = {
    "workflow-postprocess": _self_test_postprocess,
    "workflow-basic": _self_test_basic,
}

_DEFAULT_TEST = "portrait-full"


def _run_named_self_test(args, test_name: str) -> None:
    """Run a registry-based workflow self-test with HTML review output."""
    import mlx.core as mx
    from app import config as cfg
    from app.workflow import WorkflowOrchestrator
    from app.test_prompts_image import get_workflow_test, get_test_prompt

    # Resolve test config
    try:
        test_cfg = get_workflow_test(test_name)
    except ValueError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)

    tp_name = test_cfg["test_prompt"]
    tp = get_test_prompt(tp_name)
    prompt = tp["prompt"]
    width = tp["width"]
    height = tp["height"]
    seed = getattr(args, "seed", None) or test_cfg["seed"]
    steps = getattr(args, "steps", None) or test_cfg["steps"]

    ts = time.strftime("%Y%m%d_%H%M%S")
    test_dir_name = f"workflow-selftest-{test_name}-{ts}"

    print(f"\n{'═' * 60}")
    print(f"  Workflow Self-Test: {test_name}")
    print(f"  {test_cfg['description']}")
    print(f"{'═' * 60}")
    print(f"  Prompt: {tp_name!r}")
    print(f"  Seed:   {seed} | Steps: {steps} | Size: {width}×{height}")
    print(f"  Variations: {len(test_cfg['variations'])}")
    print()

    results = []

    for idx, var in enumerate(test_cfg["variations"]):
        label = var["label"]
        print(f"\n{'─' * 50}")
        print(f"  [{idx + 1}/{len(test_cfg['variations'])}] {label}")
        print(f"{'─' * 50}")

        # Build RunConfig from test prompt + variation config
        rc = RunConfig(
            schema_version=RunConfig.__dataclass_fields__["schema_version"].default,
            command="image workflow",
            pipeline="zimage",
            prompt=prompt,
            width=width,
            height=height,
            steps=steps,
            seed=seed,
            # Stage config from variation
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

        try:
            orchestrator = WorkflowOrchestrator(rc)
            wf_result = orchestrator.execute()

            # Save outputs
            label_slug = label.lower().replace(" ", "-").replace("+", "-plus-")
            base_name = f"{test_dir_name}/{label_slug}"
            out_dir = WorkflowOrchestrator.save_outputs(wf_result, rc, base_name=base_name)

            # Collect result
            active_stages = list(wf_result.stage_images.keys())
            stage_times = {}
            for stage_name, t_dict in wf_result.stage_timings.items():
                if isinstance(t_dict, dict):
                    stage_times[stage_name] = t_dict
                else:
                    stage_times[stage_name] = {"total": t_dict}

            results.append({
                "label": label,
                "out_dir": out_dir,
                "final_image_path": os.path.join(out_dir, "final.png"),
                "active_stages": active_stages,
                "stage_timings": stage_times,
                "total_seconds": wf_result.total_seconds,
                "params": {
                    "face_detail": var.get("face_detail", False),
                    "face_detail_denoise": var.get("face_detail_denoise", 0.15),
                    "film_grain": var.get("film_grain", 0.0),
                    "sharpening": var.get("sharpening", 0.0),
                    "skin_contrast": var.get("skin_contrast", False),
                    "noise_clean": var.get("noise_clean", False),
                    "upscale": var.get("upscale", False),
                    "upscale_method": var.get("upscale_method", "esrgan"),
                },
            })

            print(f"  ✓ Done in {wf_result.total_seconds:.1f}s → {out_dir}")

        except Exception as exc:
            print(f"  ✗ ERROR: {type(exc).__name__}: {exc}", file=sys.stderr)
            results.append({
                "label": label,
                "out_dir": None,
                "final_image_path": None,
                "active_stages": [],
                "stage_timings": {},
                "total_seconds": 0,
                "params": var,
                "error": str(exc),
            })

        # Memory cleanup between variations
        mx.clear_cache()
        gc.collect()

    # Generate HTML review
    html_path = os.path.join(cfg.OUTPUT_DIR, f"workflow-selftest-{test_name}-{ts}.html")
    html = _generate_workflow_selftest_html(
        test_name=test_name,
        test_cfg=test_cfg,
        results=results,
        prompt=prompt,
        tp_name=tp_name,
        seed=seed,
        steps=steps,
        width=width,
        height=height,
        ts=ts,
    )
    with open(html_path, "w", encoding="utf-8") as f:
        f.write(html)

    print(f"\n{'═' * 60}")
    print(f"  Self-test complete: {html_path}")
    print(f"{'═' * 60}")
    _open_in_browser(html_path)


# ---------------------------------------------------------------------------
# HTML renderer for workflow self-test
# ---------------------------------------------------------------------------

def _generate_workflow_selftest_html(
    test_name, test_cfg, results, prompt, tp_name,
    seed, steps, width, height, ts,
) -> str:
    """Render a self-contained HTML page for workflow self-test review."""
    # Embed images as base64
    cards_data = []
    for r in results:
        img_b64 = None
        if r["final_image_path"] and os.path.exists(r["final_image_path"]):
            with open(r["final_image_path"], "rb") as f:
                img_b64 = base64.b64encode(f.read()).decode()
        cards_data.append({
            "label": r["label"],
            "img_b64": img_b64,
            "active_stages": r["active_stages"],
            "stage_timings": r["stage_timings"],
            "total_seconds": r["total_seconds"],
            "params": r["params"],
            "error": r.get("error"),
        })

    cards_json = json.dumps(cards_data, ensure_ascii=False)
    desc = test_cfg.get("description", "")
    prompt_short = (prompt[:120] + "…") if len(prompt) > 120 else prompt

    # Build stage badge colors
    _STAGE_COLORS = {
        "base": "#4a9eff",
        "face_detail": "#f5c842",
        "postprocess": "#4caf50",
        "upscale": "#e91e63",
    }

    stage_badges_html = ""
    for stage_name, color in _STAGE_COLORS.items():
        stage_badges_html += (
            f'<span class="legend-badge" style="background:{color}">'
            f'{stage_name.replace("_", " ")}</span> '
        )

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Workflow Self-Test — {test_name}</title>
<style>
*,*::before,*::after{{box-sizing:border-box;margin:0;padding:0}}
:root{{
  --bg:#0f0f0f;--bg2:#1a1a1a;--bg3:#242424;
  --border:#333;--text:#e0e0e0;--muted:#888;
  --accent:#4a9eff;--gold:#f5c842;--green:#4caf50;--red:#f44336;
  --radius:8px;
}}
body{{background:var(--bg);color:var(--text);font-family:system-ui,sans-serif;
      font-size:14px;line-height:1.5;padding-bottom:200px}}
header{{background:var(--bg2);border-bottom:1px solid var(--border);
        padding:16px 24px;position:sticky;top:0;z-index:100}}
header h1{{font-size:18px;font-weight:600;color:var(--accent)}}
header .desc{{color:#999;font-size:12px;margin-top:4px;max-width:700px}}
header .meta{{color:var(--muted);font-size:12px;margin-top:6px}}
header .prompt{{color:#777;font-size:12px;font-style:italic;margin-top:8px;
               border-left:2px solid #333;padding-left:10px;max-width:700px}}
.legend{{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}}
.legend-badge{{font-size:10px;padding:2px 8px;border-radius:10px;color:#000;font-weight:600}}
#grid{{display:flex;gap:16px;padding:16px 24px;overflow-x:auto;align-items:flex-start}}
.card{{flex:0 0 380px;background:var(--bg2);border:2px solid var(--border);
       border-radius:var(--radius);overflow:hidden;transition:border-color .2s}}
.card.winner{{border-color:var(--gold)}}
.card-header{{display:flex;align-items:center;gap:8px;padding:10px 14px;
              background:var(--bg3);border-bottom:1px solid var(--border)}}
.card-header .label{{font-size:18px;font-weight:700;color:var(--accent);min-width:28px}}
.card-header .stages{{display:flex;gap:4px;flex-wrap:wrap}}
.stage-badge{{font-size:9px;padding:1px 6px;border-radius:8px;color:#000;font-weight:600}}
.winner-btn{{margin-left:auto;font-size:11px;padding:3px 10px;border-radius:12px;
             background:transparent;border:1px solid var(--border);color:var(--muted);
             cursor:pointer;transition:all .15s}}
.winner-btn:hover{{border-color:var(--gold);color:var(--gold)}}
.card.winner .winner-btn{{background:var(--gold);color:#000;border-color:var(--gold)}}
.image-wrap{{position:relative;background:#111;cursor:zoom-in}}
.image-wrap img{{width:100%;display:block;max-height:500px;object-fit:contain}}
.no-image{{height:200px;display:flex;align-items:center;justify-content:center;
           color:var(--red);font-size:13px}}
.error-msg{{padding:10px 14px;color:var(--red);font-size:12px;background:#1a0f0f;
            border-bottom:1px solid #331a1a}}
.params{{padding:8px 14px;border-bottom:1px solid var(--border)}}
.params table{{width:100%;border-collapse:collapse}}
.params td{{padding:1px 0;font-size:12px}}
.params td:first-child{{color:var(--muted);width:55%;padding-right:8px}}
.params td.diff{{color:var(--gold);font-weight:600}}
.timing{{padding:6px 14px;border-bottom:1px solid var(--border);font-size:12px;
         color:var(--muted);display:flex;gap:12px;flex-wrap:wrap}}
.timing span b{{color:var(--text)}}
.rating-row{{padding:8px 14px;display:flex;align-items:center;gap:8px;
             border-bottom:1px solid var(--border)}}
.stars{{display:flex;gap:2px;cursor:pointer}}
.star{{font-size:20px;color:#444;transition:color .1s;user-select:none}}
.star.on{{color:var(--gold)}}
.rating-label{{font-size:12px;color:var(--muted)}}
.comment{{padding:8px 14px}}
.comment textarea{{width:100%;height:52px;background:var(--bg3);
                   border:1px solid var(--border);border-radius:4px;
                   color:var(--text);font-size:12px;font-family:inherit;
                   padding:6px 8px;resize:vertical}}
.comment textarea:focus{{outline:none;border-color:var(--accent)}}
.comment textarea::placeholder{{color:#555}}
#lightbox{{display:none;position:fixed;inset:0;z-index:1000;
           background:rgba(0,0,0,.92);flex-direction:column}}
#lightbox.open{{display:flex}}
#lb-header{{padding:10px 20px;display:flex;align-items:center;gap:16px;
            border-bottom:1px solid var(--border);flex-shrink:0}}
#lb-header .lb-label{{font-size:16px;font-weight:700;color:var(--accent)}}
.zoom-controls{{display:flex;gap:4px;margin-left:auto}}
.zoom-btn{{padding:4px 14px;border-radius:4px;background:var(--bg3);
           border:1px solid var(--border);color:var(--muted);cursor:pointer;
           font-size:13px;font-weight:600;transition:all .15s}}
.zoom-btn:hover{{border-color:var(--text);color:var(--text)}}
.zoom-btn.active{{background:var(--accent);border-color:var(--accent);color:#fff}}
.close-btn{{padding:4px 12px;border-radius:4px;background:transparent;
            border:1px solid var(--border);color:var(--muted);cursor:pointer;
            font-size:18px;line-height:1}}
.close-btn:hover{{border-color:var(--red);color:var(--red)}}
#lb-body{{flex:1;overflow:auto;cursor:grab}}
#lb-body.dragging{{cursor:grabbing}}
#lb-inner{{display:inline-flex;min-width:100%;min-height:100%;
           align-items:center;justify-content:center}}
#lb-img{{display:block}}
#bottom{{position:fixed;bottom:0;left:0;right:0;background:var(--bg2);
         border-top:1px solid var(--border);padding:14px 20px;z-index:200}}
#bottom .row1{{display:flex;gap:10px;align-items:flex-start}}
#bottom textarea{{flex:1;height:48px;background:var(--bg3);border:1px solid var(--border);
                  border-radius:var(--radius);color:var(--text);font-size:13px;
                  font-family:inherit;padding:8px 12px;resize:none}}
#bottom textarea::placeholder{{color:#555}}
.btn{{padding:7px 14px;border-radius:var(--radius);border:none;cursor:pointer;
      font-size:12px;font-weight:500;transition:opacity .15s;white-space:nowrap}}
.btn:hover{{opacity:.85}}
.btn-primary{{background:var(--accent);color:#fff}}
.btn-outline{{background:transparent;border:1px solid var(--border);color:var(--text)}}
.btn-group{{display:flex;flex-direction:column;gap:6px}}
#output-panel{{display:none;margin-top:10px}}
#output-panel.visible{{display:block}}
#output-text{{width:100%;height:120px;background:var(--bg3);border:1px solid var(--border);
              border-radius:var(--radius);color:var(--text);font-size:12px;
              font-family:'SF Mono','Menlo',monospace;padding:10px 12px;resize:vertical}}
.copy-row{{display:flex;gap:8px;margin-top:6px;align-items:center}}
.copy-status{{font-size:12px;color:var(--green);opacity:0;transition:opacity .3s}}
.copy-status.show{{opacity:1}}
</style>
</head>
<body>
<header>
  <h1>⚙ Workflow Self-Test — {test_name}</h1>
  <div class="desc">{desc}</div>
  <div class="meta">
    Prompt: <b>{tp_name}</b> · Seed: <b>{seed}</b> · Steps: <b>{steps}</b> ·
    {width}×{height} · {ts} · {len(results)} variations
  </div>
  <div class="prompt">"{prompt_short}"</div>
  <div class="legend">{stage_badges_html}</div>
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
    <textarea id="overall-notes" placeholder="Overall notes (optional)…"></textarea>
    <div class="btn-group">
      <button class="btn btn-primary" onclick="showOutput('plain')">Generate Feedback</button>
      <button class="btn btn-outline" onclick="showOutput('json')">JSON</button>
    </div>
  </div>
  <div id="output-panel">
    <textarea id="output-text" readonly></textarea>
    <div class="copy-row">
      <button class="btn btn-outline" onclick="copyOutput()">Copy</button>
      <span class="copy-status" id="copy-status">Copied!</span>
    </div>
  </div>
</div>
<script>
const CARDS = {cards_json};
const TEST_NAME = "{test_name}";
const TS = "{ts}";
const STORAGE_KEY = 'wf-selftest-' + TEST_NAME + '-' + TS;

const STAGE_COLORS = {{
  base: '#4a9eff',
  face_detail: '#f5c842',
  postprocess: '#4caf50',
  upscale: '#e91e63'
}};

let state = {{ ratings: {{}}, comments: {{}}, winner: null, notes: '' }};

function loadState() {{
  try {{
    const s = localStorage.getItem(STORAGE_KEY);
    if (s) state = {{...state, ...JSON.parse(s)}};
  }} catch(e) {{}}
}}
function saveState() {{
  try {{ localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }} catch(e) {{}}
}}

function renderAll() {{
  const grid = document.getElementById('grid');
  grid.innerHTML = '';
  CARDS.forEach((c, i) => grid.appendChild(makeCard(c, i)));
  document.getElementById('overall-notes').value = state.notes || '';
  document.getElementById('overall-notes').addEventListener('input', e => {{
    state.notes = e.target.value; saveState();
  }});
}}

function makeCard(c, i) {{
  const card = document.createElement('div');
  card.className = 'card' + (state.winner === c.label ? ' winner' : '');
  card.id = 'card-' + i;

  // Header
  const header = document.createElement('div');
  header.className = 'card-header';
  header.innerHTML = '<div class="label">' + c.label + '</div>';
  const stagesDiv = document.createElement('div');
  stagesDiv.className = 'stages';
  c.active_stages.forEach(s => {{
    const b = document.createElement('span');
    b.className = 'stage-badge';
    b.style.background = STAGE_COLORS[s] || '#888';
    b.textContent = s.replace(/_/g, ' ');
    stagesDiv.appendChild(b);
  }});
  header.appendChild(stagesDiv);
  const wBtn = document.createElement('button');
  wBtn.className = 'winner-btn';
  wBtn.textContent = '★ Best';
  wBtn.onclick = () => toggleWinner(c.label, i);
  header.appendChild(wBtn);
  card.appendChild(header);

  // Image
  const wrap = document.createElement('div');
  wrap.className = 'image-wrap';
  if (c.img_b64) {{
    const img = document.createElement('img');
    img.src = 'data:image/png;base64,' + c.img_b64;
    img.alt = c.label;
    img.loading = 'lazy';
    img.addEventListener('click', () => openLightbox(c.img_b64, c.label));
    wrap.appendChild(img);
  }} else if (c.error) {{
    wrap.innerHTML = '<div class="no-image">✗ Error</div>';
  }} else {{
    wrap.innerHTML = '<div class="no-image">No image</div>';
  }}
  card.appendChild(wrap);

  // Error
  if (c.error) {{
    const errDiv = document.createElement('div');
    errDiv.className = 'error-msg';
    errDiv.textContent = c.error;
    card.appendChild(errDiv);
  }}

  // Params
  const ref = CARDS[0].params;
  const paramsDiv = document.createElement('div');
  paramsDiv.className = 'params';
  let rows = '';
  for (const [k, v] of Object.entries(c.params)) {{
    const isDiff = i > 0 && JSON.stringify(ref[k]) !== JSON.stringify(v);
    const cls = isDiff ? ' class="diff"' : '';
    const display = typeof v === 'boolean' ? (v ? '✓' : '—') : v;
    rows += '<tr><td>' + k + '</td><td' + cls + '>' + display + '</td></tr>';
  }}
  paramsDiv.innerHTML = '<table>' + rows + '</table>';
  card.appendChild(paramsDiv);

  // Timing
  const timingDiv = document.createElement('div');
  timingDiv.className = 'timing';
  const totalStr = c.total_seconds ? c.total_seconds.toFixed(1) + 's' : '—';
  let timingHTML = '<span>Total <b>' + totalStr + '</b></span>';
  if (c.active_stages.length > 0) {{
    timingHTML += '<span>Stages: <b>' + c.active_stages.join(' → ') + '</b></span>';
  }}
  timingDiv.innerHTML = timingHTML;
  card.appendChild(timingDiv);

  // Rating
  const ratingRow = document.createElement('div');
  ratingRow.className = 'rating-row';
  const starsDiv = document.createElement('div');
  starsDiv.className = 'stars';
  starsDiv.id = 'stars-' + i;
  for (let s = 1; s <= 5; s++) {{
    const star = document.createElement('span');
    star.className = 'star' + (s <= (state.ratings[c.label] || 0) ? ' on' : '');
    star.textContent = '★';
    star.dataset.s = s;
    star.addEventListener('click', () => setRating(c.label, i, s));
    starsDiv.appendChild(star);
  }}
  const rl = document.createElement('span');
  rl.className = 'rating-label';
  rl.id = 'rating-label-' + i;
  rl.textContent = ratingLabel(state.ratings[c.label] || 0);
  ratingRow.append(starsDiv, rl);
  card.appendChild(ratingRow);

  // Comment
  const cmtWrap = document.createElement('div');
  cmtWrap.className = 'comment';
  const cmt = document.createElement('textarea');
  cmt.placeholder = 'Notes for ' + c.label + '…';
  cmt.value = state.comments[c.label] || '';
  cmt.addEventListener('input', e => {{ state.comments[c.label] = e.target.value; saveState(); }});
  cmtWrap.appendChild(cmt);
  card.appendChild(cmtWrap);

  return card;
}}

function setRating(label, i, stars) {{
  state.ratings[label] = state.ratings[label] === stars ? 0 : stars;
  saveState();
  document.getElementById('stars-' + i).querySelectorAll('.star')
    .forEach((s, idx) => s.classList.toggle('on', idx < state.ratings[label]));
  document.getElementById('rating-label-' + i).textContent =
    ratingLabel(state.ratings[label]);
}}

function ratingLabel(n) {{
  return ['','Poor','Fair','Good','Great','Perfect'][n] || '';
}}

function toggleWinner(label, i) {{
  state.winner = state.winner === label ? null : label;
  saveState();
  document.querySelectorAll('.card').forEach((c, idx) =>
    c.classList.toggle('winner', CARDS[idx].label === state.winner));
}}

let currentZoom = 1;
function openLightbox(b64, label) {{
  document.getElementById('lb-label').textContent = label;
  const img = document.getElementById('lb-img');
  img.src = 'data:image/png;base64,' + b64;
  img.onload = () => setZoom(1);
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
  if (img.naturalWidth) {{
    img.style.width = Math.round(img.naturalWidth * level) + 'px';
    img.style.height = Math.round(img.naturalHeight * level) + 'px';
  }}
  document.querySelectorAll('.zoom-btn').forEach(b =>
    b.classList.toggle('active', parseFloat(b.dataset.zoom) === level));
}}
document.getElementById('lightbox').addEventListener('click', e => {{
  if (['lightbox','lb-body','lb-inner'].includes(e.target.id)) closeLightbox();
}});
document.addEventListener('keydown', e => {{ if (e.key === 'Escape') closeLightbox(); }});

// Drag-to-pan in lightbox
(function() {{
  let dragging=false, startX, startY, scrollLeft, scrollTop;
  document.addEventListener('mousedown', e => {{
    const body = document.getElementById('lb-body');
    if (!body || !body.contains(e.target)) return;
    dragging = true; body.classList.add('dragging');
    startX = e.clientX; startY = e.clientY;
    scrollLeft = body.scrollLeft; scrollTop = body.scrollTop;
    e.preventDefault();
  }});
  document.addEventListener('mousemove', e => {{
    if (!dragging) return;
    const body = document.getElementById('lb-body');
    body.scrollLeft = scrollLeft - (e.clientX - startX);
    body.scrollTop = scrollTop - (e.clientY - startY);
  }});
  document.addEventListener('mouseup', () => {{
    if (!dragging) return;
    dragging = false;
    const body = document.getElementById('lb-body');
    if (body) body.classList.remove('dragging');
  }});
}})();

function generatePlain() {{
  const lines = ['## Workflow Self-Test: ' + TEST_NAME, 'Date: ' + TS];
  lines.push('Prompt: ' + CARDS[0] ? CARDS[0].prompt || '' : '');
  lines.push(CARDS.length + ' variations');
  if (state.winner) lines.push('Winner: ' + state.winner);
  lines.push('');
  CARDS.forEach(c => {{
    const r = state.ratings[c.label] || 0;
    const stars = '★'.repeat(r) + '☆'.repeat(5 - r);
    const winner = state.winner === c.label ? ' ← WINNER' : '';
    lines.push('[' + c.label + '] ' + stars + winner);
    const pStr = Object.entries(c.params)
      .filter(([k,v]) => v !== false && v !== 0.0)
      .map(([k,v]) => k + '=' + v).join(', ');
    if (pStr) lines.push('  Active: ' + pStr);
    if (c.total_seconds) lines.push('  Time: ' + c.total_seconds.toFixed(1) + 's');
    const cmt = state.comments[c.label];
    if (cmt && cmt.trim()) lines.push('  Notes: ' + cmt.trim());
    lines.push('');
  }});
  if (state.winner) {{
    const w = CARDS.find(c => c.label === state.winner);
    if (w) {{
      lines.push('### Recommended Parameters');
      Object.entries(w.params).forEach(([k,v]) => lines.push(k + ': ' + v));
      lines.push('');
    }}
  }}
  if (state.notes && state.notes.trim()) {{
    lines.push('### Overall Notes');
    lines.push(state.notes.trim());
  }}
  return lines.join('\\n');
}}

function generateJSON() {{
  return JSON.stringify({{
    review_type: 'workflow-selftest',
    test_name: TEST_NAME,
    timestamp: TS,
    winner: state.winner,
    variations: CARDS.map(c => ({{
      label: c.label,
      active_stages: c.active_stages,
      params: c.params,
      total_seconds: c.total_seconds,
      rating: state.ratings[c.label] || 0,
      comment: state.comments[c.label] || '',
      is_winner: c.label === state.winner,
      error: c.error || null,
    }})),
    overall_notes: state.notes || '',
  }}, null, 2);
}}

function showOutput(format) {{
  document.getElementById('output-panel').classList.add('visible');
  document.getElementById('output-text').value =
    format === 'json' ? generateJSON() : generatePlain();
}}

function copyOutput() {{
  navigator.clipboard.writeText(document.getElementById('output-text').value).then(() => {{
    const s = document.getElementById('copy-status');
    s.classList.add('show');
    setTimeout(() => s.classList.remove('show'), 2000);
  }});
}}

loadState();
renderAll();
</script>
</body>
</html>"""


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def run_workflow(args):
    """Execute the full multi-stage workflow. Called by image.py dispatcher."""
    self_test = getattr(args, "self_test", None)

    # Legacy self-tests (no model / minimal model)
    if self_test == "workflow-postprocess":
        _self_test_postprocess()
        return
    if self_test == "workflow-basic":
        _self_test_basic()
        return

    # Registry-based self-tests (from _WORKFLOW_TESTS)
    if self_test is not None:
        test_name = _DEFAULT_TEST if self_test is True else self_test
        # Check if it's a legacy test name (already handled above)
        if test_name not in _LEGACY_TESTS:
            _run_named_self_test(args, test_name)
            return
        # Unknown legacy name — shouldn't reach here
        print(f"ERROR: Unknown self-test '{test_name}'.", file=sys.stderr)
        print(f"  Available: workflow-postprocess, workflow-basic", file=sys.stderr)
        from app.test_prompts_image import list_workflow_test_names
        print(f"  Registry:  {', '.join(list_workflow_test_names())}", file=sys.stderr)
        sys.exit(1)

    # --- Normal workflow execution ---
    from app.workflow import WorkflowOrchestrator

    # Build RunConfig from args — all workflow fields are now proper dataclass fields
    rc = RunConfig(
        schema_version=RunConfig.__dataclass_fields__["schema_version"].default,
        command="image workflow",
        pipeline="zimage",

        # Prompt
        prompt=resolve_prompt(args) if hasattr(args, "prompt") else None,
        prompt_file=getattr(args, "prompt_file", None),

        # Generation
        width=getattr(args, "width", None) or 640,
        height=getattr(args, "height", None) or 960,
        steps=getattr(args, "steps", 10),
        seed=getattr(args, "seed", 42),
        lora_path=resolve_lora_path(getattr(args, "lora_path", None)),
        lora_scale=getattr(args, "lora_scale", None) or 1.0,

        # I2I
        input_image=getattr(args, "input_image", None),
        latent_upscale=getattr(args, "latent_upscale", 1.0),
        denoise_strength=getattr(args, "denoise_strength", 1.0),

        # Upscale
        upscale=getattr(args, "upscale", False),
        upscale_model=getattr(args, "upscale_model", None),
        upscale_method=getattr(args, "upscale_method", "esrgan"),

        # Draft mode
        draft=getattr(args, "draft", False),

        # Seed variance
        seed_variance=getattr(args, "seed_variance", False),
        seed_variance_percent=getattr(args, "seed_variance_percent", 50.0),
        seed_variance_strength=getattr(args, "seed_variance_strength", 20.0),
        seed_variance_switchover=getattr(args, "seed_variance_switchover", 20.0),

        # Face detailer
        face_detail=getattr(args, "face_detail", False),
        face_detail_denoise=getattr(args, "face_detail_denoise", 0.15),
        face_detail_steps=getattr(args, "face_detail_steps", 9),
        face_detail_lora=getattr(args, "face_detail_lora", None),

        # Post-processing
        film_grain=getattr(args, "film_grain", 0.0),
        sharpening=getattr(args, "sharpening", 0.0),
        lut_path=getattr(args, "lut", None),
        lut_strength=getattr(args, "lut_strength", 0.3),
        skin_contrast=getattr(args, "skin_contrast", False),
        noise_clean=getattr(args, "noise_clean", False),
    )

    # Draft mode overrides
    if rc.draft:
        rc.steps = 4
        rc.width = 512
        rc.height = 512
        print("  [Draft] Quick preview: 4 steps, 512x512")

    # Execute workflow
    orchestrator = WorkflowOrchestrator(rc)
    try:
        result = orchestrator.execute()

        # Save all outputs to subfolder
        out_dir = WorkflowOrchestrator.save_outputs(result, rc)
        print(f"\nWorkflow output: {out_dir}")
        print(f"Final image: {os.path.join(out_dir, 'final.png')}")

    except Exception as exc:
        print(f"ERROR: {type(exc).__name__}: {exc}", file=sys.stderr)
        import traceback
        traceback.print_exc()
        sys.exit(1)
