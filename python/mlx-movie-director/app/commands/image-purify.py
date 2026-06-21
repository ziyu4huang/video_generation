"""image-purify — SeedVR2 AI high-quality redraw + upscale.

Uses SeedVR2's single-step diffusion with controlled softness to purify,
enhance, or fully redraw an image while optionally increasing resolution.

Mode presets control how much creative freedom the model has:
  purify  — light cleanup (softness 0.3), preserves most original detail
  enhance — balanced enhancement (softness 0.5, default)
  redraw  — high creative freedom (softness 0.8), model reinterprets content

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

from app.commands._shared import _arg_registered, build_run_py_cmd, run_session, OutputPaths
from app.manifest import collect_model_fingerprint_seedvr2

# ---------------------------------------------------------------------------
# Mode presets — softness controls pre-downsampling before diffusion
# ---------------------------------------------------------------------------

MODE_PRESETS = {
    "purify": 0.3,   # light cleanup, minimal reinterpretation
    "enhance": 0.5,  # balanced enhancement (default)
    "redraw": 0.8,   # high creative freedom, model reinterprets content
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

    # Resolution (guard: image-expansion registers --resolution too)
    if not _arg_registered(parser, "resolution"):
        parser.add_argument(
            "--resolution", type=str, default="same",
            help='Target resolution: "same" (no resize), pixels (e.g. 2160), or scale (e.g. 2x, 3x) (default: same)',
        )

    # Softness override (unique to purify — no guard needed)
    parser.add_argument(
        "--softness-override", type=float, default=None, metavar="FLOAT",
        help="Override mode's default softness (0.0-1.0). Advanced users only.",
    )

    # Backend: SeedVR2 (1-step upscale redraw, original behavior) vs transformer
    # (flux2-klein I2I redraw — prompt-guided, multi-step, different look). The
    # transformer backend delegates to `run.py image i2i --pipeline flux2-klein`.
    parser.add_argument(
        "--backend", dest="backend", choices=["seedvr2", "transformer"], default="seedvr2",
        help="Redraw backend: seedvr2 (SeedVR2 1-step, default) or transformer (flux2-klein I2I).",
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
# softness scale (purify < enhance < redraw). Higher denoise = more reinterpretation.
TRANSFORMER_DENOISE = {"purify": 0.35, "enhance": 0.55, "redraw": 0.85}

# SeedVR2 is prompt-free; the flux2-klein I2I redraw is prompt-guided, so the
# transformer backend falls back to a neutral quality prompt when --prompt is unset.
_DEFAULT_TRANSFORMER_PROMPT = "highly detailed, sharp focus, high quality, professional"


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
                           prompt=None, softness_override=None) -> dict:
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
        "denoise_strength": TRANSFORMER_DENOISE.get(mode, 0.55) if backend == "transformer" else None,
    }


def _run_transformer_backend(input_path, mode, resolution, w0, h0, seed, prompt,
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
        "--input-image", input_path,
        "--denoise-strength", str(denoise),
        "--width", str(out_w), "--height", str(out_h),
        "--seed", str(seed),
        "--prompt", use_prompt,
        "--json-summary",
    )
    print(f"[purify] transformer backend -> flux2-klein I2I "
          f"{out_w}x{out_h} denoise={denoise} mode={mode}")

    # Stream stdout live AND capture it (so we can parse JSON_SUMMARY afterwards).
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            text=True, bufsize=1)
    captured: list[str] = []
    assert proc.stdout is not None
    for line in proc.stdout:
        sys.stdout.write(line)
        captured.append(line)
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
# Entry point
# ---------------------------------------------------------------------------

def run_purify(args) -> None:
    """Run SeedVR2 purification / redraw / upscale (writes a manifest per run)."""
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
    image = Image.open(input_path).convert("RGB")
    w0, h0 = image.size
    print(f"[purify] {input_path} ({w0}x{h0}) mode={mode} softness={softness} "
          f"resolution={resolution} seed={seed}")

    backend = getattr(args, "backend", "seedvr2") or "seedvr2"

    # Output path + sibling run/manifest paths (CUSTOM location next to input,
    # preserved from the pre-manifest behavior).
    ext = os.path.splitext(input_path)[1]
    output_path = getattr(args, "output", None)
    paths = _make_purify_paths(input_path, mode, res_label, ext, explicit_output=output_path)

    # Write run.json BEFORE entering run_session (run_config=None path, since
    # RunConfig is t2i-specific and doesn't fit purify's mode/softness/resolution).
    run_meta = _build_purify_run_meta(
        args, input_path, mode, softness, resolution, res_label,
        backend, paths.output_file, seed,
        prompt=getattr(args, "prompt", None) if backend == "transformer" else None,
        softness_override=softness_override,
    )
    os.makedirs(os.path.dirname(os.path.abspath(paths.output_file)), exist_ok=True)
    _write_json(paths.run_file, run_meta)

    json_summary = getattr(args, "json_summary", False)
    with run_session(paths, run_config=None, json_summary=json_summary) as ctx:
        if backend == "transformer":
            # Delegate to flux2-klein i2i (writes its own manifest too); capture
            # its output path for the purify-side manifest.
            i2i_output = _run_transformer_backend(
                input_path=input_path, mode=mode, resolution=resolution,
                w0=w0, h0=h0, seed=seed, prompt=getattr(args, "prompt", None),
                json_summary=True,
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
        if film_grain > 0 or sharpening > 0:
            from app.postprocess import PostProcessChain
            chain = PostProcessChain.from_config({
                "sharpening": sharpening, "film_grain": film_grain,
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
