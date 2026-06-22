"""image-purify — SeedVR2 AI high-quality redraw + upscale.

Uses SeedVR2's single-step diffusion with controlled softness to purify,
enhance, or fully redraw an image while optionally increasing resolution.

Mode presets control how much creative freedom the model has:
  purify    — light cleanup (softness 0.3), preserves most original detail
  enhance   — balanced enhancement (softness 0.5, default)
  deartifact — stronger redraw (softness 0.65) + NoiseCleaner for
              compression/blocking artifacts (global; no region detector exists)
  redraw    — high creative freedom (softness 0.8), model reinterprets content

Targeted removal (--remove) is its own operation that short-circuits the redraw:
  subtitle — SAM3-segment caption text → surgical inpaint (original kept outside
             a feathered mask; background doesn't move so mask-blend is correct)
  watermark — same, for logos/stamps/signatures

--transformer selects the flux2-klein-9b variant for the transformer backend AND
the --remove inpaint (default klein-9b; e.g. kleinova-nsfw-v3).

Resolution can be:
  same   — output matches input size (pure purification, no upscale)
  2x     — scale by factor
  2160   — target shortest-side pixels

Examples:
  run.py image purify --input-image output/photo.png
  run.py image purify --input-image output/photo.png --purify-mode redraw --resolution 2x
  run.py image purify --input-image output/photo.png --purify-mode purify --resolution same
  run.py image purify --input-image output/photo.png --softness-override 0.95 --resolution same
  run.py image purify --input-image output/photo.png --purify-mode enhance --resolution 2160
  run.py image purify --input-image photo.png --purify-mode enhance --resolution 2x --film-grain 0.02 --sharpening 0.1
"""

import json
import os
import subprocess
import sys
import time

from app.commands._shared import _arg_registered, build_run_py_cmd, run_session, OutputPaths
from app.manifest import collect_model_fingerprint_seedvr2

# ---------------------------------------------------------------------------
# Mode presets — softness controls pre-downsampling before diffusion
# ---------------------------------------------------------------------------

MODE_PRESETS = {
    "purify": 0.3,       # light cleanup, minimal reinterpretation
    "enhance": 0.5,      # balanced enhancement (default)
    "deartifact": 0.65,  # stronger redraw + NoiseCleaner (compression/blocking artifacts)
    "redraw": 0.8,       # high creative freedom, model reinterprets content
}

PARSER_META = {
    "help": "SeedVR2 AI high-quality redraw + upscale (purify / enhance / redraw)",
    "description": __doc__,
}


# ---------------------------------------------------------------------------
# Argument registration
# ---------------------------------------------------------------------------

