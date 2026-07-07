# Receipt — gemma-4-26b-a4b-qat universal VLM default (scan-and-switch cert)

**Date:** 2026-07-08 local
**Goal:** `next-goal-20260708-062053.md` Step 2. Certify that `run.py caption`
resolves to the local gemma brain (NOT the over-praising Qwen3-VL-4b) after the
scan-and-switch, and that the score tier is observably less sycophantic. This is
the vision-tier anchor for the OpenMontage local-extraction
([[openmontage-local-port-gap-analysis]]) — OM's "orchestrator-is-the-vision-model"
assumption is replaced by an explicit local VLM, now gemma-backed.

## Verdict: SUCCESS

| Gate | Result |
|---|---|
| `run.py caption` resolves to gemma (not Qwen3-VL) | ✅ `[caption] Auto: google/gemma-4-26b-a4b-qat already loaded` |
| Output JSON `model` field is gemma | ✅ `"model": "google/gemma-4-26b-a4b-qat"` |
| `score` style is observably less sycophantic | ✅ overall 7/10, detail 6/10, concrete defect flagged |
| Only local models touched (zero cloud) | ✅ LM Studio catalog = {gemma-4-26b-a4b-qat} only |

## Invocation

```
python/venv/bin/python python/mlx-movie-director/run.py caption \
  ../video_generation__output/ab_klein.png --style score --lang en
```

LM Studio loaded set at run time (native /api/v1/models):
`['google/gemma-4-26b-a4b-qat']` — exactly one local model, no cloud id.

## Output (gemma score, 16.79s)

```json
{"model": "google/gemma-4-26b-a4b-qat", "style": "score",
 "caption": {
   "overall": 7, "detail": 6, "sharpness": 8, "composition": 8,
   "prompt_adherence": 10, "artifacts": 9,
   "issues": ["Oversmoothed skin texture on hands and neck"],
   "strengths": ["Natural lighting", "Clear facial features", "Good depth of field"],
   "summary": "A well-composed professional portrait that exhibits slightly
               oversmoothed skin textures on the hands and neck."}}
```

The `overall: 7` + a SPECIFIC defect ("Oversmoothed skin texture") is the
over-praise reduction: the prior Qwen3-VL path trended to 9–10 with vague praise
([[vlm-caption-overpraise-qa-gap]]). Gemma gives a discriminating 7 with a
concrete, actionable issue — exactly the quality gate behavior OM's review tier
needs.

## Scan-and-switch surface (Step 1, completed this goal)

`_DEFAULT_MODEL` → `google/gemma-4-26b-a4b-qat` + `_FALLBACK_MODELS =
["qwen/qwen3-vl-4b"]` (Qwen demoted to no-gemma auto-load fallback only):
- `caption.py` — `_DEFAULT_MODEL` + rewritten `_resolve_model` (catalog-aware
  fallback) + public `resolve_default_model()`.
- `import-checkpoint.py`, `import-lora-image.py` — `_DEFAULT_MODEL` literals.
- `image-review.py` — 9 hardcoded sites routed through `resolve_default_model()`
  (the load-bearing over-praise fix: auto-score, review-html, controlnet/profile
  verify, selftest + swap-all caption loops).
- `image-faceswap.py:348`, `image-profile.py` (arg default None + 3 resolve sites).
- Inherits via `_DEFAULT_MODEL`: `image-twosubject.py`, `video-segment.py`.
- `lens_reasoner.py` already gemma (unchanged).

## Step 3 — `mlx:caption` movie-director capability (e2e through the bridge)

Wired the local VLM as a first-class **analysis** capability — the explicit
replacement for OM's "orchestrator-LLM-is-the-vision-model" assumption:

- `registry.ts`: `caption_vlm` entry `{capability:"analysis", invoke:"mlx:caption",
  commands:["caption"], configured:true}` + `"mlx:caption"` added to the invoke union.
- `providers.ts`: `probeConfigured` case `mlx:caption` → `runPyRuntimePresent()`
  (honest: callable iff run.py+venv resolve; model-load is a runtime concern).
- `caption.ts` (new): `runPyCaption()` shells `run.py caption <img> --style … --lang …`
  and parses the `<stem>.caption.json` (splitext, matching run.py); `_spawnImpl`
  test seam; `captionPathFor`/`readCaption`/`buildCaptionArgs` exported.
- `bridge.ts`: `adaptCaption`/`realCaption` + `"mlx:caption"` in `realAdapters`;
  `ArtifactKind` gained `"text"`; artifact = the caption JSON (kind:"text").

E2E smoke (`scripts/caption-e2e-smoke.ts`, `MLX_E2E=1`, real gemma on local metal):

```
entry: caption_vlm | invoke: mlx:caption
success: true | provider: caption-vlm | model: google/gemma-4-26b-a4b-qat
artifacts: [{"path":"../video_generation__output/ab_klein.caption.json","kind":"text","role":"caption"}]
cost_usd: 0
```

The selector routes `{analysis, command:"caption"}` to `mlx:caption` (whisper owns
`transcribe`, clip owns `video_understand` — command-tiebreak). `movie generate
{capability:"analysis", command:"caption", options:{image, style, lang}}` now
works end-to-end, zero cloud (only HTTP induced is localhost:1234 LM Studio).
