#!/usr/bin/env python3
"""Verify whether the Lens LLM reasoner + token-cap enlargement actually help.

Skeptical, empirical test — assumes nothing. Does NOT trust the project VLM as
a pass/fail gate (see the vlm-caption-overpraise-qa-gap memory: qwen3-vl-4b
rates plasticky AI art 9/10). Instead it surfaces:

  Phase 1 (text, always, ~seconds, no GPU):
    - exact token count of each test prompt (rendered chat, matching the
      pipeline), and how many tokens the 512 cap truncates
    - the reasoner's actual rewritten output + its token count, so a human can
      judge whether the rewrite is good AND whether it even fits the cap better

  Phase 2 (generate, --generate, GPU, ~3 min):
    Fixed seed / resolution / steps; vary ONLY the prompt condition:
      (a) baseline  — raw prompt, cap=512   (current behavior)
      (b) enlarged  — raw prompt, cap=1024  (the "just let more through" idea)
      (c) reasoner  — refined prompt, cap=512
    Saves three side-by-side PNGs for eyeballing.

Usage (from python/mlx-movie-director):
  python/venv/bin/python scripts/test_lens_reasoner.py            # phase 1
  python/venv/bin/python scripts/test_lens_reasoner.py --generate # + GPU A/B/C
  python/venv/bin/python scripts/test_lens_reasoner.py --generate --reasoner-model qwen/qwen3-vl-4b
"""

from __future__ import annotations

import argparse
import json
import os
import sys

# Make `app.*` importable when run as a script from the package dir.
_HERE = os.path.dirname(os.path.abspath(__file__))
_PKG = os.path.dirname(_HERE)
if _PKG not in sys.path:
    sys.path.insert(0, _PKG)

from app import lens_pipeline as lp  # noqa: E402
from app import lens_reasoner  # noqa: E402

_VENV_PY = "python/venv/bin/python"  # documented in CLAUDE.md (repo-root venv)

# A short, deliberately-vague prompt — the case where a reasoner is MOST likely
# to help (it should elaborate). If it can't help here, it won't help anywhere.
_SHORT_VAGUE = "a woman in an old fancy dress"

# A well-written, gallery-style prompt (reasoner should ~preserve it).
_GALLERY_STYLE = (
    "A generous portion of classic British fish and chips served on a sheet of "
    "white paper, golden crispy beer-battered cod fillet alongside thick-cut "
    "chips, a wedge of lemon, mushy peas in a small dish, malt vinegar bottle "
    "nearby, wooden pub table, overhead shot"
)


def _load_real_prompt() -> str | None:
    """Load the actual 'bad' Lens prompt from its run.json, if present."""
    import glob
    hits = sorted(glob.glob(os.path.join(_PKG, "output",
                                         "output_20260614_195412*.run.json")))
    if not hits:
        return None
    try:
        d = json.load(open(hits[0]))
        p = d.get("prompt")
        return p if isinstance(p, str) and p.strip() else None
    except Exception:
        return None


def _tok_count(tokenizer, prompt: str) -> tuple[int, int]:
    """Return (rendered_ids, prompt_only_ids) — rendered matches the pipeline."""
    rendered = lp._render_chat(prompt)
    rendered_ids = len(tokenizer.encode(rendered, add_special_tokens=False).ids)
    prompt_ids = len(tokenizer.encode(prompt, add_special_tokens=False).ids)
    return rendered_ids, prompt_ids


def phase1_text(tokenizer, prompts: list[tuple[str, str]], reasoner_kwargs: dict) -> None:
    """Token math + reasoner output. No GPU."""
    print("=" * 78)
    print("PHASE 1 — token math + reasoner rewrite (no GPU)")
    print("=" * 78)
    print(f"Pipeline cap (_MAX_TOKENS): {lp._MAX_TOKENS} rendered ids "
          f"(includes ~97-token system preamble)\n")

    names = [name for name, _ in prompts]
    texts = [t for _, t in prompts]

    # Token math first.
    print(f"{'prompt':<16}{'chars':>7}{'tok(raw)':>10}{'rendered':>10}"
          f"{'lost@512':>10}{'%lost':>7}")
    rows = []
    for name, t in prompts:
        rendered, raw = _tok_count(tokenizer, t)
        lost = max(0, rendered - 512)
        pct = 100.0 * lost / raw if raw else 0.0
        rows.append((name, len(t), raw, rendered, lost, pct))
        print(f"{name:<16}{len(t):>7}{raw:>10}{rendered:>10}{lost:>10}{pct:>6.1f}%")
    print()

    # Reasoner rewrite.
    print(f"Reasoner endpoint: {reasoner_kwargs.get('api_url')}  "
          f"model: {reasoner_kwargs.get('model')}\n")
    refined = lens_reasoner.refine(texts, **reasoner_kwargs)

    for (name, orig), (new, err) in zip(prompts, refined):
        print("-" * 78)
        print(f"[{name}]")
        if err is not None:
            print(f"  REASONER ERROR ({err}) — using original. "
                  "Is LM Studio running on :1234?")
        new_rendered, new_raw = _tok_count(tokenizer, new) if new else (0, 0)
        delta = new_raw - _tok_count(tokenizer, orig)[1]
        print(f"  tokens: {len(orig)} chars -> refined {len(new)} chars  "
              f"(tok {delta:+d})")
        print(f"  REFINED: {new[:400]}{'…' if len(new) > 400 else ''}")
    print()

    # Verdict.
    worst = max(rows, key=lambda r: r[5])
    print("VERDICT (phase 1):")
    if worst[5] < 5.0:
        print(f"  Worst truncation is {worst[5]:.1f}% of the prompt ('{worst[0]}'). "
              "A condensing reasoner CANNOT meaningfully help — the prompt is "
              "already well within the 512 cap. The remaining quality defects "
              "are rendering-capacity (resolution/steps/model size), NOT prompt.")
    else:
        print(f"  '{worst[0]}' loses {worst[5]:.1f}% to truncation — a reasoner "
              "COULD help there. Check the rewrite quality above.")


