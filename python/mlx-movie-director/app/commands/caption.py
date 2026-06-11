"""caption — generate image description using Qwen3-VL via local OpenAI-compatible API."""

import base64
import html
import io
import json
import os
import re
import sys

import requests
from PIL import Image

PARSER_META = {
    "help": "Generate image caption using Qwen3-VL",
    "description": (
        "Caption an image using a local Qwen3-VL model.\n\n"
        "Examples:\n"
        "  run.py caption output/base.png\n"
        "  run.py caption base.png --style photography\n"
        "  run.py caption base.png --style prompt --lang en\n"
        "  run.py caption base.png --style score --lang en  ← VLM quality scoring\n"
    ),
}

_STYLE_PROMPTS = {
    "default": "Describe this image in detail.",
    "photography": (
        "Describe this photo as a photography prompt. "
        "Include: subject, pose, clothing, lighting, camera angle, composition, mood, and setting."
    ),
    "prompt": (
        "Write a detailed text-to-image generation prompt for this image. "
        "Describe subject, appearance, clothing, pose, background, lighting, style, and atmosphere. "
        "Output only the prompt, no preamble."
    ),
    "profile": (
        "仔细描述这个人物的服装和外貌。"
        "包括：上衣、下装、鞋子、配饰、发型、发色、肤色。"
        "只输出服装和外貌描述，不要描述背景、姿势或构图。"
        "用简体中文回答，使用简洁的逗号分隔列表格式。"
    ),
    "style": (
        "Describe the ART STYLE and RENDERING TECHNIQUE of this image. "
        "Include: medium (digital painting, anime cel-shading, watercolor, oil, 3D render, etc.), "
        "color palette (vibrant/muted, warm/cool, dominant hues), "
        "lighting style (soft/dramatic/flat, ambient/directional), "
        "line work (thick/thin, present/absent, ink/pencil), "
        "texture/shading technique (smooth/grainy, flat/cross-hatch, gradient), "
        "overall aesthetic (realistic/semi-realistic/stylized/cartoon/anime). "
        "Output ONLY the style description as a comma-separated list. "
        "Answer in English."
    ),
    "score": (
        "You are a professional image quality evaluator. "
        "Analyze this AI-generated image and score it on a 1-10 scale.\n\n"
        "Evaluate these dimensions:\n"
        "1. overall — overall image quality and aesthetic appeal\n"
        "2. detail — level of fine detail (textures, fabric, skin, hair)\n"
        "3. sharpness — image sharpness and clarity across the frame\n"
        "4. composition — framing, rule of thirds, visual balance\n"
        "5. prompt_adherence — how well the image matches a typical text-to-image prompt intent\n"
        "6. artifacts — absence of rendering artifacts (INVERTED: 10 = no artifacts, 1 = severe)\n\n"
        "Respond with ONLY a JSON object (no markdown fences, no explanation):\n"
        '{"overall": N, "detail": N, "sharpness": N, "composition": N, '
        '"prompt_adherence": N, "artifacts": N, '
        '"issues": ["..."], "strengths": ["..."], "summary": "one sentence"}\n'
        "Each score is an integer 1-10."
    ),
    "compare": (
        "Describe this image in ONE short sentence (max 25 words). "
        "Focus on: subject appearance (hair color, clothing), style (realistic/anime/3D), "
        "and overall quality. Output only the sentence, nothing else."
    ),
    "review": (
        "You are a professional image quality evaluator reviewing a TEXT-TO-IMAGE output.\n\n"
        "ORIGINAL PROMPT given to the generator:\n"
        "---\n"
        "{prompt}\n"
        "---\n\n"
        "Evaluate how faithfully the generated image matches the ORIGINAL PROMPT above, "
        "AND score general image quality.\n\n"
        "Score these dimensions (1-10):\n"
        "1. overall — overall image quality and aesthetic appeal\n"
        "2. detail — level of fine detail (textures, fabric, skin, hair)\n"
        "3. sharpness — image sharpness and clarity across the frame\n"
        "4. composition — framing, rule of thirds, visual balance\n"
        "5. prompt_adherence — how faithfully the image matches the ORIGINAL PROMPT\n"
        "6. artifacts — absence of rendering artifacts (INVERTED: 10 = no artifacts)\n\n"
        "Also list:\n"
        "- captured: elements from the prompt that are clearly present in the image\n"
        "- missed: elements from the prompt that are absent or wrong\n\n"
        'Respond with ONLY a JSON object (no markdown fences):\n'
        '{{"overall": N, "detail": N, "sharpness": N, "composition": N, '
        '"prompt_adherence": N, "artifacts": N, '
        '"captured": ["..."], "missed": ["..."], '
        '"issues": ["..."], "strengths": ["..."], "summary": "one sentence"}}\n'
        "Each score is an integer 1-10."
    ),
}