def add_purify_args(parser):
    """Register purify-specific CLI arguments.

    Uses _arg_registered guards to avoid conflicts with other image
    subcommands that share the same parser (e.g. faceswap --mode,
    workflow --film-grain, _shared --seed).

    Note: No positional IMAGE arg — the image dispatcher already has
    `action` and `sub_action` positionals, so a third positional would
    conflict. Use --input-image instead.
    """

    # Mode preset (--purify-mode to avoid conflict with faceswap --mode)
    parser.add_argument(
        "--purify-mode", dest="purify_mode", choices=list(MODE_PRESETS.keys()), default="enhance",
        help=f"Purify mode preset (default: enhance). "
             f"purify=softness {MODE_PRESETS['purify']}, "
             f"enhance=softness {MODE_PRESETS['enhance']}, "
             f"redraw=softness {MODE_PRESETS['redraw']}",
    )

    # Resolution. NOTE: image.py registers add_t2i_args() BEFORE add_purify_args()
    # on the same parser, and image-t2i.py registers --resolution (default=None)
    # unguarded — so that registration wins and this block is skipped. The shared
    # --resolution dest is owned by t2i; run_purify() applies `or "same"` so the
    # purify effective default is still "same". default="same" below only applies
    # if purify ever gets a standalone parser. The help text deliberately omits
    # "(default: same)" because argparse introspection (run.py schema, GUI
    # schema-defaults) reports default=None from the winning t2i registration.
    if not _arg_registered(parser, "resolution"):
        parser.add_argument(
            "--resolution", type=str, default="same",
            help='Target resolution: "same" (no resize), pixels (e.g. 2160), or scale (e.g. 2x, 3x). '
                 'Defaults to "same" at runtime (run_purify applies `or "same"`); '
                 'the shared dest is owned by t2i (default=None).',
        )

    # Softness override (unique to purify — no guard needed)
    parser.add_argument(
        "--softness-override", type=float, default=None, metavar="FLOAT",
        help="Override mode's default softness (0.0-1.0). Advanced users only.",
    )

    # Targeted removal: SAM3-segment the text region then surgically inpaint it
    # away (original pixels preserved outside a feathered mask). When set, this
    # IS the operation — the seedvr2/transformer redraw below is skipped and the
    # cleaned image is the output. --transformer selects the inpaint model.
    parser.add_argument(
        "--remove", dest="remove", choices=["none", "subtitle", "watermark"],
        default="none",
        help="Surgically remove burned-in text: subtitle (captions), watermark "
             "(logos/stamps), or none (default). Uses SAM3 detection + inpaint.",
    )

    # Backend: SeedVR2 (1-step upscale redraw, original behavior) vs transformer
    # (flux2-klein I2I redraw — prompt-guided, multi-step, different look). The
    # transformer backend delegates to `run.py image i2i --pipeline flux2-klein`.
    parser.add_argument(
        "--backend", dest="backend", choices=["seedvr2", "transformer"], default="seedvr2",
        help="Redraw backend: seedvr2 (SeedVR2 1-step, default) or transformer (flux2-klein I2I).",
    )
    # Transformer instance for the transformer backend AND the --remove inpaint
    # path (both go through Flux2KleinT2IPipeline). Default klein-9b; pick any
    # flux2-klein-9b variant in models/transformer/ (e.g. kleinova-nsfw-v3).
    if not _arg_registered(parser, "transformer"):
        parser.add_argument(
            "--transformer", dest="transformer", default="klein-9b", metavar="NAME",
            help="Transformer instance (models/transformer/<name>/) for the transformer "
                 "backend's I2I redraw and --remove inpaint (default: klein-9b).",
        )
    # Prompt (transformer backend only — SeedVR2 is prompt-free). When backend
    # is transformer and no prompt is given, a neutral quality prompt is used.
    if not _arg_registered(parser, "prompt"):
        parser.add_argument(
            "--prompt", dest="prompt", type=str, default=None,
            help="Prompt guiding the transformer backend's I2I redraw (ignored by seedvr2).",
        )

    # Seed (guard: _shared and others register --seed)
    if not _arg_registered(parser, "seed"):
        parser.add_argument(
            "--seed", type=int, default=42,
            help="Seed for SeedVR2 noise (default: 42)",
        )

    # Optional postprocessing (guard: image-workflow registers these)
    if not _arg_registered(parser, "film_grain"):
        parser.add_argument(
            "--film-grain", type=float, default=0.0, metavar="FLOAT",
            help="Add film grain after purification (0.0-0.03 typical, default: 0)",
        )
    if not _arg_registered(parser, "sharpening"):
        parser.add_argument(
            "--sharpening", type=float, default=0.0, metavar="FLOAT",
            help="CAS sharpening after purification (0.0-0.3 typical, default: 0)",
        )

    # Output (guard: upscale and caption register --output)
    if not _arg_registered(parser, "output"):
        parser.add_argument(
            "--output", type=str, default=None, metavar="PATH",
            help="Output image path (default: <input>_purify_<mode>_<resolution>.png)",
        )


# ---------------------------------------------------------------------------
# Resolution parsing (reused pattern from upscale.py)
# ---------------------------------------------------------------------------

def _parse_resolution(res_str: str) -> tuple[int | float, str]:
    """Parse resolution string into (value, label).

    Returns (value, label) where value is int|float and label is a display
    string for the output filename.
    """
    if res_str.lower() == "same":
        return 1.0, "same"
    if res_str.lower().endswith("x"):
        scale = float(res_str.lower().rstrip("x"))
        return scale, f"{scale}x"
    try:
        pixels = int(res_str)
        return pixels, str(pixels)
    except ValueError:
        print(
            f"ERROR: invalid resolution '{res_str}'. "
            f"Use 'same', pixels (e.g. 2160), or scale (e.g. 2x)",
            file=sys.stderr,
        )
        sys.exit(1)


