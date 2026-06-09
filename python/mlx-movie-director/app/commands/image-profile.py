"""image-profile — multi-view character profile sub-action for 'run.py image profile'.

Imported by app.commands.image via importlib (hyphen in filename prevents
regular import statements).

Public API:
  add_profile_args(parser)  — register profile-specific CLI arguments
  run_profile(args)         — execute multi-view character profile generation
"""

import argparse
import json
import os
import sys
import time
import traceback
from datetime import datetime, timezone

from app import config as cfg

# ---------------------------------------------------------------------------
# View definitions
# ---------------------------------------------------------------------------

ALL_VIEWS = ["front", "back", "side"]

# Aspect ratio presets (width × height, both multiples of 16 for VAE compatibility).
# "portrait"  — 3:4, good for upper-body or half-body shots
# "standing"  — 2:3, balanced full-body standing figure (recommended)
# "full-body" — 1:2, tall full-body with headroom
# "tall"      — current ComfyUI default (864×2016 ≈ 1:2.33), very narrow
RATIO_PRESETS = {
    "portrait":  (1024, 1360),   # ~3:4
    "standing":  (1024, 1536),   # 2:3  ← recommended default
    "full-body": (896, 1792),    # 1:2
    "tall":      (864, 2016),    # ComfyUI original
    "9:16":      (1088, 1920),   # CivitAI v2 format; 1088=68×16, 1920=120×16
}
DEFAULT_RATIO = "full-body"

VIEW_PROMPTS = {
    "front": (
        "Generate an A-pose front view of the character in the image, "
        "character standing upright, white background, remove background clutter, "
        "perfect body proportions, head not too large, "
        "maintain character outfit consistency"
    ),
    "back": (
        "Generate an A-pose back view of the character in the image, "
        "character standing upright, white background, remove background clutter, "
        "perfect body proportions, head not too large, "
        "maintain character outfit consistency"
    ),
    "side": (
        "Generate an A-pose side view of the character in the image, "
        "character standing upright, white background, remove background clutter, "
        "perfect body proportions, head not too large, "
        "maintain character outfit and character consistency"
    ),
}

# Flux2 Klein: angle-style prompts (short & simple).
# KEY INSIGHT: Long detailed prompts with anatomy instructions overwhelm the
# reference image's latent conditioning with text conditioning, causing style drift.
# The angle command uses short prompts and achieves excellent style matching —
# the reference latent does the heavy lifting for both style and identity.
# Profile adopts the same approach: minimal text, let the reference speak.
VIEW_PROMPTS_FLUX2 = {
    "front": (
        "保持人物外貌、服裝、髮型完全一致，"
        "front view, A-pose, full body from head to toes including feet and shoes, white background, "
        "photorealistic, maintain character identity and appearance consistency"
    ),
    "back": (
        "保持人物外貌、服裝、髮型完全一致，"
        "back view, A-pose, full body from head to toes including feet and shoes, white background, "
        "photorealistic, maintain character identity and appearance consistency"
    ),
    "side": (
        "保持人物外貌、服裝、髮型完全一致，"
        "side profile view (90 degrees), A-pose, full body from head to toes including feet and shoes, white background, "
        "photorealistic, maintain character identity and appearance consistency"
    ),
}

