"""caption — generate image description using Qwen3-VL via local OpenAI-compatible API."""

import argparse
import base64
import html
import io
import json
import os
import re
import shutil
import sys
import time
from typing import Any

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


def add_args(parser: argparse.ArgumentParser) -> None:
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
    parser.add_argument("--no-auto-load", action="store_true",
                        help="Don't auto-load the VLM in LM Studio before captioning "
                        "(assume the model is already loaded)")
    parser.add_argument("--prompt", type=str, default=None, metavar="TEXT",
                        help="Original T2I prompt (used by 'review' style for adherence evaluation)")
    parser.add_argument("--review-html", type=str, nargs="+", metavar="JSON",
                        help="Generate feedback HTML from caption JSON files (exits after HTML generation)")
    parser.add_argument("--ab-manifest", type=str, default=None, metavar="PATH",
                        help="Generate a MULTI-SET A/B review HTML from a manifest JSON "
                        "({sets:[{name, prompt?, variants?:[{label}], files:[caption_jsons]}]}). "
                        "Exits after HTML generation. Produces one <section> per set.")
    parser.add_argument("--html-output", type=str, default=None, metavar="PATH",
                        help="Output path for --review-html/--ab-manifest (default: "
                        "output/review_<timestamp>.html next to the images)")


def run(args: argparse.Namespace) -> None:
    # --ab-manifest mode: build a MULTI-SET A/B review HTML from a manifest JSON
    if getattr(args, "ab_manifest", None):
        html_path = generate_review_html(
            manifest_path=args.ab_manifest,
            output_path=getattr(args, "html_output", None),
        )
        print(f"Review HTML: {html_path}")
        return

    # --review-html mode: generate feedback HTML from caption JSON files (flat, single set)
    if getattr(args, "review_html", None):
        if getattr(args, "image", None) or getattr(args, "input_image", None):
            print("WARNING: --image is ignored when --review-html is used", file=sys.stderr)
        html_path = generate_review_html(
            args.review_html,
            output_path=getattr(args, "html_output", None),
        )
        print(f"Review HTML: {html_path}")
        return

    from app.io_utils import require_file
    input_path = require_file(
        args.image or args.input_image,
        "input image (positional arg or --input-image)",
    )

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
    caption = _call_vlm(args.api_url, args.model, b64, prompt_text,
                        auto_load=not getattr(args, "no_auto_load", False))

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


def _lmstudio_home() -> str:
    """Resolve the LM Studio home directory (where .internal/ lives)."""
    return os.environ.get("LMSTUDIO_HOME") or os.path.expanduser("~/.lmstudio")


def _lmstudio_default_config_path(model_id: str) -> str:
    """Path to LM Studio's per-model default load-config JSON.

    e.g. model_id="qwen/qwen3-vl-4b" ->
         ~/.lmstudio/.internal/user-concrete-model-default-config/qwen/qwen3-vl-4b.json
    """
    return os.path.join(
        _lmstudio_home(), ".internal", "user-concrete-model-default-config",
        f"{model_id}.json",
    )


def _disable_kv_cache_quant(model_id: str) -> bool:
    """Disable MLX KV-cache quantization in LM Studio's per-model default config.

    The MLX vision path (mlx-vlm) cannot load a VLM with KV-cache quantization
    enabled — it raises "The mlx-vlm batched vision path does not support KV
    cache quantization yet" and every headless load (REST /api/v1/models/load
    AND the `lms load` CLI) fails. LM Studio stores this default per-model; the
    REST load endpoint accepts only {"model"} and exposes no flag to turn it off,
    so the only programmatic fix is to edit this stored config. This flips the
    stored default to enabled=false so subsequent loads succeed.

    Idempotent and safe: a no-op (returns False) if the file is missing, the
    field is absent, or already disabled. Backs up the original before writing.

    Returns True if a change was made (caller should retry the load).
    """
    cfg_path = _lmstudio_default_config_path(model_id)
    if not os.path.exists(cfg_path):
        return False
    try:
        with open(cfg_path) as f:
            cfg = json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        print(f"[caption] Could not read LM Studio model config ({cfg_path}): {e}",
              file=sys.stderr)
        return False

    fields = cfg.get("load", {}).get("fields", [])
    kv_field = next(
        (f for f in fields if f.get("key") == "llm.load.mlx.kvCacheQuantization"), None
    )
    if kv_field is None:
        return False
    if not kv_field.get("value", {}).get("enabled", False):
        return False  # already disabled

    backup = f"{cfg_path}.bak.{int(time.time())}"
    try:
        shutil.copy2(cfg_path, backup)
        kv_field["value"]["enabled"] = False
        with open(cfg_path, "w") as f:
            json.dump(cfg, f, indent=4)
    except OSError as e:
        print(f"[caption] Could not write LM Studio model config: {e}", file=sys.stderr)
        return False

    print(
        f"[caption] Disabled KV-cache quantization for {model_id} in LM Studio "
        f"(backup: {backup}). This fixes the mlx-vlm VLM load failure.",
        flush=True,
    )
    return True


