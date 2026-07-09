"""story — storyline creation: angles → propose → shots (OM storyline gap).

OpenMontage opens every image-heavy pipeline (animated-explainer / animation /
cinematic) with a **research → proposal → approval** stage; MLX previously only
decomposed a *given* prompt (``image storyboard``). This top-level command fills
the upstream gap — from a bare TOPIC, the local gemma brain emits differentiated
creative ANGLES and an OM-shaped PROPOSAL_PACKET (concept options for an approval
gate), then ``story shots`` hands the approved concept to the EXISTING storyboard
decompose→generate path.

Sub-actions:
  story angles --topic <t> [--count N]
      gemma emits N differentiated angles from a topic (Story2Board mechanism,
      arXiv 2508.09983). Writes <base>.angles.json + prints an `Angles:` sentinel.
  story propose --topic <t> [--count N]
      gemma emits an OM-shaped proposal_packet (concept options: title, angle,
      scene_list, visual_language, est_shot_count, cost). Writes
      <base>.proposal.yaml + prints a `Proposal:` sentinel.
  story shots --proposal <yaml> [--concept-index N] [--character <hero>]
      folds the chosen concept into a narrative + style hint and delegates to the
      EXISTING `image storyboard` path (subprocess → certified decompose→generate).

LOCAL ONLY:
  - brain = local gemma on LM Studio, never a cloud LLM (constraint 2). Every
    gemma call uses ``reasoning_effort:"none"`` (the ~9s fast non-thinking path,
    [[lmstudio-reasoning-effort-none-gemma-knob]]).
  - generation stays on run.py / MLX (constraint 1); the storyboard child is a
    local ``run.py image storyboard`` subprocess, never a cloud GAI API.

The pure prompt builders + parsers live in ``app.planning.story_angles`` (the
pytest target). This module is the IO + dispatch shell.

Public API:
  add_args(parser)   — register the story sub-action args
  run(args)          — dispatch angles / propose / shots
"""
import argparse
import os
import sys
import time

from app import config as cfg
from app.planning import story_angles

# ---------------------------------------------------------------------------
# Default gemma call budget (mirrors gemma_brain: reasoning_effort:"none" fast path).
# ---------------------------------------------------------------------------
_FAST_MAX_TOKENS = 2048
_SAFETY_MAX_TOKENS = 14000
_DEFAULT_API_URL = "http://localhost:1234/v1"


# ---------------------------------------------------------------------------
# PARSER_META + arg registration
# ---------------------------------------------------------------------------

PARSER_META = {
    "help": "Storyline creation: angles / propose / shots (research → proposal → storyboard)",
    "description": (
        "Storyline creation from a topic — OM's research→proposal→approval stage.\n"
        "Fills the gap upstream of `image storyboard` (which only decomposes a\n"
        "given prompt). Brain = local gemma (reasoning_effort:none, ~9s).\n\n"
        "Sub-actions (first positional):\n"
        "  angles  — N differentiated creative angles from a topic\n"
        "  propose — an OM-shaped proposal_packet (concept options for approval)\n"
        "  shots   — fold an approved concept → the existing `image storyboard`\n\n"
        "Examples:\n"
        "  run.py story angles --topic 'a barista's first day' --count 3\n"
        "  run.py story propose --topic 'renewable energy for kids' --count 2\n"
        "  run.py story shots --proposal output/<base>.proposal.yaml --concept-index 0\n"
        "  run.py story shots --proposal <yaml> --character output/hero.png\n"
    ),
}


def add_args(parser: "argparse.ArgumentParser") -> None:
    parser.add_argument(
        "sub_action", nargs="?", default="angles",
        metavar="SUB_ACTION",
        help="angles (default) | propose | shots",
    )
    # --- angles / propose inputs ---
    parser.add_argument(
        "--topic", type=str, default=None,
        help="The subject/theme to brainstorm (angles/propose). Required for those.",
    )
    parser.add_argument(
        "--count", type=int, default=None,
        help="angles: how many angles (default 3). propose: how many concept "
             "options (default 2).",
    )
    # --- shots inputs ---
    parser.add_argument(
        "--proposal", type=str, default=None,
        help="shots: path to a proposal_packet YAML/JSON (the `propose` output).",
    )
    parser.add_argument(
        "--concept-index", type=int, default=0, dest="concept_index",
        help="shots: which concept option in the proposal to storyboard (default 0).",
    )
    parser.add_argument(
        "--character", type=str, default=None,
        help="shots: hero image path passed to `image storyboard --character` "
             "(locks recurring-character identity across frames).",
    )
    parser.add_argument(
        "--judge", action="store_true", default=False,
        help="shots: pass --judge to `image storyboard` (per-frame VLM score).",
    )
    # --- shared brain config (reused by storyboard delegation) ---
    parser.add_argument(
        "--vlm-api-url", type=str, default=_DEFAULT_API_URL, dest="vlm_api_url",
        help="LM Studio OpenAI-compatible base URL (default localhost:1234/v1).",
    )
    parser.add_argument(
        "--vlm-model", type=str, default=None, dest="vlm_model",
        help="Explicit brain model id; None → gemma brain resolver.",
    )
    # common args the storyboard child needs (steps/seed/width/height/pipeline)
    from app.commands._shared import _arg_registered
    if not _arg_registered(parser, "steps"):
        parser.add_argument("--steps", type=int, default=None,
                            help="Storyboard per-shot steps (default: storyboard's).")
    if not _arg_registered(parser, "seed"):
        parser.add_argument("--seed", type=int, default=777, help="Base seed.")
    if not _arg_registered(parser, "self_test"):
        parser.add_argument("--self-test", action="store_true", default=False,
                            dest="self_test", help="Run the command self-test.")