# Language instructions — appended to style prompt
_LANG_INSTRUCTIONS = {
    "zh_TW": "請用繁體中文回答。",
    "zh_CN": "请用简体中文回答。",
    "en": "Answer in English.",
    "ja": "日本語で答えてください。",
}

_DEFAULT_API_URL = "http://localhost:1234/v1"
_DEFAULT_MODEL = "qwen/qwen3-vl-4b"


def add_args(parser):
    parser.add_argument("image", nargs="?", default=None, metavar="IMAGE",
                        help="Input image path (positional shorthand for --input-image)")
    parser.add_argument("--input-image", type=str, default=None, metavar="PATH",
                        help="Input image path (flag form)")
    parser.add_argument("--output", type=str, default=None, metavar="PATH",
                        help="Output JSON path (default: <image>.caption.json)")
    parser.add_argument("--api-url", type=str, default=_DEFAULT_API_URL,
                        help=f"VLM API base URL (default: {_DEFAULT_API_URL})")
    parser.add_argument("--model", type=str, default=_DEFAULT_MODEL,
                        help=f"Model name (default: {_DEFAULT_MODEL})")
    parser.add_argument("--style", choices=list(_STYLE_PROMPTS.keys()), default="default",
                        help="Caption style (default: default)")
    parser.add_argument("--lang", choices=list(_LANG_INSTRUCTIONS.keys()), default="zh_TW",
                        help="Output language (default: zh_TW)")
    parser.add_argument("--prompt", type=str, default=None, metavar="TEXT",
                        help="Original T2I prompt (used by 'review' style for adherence evaluation)")
    parser.add_argument("--review-html", type=str, nargs="+", metavar="JSON",
                        help="Generate feedback HTML from caption JSON files (exits after HTML generation)")
    parser.add_argument("--html-output", type=str, default=None, metavar="PATH",
                        help="Output path for --review-html (default: output/review_<timestamp>.html)")


def run(args):
    # --review-html mode: generate feedback HTML from caption JSON files
    if getattr(args, "review_html", None):
        if getattr(args, "image", None) or getattr(args, "input_image", None):
            print("WARNING: --image is ignored when --review-html is used", file=sys.stderr)
        html_path = generate_review_html(
            args.review_html,
            output_path=getattr(args, "html_output", None),
        )
        print(f"Review HTML: {html_path}")
        return

    input_path = args.image or args.input_image
    if not input_path:
        print("ERROR: provide an image path (positional) or --input-image PATH", file=sys.stderr)
        sys.exit(1)

    if not os.path.exists(input_path):
        print(f"ERROR: input image not found: {input_path}", file=sys.stderr)
        sys.exit(1)

    # Derive default output path: image.png → image.caption.json
    output_path = args.output
    if output_path is None:
        base, _ = os.path.splitext(input_path)
        output_path = f"{base}.caption.json"

    style = args.style
    lang = args.lang

    prompt_text = _STYLE_PROMPTS[style]
    if style == "review":
        if not args.prompt:
            print("ERROR: --prompt TEXT is required for 'review' style", file=sys.stderr)
            sys.exit(1)
        prompt_text = prompt_text.format(prompt=args.prompt)
    prompt_text += "\n" + _LANG_INSTRUCTIONS[lang]

    # 1. Encode image to base64
    print(f"Captioning {input_path} (style={style}, lang={lang})...", end=" ", flush=True)
    b64 = _image_to_base64(input_path)

    # 2. Call VLM API
    caption = _call_vlm(args.api_url, args.model, b64, prompt_text)

    # 3. Save JSON
    result = {
        "image": input_path,
        "style": style,
        "model": args.model,
        "caption": caption,
    }
    with open(output_path, "w") as f:
        json.dump(result, f, indent=2, ensure_ascii=False)

    print("Done")
    print(f"Caption: {caption}")
    print(f"Saved: {output_path}")


