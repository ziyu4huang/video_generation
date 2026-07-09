"""image-kontext — true in-context character-locked re-render (OM capability E).

OpenMontage's #1 challenge is "identity anchored verbatim across shots" — the
same character rendered in different scenes without drift. Until now the repo's
only tool was a SOFT lock: seed + Flux2KleinEdit ``--ref-count`` reference
conditioning (``image character`` IdentitySpec + ``image storyboard
--character``), which is approximate — it nudges identity via the input latent,
it is not a true identity embedding.

mflux (the vendored fork at ``../mflux``, v0.17.5+) now ships ``dev-kontext``
natively (``FLUX.1-Kontext-dev``, ``black-forest-labs/FLUX.1-Kontext-dev``,
512 timesteps, supports guidance + LoRA) — confirmed present at
``../mflux/src/mflux/models/flux/variants/kontext/``. This OVERURNS the prior
"no MLX Kontext port → feasibility spike only" assumption (see memory
[[mflux-dev-kontext-native-support]]). Kontext concatenates the conditioning
image's latents with the generation latents and feeds both through the
transformer with distinct image IDs — a true in-context render of the SAME
identity, not a latent nudge.

This command wraps ``Flux1Kontext.generate_image(image_path=<hero>, prompt=...)``
so a later shot is an in-context re-render of the hero. Feed it the
``image character`` IdentitySpec's hero as ``--input``:

  run.py image character --input photo.png        # → hero.png + IdentitySpec.json
  run.py image kontext --input hero.png --prompt "<same person>, now a knight in plate armor"

This SUPERSEDES the soft ref-conditioning lock for capability E.

CONSTRAINTS:
  - LOCAL ONLY (constraint 1): the model auto-downloads from the HF hub into the
    mflux HF cache on first run. ``FLUX.1-Kontext-dev`` is a GATED repo — the
    first run needs ``HF_TOKEN`` set + the license accepted at
    https://huggingface.co/black-forest-labs/FLUX.1-Kontext-dev. A clear error
    is surfaced if the download is unauthorized (the goal's "document honestly"
    branch). No cloud GAI API is involved — the download is a one-time weight
    fetch, generation is local MLX.
  - ``--pipeline`` is IGNORED (Kontext is its own model family, not zimage /
    flux2-klein / lens). This is by design — there is no other Kontext backend.

Imported by app.commands.image via importlib (hyphen in filename).

Public API:
  build_incontext_scenes(base, count) — pure scene-prompt builder (pytest target)
  add_kontext_args(p)                — register kontext-specific CLI arguments
  run_kontext(args)                  — execute in-context generation
"""
import argparse
import os
import sys

from app import config as cfg

# ---------------------------------------------------------------------------
# mflux Kontext model id (mirrors ModelConfig.dev_kontext().model_name). Kept as
# a constant so the manifest fingerprint + error messages name it consistently
# without importing mflux at module load (heavy — pulls mlx/transformers).
# ---------------------------------------------------------------------------
KONTEXT_MODEL_ID = "black-forest-labs/FLUX.1-Kontext-dev"

# mflux's own Kontext guidance default (cli/defaults.py: GUIDANCE_SCALE_KONTEXT).
DEFAULT_KONTEXT_GUIDANCE = 2.5

# Kontext-dev is a FULL (non-distilled) 1000-step model — unlike Flux2 Klein
# (4 steps) it needs a real step budget. 20 is a safe speed/quality default.
DEFAULT_KONTEXT_STEPS = 20


# ---------------------------------------------------------------------------
# Pure scene-prompt builder (the pytest target — no model / mflux import)
# ---------------------------------------------------------------------------

