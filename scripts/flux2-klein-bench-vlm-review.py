#!/usr/bin/env python3
"""Flux 2 Klein Bench — VLM Review (local Vision Language Model).

Part of the flux2-klein-character-profile-bench workflow.
  Workflow:  .claude/workflows/flux2-klein-character-profile-bench.js  (Review phase)
  Siblings:  scripts/flux2-klein-bench-compare-html.py                 (Report HTML phase)
  Runner:    scripts/comfy_bench.py                                    (Run FP16/FP8 phases)

Calls an OpenAI-compatible chat/completions endpoint with a base64-encoded image
and a structured quality-assessment prompt.  Prints a JSON array of review objects
to stdout (one per image), matching the REVIEW_SCHEMA used by the bench workflow.

Usage:
    # Single image
    python scripts/flux2-klein-bench-vlm-review.py --image out/front.png --variant fp8

    # Batch — all PNG/JPG in a directory
    python scripts/flux2-klein-bench-vlm-review.py --batch-dir out/fp8/fp8/ --variant fp8

    # Options
    --vlm-url http://127.0.0.1:8888/v1   # default
    --model default                        # model name (depends on your server)
    --timeout 120                          # per-image request timeout (seconds)

If the VLM server is unreachable the script prints a skip notice to stdout and
exits with code 0 so callers can treat it as "no reviews available".
"""

from __future__ import annotations

import argparse
import base64
import json
import re
import sys
from pathlib import Path

import requests

# ── Constants ───────────────────────────────────────────────────────────────────

VLM_URL_DEFAULT = "http://127.0.0.1:8888/v1"
MODEL_DEFAULT = "Gemma-4-26B-A4B-MLX-4.7bit-vision"
VLM_API_KEY = "abcd"

REVIEW_PROMPT = """\
Analyze this AI-generated character profile image. \
This was generated using the {variant} model precision variant of Flux 2 Klein 9B.

Evaluate on a 1-10 scale:

1. **Anatomical correctness** — proportions, limb placement, face symmetry, hand detail
2. **Consistency** — does the character look coherent? Any contradictions between views?
3. **Image quality** — sharpness, artifacts, color accuracy, skin texture
4. **Background** — is the white background clean and uniform?
5. **Clothing/detail** — are clothing details consistent and clear? Shoes consistent?
6. **Overall score** — rate 1-10

Respond with ONLY a JSON object (no markdown, no explanation) with these keys:
- anatomy (int 1-10)
- consistency (int 1-10)
- quality (int 1-10)
- background (int 1-10)
- clothing (int 1-10)
- overall (int 1-10)
- issues (array of strings)
- strengths (array of strings)
- summary (string, one sentence)
"""


# ── Helpers ─────────────────────────────────────────────────────────────────────


def _headers() -> dict:
    """Common HTTP headers including API key for the VLM server."""
    return {"Authorization": f"Bearer {VLM_API_KEY}"}


def check_vlm_available(vlm_url: str, timeout: float = 5.0) -> bool:
    """Health-check: GET /v1/models. Returns True if server responds."""
    try:
        r = requests.get(f"{vlm_url}/models", headers=_headers(), timeout=timeout)
        return r.status_code == 200
    except requests.RequestException:
        return False


def image_to_base64(path: str) -> str:
    """Read an image file and return its base64-encoded string."""
    with open(path, "rb") as f:
        return base64.b64encode(f.read()).decode("utf-8")


def mime_type(path: str) -> str:
    """Return a MIME type based on file extension."""
    ext = Path(path).suffix.lower()
    return {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp",
    }.get(ext, "image/png")


def parse_vlm_json_response(text: str) -> dict:
    """Extract a JSON object from a VLM response string.

    Handles: pure JSON, markdown-wrapped JSON (```json ... ```),
    and text with an embedded JSON block.
    """
    # 1. Direct parse
    text = text.strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    # 2. Strip markdown code fences
    fence_match = re.search(r"```(?:json)?\s*\n?(.*?)```", text, re.DOTALL)
    if fence_match:
        try:
            return json.loads(fence_match.group(1).strip())
        except json.JSONDecodeError:
            pass

    # 3. Find first { … } block
    first_brace = text.find("{")
    last_brace = text.rfind("}")
    if first_brace != -1 and last_brace > first_brace:
        try:
            return json.loads(text[first_brace : last_brace + 1])
        except json.JSONDecodeError:
            pass

    # 4. Regex fallback — extract individual score fields
    result: dict = {"issues": [], "strengths": [], "summary": "Parse failed"}
    for field in ("anatomy", "consistency", "quality", "background", "clothing", "overall"):
        m = re.search(rf'"{field}"\s*:\s*(\d+)', text)
        if m:
            result[field] = int(m.group(1))
    return result