def _image_to_base64(image_path: str, max_size: int = 1024) -> str:
    """Load image, optionally downsize, convert to JPEG bytes, return base64 string."""
    img = Image.open(image_path).convert("RGB")
    # Downsize if largest dimension exceeds max_size (VLMs don't need huge images)
    w, h = img.size
    if max(w, h) > max_size:
        scale = max_size / max(w, h)
        img = img.resize((int(w * scale), int(h * scale)), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=85)
    return base64.b64encode(buf.getvalue()).decode()


def get_profile_verify_prompt(expected_view: str) -> str:
    """Build a VLM prompt to verify a generated profile view is the correct angle.

    The returned prompt instructs the VLM to check four boolean criteria and score
    the image, returning a JSON object suitable for _parse_caption_scores().

    Args:
        expected_view: "front", "back", or "side"
    """
    descriptions = {
        "front": "front view (0°): character faces the viewer directly, face fully visible, no back of head",
        "back":  "back view (180°): rear-facing, back of head visible, NO face, back of clothing visible",
        "side":  "side view (90°): exactly sideways, face/head in profile, only one arm visible, body in silhouette",
    }
    desc = descriptions.get(expected_view, expected_view)
    return (
        f"This image should show the {desc} of a character in A-pose on a white/neutral background. "
        "Full body from head to feet should be visible.\n\n"
        "Evaluate and respond ONLY with a JSON object (no markdown, no explanation):\n"
        '{"view_correct": true/false, "full_body": true/false, "apose": true/false, '
        '"clean_bg": true/false, "score": 1-10, "issues": ["..."], "summary": "one sentence"}\n\n'
        "Criteria:\n"
        f"- view_correct: Is this actually a {expected_view} view as described above?\n"
        "- full_body: Are feet/shoes visible at the bottom of the frame?\n"
        "- apose: Are arms slightly away from the body (not pressed against it)?\n"
        "- clean_bg: Is the background white or clean without clutter?\n"
        "- score: Overall image quality 1-10."
    )


def get_controlnet_verify_prompt() -> str:
    """Build a VLM prompt to verify a ControlNet output shows a V-pose (arms raised).

    The returned prompt instructs the VLM to check arm position and return a JSON object
    suitable for pass/fail verdict in the basic-controlnet self-test.
    """
    return (
        "This image should show a person in a VICTORY V-POSE: both arms raised high above the head "
        "forming a V-shape, similar to an athlete celebrating a win.\n\n"
        "Evaluate and respond ONLY with a JSON object (no markdown, no explanation):\n"
        '{"arms_raised": true/false, "v_pose": true/false, "both_arms_visible": true/false, '
        '"score": 1-10, "issues": ["..."], "summary": "one sentence describing the actual pose"}\n\n'
        "Criteria:\n"
        "- arms_raised: Are both arms raised above shoulder height?\n"
        "- v_pose: Do the raised arms form a V-shape (spread apart) above the head?\n"
        "- both_arms_visible: Are both arms clearly visible in the image?\n"
        "- score: How well does this match the expected V-pose? 1-10 (10=perfect V-pose).\n"
        "Answer in English."
    )


def _lmstudio_base(api_url: str) -> str:
    """Derive LM Studio native API base from an OpenAI-compatible URL.

    Example: "http://localhost:1234/v1" → "http://localhost:1234"
    """
    return api_url.rstrip("/").removesuffix("/v1")


