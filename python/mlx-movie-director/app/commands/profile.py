"""profile — multi-view character profile sheet (front / back / side).

Two pipeline modes:

  flux2-klein (default when --input-image is provided):
    Uses mflux Flux2KleinEdit with real reference-image conditioning.
    The reference image latent is concatenated into the attention sequence
    (prepare_reference_image_conditioning), giving the model genuine knowledge
    of the character appearance.  Requires Klein 4B (~15 GB, auto-downloaded
    from HuggingFace on first use).

  zimage (fallback when no --input-image, or --pipeline zimage):
    Pure text-to-image from empty latent via ZImagePipeline.  Matches the
    ComfyUI EmptyFlux2LatentImage starting point.  --base-prompt is the only
    way to describe the character.
"""

import argparse
import json
import os
import sys
import time
import traceback
from datetime import datetime, timezone

from app import config as cfg
from app.commands._shared import generate_base_name

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
}
DEFAULT_RATIO = "standing"

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

# Flux2 Klein: reference image is injected as conditioning — prompts are view-only.
# Chinese prompts with strong clothing preservation instructions; Qwen3 text encoder
# understands Chinese natively.  The explicit clothing language anchors the text
# conditioning to prevent the model from hallucinating different garments per view.
VIEW_PROMPTS_FLUX2 = {
    "front": (
        "生成图中人物A-pose的正面图。人物站立，去除杂物，纯白色背景。"
        "完美的身体比例，头不要太大。"
        "严格按照参考图中人物的服装、配饰、鞋子进行生成，"
        "保持服装的颜色、款式、纹理、图案、材质完全一致，"
        "不得更改或遗漏任何服装细节"
    ),
    "back": (
        "生成图中人物A-pose的背面图。这是从背后观察的视角。人物站立，去除杂物，纯白色背景。"
        "完美的身体比例，头不要太大。"
        "注意背面视角与正面完全不同：看不到脸部五官，只能看到后脑勺和头发；"
        "手臂从背后看只能看到手背和手肘外侧，不能看到手掌和手指内侧；"
        "肩膀和背部轮廓与正面截然不同。确保这是真正的背面视角，不要画成正面。"
        "严格按照参考图中人物的服装、配饰、鞋子进行生成，"
        "保持服装的颜色、款式、纹理、图案、材质完全一致，"
        "不得更改或遗漏任何服装细节"
    ),
    "side": (
        "生成图中人物A-pose的侧面图。人物站立，去除杂物，纯白色背景。"
        "完美的身体比例，头不要太大。"
        "严格按照参考图中人物的服装、配饰、鞋子进行生成，"
        "保持服装的颜色、款式、纹理、图案、材质完全一致，"
        "不得更改或遗漏任何服装细节"
    ),
}

# All views use the same seed for maximum inter-view consistency
VIEW_SEED_OFFSETS = {"front": 0, "back": 0, "side": 0}

# ---------------------------------------------------------------------------
# Parser
# ---------------------------------------------------------------------------

PARSER_META = {
    "help": "Character profile sheet: front / back / side views",
    "description": (
        "Generate a multi-view character profile sheet (front, back, side).\n\n"
        "Pipeline selection (--pipeline):\n"
        "  auto        — flux2-klein when --input-image is given, zimage otherwise\n"
        "  flux2-klein — Flux2 Klein 4B with real reference conditioning (mflux).\n"
        "                Reference image latent is injected into attention; model\n"
        "                genuinely sees and follows the character appearance.\n"
        "                First run downloads ~15 GB from HuggingFace.\n"
        "  zimage      — ZImage Turbo pure text-to-image (original behaviour).\n"
        "                Use --base-prompt to describe the character.\n\n"
        "Output folder: output/profile_YYYYMMDD_HHMMSS/\n"
        "  reference.png               — input image copy (if provided)\n"
        "  front.png, back.png, side.png — generated views\n"
        "  strip.png                   — [ref | front | back | side] horizontal stitch\n"
        "  run.json, manifest.json     — audit records\n\n"
        "Examples:\n"
        "  run.py profile --input-image char.png                  # flux2-klein (auto)\n"
        "  run.py profile --input-image char.png --quantize 8     # quantize Klein to INT8\n"
        "  run.py profile --input-image char.png --pipeline zimage # force ZImage t2i\n"
        "  run.py profile --pipeline zimage --base-prompt 'blue hanfu woman'\n"
        "  run.py profile --flux2-model-path /local/klein-4b/ --steps 4"
    ),
}