# Distinguished scene contexts for the identity-certify self-test. Each is a
# dramatic change of setting/outfit so a same-identity VLM judge has signal. The
# leading "<SUBJECT>" token is replaced with the hero's described subject so
# every scene refers to the SAME person.
_DEFAULT_SCENE_TEMPLATES: list[str] = [
    "<SUBJECT> standing in a sunlit forest clearing, dappled light, medium shot",
    "<SUBJECT> as a medieval knight in polished plate armor, castle courtyard, wide shot",
    "<SUBJECT> in a futuristic neon city at night, rain-slick streets, cinematic",
    "<SUBJECT> on a snowy mountain peak at dawn, mountaineering gear, heroic angle",
    "<SUBJECT> in a cozy library reading by a fireplace, warm amber light, seated",
    "<SUBJECT> on a tropical beach at golden hour, casual linen clothes, full body",
]


def build_incontext_scenes(base: str | None, count: int = 3,
                           templates: list[str] | None = None) -> list[str]:
    """Build ``count`` differentiated in-context scene prompts for one subject.

    Each scene describes the SAME subject (``base``) in a different setting so a
    true in-context Kontext render keeps the identity while the prompt drives the
    scene. ``base`` is spliced into each template's ``<SUBJECT>`` token; a bare
    template with no token is appended (", <base>") so the subject is still named.

    Args:
      base:      the subject description (e.g. "a woman with short red hair and
                 freckles"). May be empty — then templates are returned as-is
                 (the caller supplied self-contained prompts).
      count:     number of scenes to return (clamped to >=1).
      templates: override the default scene templates (testing / customization).

    Returns: ``count`` prompt strings, each a self-contained in-context render
    instruction referring to ``base``.
    """
    pool = templates if templates is not None else _DEFAULT_SCENE_TEMPLATES
    n = max(1, int(count))
    base = (base or "").strip()

    out: list[str] = []
    for i in range(n):
        tmpl = pool[i % len(pool)]
        if "<SUBJECT>" in tmpl:
            out.append(tmpl.replace("<SUBJECT>", base) if base else tmpl.replace("<SUBJECT>, ", "").replace("<SUBJECT>", ""))
        elif base:
            out.append(f"{tmpl}, {base}")
        else:
            out.append(tmpl)
    return out


# ---------------------------------------------------------------------------
# CLI argument registration
# ---------------------------------------------------------------------------

PARSER_META = {
    "help": "In-context character-locked re-render (FLUX.1-Kontext-dev, OM capability E)",
    "description": (
        "Kontext in-context generation: re-render the SAME identity from a hero\n"
        "image in a new scene/setting, anchoring identity verbatim (FLUX.1-Kontext-dev).\n"
        "Supersedes the soft seed+ref-conditioning identity lock (image character /\n"
        "storyboard --character). Feed the IdentitySpec hero as --input.\n\n"
        "  --input <hero>   the identity anchor (FLUX.1-Kontext-dev conditioning image)\n"
        "  --prompt <text>  the in-context instruction (new scene / outfit / edit)\n"
        "  --quantize <b>   mlx quantization (default 8 = mlx-8bit)\n"
        "  --guidance <f>   CFG (default 2.5, mflux GUIDANCE_SCALE_KONTEXT)\n"
        "  --steps <n>      inference steps (default 20 — Kontext-dev is non-distilled)\n"
        "  --scenes <n>     certify mode: render N differentiated scenes of the hero\n\n"
        "--pipeline is IGNORED (Kontext is its own model family).\n\n"
        "FIRST RUN downloads FLUX.1-Kontext-dev from HF (gated — needs HF_TOKEN +\n"
        "license accepted at huggingface.co/black-forest-labs/FLUX.1-Kontext-dev).\n\n"
        "Examples:\n"
        "  run.py image kontext --input hero.png --prompt '<same person>, knight in armor'\n"
        "  run.py image kontext --input hero.png --scenes 3 --prompt-subject 'a woman with red hair'\n"
        "  run.py image kontext --input hero.png --steps 28 --guidance 2.5\n"
        "  run.py image kontext --self-test\n"
    ),
}


def _option_registered(parser: "argparse.ArgumentParser", option: str) -> bool:
    for act in parser._actions:  # noqa: SLF001
        if option in act.option_strings:
            return True
    return False


def _arg_registered(parser: "argparse.ArgumentParser", dest: str) -> bool:
    return any(getattr(a, "dest", None) == dest for a in parser._actions)