def _lmstudio_ensure_model(api_url: str, model_id: str, timeout: int = 180) -> bool:
    """Ensure the given model is loaded in LM Studio via its native API.

    Uses LM Studio native endpoints:
      GET  /api/v1/models           — list currently loaded models
      POST /api/v1/models/load      — trigger model load
      (polls GET /api/v1/models until model appears or timeout)

    Args:
        api_url: OpenAI-compatible base URL (e.g., "http://localhost:1234/v1")
        model_id: Model identifier string (e.g., "qwen/qwen3-vl-4b")
        timeout: Seconds to wait for load to complete (default 180s)

    Returns:
        True if model is ready; False if LM Studio unavailable or load failed.
    """
    import time
    base = _lmstudio_base(api_url)
    lms_base = f"{base}/api/v1"

    def _loaded_models():
        try:
            # Use OpenAI-compatible /v1/models — returns only loaded models
            # with {"data": [{"id": "..."}]} format.
            # Native /api/v1/models uses {"models": [...], "key": ...} — wrong format.
            r = requests.get(f"{api_url}/models", timeout=5)
            r.raise_for_status()
            data = r.json()
            return [m.get("id", "") for m in data.get("data", [])]
        except Exception:
            return None

    # Check if already loaded
    loaded = _loaded_models()
    if loaded is None:
        return False  # LM Studio not responding
    if model_id in loaded:
        return True

    # Request load
    print(f"[caption] Loading model {model_id} via LM Studio...", flush=True)
    try:
        r = requests.post(
            f"{lms_base}/models/load",
            json={"model": model_id},
            timeout=15,
        )
        r.raise_for_status()
    except Exception as e:
        print(f"[caption] Load request failed: {e}")
        return False

    # Poll until loaded or timeout
    deadline = time.time() + timeout
    interval = 3
    while time.time() < deadline:
        time.sleep(interval)
        loaded = _loaded_models()
        if loaded is not None and model_id in loaded:
            print(f"[caption] Model ready.")
            return True
        remaining = int(deadline - time.time())
        print(f"[caption] Waiting for model load... ({remaining}s remaining)", end="\r", flush=True)
        interval = min(interval + 1, 10)

    print(f"\n[caption] Timed out waiting for model load ({timeout}s).")
    return False


def _call_vlm(api_url: str, model: str, b64_image: str, prompt: str) -> str:
    """Call OpenAI-compatible chat completions API with image + text.

    Automatically tries to load the model via LM Studio native API if the first
    request fails with a connection error or 5xx status (model not loaded).
    """
    url = f"{api_url}/chat/completions"
    payload = {
        "model": model,
        "messages": [{
            "role": "user",
            "content": [
                {
                    "type": "image_url",
                    "image_url": {"url": f"data:image/jpeg;base64,{b64_image}"},
                },
                {
                    "type": "text",
                    "text": prompt,
                },
            ],
        }],
        "max_tokens": 2048,
        "temperature": 0.3,
        "stream": False,
    }

    def _do_request():
        resp = requests.post(url, json=payload, timeout=120)
        resp.raise_for_status()
        return resp.json()

    try:
        data = _do_request()
    except (requests.ConnectionError, requests.HTTPError) as first_err:
        # Try to load the model via LM Studio native API, then retry once
        if _lmstudio_ensure_model(api_url, model):
            data = _do_request()  # raises if still failing
        else:
            raise first_err

    content = data["choices"][0]["message"]["content"]

    # Strip Qwen3 <think/> reasoning blocks if present
    content = re.sub(r"<think.*?</think\s*>", "", content, flags=re.DOTALL).strip()

    return content


# ---------------------------------------------------------------------------
# Public helper — reusable by other commands (e.g., image-review self-tests)
# ---------------------------------------------------------------------------

def caption_image(image_path: str, style: str = "photography", lang: str = "en",
                  api_url: str = _DEFAULT_API_URL, model: str = _DEFAULT_MODEL,
                  prompt: str | None = None) -> str:
    """Caption a single image and return the text. Reusable public API.

    Args:
        image_path: Path to image file.
        style: Caption style key (default, photography, prompt, profile, style, score, review).
        lang: Output language (en, zh_TW, zh_CN, ja).
        api_url: VLM API base URL.
        model: VLM model name.
        prompt: Original T2I prompt (required for 'review' style).

    Returns:
        Caption text string.
    """
    prompt_text = _STYLE_PROMPTS.get(style, _STYLE_PROMPTS["default"])
    if style == "review" and prompt:
        prompt_text = prompt_text.format(prompt=prompt)
    prompt_text += "\n" + _LANG_INSTRUCTIONS.get(lang, "")
    b64 = _image_to_base64(image_path)
    return _call_vlm(api_url, model, b64, prompt_text)


