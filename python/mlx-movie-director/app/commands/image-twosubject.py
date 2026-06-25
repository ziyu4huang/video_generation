"""image-twosubject — two characters in ONE picture via a SINGLE t2i pass, with
the LOCAL VLM (Qwen3-VL via LM Studio) doing ALL of the prompt-craft and judging.

Imported by app.commands.image via importlib (hyphen in filename prevents a
regular import statement), exactly like image-multicouple.

WHY A SINGLE PASS (not the latent-couple composite in image-multicouple): the
composite bakes two INDEPENDENTLY-generated characters — each carrying its OWN
lighting direction, scale, and pose — and then only repaints the BACKGROUND.
color-match + lock-chars unify the background *color*, but the baked-in
per-character lighting/scale stays incoherent, which no background pass can
touch: the result reads as "two photos pasted together" no matter how low the
background split measures. A SINGLE t2i pass generates both subjects inside ONE
coherent scene (one shared light source, one shared scale, one shared pose
space) — which is what makes a two-person image look natural. The price is
TOKEN BLEEDING (one subject's hair/eyes/outfit contaminating the other), and
beating that is exactly what this command's VLM loop is for:

  1. PROMPT MASTER  — the VLM looks at the two target people (two reference
     images via i2t caption, OR two text descriptions) and COMPOSES one single
     two-subject prompt engineered against bleeding: a shared scene+lighting
     prefix (so both inherit ONE light), then each subject in its OWN contiguous
     clause anchored to a clear spatial side (far left / far right), attributes
     grouped tightly so the DiT binds them to the right subject.
  2. BEST-OF-N      — generate N seeds with that one prompt (pipeline loaded
     once, serial — Apple-Silicon-safe).
  3. VLM JUDGE      — the VLM scores EVERY seed on the two-subject rubric: are
     BOTH subjects present? are they DISTINCT (no attribute bleeding)? does the
     scene read as one coherent photo? Pick the max.
  4. REVISE (opt)   — if the best score is below --min-overall AND --rounds>1,
     the VLM diagnoses the bleeding and rewrites the prompt; regenerate.
     Default --rounds 1 = pure best-of-N. Fully automatic — no human feedback.

See docs/multi-character-compose.md (the single-prompt approach) and the
multi-character-latent-couple project memory.

Public API:
  add_twosubject_args(parser) — register twosubject-specific CLI arguments
  run_twosubject(args)        — execute the VLM-driven single-prompt loop
"""

import argparse
import json
import os
import re
import sys

import requests

from app import config as cfg
from app.commands import caption as vlm

# Z-Image CFG is the single biggest quality lever (zimage-cfg-wired-biggest-
# quality-lever): ~3.0 jumps overall 4→6. Default ON; override via --cfg-scale.
_DEFAULT_CFG = 3.0
_DEFAULT_CANDIDATES = 12   # best-of-N seed count the VLM judge picks from
_DEFAULT_ROUNDS = 1        # 1 = pure best-of-N; >1 enables VLM prompt revision
_DEFAULT_MIN_OVERALL = 8.0  # judge "overall" (0-10) at/above which a round is accepted
_DEFAULT_BASE_SEED = 42
_DEFAULT_STYLE = (
    "cinematic lighting, hyperdetailed, imaginative, soft ethereal glow, "
    "painterly fantasy atmosphere"
)

# Same two dreamlike girls as the multicouple samples, for a direct A/B.
_DEFAULT_CHAR_A = (
    "a young 19-year-old girl, slim petite build, long straight raven-black hair, "
    "delicate porcelain skin, large dark eyes, soft natural makeup, wearing a "
    "flowing white summer dress with subtle silver embroidery, gentle shy smile"
)
_DEFAULT_CHAR_B = (
    "a 26-year-old woman, taller athletic curvy build, wavy auburn copper hair, "
    "warm tan skin, green eyes, elegant bold makeup, wearing a deep emerald silk gown, "
    "confident serene expression"
)

# ---------------------------------------------------------------------------
# VLM prompt templates
# ---------------------------------------------------------------------------

