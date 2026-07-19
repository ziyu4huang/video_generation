#!/usr/bin/env python3
"""harsh-hand-check.py — adversarial hand-quality audit via local VLM.

qwen3-vl-4b is known to over-praise / ignore hand defects, so for the hand
question (the user's main concern) we cross-check with gemma-4-26b under a
HARSH critic prompt that defaults to "deformed" unless hands are clearly clean.
Local LM Studio only — not MCP.
"""
import base64, json, urllib.request

URL = "http://localhost:1234/v1/chat/completions"

HARSH = (
    "You are a harsh, skeptical art critic inspecting AI-generated human hands. "
    "Default assumption: AI hands are deformed. Only answer 'CLEAN' if you can "
    "clearly count five correct fingers on each visible hand with no extra, "
    "merged, or missing digits and correct anatomy. Otherwise answer the specific "
    "defect. For EACH person, inspect hands carefully.\n\n"
    "Image may show two full-body women (pink hair left, teal/green hair right).\n"
    "Reply EXACTLY:\n"
    "LEFT-HAND: <CLEAN | defect description>\n"
    "RIGHT-HAND: <CLEAN | defect description>\n"
    "VERDICT: <pass | fail>"
)


def b64(p):
    with open(p, "rb") as f:
        return base64.b64encode(f.read()).decode()


def ask(model, path):
    payload = {"model": model, "messages": [{"role": "user", "content": [
        {"type": "text", "text": HARSH},
        {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64(path)}"}},
    ]}], "max_tokens": 300, "temperature": 0.1}
    req = urllib.request.Request(URL, data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)["choices"][0]["message"]["content"].strip()


if __name__ == "__main__":
    import os
    base = "/Users/huangziyu/proj/video_generation/swift/flux2-image-director/test_cases/fullbody"
    cases = ["scene_base_s42.png", "scene_base_s77.png", "scene_base_s123.png",
             "scene_regional_fb.png"]
    for c in cases:
        p = os.path.join(base, c)
        if not os.path.exists(p):
            continue
        print(f"\n===== {c} (gemma-4-26b harsh) =====")
        try:
            print(ask("google/gemma-4-12b-qat", p))
        except Exception as e:
            print(f"ERROR: {e}")
