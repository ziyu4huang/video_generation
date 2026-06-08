# Character Profile Sheet Generation

`run.py image profile` generates multi-view character profile sheets (front / back / side).
Two pipelines are available with fundamentally different capabilities.

## Pipeline Comparison

| Mode | Pipeline | Character Consistency | Best For |
|------|----------|-----------------------|----------|
| T2I only (no `--input`) | ZImage-Turbo | None — different character each view | Concept art, prompt angle testing |
| Reference-conditioned (`--input photo.png`) | Flux2-Klein Edit | Yes — same identity across all views | Character sheets from reference photo |

## ZImage Profile (T2I Only)

When `--input` is not provided, the command falls back to ZImage-Turbo:

```bash
run.py image profile --ratio standing --steps 6
```

- Each view is generated independently from text prompts only
- No reference conditioning → each view shows a **different random character**
- Useful for: testing whether prompt wording produces the correct view angle
- The `profile-zimage` and `profile-prompt-abc` self-tests cover this mode

**What to expect:** Front, back, and side views will look like different people. This is not a
bug — ZImage has no reference conditioning mechanism. See
`docs/zimage-turbo-vs-flux2-klein-reference-conditioning.md` for the architectural explanation.

## Flux2-Klein Profile (Reference-Conditioned)

When `--input reference.png` is provided, the command uses Flux2-Klein Edit:

```bash
run.py image profile --input reference.png --ratio standing --steps 6
```

- Reference image is encoded as latents and conditioned alongside denoising
- Character identity (face, outfit, hair, style) is maintained across all views
- `--prompt-style angle` (default) uses short prompts — the reference latent does the heavy lifting
- `--prompt-style detailed` adds explicit anatomy guidance per view (helps with back/side angles)

**Chain-ref:** Views are generated in the order `front → side → back`. Each generated view is
passed as an additional reference for the next, improving consistency.

## Prompt Styles

Three prompt styles are tested by the self-tests:

| Style | Source | Language | Prompt length | Best for |
|-------|--------|----------|---------------|----------|
| `angle` (default) | `VIEW_PROMPTS_FLUX2` | Chinese + English | ~120 chars | Flux2-Klein (reference does the work) |
| `detailed` | `VIEW_PROMPTS_FLUX2_DETAILED` | Chinese, long | ~300 chars | Flux2-Klein when anatomy guidance needed |
| `v1-medium` | ComfyUI fp16 workflow | Chinese, medium | ~60 chars | ZImage T2I |
| `v2-ultrashort` | CivitAI v2 workflow | Short Chinese | ~18 chars | Research / comparison only |

## Self-Tests

Run these to compare pipelines and prompt styles:

```bash
VENV=/Users/huangziyu/proj/video_generation/python/venv/bin/python
RUN=python/mlx-movie-director/run.py

# ZImage: 9 images — tests view-angle prompt accuracy only (no character consistency)
$VENV $RUN image review --self-test profile-prompt-abc
# Variants: v1-medium / v2-ultrashort / angle-EN (ZImage native defaults)
# VLM checks: view_correct / full_body / apose / clean_bg per image

# Flux2-Klein: generates reference portrait first, then produces 3-view profile
$VENV $RUN image review --self-test profile-flux2-gen
# Step 1: ZImage T2I → reference portrait (640×960, 9 steps, seed=42)
# Step 2: Flux2-Klein → front / side / back with reference conditioning
# VLM verifies each view angle; inspect visually for character consistency

# Flux2-Klein A/B/C: same reference, 3 prompt styles — VLM picks the winner
$VENV $RUN image review --self-test profile-flux2-abc
# Variants: v1-medium / v2-ultrashort / angle-EN (VIEW_PROMPTS_FLUX2 defaults)
# 9 images total (3 styles × 3 views), all from the same generated reference
```

Alias shortcuts:

```bash
$VENV $RUN image review --self-test profile          # → profile-zimage (ZImage default)
$VENV $RUN image review --self-test profile-abc      # → profile-prompt-abc
$VENV $RUN image review --self-test profile-flux2    # → profile-flux2-gen
```

## VLM Verification Results

> **To be filled in after running `profile-prompt-abc` and `profile-flux2-abc`.**

The VLM (`qwen/qwen3-vl-4b`) evaluates each generated view on four criteria:

| Criterion | Meaning |
|-----------|---------|
| `view_correct` | Is this actually a front / back / side view as requested? |
| `full_body` | Are feet and shoes visible at the bottom of the frame? |
| `apose` | Are arms slightly away from the body (A-pose)? |
| `clean_bg` | Is the background white or neutral without clutter? |

Results are saved to `<image>.caption.json` with `style: "profile-verify"` and displayed as
✓/✗ badges in the HTML review output (`selftest-profile-*.html`).

## Key Architectural Constraint

ZImage-Turbo **cannot** replicate Flux2-Klein Edit's reference latent conditioning. This is an
architectural limitation — ZImage uses simple noise interpolation (img2img), while Flux2-Klein
concatenates the reference image latent alongside the denoising trajectory in the transformer.
Retraining would be required to add reference conditioning to ZImage.

See `docs/zimage-turbo-vs-flux2-klein-reference-conditioning.md` for the full analysis.
