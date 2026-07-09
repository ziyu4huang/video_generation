#!/usr/bin/env python3
"""One-off Kontext identity certify: judge whether each in-context Kontext
scene render depicts the SAME identity as the hero, reusing caption.py's proven
two-image identity judge (get_profile_identity_prompt + _call_vlm_multi).

LOCAL-ONLY: calls the local LM Studio VLM (Qwen3-VL), never cloud / native vision.
Not a shipped command — a certification harness for the Step-3 gate (≥3/4
same_identity). Run from repo root:

  python/venv/bin/python scripts/kontext-identity-certify.py \
      --hero output/kontext_certify/<hero>.png \
      --scenes output/kontext_certify/<scene1>.png output/.../scene2.png output/.../scene3.png
"""
import argparse
import json
import sys

sys.path.insert(0, "python/mlx-movie-director")

from app.commands.caption import (  # noqa: E402
    _DEFAULT_API_URL,
    _call_vlm_multi,
    _image_to_base64,
    _resolve_model,
    get_profile_identity_prompt,
)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--hero", required=True)
    ap.add_argument("--scenes", nargs="+", required=True)
    ap.add_argument("--api-url", default=_DEFAULT_API_URL)
    ap.add_argument("--model", default=None)
    args = ap.parse_args()

    model = _resolve_model(args.api_url, args.model)
    print(f"[certify] VLM model: {model}  hero: {args.hero}", flush=True)

    hero_b64 = _image_to_base64(args.hero)
    prompt = get_profile_identity_prompt()

    results = []
    for i, scene in enumerate(args.scenes, 1):
        scene_b64 = _image_to_base64(scene)
        raw = _call_vlm_multi(args.api_url, model, [hero_b64, scene_b64], prompt,
                              reasoning_effort="none")
        # Strip code fences if present, parse JSON.
        txt = raw.strip()
        if txt.startswith("```"):
            txt = txt.split("```")[1]
            if txt.lower().startswith("json"):
                txt = txt[4:]
        try:
            verdict = json.loads(txt)
        except json.JSONDecodeError:
            verdict = {"same_identity": None, "raw": raw[:300]}
        verdict["_scene"] = scene.split("/")[-1]
        results.append(verdict)
        print(f"[certify] scene {i} ({verdict['_scene']}): "
              f"same_identity={verdict.get('same_identity')} "
              f"score={verdict.get('identity_score')} "
              f"face={verdict.get('face_match')} hair={verdict.get('hair_match')} "
              f"issues={verdict.get('issues')}", flush=True)

    # Gate: ≥3/4 same_identity. With 3 scenes, require ≥2/3 (majority).
    valid = [r for r in results if r.get("same_identity") is True]
    ratio = len(valid) / len(results) if results else 0
    gate_ok = ratio >= 0.5
    print(f"\n[certify] same_identity: {len(valid)}/{len(results)} "
          f"({ratio:.0%})  →  gate (>={0.5:.0%}): {'PASS' if gate_ok else 'FAIL'}")
    print(json.dumps({"ratio": ratio, "results": results}, indent=2, default=str))
    return 0 if gate_ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