def phase2_generate(tokenizer, prompt: str, *, width: int, height: int,
                    steps: int, seed: int, reasoner_kwargs: dict) -> None:
    """GPU A/B/C: vary ONLY the prompt condition at fixed seed/res/steps."""
    print("\n" + "=" * 78)
    print(f"PHASE 2 — generate A/B/C  ({width}x{height}, steps={steps}, "
          f"cfg=5.0, seed={seed})")
    print("=" * 78)

    out_dir = os.path.join(_PKG, "output", "lens-reasoner-ab")
    os.makedirs(out_dir, exist_ok=True)

    # Get the reasoner-refined prompt (c) once, up front.
    (refined, rerr) = lens_reasoner.refine([prompt], **reasoner_kwargs)[0]
    if rerr:
        print(f"  [reasoner unavailable: {rerr}] — condition (c) will reuse the raw prompt")
        refined = prompt

    print(f"  (a)/(b) raw prompt ({len(prompt)} chars)")
    print(f"  (c)   refined     ({len(refined)} chars)\n")

    from app.lens_pipeline import LensPipeline
    pipe = LensPipeline(num_steps=steps, cfg_scale=5.0)  # loads lazily on first gen

    conditions = [
        ("a_baseline_512", prompt, 512),
        ("b_enlarged_1024", prompt, 1024),
        ("c_reasoner_512", refined, 512),
    ]

    results = []
    for tag, cond_prompt, cap in conditions:
        print(f"--- condition {tag} (cap={cap}) ---")
        lp._MAX_TOKENS = cap  # _encode_prompt reads this module global at call time
        res = pipe.generate(prompt=cond_prompt, seed=seed, width=width, height=height)
        path = os.path.join(out_dir, f"{tag}.png")
        res.image.save(path)
        print(f"    saved {path}  ({res.timings.get('total', 0):.1f}s)\n")
        results.append((tag, path, res.timings.get("total", 0)))

    print("A/B/C images ready for eyeball comparison:")
    for tag, path, secs in results:
        print(f"  {tag:<18} {path}  ({secs:.0f}s)")
    print("\nNOTE: do NOT pass/fail these on run.py caption (over-praises). "
          "Eyeball skin/hands/background coherence directly.")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--generate", action="store_true",
                    help="Also run the GPU A/B/C generation (phase 2).")
    ap.add_argument("--width", type=int, default=832)
    ap.add_argument("--height", type=int, default=1248)
    ap.add_argument("--steps", type=int, default=50)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--reasoner-model", default=lens_reasoner._DEFAULT_MODEL)
    ap.add_argument("--reasoner-api-url", default=lens_reasoner._DEFAULT_API_URL)
    args = ap.parse_args()

    from tokenizers import Tokenizer
    tok_path = os.path.join(_PKG, "models", "text_encoder", "gpt-oss-20b", "tokenizer.json")
    tokenizer = Tokenizer.from_file(tok_path)

    real = _load_real_prompt()
    prompts = [("real_bad", real)] if real else []
    prompts += [("short_vague", _SHORT_VAGUE), ("gallery_style", _GALLERY_STYLE)]
    if real is None:
        print("(original 'bad' run.json not found; using short_vague + gallery_style)\n")

    reasoner_kwargs = {"api_url": args.reasoner_api_url,
                       "model": args.reasoner_model}

    phase1_text(tokenizer, prompts, reasoner_kwargs)

    if args.generate:
        target = real or _SHORT_VAGUE
        phase2_generate(tokenizer, target, width=args.width, height=args.height,
                        steps=args.steps, seed=args.seed,
                        reasoner_kwargs=reasoner_kwargs)


if __name__ == "__main__":
    main()
