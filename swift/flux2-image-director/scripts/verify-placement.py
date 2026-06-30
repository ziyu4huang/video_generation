#!/usr/bin/env python3
"""verify-placement.py — local-LLM verification of flux2 scene outputs.

Uses run.py caption (gemma-4-26b) for description + a DIRECT local LM Studio
call (qwen3-vl-4b) for the targeted questions caption styles can't ask:
  - who is on the LEFT vs RIGHT (placement correctness)
  - hand quality (finger count / deformity)
  - body proportion (full-body vs cropped)

Local LLM only — never MCP. Prints a compact verdict table.
"""
import base64, json, os, sys, urllib.request

VLM_URL = "http://localhost:1234/v1/chat/completions"
VLM_MODEL = "qwen/qwen3-vl-4b"   # vision-capable local model


def _b64(path):
    with open(path, "rb") as f:
        return base64.b64encode(f.read()).decode()


def ask_vlm(image_path, question):
    payload = {
        "model": VLM_MODEL,
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": question},
                {"type": "image_url",
                 "image_url": {"url": f"data:image/png;base64,{_b64(image_path)}"}},
            ],
        }],
        "max_tokens": 400, "temperature": 0.1,
    }
    req = urllib.request.Request(
        VLM_URL, data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)["choices"][0]["message"]["content"].strip()


def placement_verdict(scene_png):
    """Ask the VLM directly: which hair colour is on each side."""
    q = ("Look at this image with two women side by side. "
         "Answer in EXACTLY this format, nothing else:\n"
         "LEFT: <hair colour> | RIGHT: <hair colour>\n"
         "Then on a new line: HANDS: <ok|deformed|extra-fingers> | "
         "FRAMING: <full-body|half-body|head-only>")
    return ask_vlm(scene_png, q)


def main():
    repo = "/Users/huangziyu/proj/video_generation/swift/flux2-image-director"
    cases = [
        ("regional/closeup", "test_cases/regional/scene_baseline.png",
         "pink LEFT / teal RIGHT"),
        ("regional/closeup", "test_cases/regional/scene_regional.png",
         "pink LEFT / teal RIGHT"),
    ]
    # Add full-body cases if present
    fb = "test_cases/fullbody"
    for s in (42, 77, 123):
        p = f"{fb}/scene_base_s{s}.png"
        if os.path.exists(os.path.join(repo, p)):
            cases.append((f"fullbody/base s{s}", p, "pink LEFT / teal RIGHT"))
    rp = f"{fb}/scene_regional_fb.png"
    if os.path.exists(os.path.join(repo, rp)):
        cases.append(("fullbody/regional", rp, "pink LEFT / teal RIGHT"))
    print(f"{'case':<20} {'expect':<26} VLM verdict")
    print("-" * 90)
    for label, rel, expect in cases:
        full = os.path.join(repo, rel)
        if not os.path.exists(full):
            print(f"{label:<20} (missing: {rel})")
            continue
        try:
            v = placement_verdict(full).replace("\n", "  ||  ")
        except Exception as e:
            v = f"ERROR: {e}"
        print(f"{label:<20} {expect:<26} {v}")


if __name__ == "__main__":
    main()