def add_kontext_args(parser: "argparse.ArgumentParser") -> None:
    """Register kontext-specific arguments.

    Common args (--input→input_image, --prompt, --steps, --seed, --self-test,
    --gen-output-dir, --width/--height via t2i args) are added elsewhere.
    """
    if not _arg_registered(parser, "guidance"):
        parser.add_argument(
            "--guidance", type=float, default=DEFAULT_KONTEXT_GUIDANCE,
            help=f"CFG guidance scale (default {DEFAULT_KONTEXT_GUIDANCE}, "
                 "mflux GUIDANCE_SCALE_KONTEXT).",
        )
    if not _arg_registered(parser, "scheduler"):
        parser.add_argument(
            "--scheduler", type=str, default="linear",
            help="mflux scheduler (default 'linear').",
        )
    if not _arg_registered(parser, "quantize"):
        parser.add_argument(
            "--quantize", type=int, default=8,
            help="MLX quantization in bits (default 8 = mlx-8bit; 4 for 4-bit).",
        )
    if not _arg_registered(parser, "scenes"):
        parser.add_argument(
            "--scenes", type=int, default=None,
            help="Certify mode: render N differentiated in-context scenes of the "
                 "hero (identity-consistency check). Omit for a single render.",
        )
    if not _arg_registered(parser, "prompt_subject"):
        parser.add_argument(
            "--prompt-subject", type=str, default=None,
            help="Subject description for --scenes certify mode (spliced into each "
                 "scene template). Required when --scenes is set without --prompt.",
        )


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def run_kontext(args: "argparse.Namespace") -> dict[str, str] | None:
    """Execute in-context Kontext generation. Called by image.py dispatcher.

    Instantiates mflux's Flux1Kontext directly (Kontext is its own model family,
    not reachable via the repo's ZImage/Flux2Klein pipelines), generates one or
    more in-context renders, and writes the standard run.json + manifest.json +
    `Manifest:` sentinel the bridge adapter parses.
    """
    from app.commands._shared import resolve_lora_paths, seed_sequence

    # Self-test: synthesize a hero portrait, then run a single in-context render.
    if getattr(args, "self_test", None):
        args.input_image = _synth_hero(cfg.OUTPUT_DIR)
        if getattr(args, "prompt", None) is None:
            args.prompt = (
                "the same person, now wearing a futuristic silver spacesuit, "
                "standing on a red planet under two moons, cinematic wide shot"
            )
        if getattr(args, "steps", None) is None:
            args.steps = DEFAULT_KONTEXT_STEPS
        if getattr(args, "width", None) is None:
            args.width = 1024
        if getattr(args, "height", None) is None:
            args.height = 1024
        print(f"[kontext] self-test: hero={args.input_image}", flush=True)
        print(f"[kontext] self-test: prompt={args.prompt}", flush=True)

    hero = getattr(args, "input_image", None)
    if not hero:
        print("ERROR: --input (hero / identity anchor image) is required for kontext.",
              file=sys.stderr)
        sys.exit(1)
    if not os.path.exists(hero):
        print(f"ERROR: hero image not found: {hero}", file=sys.stderr)
        sys.exit(1)

    # Resolve prompt: single mode needs --prompt; scenes mode builds from templates.
    scenes_mode = getattr(args, "scenes", None) is not None
    if scenes_mode:
        subject = getattr(args, "prompt_subject", None) or ""
        n_scenes = max(1, int(getattr(args, "scenes", 1) or 1))
        prompts = build_incontext_scenes(subject, count=n_scenes)
    else:
        prompt = (getattr(args, "prompt", None) or "").strip()
        if not prompt:
            print("ERROR: --prompt (in-context instruction) is required for kontext "
                  "(or pass --scenes N for the certify mode).", file=sys.stderr)
            sys.exit(1)
        prompts = [prompt]

    # Defaults for unset common args.
    if getattr(args, "steps", None) is None:
        args.steps = DEFAULT_KONTEXT_STEPS
    if getattr(args, "width", None) is None:
        args.width = 1024
    if getattr(args, "height", None) is None:
        args.height = 1024

    guidance = getattr(args, "guidance", None) or DEFAULT_KONTEXT_GUIDANCE
    scheduler = getattr(args, "scheduler", None) or "linear"
    quantize = getattr(args, "quantize", None) or 8

    lora_paths = resolve_lora_paths(getattr(args, "lora_path", None) or [])
    lora_scales_raw = getattr(args, "lora_scale", None)
    if lora_paths:
        # Pair each path with a scale (default 1.0 for unpaired entries).
        if isinstance(lora_scales_raw, list):
            lora_scales = [lora_scales_raw[i] if i < len(lora_scales_raw) else 1.0
                           for i in range(len(lora_paths))]
        else:
            lora_scales = [float(lora_scales_raw) if lora_scales_raw else 1.0] * len(lora_paths)
    else:
        lora_scales = None

    seeds = seed_sequence(args)
    # One render per prompt. seed_sequence uses args.count (default 1) — without
    # this clamp, --scenes 3 would zip 3 prompts against 1 seed and emit only the
    # first scene. Force the render count to match the prompt count so every
    # scene gets a distinct seed.
    if len(prompts) > len(seeds):
        args.count = len(prompts)
        seeds = seed_sequence(args)

    print(f"[kontext] Model    : {KONTEXT_MODEL_ID} (quantize={quantize})", flush=True)
    print(f"[kontext] Hero     : {hero}", flush=True)
    print(f"[kontext] Guidance : {guidance}  steps={args.steps}  "
          f"{args.width}x{args.height}  scheduler={scheduler}", flush=True)
    if lora_paths:
        print(f"[kontext] LoRA     : {list(zip(lora_paths, lora_scales))}", flush=True)
    print(f"[kontext] Renders  : {len(prompts)} (seeds={seeds})", flush=True)

    _run_kontext_generation(
        hero=hero,
        prompts=prompts,
        seeds=seeds,
        width=args.width,
        height=args.height,
        steps=args.steps,
        guidance=guidance,
        scheduler=scheduler,
        quantize=quantize,
        lora_paths=lora_paths or None,
        lora_scales=lora_scales,
        args=args,
    )
    return None