# Detailed prompts (legacy — available via --prompt-style detailed).
# These provide explicit anatomy guidance per view but cause style drift
# because the long text conditioning overrides the reference image's style signal.
VIEW_PROMPTS_FLUX2_DETAILED = {
    "front": (
        "生成图中人物A-pose的正面图。人物站立，去除杂物，纯白色背景。"
        "完美的身体比例，头不要太大。"
        "严格按照参考图中人物的服装、配饰、鞋子进行生成，"
        "保持服装的颜色、款式、纹理、图案、材质完全一致，"
        "不得更改或遗漏任何服装细节。"
    ),
    "back": (
        "生成图中人物A-pose的背面图。这是从背后观察的视角。人物站立，去除杂物，纯白色背景。"
        "完美的身体比例，头不要太大。"
        "注意背面视角与正面完全不同：看不到脸部五官，只能看到后脑勺和头发；"
        "手臂在A-pose中向两侧展开，从背后看只能看到上臂后侧、手肘背面、"
        "前臂后侧和手背朝外，手腕微微向前弯曲，手指自然并拢从背后只能看到指背轮廓，"
        "绝对不能看到手掌、手指内侧或指纹；"
        "肩膀呈现圆润的肩背弧线，不是正面的锁骨和肩头形状；"
        "背部有脊椎中线和肩胛骨轮廓，这些在正面完全看不到。"
        "确保这是真正的背面视角，不要画成正面。"
        "严格按照参考图中人物的服装、配饰、鞋子进行生成，"
        "保持服装的颜色、款式、纹理、图案、材质完全一致，"
        "不得更改或遗漏任何服装细节。"
    ),
    "side": (
        "生成图中人物A-pose的侧面图。这是从正侧面（90度）观察的视角。"
        "人物站立，去除杂物，纯白色背景。完美的身体比例，头不要太大。"
        "注意侧面视角与正面截然不同：只能看到身体的一侧，"
        "只能看到一只手臂、一只耳朵的侧面轮廓；"
        "鼻子是侧面的突出轮廓，只能看到一只眼睛；"
        "身体厚度变窄，肩膀和胸部只显示侧面弧度。"
        "头部和身体必须同时朝向同一个侧方，不得只转头而身体朝前。"
        "确保这是真正的侧面视角，不要画成正面。"
        "严格按照参考图中人物的服装、配饰、鞋子进行生成，"
        "保持服装的颜色、款式、纹理、图案、材质完全一致，"
        "不得更改或遗漏任何服装细节。"
    ),
}

# All views use the same seed for maximum inter-view consistency
VIEW_SEED_OFFSETS = {"front": 0, "back": 0, "side": 0}

# Generation order for chain-ref: front → side → back.
# Rationale: front is the cleanest A-pose reference. Side generated from front
# then becomes a non-front-angle reference for back, preventing the model from
# copying front-facing hands/arms into the back view.
VIEW_ORDER = ["front", "side", "back"]

# ---------------------------------------------------------------------------
# Parser
# ---------------------------------------------------------------------------