def review_single_image(
    image_path: str,
    variant: str,
    vlm_url: str = VLM_URL_DEFAULT,
    model: str = MODEL_DEFAULT,
    timeout: float = 120.0,
) -> dict:
    """Send one image to the VLM for review and return a structured assessment."""
    b64 = image_to_base64(image_path)
    data_url = f"data:{mime_type(image_path)};base64,{b64}"

    prompt = REVIEW_PROMPT.format(variant=variant)

    payload = {
        "model": model,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {"type": "image_url", "image_url": {"url": data_url}},
                ],
            }
        ],
        "max_tokens": 2048,
        "temperature": 0.3,
    }

    resp = requests.post(
        f"{vlm_url}/chat/completions",
        json=payload,
        headers=_headers(),
        timeout=timeout,
    )
    resp.raise_for_status()
    data = resp.json()

    content = data["choices"][0]["message"]["content"]
    review = parse_vlm_json_response(content)
    review["_image"] = str(image_path)
    return review


def review_batch(
    image_dir: str,
    variant: str,
    vlm_url: str = VLM_URL_DEFAULT,
    model: str = MODEL_DEFAULT,
    timeout: float = 120.0,
) -> list[dict]:
    """Review all PNG/JPG files in *image_dir* (sorted alphabetically).

    Returns a list of review dicts.  Individual failures are recorded as
    error entries rather than aborting the whole batch.
    """
    p = Path(image_dir)
    images = sorted(
        f for f in p.iterdir()
        if f.suffix.lower() in (".png", ".jpg", ".jpeg", ".webp")
    )

    if not images:
        print(f"WARNING: no images found in {image_dir}", file=sys.stderr)
        return []

    reviews: list[dict] = []
    for img in images:
        print(f"  Reviewing {img.name} ...", file=sys.stderr)
        try:
            r = review_single_image(str(img), variant, vlm_url, model, timeout)
            reviews.append(r)
        except Exception as exc:
            print(f"  WARNING: failed to review {img.name}: {exc}", file=sys.stderr)
            reviews.append({"_image": str(img), "status": "error", "error": str(exc)})

    return reviews


# ── CLI ─────────────────────────────────────────────────────────────────────────


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="Evaluate AI-generated images via a local VLM server.",
    )
    # Mutually exclusive: single image or batch directory
    src = p.add_mutually_exclusive_group(required=True)
    src.add_argument("--image", help="Path to a single image to review")
    src.add_argument("--batch-dir", help="Directory of images to review (all PNG/JPG)")

    p.add_argument("--variant", required=True, help="Variant label (fp8 or fp16)")
    p.add_argument("--vlm-url", default=VLM_URL_DEFAULT, help="VLM API base URL")
    p.add_argument("--model", default=MODEL_DEFAULT, help="Model name for the VLM server")
    p.add_argument("--timeout", type=float, default=120.0, help="Per-image request timeout (seconds)")
    return p


def main() -> None:
    args = build_parser().parse_args()

    # Health check — skip gracefully if server is down
    if not check_vlm_available(args.vlm_url):
        result = {"status": "skipped", "reason": "VLM server not available"}
        print(json.dumps(result))
        sys.exit(0)

    try:
        if args.image:
            reviews = [review_single_image(
                args.image, args.variant, args.vlm_url, args.model, args.timeout,
            )]
        else:
            reviews = review_batch(
                args.batch_dir, args.variant, args.vlm_url, args.model, args.timeout,
            )

            # Persist reviews.json in the batch directory
            out_path = Path(args.batch_dir) / "reviews.json"
            out_path.write_text(json.dumps(reviews, indent=2))
            print(f"  Saved {out_path}", file=sys.stderr)

        print(json.dumps(reviews, indent=2))

    except Exception as exc:
        # Print error JSON to stdout (not stderr) so callers can parse it
        print(json.dumps({"status": "error", "error": str(exc)}))
        sys.exit(0)


if __name__ == "__main__":
    main()