def _run_kontext_generation(*, hero: str, prompts: list[str], seeds: list[int],
                            width: int, height: int, steps: int, guidance: float,
                            scheduler: str, quantize: int,
                            lora_paths: list[str] | None,
                            lora_scales: list[float] | None,
                            args: "argparse.Namespace") -> None:
    """Load Flux1Kontext once, render each prompt, write run.json + manifest.

    Kept separate from run_kontext so the generation surface is testable without
    argparse — the heavy mflux import lives here (deferred to call time).
    """
    import gc
    from datetime import datetime, timezone

    import mlx.core as mx

    from mflux.models.flux.variants.kontext.flux_kontext import Flux1Kontext
    from app.manifest import Manifest
    from app.run_config import RunConfig
    from app.commands._shared import make_output_paths

    paths = make_output_paths()
    run_config = RunConfig.from_args(args, command="image kontext")
    run_config.to_json(paths.run_file)
    start_time = datetime.now(timezone.utc).isoformat()

    print(f"[kontext] Loading model (first run downloads {KONTEXT_MODEL_ID})...",
          flush=True)
    flux = Flux1Kontext(
        quantize=quantize,
        model_path=None,          # None → mflux downloads KONTEXT_MODEL_ID from HF
        lora_paths=lora_paths,
        lora_scales=lora_scales,
    )

    all_outputs: list[dict] = []
    last_timings: dict = {}

    try:
        for i, (prompt, seed) in enumerate(zip(prompts, seeds)):
            label = f"scene {i + 1}/{len(prompts)}" if len(prompts) > 1 else "render"
            print(f"\n=== Kontext {label} (seed={seed}) ===", flush=True)
            print(f"[kontext] prompt: {prompt}", flush=True)
            image = flux.generate_image(
                seed=seed,
                prompt=prompt,
                num_inference_steps=steps,
                height=height,
                width=width,
                guidance=guidance,
                image_path=hero,
                scheduler=scheduler,
            )
            suffix = f"_s{seed}" if len(prompts) > 1 else ""
            scene_suffix = f"_scene{i + 1}" if len(prompts) > 1 else ""
            out_path = os.path.join(cfg.OUTPUT_DIR,
                                    f"{paths.base_name}{scene_suffix}{suffix}.png")
            image.save(path=out_path)
            print(f"Saved: {out_path}", flush=True)
            all_outputs.append({
                "path": out_path,
                "seed": seed,
                "size_bytes": os.path.getsize(out_path),
                "width": image.image.width,
                "height": image.image.height,
            })
            last_timings = {"generate": float(getattr(image, "generation_time", 0.0) or 0.0)}

        # Release the heavy model before manifest write / next process.
        del flux
        mx.clear_cache()
        gc.collect()

        end_time = datetime.now(timezone.utc).isoformat()
        models = {
            "transformer": {
                "path": KONTEXT_MODEL_ID,
                "name": "flux1-kontext-dev",
                "quantize": quantize,
            },
            **({"loras": [{"path": p, "scale": s} for p, s in zip(lora_paths, lora_scales)]}
               if lora_paths else {}),
        }
        manifest = Manifest.from_success(
            paths.run_file, start_time, end_time, last_timings, all_outputs, models,
        )
        manifest.to_json(paths.manifest_file)
        print(f"Run config: {paths.run_file}")
        print(f"Manifest:   {paths.manifest_file}")

    except Exception as exc:
        end_time = datetime.now(timezone.utc).isoformat()
        manifest = Manifest.from_error(
            paths.run_file, start_time, end_time, last_timings or {}, exc, {},
        )
        manifest.to_json(paths.manifest_file)
        print(f"ERROR: {type(exc).__name__}: {exc}", file=sys.stderr)
        print(f"Manifest (error): {paths.manifest_file}", file=sys.stderr)
        # Kontext's most likely first-run failure is the gated HF download —
        # surface a targeted hint so the user knows it is an auth gap, not a bug.
        msg = str(exc).lower()
        if "gated" in msg or "401" in msg or "unauthorized" in msg or "agreement" in msg or "access" in msg:
            print(
                "[kontext] FLUX.1-Kontext-dev is a GATED HF repo. Accept the license at\n"
                "          https://huggingface.co/black-forest-labs/FLUX.1-Kontext-dev\n"
                "          and set HF_TOKEN (huggingface-cli login) before the first run.",
                file=sys.stderr,
            )
        raise