def add_profile_args(parser):
    """Register profile-specific arguments on an argparse parser.

    Shared args (--steps, --seed, --width, --height, --pipeline, --quantize,
    --variant, --flux2-model-path, --lora-path, --lora-scale) are registered
    by image-t2i.py and _shared.py — profile applies its own defaults at runtime.
    """
    parser.add_argument(
        "--views", nargs="+", default=["front", "back", "side"],
        choices=["front", "back", "side"], metavar="VIEW",
        help="Views to generate: front back side (default: all three)",
    )
    parser.add_argument(
        "--base-prompt", type=str, default=None, metavar="TEXT",
        help=(
            "Character clothing/appearance description appended to each view prompt.\n"
            "Works for both flux2-klein and zimage pipelines.\n"
            "For flux2-klein, this adds explicit clothing info to text conditioning,\n"
            "which helps preserve outfit consistency across views.\n"
            "When omitted with flux2-klein + --vlm, auto-generated from reference image.\n"
            "Example: 'red jacket, blue jeans, white sneakers, silver hair'"
        ),
    )
    parser.add_argument(
        "--ratio",
        choices=list(RATIO_PRESETS.keys()),
        default=DEFAULT_RATIO,
        help=(
            "Aspect ratio preset per view. "
            f"Choices: {', '.join(f'{k} ({v[0]}×{v[1]})' for k, v in RATIO_PRESETS.items())}. "
            f"Default: {DEFAULT_RATIO}. Overridden by explicit --width/--height."
        ),
    )
    parser.add_argument(
        "--no-strip", action="store_true", default=False,
        help="Skip creating the horizontal strip image",
    )
    parser.add_argument(
        "--strip-gap", type=int, default=0, metavar="PX",
        help="Gap in pixels between panels in the strip (default: 0)",
    )
    parser.add_argument(
        "--ref-count", type=int, default=3, metavar="N",
        help=(
            "Number of times to pass the reference image to the model (default: 3). "
            "More copies = stronger style/identity matching but slower per step. "
            "1 = single ref (fastest), 2 = double ref, 3 = triple ref (best style)."
        ),
    )
    parser.add_argument(
        "--ref-strength", type=float, default=None, metavar="FLOAT",
        help=(
            "Reference image conditioning strength passed to Flux2 Klein "
            "(None = mflux default). Lower = less reference influence, higher = more. "
            "Try 0.3–0.8 to tune how closely the output follows the reference."
        ),
    )
    parser.add_argument(
        "--chain-ref", "--no-chain-ref", action=argparse.BooleanOptionalAction, default=False,
        help=(
            "Use generated views as cascade reference for subsequent views "
            "(default: False). When on, side refs original+front, back refs original+side. "
            "Can cause style drift — keep off for best style matching."
        ),
    )
    parser.add_argument(
        "--prompt-style", choices=["angle", "detailed"], default="angle",
        help=(
            "Prompt style for Flux2 Klein views. "
            "'angle' (default): short prompt, lets reference latent drive style — best style matching. "
            "'detailed': long anatomy/clothing instructions — better pose accuracy but style drift."
        ),
    )
    # VLM auto-caption options
    parser.add_argument(
        "--vlm", "--no-vlm", action=argparse.BooleanOptionalAction, default=True,
        help=(
            "Auto-generate clothing description from reference image using VLM "
            "when --base-prompt is not provided (default: True). "
            "Requires LM Studio with Qwen3-VL running on localhost:1234. "
            "Use --no-vlm to disable."
        ),
    )
    parser.add_argument(
        "--vlm-api-url", type=str, default="http://localhost:1234/v1",
        help="VLM API base URL for auto-captioning (default: http://localhost:1234/v1)",
    )
    parser.add_argument(
        "--vlm-model", type=str, default="qwen/qwen3-vl-4b",
        help="VLM model name for auto-captioning (default: qwen/qwen3-vl-4b)",
    )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _build_view_prompt(view: str, base_prompt: str | None, pipeline_type: str = "zimage",
                       prompt_style: str = "angle") -> str:
    if pipeline_type == "flux2-klein":
        if prompt_style == "detailed":
            template = VIEW_PROMPTS_FLUX2_DETAILED[view]
            parts = [template]
            if base_prompt and base_prompt.strip():
                parts.append(f"人物穿着：{base_prompt.strip()}")
            return "。".join(parts)
        # "angle" style — short prompt, reference latent drives style
        return VIEW_PROMPTS_FLUX2[view]
    template = VIEW_PROMPTS[view]
    if base_prompt and base_prompt.strip():
        return f"{template}, {base_prompt.strip()}"
    return template


def _vlm_verify_profile_view(image_path: str, expected_view: str,
                              vlm_api_url: str, vlm_model: str) -> dict | None:
    """Call Qwen3-VL to verify a generated view image is the correct angle.

    Returns a dict with keys: view_correct, full_body, apose, clean_bg, score, issues, summary.
    Returns None if VLM is unavailable or response cannot be parsed.
    """
    try:
        from app.commands.caption import _image_to_base64, _call_vlm, get_profile_verify_prompt
        b64 = _image_to_base64(image_path)
        prompt = get_profile_verify_prompt(expected_view)
        raw = _call_vlm(vlm_api_url, vlm_model, b64, prompt)
        result = json.loads(raw) if isinstance(raw, str) else raw
        if isinstance(result, dict) and "view_correct" in result:
            return result
    except Exception as e:
        print(f"skipped ({type(e).__name__})")
    return None


