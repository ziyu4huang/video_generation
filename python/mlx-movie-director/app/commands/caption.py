"""caption — generate image description using Qwen3-VL via local OpenAI-compatible API."""

import base64
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


def run(args):
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
    prompt_text = _STYLE_PROMPTS[style] + "\n" + _LANG_INSTRUCTIONS[lang]

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


def _call_vlm(api_url: str, model: str, b64_image: str, prompt: str) -> str:
    """Call OpenAI-compatible chat completions API with image + text."""
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

    resp = requests.post(url, json=payload, timeout=120)
    resp.raise_for_status()
    data = resp.json()

    content = data["choices"][0]["message"]["content"]

    # Strip Qwen3 <think/> reasoning blocks if present
    content = re.sub(r"<think.*?</think\s*>", "", content, flags=re.DOTALL).strip()

    return content