# ---------------------------------------------------------------------------
# Self-test hero synthesis
# ---------------------------------------------------------------------------

def _synth_hero(out_dir: str) -> str:
    """Generate a simple hero portrait (ZImage T2I) for the kontext self-test.

    The hero is the identity anchor Kontext re-renders. A deterministic,
    well-described portrait gives the in-context render a strong identity to
    preserve. Local MLX only (constraint 1).
    """
    import time

    import mlx.core as mx

    from app.pipeline import ZImagePipeline
    from app.commands._shared import generate_base_name

    os.makedirs(out_dir, exist_ok=True)
    prompt = (
        "A clean portrait of a young woman with short auburn hair and freckles, "
        "green eyes, wearing a simple grey hoodie, neutral studio background, "
        "soft even lighting, looking at camera, head and shoulders, high quality."
    )
    print("[kontext] self-test: generating hero portrait (ZImage)...", flush=True)
    pipeline = ZImagePipeline()
    try:
        result = pipeline.generate(prompt=prompt, width=832, height=1024,
                                   steps=9, seed=42)
    finally:
        del pipeline
        mx.clear_cache()
    base = generate_base_name()
    ts = time.strftime("%Y%m%d_%H%M%S")
    path = os.path.join(out_dir, f"{base}_kontext_hero_{ts}.png")
    result.image.save(path)
    print(f"[kontext] self-test: hero saved {path}", flush=True)
    return path