def add_args(parser):
    parser.add_argument(
        "--input-image", default=None, metavar="PATH",
        help="Reference character image (optional; shown in strip but not used for generation)",
    )
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
        "--steps", type=int, default=6,
        help="Denoising steps per view (default: 6, matches ComfyUI workflow)",
    )
    parser.add_argument(
        "--seed", type=int, default=63515082432616,
        help=(
            "Base seed (default: 63515082432616, matches ComfyUI workflow). "
            "All views use the same seed for maximum consistency."
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
        "--width", type=int, default=None,
        help="Output width per view in pixels (overrides --ratio)",
    )
    parser.add_argument(
        "--height", type=int, default=None,
        help="Output height per view in pixels (overrides --ratio)",
    )
    parser.add_argument(
        "--lora-path", type=str, default=None,
        help="Path to LoRA .safetensors file",
    )
    parser.add_argument(
        "--lora-scale", type=float, default=1.0,
        help="LoRA scale factor (default: 1.0)",
    )
    parser.add_argument(
        "--no-strip", action="store_true", default=False,
        help="Skip creating the horizontal strip image",
    )
    parser.add_argument(
        "--strip-gap", type=int, default=0, metavar="PX",
        help="Gap in pixels between panels in the strip (default: 0)",
    )
    # Pipeline selection
    parser.add_argument(
        "--pipeline", choices=["auto", "flux2-klein", "zimage"], default="auto",
        help=(
            "auto: flux2-klein when --input-image present, zimage otherwise. "
            "flux2-klein: Flux2 Klein 4B with reference conditioning (mflux). "
            "zimage: ZImage Turbo text-to-image."
        ),
    )
    parser.add_argument(
        "--flux2-model-path", default=None, metavar="PATH",
        help=(
            "Local path to Klein 4B model in HuggingFace directory structure "
            "(transformer/, vae/, text_encoder/, tokenizer/). "
            "Omit to let mflux auto-download from HuggingFace."
        ),
    )
    parser.add_argument(
        "--quantize", type=int, choices=[4, 8], default=None, metavar="BITS",
        help="Quantization for HF auto-download mode (4 or 8 bits). Not needed when local pre-quantized model exists.",
    )
    parser.add_argument(
        "--variant", choices=["4b", "9b"], default="9b",
        help="Klein model variant (default: 9b, better quality; 4b for less memory)",
    )
    parser.add_argument(
        "--double-ref", "--no-double-ref", action=argparse.BooleanOptionalAction, default=False,
        help=(
            "Pass the reference image twice for stronger clothing consistency "
            "(default: False). Enable with --double-ref if needed."
        ),
    )
    parser.add_argument(
        "--chain-ref", "--no-chain-ref", action=argparse.BooleanOptionalAction, default=True,
        help=(
            "Use the generated front view as reference for back/side views "
            "(default: True). The front view is a clean A-pose on white background, "
            "providing better visual reference than the original photo. "
            "Use --no-chain-ref to use the original reference for all views."
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

def _build_view_prompt(view: str, base_prompt: str | None, pipeline_type: str = "zimage") -> str:
    if pipeline_type == "flux2-klein":
        # Flux2 Klein reference conditioning carries character identity from the
        # image latent.  base_prompt is appended as an explicit clothing description
        # to anchor text conditioning — this compensates for the lack of ComfyUI's
        # ReferenceLatent attention-sharing mechanism.
        template = VIEW_PROMPTS_FLUX2[view]
        if base_prompt and base_prompt.strip():
            return f"{template}。人物穿着：{base_prompt.strip()}"
        return template
    template = VIEW_PROMPTS[view]
    if base_prompt and base_prompt.strip():
        return f"{template}, {base_prompt.strip()}"
    return template


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


def _write_html_viewer(html_path: str, out_dir: str, ref_image, ref_path: str | None, view_outputs: list):
    """Write a self-contained HTML file that shows all profile views left-to-right."""
    import html as html_mod

    # Build card entries: reference (if any) + generated views
    cards = []
    if ref_path:
        cards.append({"label": "Reference", "file": "reference.png"})
    for vo in view_outputs:
        if vo.get("view") in ("html", "strip"):
            continue
        label = vo["view"].capitalize()
        cards.append({"label": label, "file": os.path.basename(vo["path"])})

    cards_html = ""
    for c in cards:
        safe_label = html_mod.escape(c["label"])
        safe_file = html_mod.escape(c["file"])
        cards_html += (
            f'      <div class="card">\n'
            f'        <img src="{safe_file}" alt="{safe_label}">\n'
            f'        <div class="label">{safe_label}</div>\n'
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

def run(args):
    from PIL import Image
    from app.manifest import Manifest, collect_model_fingerprint

    # Validate input image path if provided
    if args.input_image and not os.path.exists(args.input_image):
        print(f"ERROR: input image not found: {args.input_image}", file=sys.stderr)
        sys.exit(1)

    # Determine pipeline type
    use_flux2 = (
        args.pipeline == "flux2-klein"
        or (args.pipeline == "auto" and args.input_image is not None)
    )
    pipeline_type = "flux2-klein" if use_flux2 else "zimage"

    # Resolve dimensions: explicit --width/--height override --ratio preset
    if args.width is not None and args.height is not None:
        width, height = args.width, args.height
    else:
        preset = RATIO_PRESETS[args.ratio]
        width, height = preset
        # If user specifies only one of width/height, keep the other from preset
        if args.width is not None:
            width = args.width
        if args.height is not None:
            height = args.height

    print(f"Resolution: {width}×{height} (ratio={args.ratio})")

    # Maintain canonical view order regardless of --views input order
    views = [v for v in ALL_VIEWS if v in args.views]

    # Create output folder: output/profile_YYYYMMDD_HHMMSS/
    base_name = f"profile_{time.strftime('%Y%m%d_%H%M%S')}"
    out_dir = os.path.join(cfg.OUTPUT_DIR, base_name)
    os.makedirs(out_dir, exist_ok=True)

    # Write run.json
    run_meta = {
        "command": "profile",
        "pipeline": pipeline_type,
        "mode": "reference-conditioning" if use_flux2 else "t2i",
        "input_image": args.input_image,
        "views": views,
        "base_prompt": args.base_prompt,
        "steps": args.steps,
        "seed": args.seed,
        "width": width,
        "height": height,
        "ratio": args.ratio,
        "lora_path": getattr(args, "lora_path", None),
        "lora_scale": getattr(args, "lora_scale", 1.0),
        "strip_gap": args.strip_gap,
        "no_strip": args.no_strip,
        "flux2_model_path": getattr(args, "flux2_model_path", None),
        "quantize": getattr(args, "quantize", None),
        "double_ref": getattr(args, "double_ref", False),
        "chain_ref": getattr(args, "chain_ref", True),
        "vlm": getattr(args, "vlm", True),
        "vlm_caption": None,  # filled in after VLM call
    }
    run_file = os.path.join(out_dir, "run.json")
    with open(run_file, "w") as f:
        json.dump(run_meta, f, indent=2, ensure_ascii=False)
        f.write("\n")

    print(f"Output folder: {out_dir}")
    print(f"Views: {' + '.join(views)}")
    print(f"Pipeline: {pipeline_type}")

    # Load reference image
    ref_image = None
    if args.input_image:
        ref_image = Image.open(args.input_image).convert("RGB")
        ref_image.save(os.path.join(out_dir, "reference.png"))
        ref_note = "reference conditioning" if use_flux2 else "display only"
        print(f"Reference: {args.input_image} ({ref_image.width}×{ref_image.height}) — {ref_note}")

    # Resolve base_prompt: user-provided, VLM auto-caption, or None
    base_prompt = args.base_prompt
    vlm_caption = None
    if use_flux2 and args.input_image and not base_prompt and getattr(args, "vlm", True):
        try:
            from app.commands.caption import _image_to_base64, _call_vlm, _STYLE_PROMPTS, _LANG_INSTRUCTIONS
            print("[VLM] Auto-captioning reference image for clothing description...", end=" ", flush=True)
            b64 = _image_to_base64(args.input_image)
            style_prompt = _STYLE_PROMPTS["profile"] + "\n" + _LANG_INSTRUCTIONS["zh_CN"]
            vlm_caption = _call_vlm(
                getattr(args, "vlm_api_url", "http://localhost:1234/v1"),
                getattr(args, "vlm_model", "qwen/qwen3-vl-4b"),
                b64,
                style_prompt,
            )
            base_prompt = vlm_caption
            print("Done")
            print(f"[VLM] Clothing: {vlm_caption}")
            # Save caption JSON alongside reference
            caption_out = {
                "image": args.input_image,
                "style": "profile",
                "caption": vlm_caption,
            }
            with open(os.path.join(out_dir, "reference.caption.json"), "w") as f:
                json.dump(caption_out, f, indent=2, ensure_ascii=False)
                f.write("\n")
        except Exception as exc:
            print(f"\n[VLM] Warning: auto-caption failed ({exc}) — continuing without it")

    if base_prompt:
        print(f"Base prompt: {base_prompt}")

    # Update run.json with resolved base_prompt / VLM caption
    run_meta["base_prompt_resolved"] = base_prompt
    run_meta["vlm_caption"] = vlm_caption
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
        )
    else:
        from app.pipeline import ZImagePipeline
        pipeline = ZImagePipeline()

    start_time = datetime.now(timezone.utc).isoformat()

    view_outputs = []
    view_images = []
    all_timings = {}

    try:
        # Determine chain-ref eligibility:
        # When enabled + flux2-klein + front is in views, generate front first
        # and use it as reference for subsequent views.  The generated front is
        # a clean A-pose on white background — much better reference than the
        # original photo for consistent back/side generation.
        use_chain_ref = (
            use_flux2
            and getattr(args, "chain_ref", True)
            and "front" in views
            and args.input_image is not None
        )
        if use_chain_ref:
            print(f"Chain-ref: ON (front view will become reference for back/side)")

        # Double-ref: optionally pass the same reference image twice for
        # stronger conditioning (doubled attention signal).
        use_double_ref = getattr(args, "double_ref", False)
        if use_double_ref:
            print(f"Double-ref: ON (reference passed twice)")

        # Track the front view path for cascade reference
        front_path = None

        for view in views:
            # NumPy/mflux seed must be in [0, 2**32-1]; fold the ComfyUI 64-bit seed
            view_seed = (args.seed + VIEW_SEED_OFFSETS[view]) % (2 ** 32)
            prompt = _build_view_prompt(view, base_prompt, pipeline_type)

            # Determine reference images for this view
            if use_flux2:
                if use_chain_ref and front_path is not None:
                    # Cascade: use generated front as reference for back/side
                    ref_images = [front_path]
                    ref_label = f"front.png (cascade)"
                elif use_chain_ref and view == "front":
                    # Front view: use original reference
                    ref_images = [args.input_image]
                    ref_label = "original"
                else:
                    # No chain-ref, or zimage fallback: use original reference
                    ref_images = [args.input_image] if args.input_image else []
                    ref_label = "original" if args.input_image else "none"

                # Apply double-ref: pass the same image twice
                if ref_images and use_double_ref:
                    ref_images = [ref_images[0], ref_images[0]]
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
                    steps=args.steps,
                )
            else:
                result = pipeline.generate(
                    prompt=prompt,
                    width=width,
                    height=height,
                    steps=args.steps,
                    seed=view_seed,
                    lora_path=getattr(args, "lora_path", None),
                    lora_scale=getattr(args, "lora_scale", 1.0),
                    upscale=False,
                    upscale_model=None,
                )

            view_path = os.path.join(out_dir, f"{view}.png")
            result.image.save(view_path)
            print(f"  Saved: {view_path}")

            # Track front view for cascade reference
            if use_chain_ref and view == "front":
                front_path = view_path

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

        # Generate HTML viewer showing all images left-to-right
        html_path = os.path.join(out_dir, "index.html")
        _write_html_viewer(html_path, out_dir, ref_image, args.input_image, view_outputs)
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
        models = collect_model_fingerprint(lora_path=args.lora_path)
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