def _stitch_horizontal(images, gap: int = 0, bg_color=(255, 255, 255)):
    from PIL import Image as PILImage
    max_h = max(img.height for img in images)
    total_w = sum(img.width for img in images) + gap * (len(images) - 1)
    strip = PILImage.new("RGB", (total_w, max_h), color=bg_color)
    x = 0
    for img in images:
        strip.paste(img, (x, 0))
        x += img.width + gap
    return strip


def _load_view_verify(view_path: str) -> dict | None:
    """Load VLM view-verification result from .caption.json, or None."""
    caption_path = os.path.splitext(view_path)[0] + ".caption.json"
    if not os.path.exists(caption_path):
        return None
    try:
        with open(caption_path) as f:
            data = json.load(f)
        if data.get("style") == "profile-verify":
            caption = data.get("caption", {})
            if isinstance(caption, dict) and "view_correct" in caption:
                return caption
    except (OSError, json.JSONDecodeError):
        pass
    return None


def _render_verify_badges(verify: dict) -> str:
    """Return HTML badge row from a view-verify dict."""
    import html as html_mod
    checks = [
        ("view_correct", "View angle"),
        ("full_body",    "Full body"),
        ("apose",        "A-pose"),
        ("clean_bg",     "Clean BG"),
    ]
    badges = ""
    for key, label in checks:
        val = verify.get(key)
        icon = "✓" if val is True else "✗" if val is False else "?"
        cls = "vbadge-ok" if val is True else "vbadge-err" if val is False else "vbadge-unk"
        badges += f'<span class="{cls}">{icon} {label}</span>'
    score = verify.get("score")
    if score is not None:
        badges += f'<span class="vbadge-score">Score: {score}/10</span>'
    summary = verify.get("summary", "")
    if summary:
        safe_sum = html_mod.escape(summary[:120])
        badges += f'<div class="vsummary">{safe_sum}</div>'
    return f'<div class="verify-row">{badges}</div>'


def _write_html_viewer(html_path: str, out_dir: str, ref_image, ref_path: str | None, view_outputs: list):
    """Write a self-contained HTML file that shows all profile views left-to-right."""
    import html as html_mod

    # Build card entries: reference (if any) + generated views
    cards = []
    if ref_path:
        cards.append({"label": "Reference", "file": "reference.png", "verify": None})
    for vo in view_outputs:
        if vo.get("view") in ("html", "strip"):
            continue
        label = vo["view"].capitalize()
        verify = _load_view_verify(vo["path"]) if "path" in vo else None
        cards.append({"label": label, "file": os.path.basename(vo["path"]), "verify": verify})

    cards_html = ""
    for c in cards:
        safe_label = html_mod.escape(c["label"])
        safe_file = html_mod.escape(c["file"])
        verify_html = _render_verify_badges(c["verify"]) if c.get("verify") else ""
        cards_html += (
            f'      <div class="card">\n'
            f'        <img src="{safe_file}" alt="{safe_label}">\n'
            f'        <div class="label">{safe_label}</div>\n'
            f'        {verify_html}\n'
            f"      </div>\n"
        )

    page = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Character Profile Sheet</title>