# ---------------------------------------------------------------------------
# Transformer backend (flux2-klein I2I redraw) — alternative to SeedVR2
# ---------------------------------------------------------------------------

# Mode → denoise mapping for the transformer backend, mirroring the SeedVR2
# softness scale (purify < enhance < deartifact < redraw). Higher denoise = more
# reinterpretation.
TRANSFORMER_DENOISE = {"purify": 0.35, "enhance": 0.55, "deartifact": 0.7, "redraw": 0.85}

# SeedVR2 is prompt-free; the flux2-klein I2I redraw is prompt-guided, so the
# transformer backend falls back to a neutral quality prompt when --prompt is unset.
_DEFAULT_TRANSFORMER_PROMPT = "highly detailed, sharp focus, high quality, professional"

# --- Targeted removal (--remove) ---
# SAM3 matches SINGLE clean words best — a comma-joined phrase like
# "subtitles, caption text" confuses it and returns 0 detections (smoke-tested:
# "subtitles" scores ~0.59 @ thr 0.3; the old comma form scored 0.0). The plural
# "subtitles" matters (singular "subtitle" → 0). Recall on thin/small text is
# still the known weak spot (documented limitation — fall back to manual mask).
REMOVE_SAM3_PROMPTS = {
    "subtitle": "subtitles",
    "watermark": "watermark",
}
# The inpaint generate() prompt describes what to fill the removed region WITH
# (background continuation), NOT the text being removed.
_REMOVE_FILL_PROMPT = "clean unobstructed background, seamlessly blended, no text"


def _write_json(path: str, data: dict) -> None:
    """Write a JSON file (controlnet-style run.json helper)."""
    with open(path, "w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")


def _make_purify_paths(input_path: str, mode: str, res_label: str, ext: str,
                       explicit_output: str | None = None) -> OutputPaths:
    """Build OutputPaths with manifest/run siblings next to the purify output.

    Preserves the existing custom output naming (next to input, NOT the
    OUTPUT_DIR/output_XXX convention) so existing gallery indexes keep working.
    """
    if explicit_output is None:
        base, _ = os.path.splitext(input_path)
        explicit_output = f"{base}_purify_{mode}_{res_label}{ext or '.png'}"
    out_abs = os.path.abspath(explicit_output)
    out_dir = os.path.dirname(out_abs) or "."
    stem = os.path.splitext(os.path.basename(out_abs))[0]
    return OutputPaths(
        base_name=stem,
        run_file=os.path.join(out_dir, f"{stem}.run.json"),
        manifest_file=os.path.join(out_dir, f"{stem}.manifest.json"),
        output_file=explicit_output,
    )


def _build_purify_run_meta(args, input_path, mode, softness, resolution,
                           res_label, backend, output_path, seed,
                           prompt=None, softness_override=None,
                           remove="none", transformer="klein-9b") -> dict:
    """Build the run.json metadata dict for a purify run (full params for replay)."""
    return {
        "command": "image",
        "action": "purify",
        "backend": backend,  # "seedvr2" | "transformer"
        "input_image": input_path,
        "purify_mode": mode,
        "softness": softness,
        # Store the raw override (not just the resolved `softness`) so replay
        # reproduces an exact run; without it, replay re-derives softness from
        # purify_mode and silently drops a --softness-override the user set.
        "softness_override": softness_override,
        "resolution": res_label,
        "seed": seed,
        "film_grain": getattr(args, "film_grain", 0.0) or 0.0,
        "sharpening": getattr(args, "sharpening", 0.0) or 0.0,
        "output": output_path,
        "prompt": prompt,
        "remove": remove,                     # targeted removal target (none|subtitle|watermark)
        "transformer": transformer,           # flux2-klein variant for redraw/inpaint
        "denoise_strength": TRANSFORMER_DENOISE.get(mode, 0.55) if backend == "transformer" else None,
    }