# ---------------------------------------------------------------------------
# gemma brain call (reasoning_effort:"none" fast path, mirrors gemma_brain)
# ---------------------------------------------------------------------------

def _gemma_json_call(prompt: str, parser_fn, *, api_url: str, model: str | None,
                     timeout: int = 600):
    """Send ``prompt`` to the local gemma brain, parse the JSON array via ``parser_fn``.

    Fast path first (reasoning_effort:"none", small budget — ~9s on gemma-4-26b);
    safety-net retry at a large budget without the knob if the fast path yielded
    no parseable JSON. Returns whatever ``parser_fn`` extracts. LOCAL ONLY.
    """
    import requests
    from app.commands.caption import _lmstudio_ensure_model, resolve_default_model

    resolved = model or resolve_default_model(api_url)
    try:
        _lmstudio_ensure_model(api_url, resolved)
    except Exception as e:  # noqa: BLE001 — ensure is best-effort
        print(f"[story] model-ensure warning ({type(e).__name__}: {e}); trying anyway.",
              file=sys.stderr)

    url = f"{api_url}/chat/completions"
    attempts = [(_FAST_MAX_TOKENS, "none"), (_SAFETY_MAX_TOKENS, None)]
    last_err: Exception | None = None
    for attempt, (max_tokens, reasoning_effort) in enumerate(attempts):
        payload = {
            "model": resolved,
            "messages": [{"role": "user", "content": prompt}],
            "max_tokens": max_tokens,
            "temperature": 0.3,
            "stream": False,
        }
        if reasoning_effort is not None:
            payload["reasoning_effort"] = reasoning_effort
        resp = requests.post(url, json=payload, timeout=timeout)
        resp.raise_for_status()
        data = resp.json()
        try:
            content = data["choices"][0]["message"].get("content") or ""
        except (KeyError, IndexError, TypeError) as e:
            raise RuntimeError(
                f"gemma call: response missing OpenAI chat shape "
                f"({type(e).__name__}: {e}); raw excerpt: {str(data)[:300]}"
            ) from e
        reasoning = data["choices"][0]["message"].get("reasoning_content")
        try:
            return parser_fn(content)
        except ValueError:
            if reasoning and attempt < len(attempts) - 1:
                try:
                    return parser_fn(reasoning)
                except ValueError:
                    pass
            last_err = ValueError(f"no JSON at budget {max_tokens}; retrying")
            continue
    raise last_err or ValueError("gemma call produced no parseable JSON array")


# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------

def _write_out(suffix: str, ext: str, content: str) -> str:
    """Write ``content`` to <output>/<base>_<suffix><ext>, return the path."""
    os.makedirs(cfg.OUTPUT_DIR, exist_ok=True)
    base = f"story_{time.strftime('%Y%m%d_%H%M%S')}"
    path = os.path.join(cfg.OUTPUT_DIR, f"{base}_{suffix}{ext}")
    with open(path, "w") as f:
        f.write(content)
    return path


# ---------------------------------------------------------------------------
# Sub-action runners
# ---------------------------------------------------------------------------

def run_angles(args: "argparse.Namespace") -> None:
    topic = (getattr(args, "topic", None) or "").strip()
    if not topic:
        print("ERROR: --topic is required for `story angles`.", file=sys.stderr)
        sys.exit(1)
    count = getattr(args, "count", None) or 3
    prompt = story_angles.build_angles_prompt(topic, count=count)
    print(f"[story:angles] topic={topic!r} count={count}  → local gemma...",
          flush=True)
    angles = _gemma_json_call(prompt, story_angles.parse_angles,
                              api_url=args.vlm_api_url, model=args.vlm_model)
    # Defend the count contract (trust the model, but clamp).
    if isinstance(angles, list) and len(angles) > count:
        angles = angles[:count]
    import json as _json
    path = _write_out("angles", ".json", _json.dumps(angles, indent=2, ensure_ascii=False))
    print(f"[story:angles] {len(angles)} angle(s):")
    for i, a in enumerate(angles):
        print(f"  {i}: {a.get('angle', '?')} — {a.get('logline', '')}")
    print(f"Angles:    {path}")