<style>
  * {{ margin: 0; padding: 0; box-sizing: border-box; }}
  body {{
    background: #1a1a1a;
    color: #eee;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    padding: 20px;
    overflow-x: auto;
  }}
  h1 {{
    font-size: 18px;
    font-weight: 600;
    margin-bottom: 16px;
    color: #999;
  }}
  .row {{
    display: flex;
    gap: 12px;
    align-items: flex-start;
  }}
  .card {{
    display: flex;
    flex-direction: column;
    align-items: center;
    background: #222;
    border-radius: 8px;
    overflow: hidden;
    flex-shrink: 0;
  }}
  .card img {{
    display: block;
    max-height: 90vh;
    width: auto;
    object-fit: contain;
  }}
  .label {{
    padding: 6px 12px;
    font-size: 13px;
    color: #888;
    text-align: center;
  }}
  .verify-row {{
    padding: 6px 10px 8px;
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    justify-content: center;
    border-top: 1px solid #333;
  }}
  .vbadge-ok, .vbadge-err, .vbadge-unk, .vbadge-score {{
    font-size: 11px;
    padding: 2px 6px;
    border-radius: 3px;
    font-weight: 600;
  }}
  .vbadge-ok    {{ background: #1b3a1b; color: #4caf50; }}
  .vbadge-err   {{ background: #3a1b1b; color: #f44336; }}
  .vbadge-unk   {{ background: #2a2a2a; color: #888; }}
  .vbadge-score {{ background: #1a2a3a; color: #4a9eff; }}
  .vsummary {{
    width: 100%;
    font-size: 11px;
    color: #999;
    padding: 2px 4px;
    font-style: italic;
    text-align: center;
  }}
</style>
</head>
<body>
  <h1>Character Profile</h1>
  <div class="row">
{cards_html}  </div>
</body>
</html>"""

    with open(html_path, "w") as f:
        f.write(page)


# ---------------------------------------------------------------------------
# Command entry point
# ---------------------------------------------------------------------------

# Profile-specific defaults (differ from t2i defaults)
_PROFILE_DEFAULT_SEED = 63515082432616
_PROFILE_DEFAULT_STEPS = 6


def run_profile(args):
    """Execute multi-view character profile generation. Called by image.py dispatcher."""
    from PIL import Image
    from app.manifest import Manifest, collect_model_fingerprint, collect_model_fingerprint_flux2

    # Validate input image path if provided (--input is registered by image-angle.py)
    input_image = getattr(args, "input", None)
    if input_image and not os.path.exists(input_image):
        print(f"ERROR: input image not found: {input_image}", file=sys.stderr)
        sys.exit(1)

    # Apply profile-specific defaults for shared args
    # Profile's default pipeline is "auto" (flux2-klein with input, zimage without).
    # The shared --pipeline arg defaults to "zimage" from t2i — override for profile.
    pipeline_choice = getattr(args, "pipeline", "zimage") or "zimage"
    if pipeline_choice == "zimage" and input_image is not None:
        pipeline_choice = "auto"
    use_flux2 = (
        pipeline_choice == "flux2-klein"
        or (pipeline_choice == "auto" and input_image is not None)
    )
    pipeline_type = "flux2-klein" if use_flux2 else "zimage"

    steps = args.steps if args.steps is not None else _PROFILE_DEFAULT_STEPS
    seed = getattr(args, "seed", _PROFILE_DEFAULT_SEED)
    # If seed is still the t2i default (42), use profile default instead
    if seed == 42:
        seed = _PROFILE_DEFAULT_SEED

    # Resolve dimensions: explicit --width/--height override --ratio preset
    width = getattr(args, "width", None)
    height = getattr(args, "height", None)
    if width is None and height is None:
        preset = RATIO_PRESETS[args.ratio]
        width, height = preset
    elif width is None or height is None:
        # If user specifies only one, fill the other from preset
        preset = RATIO_PRESETS[args.ratio]
        width = width or preset[0]
        height = height or preset[1]

    print(f"Resolution: {width}×{height} (ratio={args.ratio})")

    # Maintain canonical view order regardless of --views input order.
    # When chain-ref is active, generate in VIEW_ORDER (front → side → back)
    # so each subsequent view can reference the previously generated one.
    views = [v for v in VIEW_ORDER if v in args.views]

    # Create output folder: output/profile_YYYYMMDD_HHMMSS/
    base_name = f"profile_{time.strftime('%Y%m%d_%H%M%S')}"
    out_dir = os.path.join(cfg.OUTPUT_DIR, base_name)
    os.makedirs(out_dir, exist_ok=True)

    # Write run.json
    run_meta = {
        "command": "image",
        "action": "profile",
        "pipeline": pipeline_type,
        "mode": "reference-conditioning" if use_flux2 else "t2i",
        "input_image": input_image,
        "views": views,
        "base_prompt": getattr(args, "base_prompt", None),
        "steps": steps,
        "seed": seed,
        "width": width,
        "height": height,
        "ratio": args.ratio,
        "lora_path": getattr(args, "lora_path", None),
        "lora_scale": getattr(args, "lora_scale", None) or 1.0,
        "strip_gap": args.strip_gap,
        "no_strip": args.no_strip,
        "flux2_model_path": getattr(args, "flux2_model_path", None),
        "quantize": getattr(args, "quantize", None),
        "ref_count": getattr(args, "ref_count", 3),
        "chain_ref": getattr(args, "chain_ref", False),
        "prompt_style": getattr(args, "prompt_style", "angle"),
        "vlm": getattr(args, "vlm", True),
        "vlm_caption": None,  # filled in after VLM call
    }
    run_file = os.path.join(out_dir, "run.json")
    with open(run_file, "w") as f:
        json.dump(run_meta, f, indent=2, ensure_ascii=False)
        f.write("\n")

    print(f"Output folder: {out_dir}")
    print(f"Views: {' + '.join(views)}")
    print(f"Pipeline: {pipeline_type}  (prompt_style={getattr(args, 'prompt_style', 'angle')})")

    # Load reference image
    ref_image = None
    if input_image:
        ref_image = Image.open(input_image).convert("RGB")
        ref_image.save(os.path.join(out_dir, "reference.png"))
        ref_note = "reference conditioning" if use_flux2 else "display only"
        print(f"Reference: {input_image} ({ref_image.width}×{ref_image.height}) — {ref_note}")

    # Resolve base_prompt: user-provided, VLM auto-caption, or None
    base_prompt = getattr(args, "base_prompt", None)
    vlm_caption = None
    vlm_style = None
    prompt_style = getattr(args, "prompt_style", "angle")
    if use_flux2 and input_image and getattr(args, "vlm", True):
        try:
            from app.commands.caption import _image_to_base64, _call_vlm, _STYLE_PROMPTS, _LANG_INSTRUCTIONS
            b64 = _image_to_base64(input_image)
            vlm_api_url = getattr(args, "vlm_api_url", "http://localhost:1234/v1")
            vlm_model = getattr(args, "vlm_model", "qwen/qwen3-vl-4b")

            # Art style description — only for "detailed" prompt style
            if prompt_style == "detailed" and (not base_prompt or not base_prompt.strip()):
                print("[VLM] Analyzing art style...", end=" ", flush=True)
                vlm_style = _call_vlm(
                    vlm_api_url, vlm_model, b64,
                    _STYLE_PROMPTS["style"],
                )
                print("Done")
                print(f"[VLM] Style: {vlm_style}")

            # Clothing/appearance description — only for "detailed" prompt style
            if prompt_style == "detailed" and (not base_prompt or not base_prompt.strip()):
                print("[VLM] Auto-captioning clothing...", end=" ", flush=True)
                style_prompt = _STYLE_PROMPTS["profile"] + "\n" + _LANG_INSTRUCTIONS["zh_CN"]
                vlm_caption = _call_vlm(vlm_api_url, vlm_model, b64, style_prompt)
                base_prompt = vlm_caption
                print("Done")
                print(f"[VLM] Clothing: {vlm_caption}")

            # Save captions alongside reference (even for angle style, useful for records)
            if vlm_style or vlm_caption:
                caption_out = {
                    "image": input_image,
                    "style_caption": vlm_style,
                    "clothing_caption": vlm_caption,
                }
                with open(os.path.join(out_dir, "reference.caption.json"), "w") as f:
                    json.dump(caption_out, f, indent=2, ensure_ascii=False)
                    f.write("\n")
        except Exception as exc:
            print(f"\n[VLM] Warning: auto-caption failed ({exc}) — continuing without it")

    if base_prompt:
        print(f"Base prompt: {base_prompt}")

    # Update run.json with resolved base_prompt / VLM caption / style
    run_meta["base_prompt_resolved"] = base_prompt
    run_meta["vlm_caption"] = vlm_caption
    run_meta["vlm_style"] = vlm_style
    with open(run_file, "w") as f:
        json.dump(run_meta, f, indent=2, ensure_ascii=False)
        f.write("\n")

    # Initialise the chosen pipeline (once — model stays loaded across all views)
    if use_flux2:
        from app.flux2_pipeline import Flux2KleinPipeline
        pipeline = Flux2KleinPipeline(
            model_path=getattr(args, "flux2_model_path", None),
            quantize=getattr(args, "quantize", None),
            variant=args.variant,
            transformer_name=getattr(args, "transformer", "klein-9b"),
        )
    else:
        from app.pipeline import ZImagePipeline
        pipeline = ZImagePipeline()

    start_time = datetime.now(timezone.utc).isoformat()

    view_outputs = []
    view_images = []
    all_timings = {}

    try:
        # Chain-ref: generate views in cascade order (front → side → back).
        # Each non-front view uses BOTH the original reference (for character
        # identity/clothing) AND the previously generated view (for correct
        # camera-angle awareness).  This prevents the back view from copying
        # front-facing hands/arms from the front reference.
        use_chain_ref = (
            use_flux2
            and getattr(args, "chain_ref", False)
            and "front" in views
            and input_image is not None
        )
        if use_chain_ref:
            print(f"Chain-ref: ON (order: front → side → back, dual reference)")

        # Multi-ref: pass the reference image N times for stronger conditioning.
        ref_count = max(1, getattr(args, "ref_count", 3))
        if ref_count > 1:
            print(f"Multi-ref: ON (reference ×{ref_count})")

        ref_strength = getattr(args, "ref_strength", None)

        # Track generated views by name for cascade reference
        generated_paths: dict[str, str] = {}

        for view in views:
            # NumPy/mflux seed must be in [0, 2**32-1]; fold the ComfyUI 64-bit seed
            view_seed = (seed + VIEW_SEED_OFFSETS[view]) % (2 ** 32)
            prompt = _build_view_prompt(view, base_prompt, pipeline_type,
                                        prompt_style=getattr(args, "prompt_style", "angle"))

            # Determine reference images for this view
            if use_flux2:
                if use_chain_ref and view != "front":
                    # Cascade: use N×original + previous generated view
                    order_idx = VIEW_ORDER.index(view)
                    prev_view = None
                    for candidate in reversed(VIEW_ORDER[:order_idx]):
                        if candidate in generated_paths:
                            prev_view = candidate
                            break
                    ref_images = [input_image] * ref_count
                    if prev_view:
                        ref_images.append(generated_paths[prev_view])
                    ref_label = f"original ×{ref_count}" + (f" + {prev_view}.png" if prev_view else "")
                else:
                    # Standard: N copies of original reference
                    ref_images = [input_image] * ref_count if input_image else []
                    ref_label = f"original ×{ref_count}" if input_image else "none"
            else:
                ref_images = []
                ref_label = "none"

            print(f"\n=== {view.upper()} (seed={view_seed}) === [ref: {ref_label}]")
            print(f"  {prompt[:120]}...")

            if use_flux2:
                result = pipeline.generate(
                    seed=view_seed,
                    prompt=prompt,
                    reference_images=ref_images,
                    width=width,
                    height=height,
                    steps=steps,
                    image_strength=ref_strength,
                )
            else:
                result = pipeline.generate(
                    prompt=prompt,
                    width=width,
                    height=height,
                    steps=steps,
                    seed=view_seed,
                    lora_path=getattr(args, "lora_path", None),
                    lora_scale=getattr(args, "lora_scale", None) or 1.0,
                    upscale=False,
                    upscale_model=None,
                )

            view_path = os.path.join(out_dir, f"{view}.png")
            result.image.save(view_path)
            print(f"  Saved: {view_path}")

            # Track generated view for cascade reference
            generated_paths[view] = view_path

            view_images.append(result.image)
            all_timings[view] = result.timings
            view_outputs.append({
                "view": view,
                "prompt": prompt,
                "seed": view_seed,
                "path": view_path,
                "ref_source": ref_label,
                "size_bytes": os.path.getsize(view_path),
                "width": result.image.width,
                "height": result.image.height,
            })

        # VLM view-angle verification (saves .caption.json; runs before HTML so badges appear)
        if getattr(args, "vlm", True):
            vlm_api_url = getattr(args, "vlm_api_url", "http://localhost:1234/v1")
            vlm_model = getattr(args, "vlm_model", "qwen/qwen3-vl-4b")
            print()
            for vo in view_outputs:
                view = vo.get("view")
                if view not in ("front", "back", "side"):
                    continue
                print(f"  [view-verify] {view}...", end=" ", flush=True)
                result_v = _vlm_verify_profile_view(vo["path"], view, vlm_api_url, vlm_model)
                if result_v:
                    ok = "✓" if result_v.get("view_correct") else "✗"
                    print(f"{ok} score={result_v.get('score', '?')}")
                    caption_data = {
                        "image": vo["path"],
                        "style": "profile-verify",
                        "view": view,
                        "model": vlm_model,
                        "caption": result_v,
                    }
                    caption_path = os.path.splitext(vo["path"])[0] + ".caption.json"
                    with open(caption_path, "w") as _f:
                        json.dump(caption_data, _f, indent=2, ensure_ascii=False)

        # Generate HTML viewer showing all images left-to-right (after VLM so badges appear)
        html_path = os.path.join(out_dir, "index.html")
        _write_html_viewer(html_path, out_dir, ref_image, input_image, view_outputs)
        print(f"\nHTML: {html_path}")
        view_outputs.append({
            "view": "html",
            "path": html_path,
            "size_bytes": os.path.getsize(html_path),
        })

        # Optionally also create the horizontal strip PNG
        if not args.no_strip and len(view_images) > 0:
            stitch_images = view_images
            if ref_image:
                ref_h = view_images[0].height
                ref_w = int(ref_image.width * ref_h / ref_image.height)
                stitch_images = [ref_image.resize((ref_w, ref_h), Image.LANCZOS)] + view_images
            strip = _stitch_horizontal(stitch_images, gap=args.strip_gap)
            strip_path = os.path.join(out_dir, "strip.png")
            strip.save(strip_path)
            print(f"Strip: {strip_path}  ({strip.width}×{strip.height})")

        end_time = datetime.now(timezone.utc).isoformat()
        if use_flux2:
            from app.commands._shared import resolve_lora_path
            resolved_lora = resolve_lora_path(getattr(args, "lora_path", None))
            models = collect_model_fingerprint_flux2(lora_path=resolved_lora)
        else:
            models = collect_model_fingerprint(lora_path=getattr(args, "lora_path", None))
        manifest = Manifest.from_success(
            run_file, start_time, end_time, all_timings, view_outputs, models
        )
        manifest.to_json(os.path.join(out_dir, "manifest.json"))
        print(f"\nDone → {out_dir}")

    except Exception as exc:
        end_time = datetime.now(timezone.utc).isoformat()
        manifest = Manifest.from_error(run_file, start_time, end_time, all_timings, exc, {})
        manifest.to_json(os.path.join(out_dir, "manifest.json"))
        print(f"ERROR: {type(exc).__name__}: {exc}", file=sys.stderr)
        traceback.print_exc()
        sys.exit(1)