# ---------------------------------------------------------------------------
# Review HTML generation
# ---------------------------------------------------------------------------

def _extract_caption_json(raw) -> dict:
    """Parse the nested caption field into a dict, tolerating markdown fences/prose.

    _call_vlm does not set response_format=json_object, so the VLM often wraps
    JSON in ```json fences or surrounds it with prose. A naive json.loads then
    fails and silently zeroes every score in the review HTML. Strip fences and
    fall back to the first {...} block.
    """
    if isinstance(raw, dict):
        return raw
    if not isinstance(raw, str):
        return {}
    s = raw.strip()
    if s.startswith("```"):
        s = re.sub(r"^```[a-zA-Z]*\s*", "", s)
        s = re.sub(r"```\s*$", "", s).strip()
    try:
        return json.loads(s)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", s, re.DOTALL)
        if match:
            try:
                return json.loads(match.group(0))
            except json.JSONDecodeError:
                pass
        return {}


def generate_review_html(caption_json_paths: list[str], output_path: str | None = None) -> str:
    """Generate a self-contained feedback HTML from caption JSON files.

    Args:
        caption_json_paths: Paths to .caption.json files produced by --style score/review.
        output_path: Where to write the HTML. Default: output/review_<timestamp>.html.

    Returns:
        Absolute path to the generated HTML file.
    """
    import datetime

    items = []
    for path in caption_json_paths:
        with open(path) as f:
            data = json.load(f)
        # Parse nested caption JSON string (VLM may wrap in markdown fences / prose)
        caption_raw = _extract_caption_json(data.get("caption", "{}"))
        # Embed image as base64
        img_path = data.get("image", "")
        img_b64 = ""
        if img_path and os.path.exists(img_path):
            img_b64 = _image_to_base64(img_path, max_size=1024)
        items.append({
            "image_path": img_path,
            "filename": os.path.basename(img_path),
            "img_b64": img_b64,
            "style": data.get("style", ""),
            "model": data.get("model", ""),
            "scores": {
                "overall": caption_raw.get("overall", 0),
                "detail": caption_raw.get("detail", 0),
                "sharpness": caption_raw.get("sharpness", 0),
                "composition": caption_raw.get("composition", 0),
                "prompt_adherence": caption_raw.get("prompt_adherence", 0),
                "artifacts": caption_raw.get("artifacts", 0),
            },
            "captured": caption_raw.get("captured", []),
            "missed": caption_raw.get("missed", []),
            "issues": caption_raw.get("issues", []),
            "strengths": caption_raw.get("strengths", []),
            "summary": caption_raw.get("summary", ""),
        })

    ts = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")

    # Default output path
    if not output_path:
        ts_file = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        output_path = os.path.join(
            os.path.dirname(caption_json_paths[0]) if caption_json_paths else ".",
            f"review_{ts_file}.html",
        )

    # Build score table header
    score_keys = ["overall", "detail", "sharpness", "composition", "prompt_adherence", "artifacts"]
    score_labels = ["Overall", "Detail", "Sharpness", "Composition", "Adherence", "Artifacts"]

    # Build image cards HTML
    cards_html = ""
    for i, item in enumerate(items):
        # Score bars
        bars_html = ""
        for key, label in zip(score_keys, score_labels):
            val = item["scores"].get(key, 0)
            pct = val * 10  # 1-10 → 10-100%
            color = "#4caf50" if val >= 8 else "#ff9800" if val >= 5 else "#f44336"
            bars_html += (
                f'<div class="score-row">'
                f'<span class="score-label">{label}</span>'
                f'<div class="score-bar-bg"><div class="score-bar-fill" style="width:{pct}%;background:{color}"></div></div>'
                f'<span class="score-val">{val}</span>'
                f'</div>'
            )

        # Captured / missed tags
        captured_html = "".join(
            f'<span class="tag captured">{html.escape(str(c))}</span>' for c in item["captured"]
        )
        missed_html = "".join(
            f'<span class="tag missed">{html.escape(str(m))}</span>' for m in item["missed"]
        )
        issues_html = "".join(
            f'<li>{html.escape(str(iss))}</li>' for iss in item["issues"]
        )
        strengths_html = "".join(
            f'<li>{html.escape(str(s))}</li>' for s in item["strengths"]
        )

        cards_html += f"""
        <div class="img-card" data-idx="{i}" data-filename="{html.escape(item['filename'])}">
          <div class="card-header">
            <h3>{html.escape(item['filename'])}</h3>
            <label class="pick-label"><input type="radio" name="best" value="{i}"/> Best</label>
          </div>
          <div class="img-wrap">
            <img src="data:image/png;base64,{item['img_b64']}" alt="{html.escape(item['filename'])}" onclick="openLb(this.src)"/>
          </div>
          <div class="scores">{bars_html}</div>
          <div class="tags-row">
            <div class="tags captured-list"><b>Captured:</b> {captured_html or '—'}</div>
            <div class="tags missed-list"><b>Missed:</b> {missed_html or '—'}</div>
          </div>
          <details class="details-section">
            <summary>Strengths & Issues</summary>
            <div class="details-inner">
              <b>Strengths:</b><ul>{strengths_html or '<li>—</li>'}</ul>
              <b>Issues:</b><ul>{issues_html or '<li>None</li>'}</ul>
              <p class="summary"><i>{html.escape(item['summary'])}</i></p>
            </div>
          </details>
          <textarea class="comment-box" data-idx="{i}" placeholder="Your comments..."></textarea>
        </div>
        """

    # Score comparison table
    table_header = "<th>Dimension</th>" + "".join(
        f'<th>{html.escape(item["filename"])}</th>' for item in items
    )
    table_rows = ""
    for key, label in zip(score_keys, score_labels):
        vals = [item["scores"].get(key, 0) for item in items]
        best_val = max(vals) if vals else 0
        row = f"<tr><td class='metric-name'>{label}</td>"
        for v in vals:
            cls = "win" if v == best_val and best_val > 0 else ""
            row += f'<td class="{cls}">{v}</td>'
        row += "</tr>"
        table_rows += row

    # Full HTML
    html_content = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>T2I A/B Review — {ts}</title>