def _lmstudio_ensure_model(api_url: str, model_id: str, timeout: int = 180) -> bool:
    """Ensure the given model is loaded in LM Studio.

    Checks the native /api/v1/models endpoint for actual load state; if not
    loaded, POSTs /api/v1/models/load. If that load fails, attempts to auto-fix
    the most common MLX-VLM failure (KV-cache quantization) and retries once.

    Args:
        api_url: OpenAI-compatible base URL (e.g., "http://localhost:1234/v1")
        model_id: Model identifier string (e.g., "qwen/qwen3-vl-4b")
        timeout: Seconds to wait for a single load attempt (default 180s)

    Returns:
        True if the model is loaded (or becomes loaded); False if LM Studio is
        unavailable or the load genuinely fails.
    """
    base = _lmstudio_base(api_url)
    lms_base = f"{base}/api/v1"

    def _loaded_models():
        """Return the set of currently-loaded model keys, or None if unreachable.

        Uses the NATIVE /api/v1/models endpoint: each model carries a
        `loaded_instances` list (non-empty iff loaded). The OpenAI /v1/models
        endpoint lists ALL indexed models regardless of load state, so it cannot
        distinguish loaded from unloaded.
        """
        try:
            r = requests.get(f"{lms_base}/models", timeout=5)
            r.raise_for_status()
            data = r.json()
            return {
                m.get("key", "") for m in data.get("models", [])
                if m.get("loaded_instances")
            }
        except Exception:
            return None

    def _load_once() -> bool:
        """POST the load endpoint; returns True if the model reports loaded."""
        try:
            r = requests.post(
                f"{lms_base}/models/load",
                json={"model": model_id},
                timeout=timeout,
            )
            if r.status_code == 200:
                body = r.json()
                # Successful load: {"status": "loaded", "instance_id": ...}
                if body.get("status") == "loaded" or body.get("instance_id"):
                    return True
                err = body.get("error")
                if err:
                    print(f"[caption] LM Studio load error: {err.get('type')}: "
                          f"{err.get('message', '')}", file=sys.stderr)
            else:
                print(f"[caption] LM Studio load HTTP {r.status_code}: "
                      f"{r.text[:200]}", file=sys.stderr)
        except requests.RequestException as e:
            print(f"[caption] LM Studio load request failed: {e}", file=sys.stderr)
        return False

    loaded = _loaded_models()
    if loaded is None:
        return False  # LM Studio not responding
    if model_id in loaded:
        return True

    print(f"[caption] Loading model {model_id} via LM Studio...", flush=True)
    if _load_once():
        return True

    # Load failed — the most common cause for MLX VLMs is KV-cache quantization.
    # Auto-fix it (idempotent), give LM Studio a moment to release the failed
    # load state and re-read the edited config, then retry once.
    if _disable_kv_cache_quant(model_id):
        # LM Studio caches the failed-load state for a brief window: a retry
        # fired immediately after the config edit still fails with
        # model_load_failed. A short pause lets it pick up the updated config.
        time.sleep(2)
        print("[caption] Retrying load after KV-cache fix...", flush=True)
        if _load_once():
            return True

    return False