def run_propose(args: "argparse.Namespace") -> None:
    topic = (getattr(args, "topic", None) or "").strip()
    if not topic:
        print("ERROR: --topic is required for `story propose`.", file=sys.stderr)
        sys.exit(1)
    count = getattr(args, "count", None) or 2
    prompt = story_angles.build_propose_prompt(topic, count=count)
    print(f"[story:propose] topic={topic!r} concepts={count}  → local gemma...",
          flush=True)
    packet = _gemma_json_call(prompt, story_angles.parse_proposal,
                              api_url=args.vlm_api_url, model=args.vlm_model)
    if isinstance(packet, list) and len(packet) > count:
        packet = packet[:count]
    yaml_str = story_angles.proposal_to_yaml(packet)
    path = _write_out("proposal", ".yaml", yaml_str)
    print(f"[story:propose] {len(packet)} concept option(s):")
    for i, c in enumerate(packet):
        print(f"  [{i}] {c.get('title', '?')} "
              f"(angle: {c.get('angle', '?')}, "
              f"shots: {c.get('est_shot_count', '?')}, "
              f"cost: {c.get('estimated_cost', '?')})")
    print(f"Proposal:  {path}")


def run_shots(args: "argparse.Namespace") -> None:
    """Delegate an approved proposal concept to the EXISTING `image storyboard`.

    Loads the proposal, folds the chosen concept into (story, style_hint,
    num_panels), then runs `run.py image storyboard --story ...` as a subprocess
    (the certified decompose→generate path, with its own GPU lock). LOCAL ONLY.
    """
    import json as _json
    import subprocess

    from app.commands._shared import build_run_py_cmd

    proposal_path = getattr(args, "proposal", None)
    if not proposal_path:
        print("ERROR: --proposal <yaml/json> is required for `story shots`.",
              file=sys.stderr)
        sys.exit(1)
    if not os.path.exists(proposal_path):
        print(f"ERROR: proposal not found: {proposal_path}", file=sys.stderr)
        sys.exit(1)

    # Load YAML or JSON (YAML is a JSON superset; try json first, then yaml).
    raw = open(proposal_path).read()
    packet = None
    try:
        packet = _json.loads(raw)
    except _json.JSONDecodeError:
        try:
            import yaml  # type: ignore[import-untyped]
            packet = yaml.safe_load(raw)
        except ImportError:
            pass
    if isinstance(packet, dict):
        packet = [packet]
    if not isinstance(packet, list) or not packet:
        print(f"ERROR: proposal has no concept options: {proposal_path}",
              file=sys.stderr)
        sys.exit(1)

    idx = getattr(args, "concept_index", 0) or 0
    if idx < 0 or idx >= len(packet):
        print(f"ERROR: --concept-index {idx} out of range (0..{len(packet) - 1}).",
              file=sys.stderr)
        sys.exit(1)
    concept = packet[idx]
    story, style_hint, num_panels = story_angles.concept_to_story(concept)
    print(f"[story:shots] concept [{idx}] {concept.get('title', '?')}", flush=True)
    print(f"[story:shots] {num_panels} panels, style='{style_hint or '(none)'}'",
          flush=True)
    print(f"[story:shots] story:\n{story}\n", flush=True)

    # Delegate to the certified storyboard path. force=None (default) so the
    # GPU-heavy child acquires its OWN lock (story.py itself is not GPU-heavy).
    cmd = build_run_py_cmd(
        "image", "storyboard",
        "--story", story,
        "--num-panels", str(num_panels),
        "--vlm-api-url", args.vlm_api_url,
    )
    if style_hint:
        cmd += ["--style-hint", style_hint]
    if getattr(args, "vlm_model", None):
        cmd += ["--vlm-model", args.vlm_model]
    if getattr(args, "character", None):
        cmd += ["--character", args.character]
    if getattr(args, "judge", False):
        cmd += ["--judge"]
    if getattr(args, "steps", None) is not None:
        cmd += ["--steps", str(args.steps)]
    # Forward the output-dir override so storyboard frames land where the caller
    # asked (run.py applies --gen-output-dir to cfg.OUTPUT_DIR before dispatch).
    if getattr(args, "gen_output_dir", None):
        cmd += ["--gen-output-dir", args.gen_output_dir]

    print(f"[story:shots] → {' '.join(cmd[:6])} ...", flush=True)
    result = subprocess.run(cmd)
    if result.returncode != 0:
        print(f"[story:shots] storyboard child exited {result.returncode}.",
              file=sys.stderr)
        sys.exit(result.returncode)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def run(args: "argparse.Namespace") -> None:
    sub = getattr(args, "sub_action", None) or "angles"
    if sub == "angles":
        run_angles(args)
    elif sub == "propose":
        run_propose(args)
    elif sub == "shots":
        run_shots(args)
    else:
        print(f"ERROR: unknown story sub-action '{sub}'. "
              f"Use: angles | propose | shots", file=sys.stderr)
        sys.exit(1)