_PROMPT_MASTER_RULES = """\
You are a master prompt engineer for a text-to-image diffusion model (Z-Image DiT).
Goal: write ONE single text prompt that generates an image of TWO distinct people
in ONE coherent scene, with MINIMAL "token bleeding" (where one subject's hair \
color / eye color / outfit / skin contaminates the other subject).

{target_block}

Write ONE prompt that:
1. OPENS with the SHARED scene + lighting ("two women standing together in a \
dreamlike surreal fantasy scene, unified cinematic lighting from above, ..."). \
Both people MUST inherit the SAME light source and environment — this is what \
makes a two-person image read as one photo instead of a collage.
2. Describes person A in ONE contiguous clause anchored to a clear spatial side \
("The woman on the FAR LEFT: <all of A's attributes — age, build, hair, skin, \
eyes, makeup, outfit, expression>"), then a comma, then person B in another \
contiguous clause anchored to the opposite side ("the woman on the FAR RIGHT: \
<all of B's attributes>").
3. Groups EACH person's attributes tightly together and far from the other \
person's, so the model binds hair/eyes/outfit to the correct subject. NEVER \
interleave the two people's attributes.
4. Has the two face each other / share the space so they read as one scene.
5. Do NOT append style tags — they are added automatically after your prompt.

Return ONLY the prompt text (the shared scene + the two people). No preamble, no
quotes, no labels, no explanation, no trailing style tags."""

_PROMPT_MASTER_REVISE = """

The PREVIOUS attempt at this prompt produced token bleeding. Judge findings:
- bleeding (attributes that crossed over): {bleeding}
- note: {summary}
Rewrite the single two-subject prompt to FIX that specific bleeding (e.g. \
re-anchor the swapped attribute to its owner with an explicit side, or separate \
the two clauses more). Keep all the rules above. Return ONLY the prompt text."""

_JUDGE = """\
You are HARSHLY judging a text-to-image result for a TWO-PERSON prompt.

Target person A (should be on the LEFT): {desc_a}
Target person B (should be on the RIGHT): {desc_b}

Look at the image and answer as STRICT JSON only (no prose, no code fence):
{{
  "both_present": <true|false>,
  "distinct": <true|false>,
  "bleeding": ["<each attribute that crossed between the two people, or empty list>"],
  "natural": <0-10, does it read as ONE coherent photo with shared lighting/scale/scene, not two photos pasted together?>,
  "overall": <0-10, overall quality for the two-distinct-people goal>,
  "summary": "<one short sentence>"
}}

Rules:
- "distinct" is FALSE if the two people share hair color, eye color, outfit, or \
face when they should differ. Token bleeding MUST lower "distinct" and "overall".
- "natural" is LOW if the two halves have different lighting, scale, or look \
collaged.
- Be precise and critical; do not inflate scores.
Return ONLY the JSON object."""


# ---------------------------------------------------------------------------
# VLM helpers
# ---------------------------------------------------------------------------