def _call_vlm(api_url: str, model: str, b64_image: str, prompt: str,
              auto_load: bool = True) -> str:
    """Call OpenAI-compatible chat completions API with image + text.

    When auto_load is True (default), ensures the model is loaded in LM Studio
    before the first request — proactively, not only on failure. As a fallback,
    also retries once via _lmstudio_ensure_model if the first request fails with
    a connection error or HTTP error (model not loaded).
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

    if auto_load:
        _lmstudio_ensure_model(api_url, model)

    try:
        data = _do_request()
    except (requests.ConnectionError, requests.HTTPError) as first_err:
        # Reactive fallback: ensure the model is loaded, then retry once.
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
                  prompt: str | None = None, auto_load: bool = True) -> str:
    """Caption a single image and return the text. Reusable public API.

    Args:
        image_path: Path to image file.
        style: Caption style key (default, photography, prompt, profile, style, score, review).
        lang: Output language (en, zh_TW, zh_CN, ja).
        api_url: VLM API base URL.
        model: VLM model name.
        prompt: Original T2I prompt (required for 'review' style).
        auto_load: If True, ensure the VLM is loaded in LM Studio first.

    Returns:
        Caption text string.
    """
    prompt_text = _STYLE_PROMPTS.get(style, _STYLE_PROMPTS["default"])
    if style == "review" and prompt:
        prompt_text = prompt_text.format(prompt=prompt)
    prompt_text += "\n" + _LANG_INSTRUCTIONS.get(lang, "")
    b64 = _image_to_base64(image_path)
    return _call_vlm(api_url, model, b64, prompt_text, auto_load=auto_load)


# ---------------------------------------------------------------------------
# Review HTML generation
# ---------------------------------------------------------------------------

def _extract_caption_json(raw: dict | str | Any) -> dict:
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


_SCORE_KEYS = ["overall", "detail", "sharpness", "composition", "prompt_adherence", "artifacts"]
_SCORE_LABELS = ["Overall", "Detail", "Sharpness", "Composition", "Adherence", "Artifacts"]

# Chrome-string localization for the review HTML (VLM caption CONTENT is unaffected —
# it is whatever run.py caption --style produced). Selected by the manifest's top-level `lang`.
_REVIEW_I18N = {
    "en": {
        "best": "Best", "export": "Export Feedback JSON", "exported": "Feedback exported!",
        "captured": "Captured", "missed": "Missed", "compare": "Score Comparison",
        "strengths": "Strengths & Issues", "str_label": "Strengths", "issues_label": "Issues",
        "comment_ph": "Your comments...", "prompt_label": "Prompt", "guide_label": "What to compare",
        "reco_label": "VLM suggests", "none": "—", "close_hint": "click outside to close",
        "meta_across": "image(s) across", "meta_sets": "set(s)", "dimension": "Dimension",
        "tiebreak": " (by detail/sharpness)",
        "img_count": lambda n: f"{n} image{'s' if n != 1 else ''}",
    },
    "zh_TW": {
        "best": "最佳", "export": "匯出回饋 JSON", "exported": "已匯出回饋！",
        "captured": "命中", "missed": "遺漏", "compare": "分數比較",
        "strengths": "優點與問題", "str_label": "優點", "issues_label": "問題",
        "comment_ph": "你的評論...", "prompt_label": "提示詞", "guide_label": "評判重點",
        "reco_label": "VLM 建議", "none": "—", "close_hint": "點圖外關閉",
        "meta_across": "張圖片，共", "meta_sets": "組", "dimension": "指標",
        "tiebreak": "（依細節/銳利度）",
        "img_count": lambda n: f"{n} 張圖片",
    },
}


def _resolve_review_path(p: str, base_dir: str = "") -> str:
    """Resolve a caption-JSON path that may be relative.

    Tries the path as-is, then relative to base_dir (the manifest's directory),
    then basename-in-base_dir. Returns the first that exists; falls back to the
    original guess so the loader can emit a clear 'not found' warning.
    """
    if not p:
        return ""
    cands = [p]
    if not os.path.isabs(p) and base_dir:
        cands.append(os.path.join(base_dir, p))
        cands.append(os.path.join(base_dir, os.path.basename(p)))
    for c in cands:
        if c and os.path.exists(c):
            return c
    return cands[0]


def _load_review_item(path: str) -> dict:
    """Load one caption JSON into a flat display item.

    The image is referenced by RELATIVE filename (basename) so the browser
    resolves it next to the HTML file — no base64, no CWD dependency.
    """
    with open(path) as f:
        data = json.load(f)
    caption_raw = _extract_caption_json(data.get("caption", "{}"))
    img_path = data.get("image", "")
    # If a sibling video (.mp4) shares the first-frame PNG's basename, embed it
    # as a playable <video> (video A/B review). Pure-image reviews have no mp4
    # → video_src "" → card renders the usual <img>. Resolve relative to the
    # caption JSON's dir first (robust to CWD), then the image path itself.
    video_path = ""
    if img_path:
        stem = os.path.splitext(os.path.basename(img_path))[0]
        caption_dir = os.path.dirname(os.path.abspath(path))
        for cand in (os.path.join(caption_dir, stem + ".mp4"),
                     os.path.splitext(img_path)[0] + ".mp4"):
            if cand and os.path.exists(cand):
                video_path = cand
                break
    return {
        "caption_path": path,
        "image_path": img_path,
        "filename": os.path.basename(img_path) if img_path else os.path.basename(path),
        "image_src": os.path.basename(img_path) if img_path else "",
        "video_src": os.path.basename(video_path) if video_path else "",
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
    }


def _score_bars_html(item: dict) -> str:
    bars = ""
    for key, label in zip(_SCORE_KEYS, _SCORE_LABELS):
        val = item["scores"].get(key, 0)
        pct = val * 10  # 1-10 → 10-100%
        color = "#4caf50" if val >= 8 else "#ff9800" if val >= 5 else "#f44336"
        bars += (
            f'<div class="score-row">'
            f'<span class="score-label">{label}</span>'
            f'<div class="score-bar-bg"><div class="score-bar-fill" style="width:{pct}%;background:{color}"></div></div>'
            f'<span class="score-val">{val}</span>'
            f'</div>'
        )
    return bars


def _build_card_html(gi: int, li: int, item: dict, variant_label: str, T: dict) -> str:
    bars_html = _score_bars_html(item)
    captured_html = "".join(
        f'<span class="tag captured">{html.escape(str(c))}</span>' for c in item["captured"]
    )
    missed_html = "".join(
        f'<span class="tag missed">{html.escape(str(m))}</span>' for m in item["missed"]
    )
    issues_html = "".join(f'<li>{html.escape(str(s))}</li>' for s in item["issues"])
    strengths_html = "".join(f'<li>{html.escape(str(s))}</li>' for s in item["strengths"])
    variant_html = (
        f'<div class="variant"><b>{html.escape(variant_label)}</b></div>'
        if variant_label else ""
    )
    summary_html = (
        f'<p class="summary"><b>VLM:</b> <i>{html.escape(item["summary"])}</i></p>'
        if item["summary"] else ""
    )
    # Media: embed a playable <video> (poster = the captioned first frame) when a
    # sibling mp4 exists (video A/B review); otherwise the usual zoomable <img>.
    if item.get("video_src"):
        media_html = (
            f'<video class="card-video" controls preload="none" playsinline '
            f'poster="{html.escape(item["image_src"])}" '
            f'src="{html.escape(item["video_src"])}"></video>'
        )
    else:
        media_html = (
            f'<img src="{html.escape(item["image_src"])}" '
            f'alt="{html.escape(item["filename"])}" onclick="openLb(this.src)"/>'
        )
    return f"""
        <div class="img-card" data-set="{gi}" data-idx="{li}"
             data-variant="{html.escape(variant_label)}" data-filename="{html.escape(item['filename'])}">
          <div class="card-header">
            <h3>{html.escape(item['filename'])}</h3>
            <label class="pick-label"><input type="radio" name="best_set{gi}" value="{li}"/> {T['best']}</label>
          </div>
          {variant_html}
          <div class="img-wrap">
            {media_html}
          </div>
          <div class="scores">{bars_html}</div>
          <div class="tags-row">
            <div class="tags captured-list"><b>{T['captured']}:</b> {captured_html or T['none']}</div>
            <div class="tags missed-list"><b>{T['missed']}:</b> {missed_html or T['none']}</div>
          </div>
          {summary_html}
          <details class="details-section">
            <summary>{T['strengths']}</summary>
            <div class="details-inner">
              <b>{T['str_label']}:</b><ul>{strengths_html or f"<li>{T['none']}</li>"}</ul>
              <b>{T['issues_label']}:</b><ul>{issues_html or f"<li>{T['none']}</li>"}</ul>
            </div>
          </details>
          <textarea class="comment-box" data-set="{gi}" data-idx="{li}" placeholder="{T['comment_ph']}"></textarea>
        </div>
        """


def _build_recommendation_html(group: dict, T: dict) -> str:
    """Per-set VLM recommendation: winner by overall, tiebreak detail+sharpness+artifacts.
    When overalls tie, append a note so a detail/sharpness win (e.g. SeedVR2) is self-explaining.
    Returns '' if fewer than 2 items or no score difference at all."""
    items = group["items"]
    if len(items) < 2:
        return ""
    variants = group.get("variants") or []

    def label(i):
        if i < len(variants) and variants[i]:
            return variants[i].get("label", "") or items[i]["filename"]
        return items[i]["filename"]

    def overall(it):
        return it["scores"].get("overall", 0)

    def detsum(it):
        s = it["scores"]
        return s.get("detail", 0) + s.get("sharpness", 0) + s.get("artifacts", 0)

    order = sorted(range(len(items)), key=lambda i: (overall(items[i]), detsum(items[i])), reverse=True)
    top, second = items[order[0]], items[order[1]]
    if overall(top) == overall(second) and detsum(top) == detsum(second):
        return ""  # no measurable difference
    winner = order[0]
    note = T["tiebreak"] if overall(top) == overall(second) else ""
    scores_str = "  ·  ".join(
        f"{html.escape(label(i))}: overall {overall(items[i])}" for i in order
    )
    return (
        f'<div class="set-recommendation"><b>{T['reco_label']}:</b> '
        f'{html.escape(label(winner))}{note}<span class="reco-scores">  —  {scores_str}</span></div>'
    )


def _build_group_table_html(group: dict, T: dict) -> str:
    items = group["items"]
    variants = group.get("variants") or []
    header = f"<th>{T['dimension']}</th>" + "".join(
        f'<th>{html.escape((variants[i].get("label") if i < len(variants) and variants[i] else "") or items[i]["filename"])}</th>'
        for i in range(len(items))
    )
    rows = ""
    for key, label in zip(_SCORE_KEYS, _SCORE_LABELS):
        vals = [item["scores"].get(key, 0) for item in items]
        best_val = max(vals) if vals else 0
        row = f"<tr><td class='metric-name'>{label}</td>"
        for v in vals:
            cls = "win" if v == best_val and best_val > 0 else ""
            row += f'<td class="{cls}">{v}</td>'
        row += "</tr>"
        rows += row
    return f'<table><thead><tr>{header}</tr></thead><tbody>{rows}</tbody></table>'


def generate_review_html(caption_json_paths: list[str] | None = None,
                         output_path: str | None = None,
                         groups: list[dict[str, Any]] | None = None,
                         manifest_path: str | None = None,
                         lang: str | None = None) -> str:
    """Generate a multi-set A/B review HTML from caption JSON files.

    Images are referenced by RELATIVE filename and the HTML is written next to
    them, so the browser loads them from disk (no base64, no CWD dependency).

    Args:
        caption_json_paths: Flat list → wrapped into one implicit set "Comparison"
            (backwards-compatible with --review-html).
        output_path: Where to write the HTML. Default: review_<ts>.html in the
            same folder as the images (so relative <img src> resolves).
        groups: List of {name, prompt?, guide?, variants?:[{label}], files:[caption_jsons]}.
        manifest_path: Path to a JSON {lang?, sets:[...]} → loaded into groups.
        lang: Chrome language ("en" | "zh_TW"). Manifest `lang` overrides; default "en".

    Returns:
        Absolute path to the generated HTML file.
    """
    import datetime

    # Resolve groups: manifest → explicit groups → flat list wrapped as one set
    base_dir = ""
    mf = {}
    if manifest_path:
        manifest_path = os.path.abspath(manifest_path)
        base_dir = os.path.dirname(manifest_path)
        with open(manifest_path) as f:
            mf = json.load(f)
        groups = mf.get("sets", [])
    elif groups is None:
        groups = [{"name": "Comparison", "files": caption_json_paths or []}]
        if caption_json_paths:
            base_dir = os.path.dirname(os.path.abspath(caption_json_paths[0]))

    # Resolve chrome language (VLM caption CONTENT is unaffected — it is whatever
    # run.py caption --style produced). kwarg > manifest > "en".
    resolved_lang = lang or mf.get("lang") or "en"
    T = _REVIEW_I18N.get(resolved_lang, _REVIEW_I18N["en"])

    # Load items per group, resolving relative file paths
    rendered = []
    for gi, g in enumerate(groups):
        items = []
        for fp in (g.get("files") or []):
            resolved = _resolve_review_path(fp, base_dir)
            if not resolved or not os.path.exists(resolved):
                print(f"WARNING: caption JSON not found, skipping: {fp}", file=sys.stderr)
                continue
            try:
                items.append(_load_review_item(resolved))
            except Exception as e:
                print(f"WARNING: could not load caption JSON {fp}: {e}", file=sys.stderr)
        if not items:
            continue
        rendered.append({
            "name": g.get("name") or f"Set {gi + 1}",
            "prompt": g.get("prompt", "") or "",
            "guide": g.get("guide", "") or "",
            "variants": g.get("variants") or [],
            "items": items,
        })

    total_items = sum(len(g["items"]) for g in rendered)
    if total_items == 0:
        raise ValueError("No valid caption JSON items to render")

    # Default output path = the images' folder (so relative <img src> resolves)
    default_dir = os.path.dirname(os.path.abspath(rendered[0]["items"][0]["caption_path"]))
    ts = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
    if not output_path:
        ts_file = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        output_path = os.path.join(default_dir, f"review_{ts_file}.html")
    else:
        output_path = os.path.abspath(output_path)
        if os.path.abspath(os.path.dirname(output_path)) != os.path.abspath(default_dir):
            print(
                f"WARNING: --html-output directory differs from the images' folder "
                f"({default_dir}). Relative <img src> links will break — write the "
                f"HTML next to the images.",
                file=sys.stderr,
            )

    first_model = rendered[0]["items"][0].get("model", "")
    title = mf.get("title") or "A/B Review"

    # Build per-set sections (guide + VLM recommendation + cards + table)
    sets_html = ""
    for gi, group in enumerate(rendered):
        variants = group["variants"]
        cards = ""
        for li, item in enumerate(group["items"]):
            vlabel = ""
            if li < len(variants) and variants[li]:
                vlabel = variants[li].get("label", "") or ""
            cards += _build_card_html(gi, li, item, vlabel, T)
        n = len(group["items"])
        prompt_html = (
            f'<p class="set-prompt"><b>{T["prompt_label"]}:</b> {html.escape(group["prompt"])}</p>'
            if group["prompt"] else ""
        )
        guide_html = (
            f'<div class="set-guide"><b>{T["guide_label"]}:</b> {html.escape(group["guide"])}</div>'
            if group.get("guide") else ""
        )
        reco_html = _build_recommendation_html(group, T)
        sets_html += f"""
    <section class="set" data-set="{gi}">
      <h2 class="set-title"><span class="set-name">{html.escape(group['name'])}</span>
        <span class="set-count">({T['img_count'](n)})</span></h2>
      {reco_html}
      {prompt_html}
      {guide_html}
      <div class="set-images">{cards}</div>
      <h3 class="tbl-title">{T['compare']}</h3>
      {_build_group_table_html(group, T)}
    </section>
    """

    html_content = f"""<!DOCTYPE html>
<html lang="{resolved_lang}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{html.escape(title)} — {ts}</title>
<style>
*{{box-sizing:border-box;margin:0;padding:0}}
body{{background:#181818;color:#ddd;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:2rem 2rem 5rem;line-height:1.5}}
h1{{color:#fff;font-size:1.35rem;margin-bottom:.3rem}}
.meta{{color:#555;font-size:.8rem;margin-bottom:1.5rem}}
.set{{background:#1c1c1c;border:1px solid #2a2a2a;border-radius:10px;padding:1.2rem;margin-bottom:1.5rem}}
.set-title{{color:#fff;font-size:1.05rem;margin-bottom:.6rem;display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}}
.set-name{{font-weight:600}}
.set-count{{color:#666;font-size:.78rem;font-weight:400}}
.set-recommendation{{background:#11271a;border-left:3px solid #6cbe6c;padding:.5rem .75rem;border-radius:0 4px 4px 0;font-size:.82rem;color:#9be0a6;margin-bottom:.75rem}}
.set-recommendation .reco-scores{{color:#777;font-size:.76rem}}
.set-prompt{{background:#161616;border-left:3px solid #4a9eff;padding:.5rem .75rem;border-radius:0 4px 4px 0;font-size:.8rem;color:#bbb;margin-bottom:.75rem;word-break:break-word}}
.set-guide{{background:#2a2410;border-left:3px solid #e0a800;padding:.5rem .75rem;border-radius:0 4px 4px 0;font-size:.8rem;color:#e8c873;margin-bottom:.75rem}}
.set-images{{display:flex;gap:1.5rem;flex-wrap:wrap;margin-bottom:1rem}}
.tbl-title{{color:#888;font-size:.78rem;text-transform:uppercase;letter-spacing:.06em;margin:.8rem 0 .4rem}}
.img-card{{flex:1;min-width:300px;max-width:600px;background:#222;border-radius:8px;padding:1rem;border:1px solid #2e2e2e}}
.card-header{{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:.5rem}}
.card-header h3{{font-size:.8rem;color:#ccc;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}}
.variant{{font-size:.78rem;color:#4a9eff;margin-bottom:.5rem}}
.pick-label{{font-size:.82rem;color:#888;cursor:pointer;white-space:nowrap}}
.pick-label input{{margin-right:4px}}
.img-wrap{{margin-bottom:.8rem}}
.img-card img{{width:100%;border-radius:4px;display:block;cursor:zoom-in;transition:opacity .15s;background:#111}}
.img-card img:hover{{opacity:.9}}
.img-card video.card-video{{width:100%;border-radius:4px;display:block;background:#111;max-height:70vh}}
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
.summary{{color:#bbb;font-size:.8rem;margin:.6rem 0;padding:.4rem .6rem;background:#1a1a1a;border-radius:4px}}
.details-section{{margin-bottom:.5rem}}
.details-section summary{{cursor:pointer;color:#888;font-size:.78rem;padding:4px 0}}
.details-inner{{padding:.5rem 0;font-size:.8rem;color:#aaa}}
.details-inner ul{{padding-left:1.2rem;margin:4px 0}}
.comment-box{{width:100%;min-height:48px;background:#1a1a1a;border:1px solid #333;border-radius:4px;color:#ddd;padding:8px;font-size:.82rem;resize:vertical;margin-top:.5rem;font-family:inherit}}
.comment-box:focus{{border-color:#4a9eff;outline:none}}
table{{width:100%;border-collapse:collapse;background:#1e1e1e;border-radius:8px;overflow:hidden;border:1px solid #2a2a2a}}
th{{text-align:center;padding:.5rem .8rem;background:#242424;color:#666;font-size:.72rem;text-transform:uppercase;letter-spacing:.06em}}
td{{text-align:center;padding:.45rem .8rem;border-bottom:1px solid #252525;font-size:.85rem}}
.metric-name{{text-align:left;color:#999}}
.win{{color:#6cbe6c;font-weight:600}}
.bottom-bar{{position:fixed;bottom:0;left:0;right:0;background:#222;border-top:1px solid #333;padding:.75rem 2rem;display:flex;gap:1rem;align-items:center;z-index:100}}
.bottom-bar button{{background:#4a9eff;color:#fff;border:none;padding:8px 20px;border-radius:6px;cursor:pointer;font-size:.85rem}}
.bottom-bar button:hover{{background:#3a8eef}}
.bottom-bar .status{{color:#888;font-size:.82rem}}
.lb{{display:none;position:fixed;inset:0;background:rgba(0,0,0,.94);z-index:999;flex-direction:column}}
.lb.open{{display:flex}}
.lb-bar{{display:flex;gap:6px;align-items:center;padding:10px 16px;background:#111;border-bottom:1px solid #222;flex:none}}
.lb-bar button{{background:#333;color:#ddd;border:none;padding:6px 12px;border-radius:5px;cursor:pointer;font-size:.85rem}}
.lb-bar button.active{{background:#4a9eff;color:#fff}}
.lb-bar .lb-close{{margin-left:auto;background:#4a1c1c;color:#e07070;font-size:1rem;line-height:1}}
.lb-hint{{color:#666;font-size:.76rem}}
.lb-viewport{{flex:1;overflow:auto;display:flex;align-items:safe center;justify-content:safe center;cursor:zoom-out}}
#lb-img{{max-width:90vw;max-height:90vh;object-fit:contain;border-radius:4px;cursor:default}}
</style>
</head>
<body>
<h1>{html.escape(title)}</h1>
<p class="meta">Generated {ts} &middot; {total_items} {T['meta_across']} {len(rendered)} {T['meta_sets']} &middot; VLM: {html.escape(str(first_model))}</p>

{sets_html}

<div class="lb" id="lb">
  <div class="lb-bar">
    <button data-z="1" class="active">1&times;</button>
    <button data-z="2">2&times;</button>
    <button data-z="4">4&times;</button>
    <span class="lb-hint">{T['close_hint']}</span>
    <button class="lb-close" onclick="closeLb()">&times;</button>
  </div>
  <div class="lb-viewport" id="lb-vp" onclick="closeLb()">
    <img id="lb-img" src="" alt="" onclick="event.stopPropagation()"/>
  </div>
</div>

<div class="bottom-bar">
  <button onclick="exportFeedback()">{T['export']}</button>
  <span class="status" id="status"></span>
</div>

<script>
function setZoom(n) {{
  var img = document.getElementById('lb-img');
  document.querySelectorAll('.lb-bar button[data-z]').forEach(function(b) {{
    b.classList.toggle('active', b.dataset.z === String(n));
  }});
  if (n === 1) {{
    img.style.width = ''; img.style.height = '';
    img.style.maxWidth = '90vw'; img.style.maxHeight = '90vh';
  }} else {{
    img.style.maxWidth = 'none'; img.style.maxHeight = 'none';
    img.style.width = (img.naturalWidth * n) + 'px';
    img.style.height = 'auto';
  }}
}}
function openLb(src) {{
  var img = document.getElementById('lb-img');
  img.src = src;
  document.getElementById('lb').classList.add('open');
  setZoom(1);
  document.getElementById('lb-vp').scrollTo(0, 0);
}}
function closeLb() {{
  document.getElementById('lb').classList.remove('open');
}}
document.querySelectorAll('.lb-bar button[data-z]').forEach(function(b) {{
  b.addEventListener('click', function() {{ setZoom(parseInt(b.dataset.z)); }});
}});
document.addEventListener('keydown', function(e) {{ if (e.key === 'Escape') closeLb(); }});

function exportFeedback() {{
  var data = {{ timestamp: new Date().toISOString(), sets: [] }};
  document.querySelectorAll('section.set').forEach(function(set) {{
    var gi = set.dataset.set;
    var nameEl = set.querySelector('.set-name');
    var promptEl = set.querySelector('.set-prompt');
    var promptText = '';
    if (promptEl) {{
      // strip the localized "<label>:" prefix (works for "Prompt:" and "提示詞:")
      promptText = (promptEl.textContent || '').replace(/^\\s*[^:]*:\\s*/, '').trim();
    }}
    var best = set.querySelector('input[name="best_set' + gi + '"]:checked');
    var images = [];
    set.querySelectorAll('.img-card').forEach(function(card) {{
      images.push({{
        index: parseInt(card.dataset.idx),
        filename: card.dataset.filename || '',
        variant: card.dataset.variant || '',
        comment: card.querySelector('.comment-box').value
      }});
    }});
    data.sets.push({{
      name: nameEl ? nameEl.textContent.trim() : '',
      prompt: promptText,
      best_image: best ? parseInt(best.value) : null,
      images: images
    }});
  }});
  var blob = new Blob([JSON.stringify(data, null, 2)], {{type: 'application/json'}});
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = 'review_feedback.json';
  a.click();
  URL.revokeObjectURL(url);
  document.getElementById('status').textContent = '{T['exported']}';
  setTimeout(function() {{ document.getElementById('status').textContent = ''; }}, 3000);
}}
</script>
</body>
</html>"""

    with open(output_path, "w") as f:
        f.write(html_content)

    return os.path.abspath(output_path)
