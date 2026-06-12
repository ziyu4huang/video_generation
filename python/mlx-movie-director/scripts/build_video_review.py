#!/usr/bin/env python3
"""build_video_review — turn a sweep_dasiwa_dev.sh run into bilingual review HTMLs.

Reads output/.sweep_runs.txt (written by the sweep) — one line per cell:
    <mp4_path>|<label>|<transformer>|<steps>|<cfg>|<extra>

For each cell:
  1. caption the extracted first frame <base>.png with --style review in BOTH
     en (-> <base>.caption.json) and zh_TW (-> <base>.caption.zh.json), passing
     the generation prompt so prompt_adherence is scored.
  2. group cells into two sets (DaSiWa / Dev), preserving sweep order.

Then builds two manifests (en, zh_TW) and calls app.commands.caption.
generate_review_html twice -> output/review_dasiwa_vs_dev_{en,zh}.html next to
the mp4s (relative <video src> resolves in-browser).

Usage:
    python scripts/build_video_review.py [--prompt-file /tmp/forge-catgirl.txt]
                                         [--runs output/.sweep_runs.txt]
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys

PROJECT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, PROJECT_DIR)

from app.commands.caption import generate_review_html  # noqa: E402

ROOT = PROJECT_DIR
PY = sys.executable  # the builder is itself launched from the project venv
RUN_PY = os.path.join(ROOT, "run.py")

GUIDE = (
    "Compare character coherence, forge/fire rendering, cat-ear accuracy, and "
    "motion stability across step/cfg settings and the HQ sampler. Higher step "
    "counts and the HQ (res_2s) sampler should yield a sharper, more solid "
    "figure; cfg 5 follows the prompt more aggressively than cfg 3."
)
GUIDE_ZH = (
    "比較角色連貫度、爐火渲染、貓耳準確度與運鏡穩定度。步數越高、以及 HQ（res_2s）"
    "取樣器，應讓人物更銳利扎實；cfg 5 比 cfg 3 更積極遵循提示詞。"
)
TITLE_EN = "DaSiWa vs Dev — parameter sweep"
TITLE_ZH = "DaSiWa vs Dev — 參數掃描評測"


def _variant_label(steps: str, cfg: str, extra: str) -> str:
    if "hq" in extra.lower():
        return f"HQ · {steps} steps · cfg {cfg}"
    return f"{steps} steps · cfg {cfg}"


def _caption(png: str, lang: str, prompt: str, out_path: str) -> bool:
    """Run run.py caption --style review --lang <lang> --prompt <prompt>."""
    cmd = [PY, RUN_PY, "caption", png, "--style", "review",
           "--lang", lang, "--output", out_path]
    if prompt:
        cmd += ["--prompt", prompt]
    print(f"  caption [{lang}] {os.path.basename(png)} -> {os.path.basename(out_path)}")
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=240)
    if r.returncode != 0:
        print(f"    ⚠️  caption failed: {r.stderr.strip()[:200]}", file=sys.stderr)
        return False
    return os.path.exists(out_path)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--runs", default=os.path.join(ROOT, "output", ".sweep_runs.txt"))
    ap.add_argument("--prompt-file", default="/tmp/forge-catgirl.txt")
    ap.add_argument("--out-en", default=os.path.join(ROOT, "output", "review_dasiwa_vs_dev_en.html"))
    ap.add_argument("--out-zh", default=os.path.join(ROOT, "output", "review_dasiwa_vs_dev_zh.html"))
    args = ap.parse_args()

    if not os.path.exists(args.runs):
        sys.exit(f"ERROR: runs log not found: {args.runs} (run sweep_dasiwa_dev.sh first)")

    prompt = ""
    if os.path.exists(args.prompt_file):
        with open(args.prompt_file) as f:
            prompt = f.read().strip()

    # Parse run log -> cells grouped by transformer (preserve sweep order)
    sets: dict[str, list[dict]] = {"dasiwa": [], "dev": []}
    with open(args.runs) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            mp4, label, transformer, steps, cfg, extra = (line.split("|") + [""] * 6)[:6]
            if transformer not in sets:
                continue
            base = os.path.splitext(mp4)[0]  # output/<ts>
            png = base + ".png"
            if not os.path.exists(png):
                # sweep used --first-frame; fall back to extracting it now
                subprocess.run(["ffmpeg", "-y", "-i", mp4, "-vframes", "1", png],
                               capture_output=True, timeout=30)
            if not os.path.exists(png):
                print(f"  ⚠️  skip {label}: no first-frame png for {mp4}", file=sys.stderr)
                continue
            sets[transformer].append({
                "label": label, "steps": steps, "cfg": cfg, "extra": extra,
                "png": png, "base": base,
            })

    total = sum(len(v) for v in sets.values())
    if total == 0:
        sys.exit("ERROR: no sweep cells found")
    print(f"Found {total} cells: dasiwa={len(sets['dasiwa'])} dev={len(sets['dev'])}")

    # Caption every cell in en + zh (skip if already present)
    for cells in sets.values():
        for c in cells:
            en_cap = c["base"] + ".caption.json"
            zh_cap = c["base"] + ".caption.zh.json"
            if not os.path.exists(en_cap):
                _caption(c["png"], "en", prompt, en_cap)
            if not os.path.exists(zh_cap):
                _caption(c["png"], "zh_TW", prompt, zh_cap)
            c["en_cap"] = en_cap if os.path.exists(en_cap) else None
            c["zh_cap"] = zh_cap if os.path.exists(zh_cap) else None

    # Build manifests + HTML for each language
    for lang, title, guide, cap_key, out_html in (
        ("en", TITLE_EN, GUIDE, "en_cap", args.out_en),
        ("zh_TW", TITLE_ZH, GUIDE_ZH, "zh_cap", args.out_zh),
    ):
        mf_sets = []
        for transformer, display in (("dasiwa", "DaSiWa (Golden Lace v3)"), ("dev", "Dev (baseline)")):
            cells = sets.get(transformer, [])
            files = [c[cap_key] for c in cells if c.get(cap_key)]
            if not files:
                continue
            variants = [{"label": _variant_label(c["steps"], c["cfg"], c["extra"])} for c in cells if c.get(cap_key)]
            mf_sets.append({"name": display, "prompt": prompt, "guide": guide,
                            "variants": variants, "files": files})
        if not mf_sets:
            print(f"  ⚠️  no captioned cells for lang={lang}, skipping", file=sys.stderr)
            continue
        manifest = {"title": title, "lang": lang, "sets": mf_sets}
        mf_path = os.path.join(ROOT, "output", f".sweep_manifest_{lang}.json")
        with open(mf_path, "w") as f:
            json.dump(manifest, f, indent=2, ensure_ascii=False)
        html = generate_review_html(manifest_path=mf_path, lang=lang, output_path=out_html)
        print(f"  📄 [{lang}] {html}")

    print("\nDone. Open output/review_dasiwa_vs_dev_{en,zh}.html in a browser.")


if __name__ == "__main__":
    main()