def _vlm_text(api_url: str, model: str, prompt: str, auto_load: bool = True) -> str:
    """Text-only VLM call (no image) — symmetric to caption._call_vlm minus the image.

    Used by the prompt-master when no reference images are supplied (pure
    text-description composition). Reuses caption's model-load + think-strip
    machinery so the local VLM stays the prompt master even without images.
    """
    url = f"{api_url}/chat/completions"
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": 2048,
        "temperature": 0.3,
        "stream": False,
    }

    def _do_request():
        resp = requests.post(url, json=payload, timeout=vlm._VLM_REQUEST_TIMEOUT)
        resp.raise_for_status()
        return resp.json()

    if auto_load:
        vlm._lmstudio_ensure_model(api_url, model)
    try:
        data = _do_request()
    except (requests.ConnectionError, requests.HTTPError) as first_err:
        if vlm._lmstudio_ensure_model(api_url, model):
            data = _do_request()
        else:
            raise first_err
    try:
        content = data["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as e:
        raise RuntimeError(f"VLM text response malformed ({type(e).__name__}: {e})") from e
    return re.sub(r"<think.*?</think\s*>", "", content, flags=re.DOTALL).strip()


def _resolve_refs(desc_a, desc_b, ref_a, ref_b, api_url, model, auto_load=True):
    """Caption any supplied reference images to (re)derive appearance descriptions.

    Returns (desc_a, desc_b, b64_a|None, b64_b|None). If a ref image is given,
    its i2t caption overrides the text description for that subject (the user's
    "take two images, use i2t caption to refine prompts" path). b64 images are
    passed back so the prompt-master can SEE the two targets, not just read text.
    """
    b64_a = b64_b = None
    if ref_a:
        if not os.path.isfile(ref_a):
            raise FileNotFoundError(f"--ref-a not found: {ref_a}")
        desc_a = vlm.caption_image(ref_a, style="t2i", lang="en",
                                   api_url=api_url, model=model, auto_load=auto_load)
        b64_a = vlm._image_to_base64(ref_a)
        print(f"[prompt-master] captioned ref A: {desc_a[:120]}…", flush=True)
    if ref_b:
        if not os.path.isfile(ref_b):
            raise FileNotFoundError(f"--ref-b not found: {ref_b}")
        desc_b = vlm.caption_image(ref_b, style="t2i", lang="en",
                                   api_url=api_url, model=model, auto_load=auto_load)
        b64_b = vlm._image_to_base64(ref_b)
        print(f"[prompt-master] captioned ref B: {desc_b[:120]}…", flush=True)
    return desc_a, desc_b, b64_a, b64_b


def compose_two_subject_prompt(api_url: str, model: str, desc_a: str, desc_b: str,
                               style: str, b64_a=None, b64_b=None,
                               failure=None, auto_load: bool = True) -> str:
    """The VLM prompt-master: compose ONE anti-bleeding two-subject t2i prompt.

    If both reference images are supplied, the VLM SEES them (_call_vlm_multi);
    otherwise it composes from the two text descriptions (_vlm_text). An optional
    `failure` dict ({bleeding, summary}) from a prior round triggers a revision.
    Returns the composed prompt text (stripped, single string).
    """
    target_block = (
        f"Person A (place on the FAR LEFT): {desc_a}\n"
        f"Person B (place on the FAR RIGHT): {desc_b}"
    )
    instruction = _PROMPT_MASTER_RULES.format(target_block=target_block, style=style)
    if failure:
        instruction += _PROMPT_MASTER_REVISE.format(
            bleeding=", ".join(failure.get("bleeding") or []) or "(none diagnosed)",
            summary=(failure.get("summary") or "").strip() or "(none)",
        )

    if b64_a and b64_b:
        # The VLM sees both reference images AND the textual targets.
        return vlm._call_vlm_multi(api_url, model, [b64_a, b64_b], instruction,
                                   auto_load=auto_load)
    return _vlm_text(api_url, model, instruction, auto_load=auto_load)


def judge_two_subject(api_url: str, model: str, image_path: str,
                      desc_a: str, desc_b: str, auto_load: bool = True) -> dict:
    """Score one generated seed on the two-subject rubric via the local VLM.

    Returns a dict {both_present, distinct, bleeding, natural, overall, summary}.
    Tolerates code-fences / prose wrapping (reuses caption._parse_score_dict).
    On total parse failure returns {"overall": None, ...} so the caller can skip.
    """
    prompt = _JUDGE.format(desc_a=desc_a, desc_b=desc_b)
    b64 = vlm._image_to_base64(image_path)
    raw = vlm._call_vlm(api_url, model, b64, prompt, auto_load=auto_load)
    parsed = vlm._parse_score_dict(raw)
    if not parsed:
        return {"overall": None, "natural": None, "distinct": None,
                "both_present": None, "bleeding": [], "summary": raw[:200],
                "unparsed": True}
    # Coerce numeric fields so selection can compare cleanly.
    for k in ("natural", "overall"):
        if k in parsed and parsed[k] is not None:
            try:
                parsed[k] = float(parsed[k])
            except (TypeError, ValueError):
                parsed[k] = None
    parsed.setdefault("bleeding", [])
    parsed.setdefault("summary", "")
    return parsed


def _bg_edge_split(image_path: str) -> float:
    """Objective background color-temperature split: |warm(R-B)_right − warm(R-B)_left|
    over the outer 8 % edge strips. 0 = perfectly unified; larger = a stronger
    left/right color-temperature gradient. Cheap numpy (no VLM). Used as the final
    selection tiebreak so that, among equally-natural/distinct seeds, the loop
    prefers the one whose background reads as one tone rather than two worlds.
    """
    import numpy as np
    from PIL import Image

    im = np.asarray(Image.open(image_path).convert("RGB"), dtype="float32")
    _, w, _ = im.shape
    ew = max(1, int(w * 0.08))
    warm = lambda region: float((region[..., 0] - region[..., 2]).mean())
    return abs(warm(im[:, w - ew:]) - warm(im[:, :ew]))


def pick_best(scored: list) -> "dict | None":
    """Select the best-scored candidate. Pure function (CPU-testable).

    Ranks by overall, tie-broken by natural, then distinct (True > False), then by
    the LOWEST background edge-split (most unified background). The split tiebreak
    is what makes the loop prefer a "natural AND unified" seed over an
    equally-scored one with a strong left/right color gradient. Candidates with
    overall=None (unparseable judge output) are excluded. Returns None if none scored.
    """
    valid = [s for s in scored if s and s.get("overall") is not None]
    if not valid:
        return None
    return max(valid, key=lambda s: (
        s.get("overall") or 0.0,
        s.get("natural") or 0.0,
        1 if s.get("distinct") else 0,
        # Lower |split| is better → negate so max() prefers it. Unmeasured (None)
        # candidates lose ties to any measured one.
        -(abs(s["bg_edge_split"]) if s.get("bg_edge_split") is not None else 1e9),
    ))


def _resolve_geometry(args: argparse.Namespace) -> tuple:
    """Resolve (width, height, steps). Pure, CPU-testable.

    Explicit CLI values win; otherwise the ``--detail`` preset (768x1152 / 20)
    applies when set, else the fast default (640x960 / 9). The detail preset is
    the quality target validated against the single-subject benchmark: at
    768x1152/20 the two-subject output's per-face detail reads as a real photo
    (validated 2026-06-25 — user picked the 768x1152/20 seed). It costs ~137s
    per image (~4x the fast default), so it stays opt-in.
    """
    detail = bool(getattr(args, "detail", False))
    width = getattr(args, "width", None) or (768 if detail else 640)
    height = getattr(args, "height", None) or (1152 if detail else 960)
    steps = getattr(args, "steps", None) or (20 if detail else 9)
    return width, height, steps


# ---------------------------------------------------------------------------
# Pipeline
# ---------------------------------------------------------------------------

def _resolve_pipeline(args: argparse.Namespace):
    """Build a ZImagePipeline, resolving the transformer dir from --transformer."""
    from app.pipeline import ZImagePipeline

    transformer = getattr(args, "transformer", None)
    if transformer:
        t_dir = os.path.join(cfg.MODELS_DIR, "transformer", transformer)
        if not os.path.isdir(t_dir):
            raise FileNotFoundError(f"Transformer '{transformer}' not found at {t_dir}")
        print(f"[Pipeline] Using transformer: {transformer}", flush=True)
        return ZImagePipeline(transformer_dir=t_dir), transformer
    return ZImagePipeline(), None


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def add_twosubject_args(parser: argparse.ArgumentParser) -> None:
    """Register twosubject-specific arguments.

    Shares --transformer/--width/--height/--steps/--cfg-scale/--seed/--seed-start/
    --json-summary (from t2i + common args), --style (from multicouple), and
    --vlm-api-url/--vlm-model (from profile). Only the twosubject knobs live here.
    """
    parser.add_argument(
        "--char-a", default=None, metavar="TEXT",
        help="Character A appearance description (left of frame). Overridden by "
             "--ref-a's i2t caption when an image is supplied.",
    )
    parser.add_argument(
        "--char-b", default=None, metavar="TEXT",
        help="Character B appearance description (right of frame). Overridden by "
             "--ref-b's i2t caption when an image is supplied.",
    )
    parser.add_argument(
        "--ref-a", default=None, metavar="IMAGE",
        help="Optional reference image for character A. The local VLM captions it "
             "(i2t, --style t2i) to refine the appearance, AND sees it while "
             "composing the prompt.",
    )
    parser.add_argument(
        "--ref-b", default=None, metavar="IMAGE",
        help="Optional reference image for character B (see --ref-a).",
    )
    parser.add_argument(
        "--candidates", type=int, default=_DEFAULT_CANDIDATES, metavar="N",
        help=f"Best-of-N seed count the VLM judge picks from (default {_DEFAULT_CANDIDATES}). "
             "The pipeline loads once and generates N seeds serially.",
    )
    parser.add_argument(
        "--rounds", type=int, default=_DEFAULT_ROUNDS, metavar="N",
        help="Loop rounds. 1 (default) = pure best-of-N. >1 enables VLM prompt "
             "revision: if the best score is below --min-overall, the VLM "
             "diagnoses the bleeding and rewrites the prompt, then regenerates.",
    )
    parser.add_argument(
        "--min-overall", type=float, default=_DEFAULT_MIN_OVERALL, metavar="0..10",
        help="Accept a round (and stop early) once the best judge 'overall' is at "
             f"or above this (default {_DEFAULT_MIN_OVERALL}). Only matters with "
             "--rounds>1.",
    )
    parser.add_argument(
        "--detail", action="store_true",
        help="High-detail mode: generate at 768x1152 / 20 steps (vs the 640x960 / 9 "
             "fast default). ~4x slower per image (~137s vs ~35s) but materially more "
             "facial/fabric/hair detail — the quality target validated against the "
             "single-subject benchmark (2026-06-25). A 12-candidate loop at --detail "
             "runs ~25-30 min. Explicit --width/--height/--steps still override.",
    )


def run_twosubject(args: argparse.Namespace) -> None:
    """Execute the VLM-driven single-prompt two-subject loop. Called by image.py."""
    from PIL import Image as PILImage

    width, height, steps = _resolve_geometry(args)
    cfg_scale = getattr(args, "cfg_scale", None)
    if cfg_scale is None:
        cfg_scale = _DEFAULT_CFG
    style = getattr(args, "style", None) or _DEFAULT_STYLE

    desc_a = getattr(args, "char_a", None) or _DEFAULT_CHAR_A
    desc_b = getattr(args, "char_b", None) or _DEFAULT_CHAR_B
    ref_a = getattr(args, "ref_a", None)
    ref_b = getattr(args, "ref_b", None)
    candidates = max(1, getattr(args, "candidates", None) or _DEFAULT_CANDIDATES)
    rounds = max(1, int(getattr(args, "rounds", None) or _DEFAULT_ROUNDS))
    min_overall = getattr(args, "min_overall", None) or _DEFAULT_MIN_OVERALL
    json_summary = bool(getattr(args, "json_summary", False))

    api_url = getattr(args, "vlm_api_url", None) or vlm._DEFAULT_API_URL
    model = getattr(args, "vlm_model", None) or vlm._DEFAULT_MODEL

    base_seed = getattr(args, "seed_start", None)
    if base_seed is None:
        base_seed = getattr(args, "seed", None) or _DEFAULT_BASE_SEED

    # ── Phase 0: refine descriptions from reference images (i2t caption) ──────
    print("\n=== Phase 0: VLM prompt-master prep (refine appearances) ===")
    desc_a, desc_b, b64_a, b64_b = _resolve_refs(
        desc_a, desc_b, ref_a, ref_b, api_url, model)

    pipeline, transformer_name = _resolve_pipeline(args)

    best = None       # {path, seed, scores, prompt, round}
    history = []
    failure = None

    for r in range(rounds):
        # ── Phase 1: VLM composes ONE anti-bleeding two-subject prompt ────────
        label = "compose" if failure is None else "revise (fix bleeding)"
        print(f"\n=== Round {r + 1}/{rounds}: VLM prompt-master [{label}] ===")
        composed = compose_two_subject_prompt(
            api_url, model, desc_a, desc_b, style,
            b64_a=b64_a, b64_b=b64_b, failure=failure)
        full_prompt = f"{composed}, {style}" if style else composed
        print(f"[prompt] {full_prompt}\n", flush=True)

        # ── Phase 2: best-of-N (pipeline loaded once, serial) ─────────────────
        seeds = [base_seed + i for i in range(candidates)]
        round_candidates = []
        for i, seed in enumerate(seeds):
            print(f"  candidate {i + 1}/{candidates} (seed={seed})…", flush=True)
            res = pipeline.generate(
                prompt=full_prompt, width=width, height=height, steps=steps,
                seed=seed, cfg_scale=cfg_scale,
            )
            cand_path = os.path.join(cfg.OUTPUT_DIR, f"twosubject_r{r + 1}_s{seed}.png")
            res.image.save(cand_path)

            # ── Phase 3: VLM judges this seed ─────────────────────────────────
            scores = judge_two_subject(api_url, model, cand_path, desc_a, desc_b)
            scores["path"] = cand_path
            scores["seed"] = seed
            scores["bg_edge_split"] = _bg_edge_split(cand_path)
            round_candidates.append(scores)
            print(f"    overall={scores.get('overall')} "
                  f"distinct={scores.get('distinct')} "
                  f"natural={scores.get('natural')} "
                  f"split={scores.get('bg_edge_split')} "
                  f"bleed={scores.get('bleeding')}", flush=True)

        round_best = pick_best(round_candidates)
        history.append({
            "round": r + 1,
            "prompt": full_prompt,
            "best_seed": round_best.get("seed") if round_best else None,
            "best_overall": round_best.get("overall") if round_best else None,
            "candidates": [
                {k: v for k, v in s.items() if k != "path"} or {"seed": s.get("seed")}
                for s in round_candidates
            ],
            "candidate_paths": [s["path"] for s in round_candidates],
        })

        if round_best and (
            best is None
            or (round_best.get("overall") or 0) > (best["scores"].get("overall") or 0)
        ):
            best = {"path": round_best["path"], "seed": round_best["seed"],
                    "scores": round_best, "prompt": full_prompt, "round": r + 1}

        best_overall = best["scores"].get("overall") if best else None
        if best_overall is not None and best_overall >= min_overall:
            print(f"\n[accept] best overall {best_overall} >= {min_overall} — stopping early.")
            break

        # Below threshold + rounds remain → feed the failure back for revision.
        if r + 1 < rounds:
            src = round_best or best
            failure = {
                "bleeding": (src.get("bleeding") if src else []) or [],
                "summary": (src.get("summary") if src else "") or "",
            }
            print(f"\n[revise] best overall {best_overall} < {min_overall} — "
                  f"VLM will rewrite the prompt for round {r + 2}.")

    if best is None:
        print("ERROR [twosubject]: no candidate produced a parseable score.",
              file=sys.stderr)
        sys.exit(1)

    # ── Winner + manifest ─────────────────────────────────────────────────────
    winner_path = os.path.join(cfg.OUTPUT_DIR, "twosubject_best.png")
    PILImage.open(best["path"]).save(winner_path)
    manifest = {
        "winner": winner_path,
        "winner_seed": best["seed"],
        "winner_round": best["round"],
        "winner_overall": best["scores"].get("overall"),
        "winner_distinct": best["scores"].get("distinct"),
        "winner_natural": best["scores"].get("natural"),
        "winner_bleeding": best["scores"].get("bleeding"),
        "composed_prompt": best["prompt"],
        "threshold": min_overall,
        "vlm_model": model,
        "candidates_per_round": candidates,
        "rounds_requested": rounds,
        "rounds_run": len(history),
        "history": history,
    }
    manifest_path = os.path.join(cfg.OUTPUT_DIR, "twosubject_manifest.json")
    with open(manifest_path, "w") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)

    s = best["scores"]
    print(f"\n=== WINNER: round {best['round']} seed {best['seed']} "
          f"(overall={s.get('overall')}, distinct={s.get('distinct')}, "
          f"natural={s.get('natural')}) ===")
    print(f"Saved winner: {winner_path}")
    print(f"Manifest:     {manifest_path}")
    if json_summary:
        print(json.dumps({
            "final": winner_path,
            "winner_seed": best["seed"],
            "overall": s.get("overall"),
            "distinct": s.get("distinct"),
            "natural": s.get("natural"),
        }, ensure_ascii=False))