<style>
*{{box-sizing:border-box;margin:0;padding:0}}
body{{background:#181818;color:#ddd;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:2rem;line-height:1.5}}
h1{{color:#fff;font-size:1.35rem;margin-bottom:.3rem}}
.meta{{color:#555;font-size:.8rem;margin-bottom:1.5rem}}
.images{{display:flex;gap:1.5rem;flex-wrap:wrap;margin-bottom:2rem}}
.img-card{{flex:1;min-width:300px;max-width:600px;background:#222;border-radius:8px;padding:1rem;border:1px solid #2e2e2e}}
.card-header{{display:flex;justify-content:space-between;align-items:center;margin-bottom:.65rem}}
.card-header h3{{font-size:.85rem;color:#ccc;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}}
.pick-label{{font-size:.82rem;color:#888;cursor:pointer}}
.pick-label input{{margin-right:4px}}
.img-wrap{{margin-bottom:.8rem}}
.img-card img{{width:100%;border-radius:4px;display:block;cursor:zoom-in;transition:opacity .15s}}
.img-card img:hover{{opacity:.9}}
.scores{{margin-bottom:.7rem}}
.score-row{{display:flex;align-items:center;gap:8px;margin-bottom:4px}}
.score-label{{width:90px;font-size:.75rem;color:#999;text-align:right}}
.score-bar-bg{{flex:1;height:14px;background:#333;border-radius:7px;overflow:hidden}}
.score-bar-fill{{height:100%;border-radius:7px;transition:width .3s}}
.score-val{{width:24px;font-size:.82rem;font-weight:600;text-align:right}}
.tags-row{{margin-bottom:.5rem}}
.tags{{margin-bottom:4px;font-size:.75rem}}
.tag{{display:inline-block;padding:2px 8px;border-radius:4px;margin:2px;font-size:.72rem}}
.tag.captured{{background:#1b4332;color:#6cbe6c}}
.tag.missed{{background:#4a1c1c;color:#e07070}}
.details-section{{margin-bottom:.5rem}}
.details-section summary{{cursor:pointer;color:#888;font-size:.8rem;padding:4px 0}}
.details-inner{{padding:.5rem 0;font-size:.8rem;color:#aaa}}
.details-inner ul{{padding-left:1.2rem;margin:4px 0}}
.summary{{color:#999;font-style:italic;margin-top:6px}}
.comment-box{{width:100%;min-height:48px;background:#1a1a1a;border:1px solid #333;border-radius:4px;color:#ddd;padding:8px;font-size:.82rem;resize:vertical;margin-top:.5rem;font-family:inherit}}
.comment-box:focus{{border-color:#4a9eff;outline:none}}
table{{width:100%;border-collapse:collapse;background:#1e1e1e;border-radius:8px;overflow:hidden;border:1px solid #2a2a2a;margin-bottom:1.5rem}}
th{{text-align:center;padding:.55rem 1rem;background:#242424;color:#666;font-size:.72rem;text-transform:uppercase;letter-spacing:.06em}}
td{{text-align:center;padding:.5rem 1rem;border-bottom:1px solid #252525;font-size:.88rem}}
.metric-name{{text-align:left;color:#999}}
.win{{color:#6cbe6c;font-weight:600}}
.bottom-bar{{position:fixed;bottom:0;left:0;right:0;background:#222;border-top:1px solid #333;padding:.75rem 2rem;display:flex;gap:1rem;align-items:center;z-index:100}}
.bottom-bar button{{background:#4a9eff;color:#fff;border:none;padding:8px 20px;border-radius:6px;cursor:pointer;font-size:.85rem}}
.bottom-bar button:hover{{background:#3a8eef}}
.bottom-bar .status{{color:#888;font-size:.82rem}}
.lb{{display:none;position:fixed;inset:0;background:rgba(0,0,0,.92);z-index:999;align-items:center;justify-content:center;cursor:zoom-out}}
.lb.open{{display:flex}}
.lb img{{max-width:90vw;max-height:90vh;object-fit:contain;border-radius:4px}}
h2{{color:#aaa;font-size:.8rem;text-transform:uppercase;letter-spacing:.08em;margin:1.5rem 0 .6rem}}
</style>
</head>
<body>
<h1>T2I A/B Review</h1>
<p class="meta">Generated {ts} &middot; {len(items)} image(s) &middot; VLM: {html.escape(str(items[0]['model'])) if items else 'N/A'}</p>

<h2>Images</h2>
<div class="images">
{cards_html}
</div>

<h2>Score Comparison</h2>
<table>
<thead><tr>{table_header}</tr></thead>
<tbody>{table_rows}</tbody>
</table>

<div class="lb" id="lb" onclick="this.classList.remove('open')">
  <img id="lb-img" src="" alt=""/>
</div>

<div class="bottom-bar">
  <button onclick="exportFeedback()">Export Feedback JSON</button>
  <span class="status" id="status"></span>
</div>

<script>
function openLb(src) {{
  var lb = document.getElementById('lb');
  document.getElementById('lb-img').src = src;
  lb.classList.add('open');
}}

function exportFeedback() {{
  var best = document.querySelector('input[name="best"]:checked');
  var data = {{
    timestamp: new Date().toISOString(),
    best_image: best ? best.value : null,
    images: []
  }};
  document.querySelectorAll('.img-card').forEach(function(card) {{
    var idx = card.dataset.idx;
    var fname = card.dataset.filename || '';
    var comment = card.querySelector('.comment-box').value;
    data.images.push({{ index: parseInt(idx), filename: fname, comment: comment }});
  }});
  var blob = new Blob([JSON.stringify(data, null, 2)], {{type: 'application/json'}});
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = 'review_feedback.json';
  a.click();
  URL.revokeObjectURL(url);
  document.getElementById('status').textContent = 'Feedback exported!';
  setTimeout(function() {{ document.getElementById('status').textContent = ''; }}, 3000);
}}
</script>
</body>
</html>"""

    with open(output_path, "w") as f:
        f.write(html_content)

    return os.path.abspath(output_path)