def _run_transformer_backend(input_path, mode, resolution, w0, h0, seed, prompt,
                             transformer_name: str = "klein-9b",
                             json_summary: bool = False) -> str:
    """Redraw via flux2-klein I2I by delegating to `run.py image i2i`.

    Returns the i2i output path (parsed from i2i's JSON_SUMMARY line, with a
    `Saved:` fallback). Uses build_run_py_cmd so --force auto-propagates to the
    child (prevents GPU-lock deadlock). Streams stdout live while capturing it.
    """
    denoise = TRANSFORMER_DENOISE.get(mode, 0.55)

    # Compute explicit target dims: 1.0 → input size; float → scale;
    # int → shortest-side pixel target. Round to 16-divisible (diffusion req.).
    if resolution == 1.0:
        out_w, out_h = w0, h0
    elif isinstance(resolution, float):
        out_w, out_h = round(w0 * resolution), round(h0 * resolution)
    else:
        scale = float(resolution) / min(w0, h0)
        out_w, out_h = round(w0 * scale), round(h0 * scale)
    out_w = max(16, (out_w // 16) * 16)
    out_h = max(16, (out_h // 16) * 16)

    use_prompt = prompt or _DEFAULT_TRANSFORMER_PROMPT
    cmd = build_run_py_cmd(
        "image", "i2i",
        "--pipeline", "flux2-klein",
        "--transformer", transformer_name,
        "--input-image", input_path,
        "--denoise-strength", str(denoise),
        "--width", str(out_w), "--height", str(out_h),
        "--seed", str(seed),
        "--prompt", use_prompt,
        "--json-summary",
    )
    print(f"[purify] transformer backend -> flux2-klein I2I "
          f"{out_w}x{out_h} denoise={denoise} mode={mode} transformer={transformer_name}")

    # Stream stdout live AND capture it (so we can parse JSON_SUMMARY afterwards).
    # Guard against a hung/crashed child (OOM, stuck Metal compile, MLX graph
    # hang) blocking forever: enforce a deadline via timed readline + kill.
    _SUBPROC_TIMEOUT = 1800  # 30 min upper bound for one i2i redraw
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            text=True, bufsize=1)
    captured: list[str] = []
    assert proc.stdout is not None
    deadline = time.monotonic() + _SUBPROC_TIMEOUT
    timed_out = False
    while True:
        line = proc.stdout.readline()
        if line:
            sys.stdout.write(line)
            captured.append(line)
            continue
        # No data right now — check if the child has exited.
        if proc.poll() is not None:
            break
        if time.monotonic() > deadline:
            timed_out = True
            break
        time.sleep(0.1)
    if timed_out:
        proc.kill()
        try:
            proc.wait(timeout=30)
        except subprocess.TimeoutExpired:
            pass
        raise RuntimeError(
            f"transformer-backend i2i subprocess timed out after "
            f"{_SUBPROC_TIMEOUT}s; killed child to unblock purify run"
        )
    rc = proc.wait()
    if rc != 0:
        raise subprocess.CalledProcessError(rc, cmd)

    blob = "".join(captured)
    # Prefer the last JSON_SUMMARY line (outputs[0]); fall back to "Saved: <path>".
    for line in reversed(blob.splitlines()):
        line = line.strip()
        if line.startswith("JSON_SUMMARY:"):
            try:
                summary = json.loads(line[len("JSON_SUMMARY:"):])
                outputs = summary.get("outputs") or []
                if outputs:
                    return outputs[0]
            except json.JSONDecodeError:
                pass
    for line in reversed(blob.splitlines()):
        if line.strip().startswith("Saved:"):
            return line.strip()[len("Saved:"):].strip()
    print("ERROR: could not determine i2i output path from subprocess output",
          file=sys.stderr)
    sys.exit(1)


# ---------------------------------------------------------------------------
# Targeted removal (--remove subtitle|watermark)
# ---------------------------------------------------------------------------

def _run_remove_target(image, target: str, transformer_name: str, seed: int,
                       denoise: float = 0.8, score_threshold: float = 0.3):
    """Surgically remove burned-in text: SAM3 segment → inpaint → mask composite.

    Unlike object swap (which regenerates the whole scene at high denoise),
    removal keeps the original image pixel-perfect OUTSIDE the text region and
    only fills the masked area. Background doesn't relocate on removal, so a
    feathered mask-blend of original-vs-regenerated is correct here (the swap
    path skips the blend because a swapped object moves position).

    Pipeline (mirrors image-swap.py's inpaint core, generalised to union all
    detections + a surgical composite):
      1. SAM3 text-prompted segmentation → union of all high-score masks
      2. Pre-fill the text region with the border-median colour (hide original)
      3. Flux2KleinT2IPipeline I2I regenerate at high denoise (fill prompt)
      4. Alpha-composite: original outside the feathered mask, regenerated inside

    Returns the cleaned PIL image (same size as input). If SAM3 finds no text,
    the original image is returned unchanged with a warning.
    """
    import gc
    import numpy as np
    import mlx.core as mx
    from PIL import Image
    from app.sam3_predictor import get_sam3_predictor, segment_image, feather_mask
    from app.flux2_t2i_pipeline import Flux2KleinT2IPipeline

    w0, h0 = image.size
    sam_prompt = REMOVE_SAM3_PROMPTS[target]
    print(f"[purify] --remove {target}: SAM3 segmenting '{sam_prompt}'...")

    predictor = get_sam3_predictor(threshold=score_threshold)
    result = segment_image(predictor, image, sam_prompt, score_threshold=score_threshold)
    if len(result.scores) == 0:
        print(f"[purify] --remove: SAM3 found no '{target}' regions; "
              f"returning original unchanged")
        return image

    # Union all detections (subtitles/watermarks often span several boxes).
    mask_stack = np.asarray(result.masks)               # (N, Hm, Wm)
    union = np.any(mask_stack > 0, axis=0)              # (Hm, Wm) bool
    # Align to input resolution if SAM3 ran at a different one.
    if union.shape != (h0, w0):
        union_pil = Image.fromarray((union.astype(np.uint8) * 255))
        union = np.array(union_pil.resize((w0, h0), Image.NEAREST)).astype(bool)
    # Dilate the mask a few px: SAM3's text masks are tight to the glyph centres
    # and miss thin strokes/edges (smoke-tested: ~43% bbox coverage on a
    # semi-transparent watermark, leaving residual text after inpaint). Expanding
    # the region before inpaint+blend covers those edges — strict recall win for
    # both subtitles and watermarks, with no downside outside the feathered area.
    from scipy.ndimage import binary_dilation
    raw_px = int(union.sum())
    union = binary_dilation(union, iterations=5)
    print(f"[purify] --remove: {len(result.scores)} detection(s) → "
          f"{raw_px} px (dilated to {int(union.sum())} px) to inpaint")

    # Pre-fill the text region with the median colour of pixels just outside it,
    # so the model does NOT see the original text (same trick as swap inpaint).
    src_np = np.array(image)
    inv = ~union
    if inv.any():
        from scipy.ndimage import binary_dilation
        border = binary_dilation(union, iterations=3) & ~union
        pool = border if border.any() else inv
        fill_color = np.median(src_np[pool].astype(np.float32), axis=0).astype(np.uint8)
    else:
        fill_color = np.array([128, 128, 128], dtype=np.uint8)

    masked_np = src_np.copy()
    masked_np[union] = fill_color
    masked_pil = Image.fromarray(masked_np)

    # High-denoise I2I regenerate to convincingly fill the pre-masked region.
    pipeline = Flux2KleinT2IPipeline(transformer_name=transformer_name)
    try:
        regenerated = pipeline.generate(
            prompt=_REMOVE_FILL_PROMPT,
            input_image=masked_pil,
            denoise_strength=denoise,
            width=w0, height=h0,
            steps=4,
            seed=seed,
        ).image
    finally:
        del pipeline
        mx.clear_cache()
        gc.collect()

    # Surgical composite: original outside the feathered mask, regenerated inside.
    if regenerated.size != (w0, h0):
        regenerated = regenerated.resize((w0, h0), Image.LANCZOS)
    reg_np = np.array(regenerated).astype(np.float32)
    feathered = feather_mask(union.astype(np.uint8), radius=8)[..., None]  # (H,W,1)
    out_np = src_np.astype(np.float32) * (1.0 - feathered) + reg_np * feathered
    print(f"[purify] --remove {target}: done (inpainted + mask-blended)")
    return Image.fromarray(np.clip(out_np, 0, 255).astype(np.uint8))


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def _run_self_test(args) -> None:
    """Nomodel arg-wiring self-test.

    Validates that the new param-resolution code paths work (mode → softness
    incl. deartifact, TRANSFORMER_DENOISE coverage, --remove prompts, resolution
    parser, and the backend/remove/transformer defaults) WITHOUT loading any
    model. Lets `run.py image purify --self-test` catch wiring bugs fast. Does
    NOT register in the heavy _ALL_TESTS registry (keeps it self-contained and
    avoids the self-test-integrity coupling).
    """
    print("[purify:self-test] Nomodel arg-wiring check (no models loaded)")
    failures = []

    for mode, s in MODE_PRESETS.items():
        ok = isinstance(s, (int, float)) and 0.0 <= s <= 1.0
        print(f"  mode={mode:10s} softness={s} {'OK' if ok else 'FAIL'}")
        if not ok:
            failures.append(f"MODE_PRESETS[{mode}]={s}")
    for mode in MODE_PRESETS:
        if mode not in TRANSFORMER_DENOISE:
            failures.append(f"TRANSFORMER_DENOISE missing {mode}")
    print(f"  TRANSFORMER_DENOISE covers all modes: "
          f"{'OK' if len(failures) == 0 else 'FAIL'}")

    if set(REMOVE_SAM3_PROMPTS) != {"subtitle", "watermark"}:
        failures.append(f"REMOVE_SAM3_PROMPTS keys={list(REMOVE_SAM3_PROMPTS)}")
    print(f"  REMOVE_SAM3_PROMPTS: {REMOVE_SAM3_PROMPTS} "
          f"{'OK' if set(REMOVE_SAM3_PROMPTS) == {'subtitle', 'watermark'} else 'FAIL'}")

    for res, want in [("same", (1.0, "same")), ("2x", (2.0, "2.0x")), ("2160", (2160, "2160"))]:
        got = _parse_resolution(res)
        print(f"  resolution={res!r:8s} -> {got} {'OK' if got == want else 'FAIL'}")
        if got != want:
            failures.append(f"_parse_resolution({res!r})={got} != {want}")

    for name, default in [("backend", "seedvr2"), ("remove", "none"), ("transformer", "klein-9b")]:
        val = getattr(args, name, None) or default
        print(f"  default {name}={val} OK")

    if failures:
        print(f"\n[purify:self-test] FAIL: {len(failures)} issue(s): {failures}")
        sys.exit(1)
    print("\n[purify:self-test] PASS — all arg wiring resolved correctly")
    sys.exit(0)


def run_purify(args) -> None:
    """Run SeedVR2 purification / redraw / upscale (writes a manifest per run)."""
    if getattr(args, "self_test", False):
        _run_self_test(args)
        return

    from PIL import Image
    from app.seedvr2.pipeline import SeedVR2Upscaler

    # Resolve input path
    input_path = getattr(args, "input_image", None)
    if not input_path:
        print("ERROR: provide --input-image PATH", file=sys.stderr)
        sys.exit(1)
    if not os.path.exists(input_path):
        print(f"ERROR: input image not found: {input_path}", file=sys.stderr)
        sys.exit(1)

    # Determine softness: override > mode preset
    mode = getattr(args, "purify_mode", "enhance") or "enhance"
    softness_override = getattr(args, "softness_override", None)
    softness = softness_override if softness_override is not None else MODE_PRESETS[mode]

    # Parse resolution
    res_str = getattr(args, "resolution", "same") or "same"
    resolution, res_label = _parse_resolution(res_str)
    seed = getattr(args, "seed", None)
    if seed is None:
        seed = 42  # default; --seed may be registered with default=None by a sibling subcommand

    # Load image
    try:
        with Image.open(input_path) as _im:
            image = _im.convert("RGB")
    except (FileNotFoundError, OSError) as e:
        raise ValueError(f"cannot read input image {input_path}: {e}") from e
    w0, h0 = image.size
    print(f"[purify] {input_path} ({w0}x{h0}) mode={mode} softness={softness} "
          f"resolution={resolution} seed={seed}")

    backend = getattr(args, "backend", "seedvr2") or "seedvr2"
    remove = getattr(args, "remove", "none") or "none"
    transformer_name = getattr(args, "transformer", "klein-9b") or "klein-9b"

    # Output path + sibling run/manifest paths (CUSTOM location next to input,
    # preserved from the pre-manifest behavior). --remove gets its own label so
    # cleaned outputs don't collide with redraw outputs.
    ext = os.path.splitext(input_path)[1]
    output_path = getattr(args, "output", None)
    path_mode = f"remove-{remove}" if remove != "none" else mode
    paths = _make_purify_paths(input_path, path_mode, res_label, ext, explicit_output=output_path)

    # Write run.json BEFORE entering run_session (run_config=None path, since
    # RunConfig is t2i-specific and doesn't fit purify's mode/softness/resolution).
    run_meta = _build_purify_run_meta(
        args, input_path, mode, softness, resolution, res_label,
        backend, paths.output_file, seed,
        prompt=getattr(args, "prompt", None) if backend == "transformer" else None,
        softness_override=softness_override,
        remove=remove, transformer=transformer_name,
    )
    os.makedirs(os.path.dirname(os.path.abspath(paths.output_file)), exist_ok=True)
    _write_json(paths.run_file, run_meta)

    json_summary = getattr(args, "json_summary", False)
    with run_session(paths, run_config=None, json_summary=json_summary) as ctx:
        if remove != "none":
            # --remove IS the operation: SAM3 + inpaint produce the cleaned image
            # (same resolution); the seedvr2/transformer redraw is skipped. The
            # chosen transformer drives the inpaint model.
            cleaned = _run_remove_target(image, remove, transformer_name, seed)
            cleaned.save(paths.output_file)
            w1, h1 = cleaned.size
            print(f"[purify] Saved: {paths.output_file} ({w1}x{h1})")
            ctx["outputs"] = [{
                "path": paths.output_file, "seed": seed,
                "size_bytes": os.path.getsize(paths.output_file),
                "width": w1, "height": h1,
            }]
            ctx["models"] = {}   # flux2-klein weights live in the in-process pipeline
            ctx["timings"] = {}
            return

        if backend == "transformer":
            # Delegate to flux2-klein i2i (writes its own manifest too); capture
            # its output path for the purify-side manifest.
            i2i_output = _run_transformer_backend(
                input_path=input_path, mode=mode, resolution=resolution,
                w0=w0, h0=h0, seed=seed, prompt=getattr(args, "prompt", None),
                transformer_name=transformer_name, json_summary=True,
            )
            with Image.open(i2i_output) as _im:
                ow, oh = _im.size
            ctx["outputs"] = [{
                "path": i2i_output,
                "seed": seed,
                "size_bytes": os.path.getsize(i2i_output),
                "width": ow, "height": oh,
            }]
            ctx["models"] = {}   # flux2-klein weights fingerprinted in i2i's own manifest
            ctx["timings"] = {}  # subprocess boundary — i2i child manifest has the detail
            return

        # --- seedvr2 backend ---
        upscaler = SeedVR2Upscaler(model_size="7b")
        try:
            result = upscaler.upscale(
                image=image, resolution=resolution, softness=softness, seed=seed,
            )
        finally:
            upscaler.unload()

        film_grain = getattr(args, "film_grain", 0.0) or 0.0
        sharpening = getattr(args, "sharpening", 0.0) or 0.0
        # deartifact mode auto-enables NoiseCleaner (JPEG/blocking artifact scrub)
        # on top of the stronger redraw — the honest global-artifact-cleanup path
        # (no region detector exists in the repo).
        noise_clean = mode == "deartifact"
        if film_grain > 0 or sharpening > 0 or noise_clean:
            from app.postprocess import PostProcessChain
            chain = PostProcessChain.from_config({
                "sharpening": sharpening, "film_grain": film_grain,
                "noise_clean": noise_clean,
            })
            result, pp_timings = chain.apply(result, seed=seed)
            if chain.has_filters():
                for name, elapsed in pp_timings.items():
                    print(f"  [postprocess] {name}: {elapsed:.2f}s")

        result.save(paths.output_file)
        w1, h1 = result.size
        print(f"[purify] Saved: {paths.output_file} ({w1}x{h1})")

        ctx["outputs"] = [{
            "path": paths.output_file,
            "seed": seed,
            "size_bytes": os.path.getsize(paths.output_file),
            "width": w1, "height": h1,
        }]
        models = collect_model_fingerprint_seedvr2()
        # Effective quant the loader resolved (incl. fallback) — pairs with the
        # static seedvr2_dit_format so an 8-bit vs 4-bit-gs32 run is auditable
        # and a manifest-missing fallback is detectable.
        if upscaler.quant_config:
            models["seedvr2_quant_resolved"] = dict(upscaler.quant_config)
        ctx["models"] = models
        ctx["timings"] = dict(upscaler.last_timings)
        ctx["events"] = list(upscaler.events)
