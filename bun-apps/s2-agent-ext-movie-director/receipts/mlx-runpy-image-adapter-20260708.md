# Receipt — mlx:runpy-image adapter (Step 1 of next-goal-20260708-080000)

**Date:** 2026-07-08
**Goal:** Unlock run.py's ~15 local, tested image sub-actions to the s2-agent
at **zero new generation code** — wiring, not new MLX. The bridge had only
`mlx:runpy` (VIDEO) + `mlx:caption`; the ENTIRE run.py image surface was
direct-CLI-only, so the agent could not call any of it. One adapter closes that.

## Verdict: SUCCESS

All Step 1 done-when gates met:

| Gate | Result |
|---|---|
| `mlx:runpy-image` adapter wired (mirror runPyCaption/runPyVideo) | ✅ `src/runpy_image.ts` — `runPyImage()` + `_spawnImpl` seam + manifest-sentinel parse + newest-image glob fallback |
| ≥4 run.py image sub-actions agent-callable through the bridge | ✅ 8 verified by routing proof: controlnet / faceswap / profile / twosubject / swap / anime2real / angle / purify (all → `runpy-image/mlx:runpy-image`); basic t2i/i2i stay on Swift directors |
| E2E smoke + real artifact | ✅ real 640×960 PNG, seed 777, 923 KB, 12.5–20.6s wall; manifest parsed (`status:success`, model `moody-pro-mix`) |
| pytest + bun green | ✅ bun 212 pass / 0 fail (added 24 tests); no Python touched (pytest unaffected) |
| Zero cloud | ✅ spawn is `python/venv/bin/python run.py image`; model id `moody-pro-mix` (local transformer); $0 cloud spend |

## What landed

- **`src/runpy_image.ts`** — `runPyImage(options)` spawns
  `python/venv/bin/python run.py image <action>`, parses the
  `Manifest:   <path>` sentinel (or `Manifest (error):`), reads the manifest's
  `output_files[{path,seed,size_bytes,width,height}]` + transformer model +
  `elapsed_seconds`, and globs the newest image as a fallback for sub-actions
  that don't use `run_session`. `ok` = exit 0 AND a real image landed (a 0-exit
  review/list-only run is NOT success — mirrors `adaptRunPy`).
- **`registry.ts`** — new `runpy_image` provider (`image_generation`,
  `invoke:"mlx:runpy-image"`, `commands:[controlnet,faceswap,swap,anime2real,
  profile,angle,purify,restore,multicouple,twosubject,workflow,expansion,i2i]`).
  Declared AFTER the Swift directors (same native_swift rank 0) and addressed by
  COMMAND, so the selector routes `{image_generation,"controlnet"|...}` here when
  no Swift director claims it; basic `t2i` falls through to the Swift directors.
- **`providers.ts`** — `mlx:runpy-image` probe = `runPyRuntimePresent()` (cached +
  `_setRunPyRuntimeForTest` seam added, mirroring the other probe setters so
  selector tests are host-independent).
- **`bridge.ts`** — `adaptRunPyImage`/`realRunPyImage` + wired into
  `realAdapters`; each output image → one `kind:"image"` artifact with
  seed/width/height/bytes; `model` = manifest transformer dir name.
- **`index.ts`** — exports `runpy_image.ts` + `caption.ts` (public surface).
- **Tests** — `src/runpy_image.test.ts` (argv / sentinel / manifest / extraArgs
  allowlist / spawn-seam success+failure+glob-fallback) + selector
  command-routing test (8 run.py-exclusive commands → runpy-image).
- **`scripts/runpy-image-e2e-smoke.ts`** — gated `MLX_E2E=1`; Proof 1 (routing,
  cheap) always runs; Proof 2 (real gen) opt-in.

## E2E output (Proof 2, MLX_E2E=1)

```
summary: image t2i: ✓ .../output_20260708_202708.png [moody-pro-mix]
details.ok: true
details.manifestStatus: success
details.model: moody-pro-mix
details.elapsedSeconds: 20.613468
details.outputs: [{ path: .../output_20260708_202708.png, seed: 777,
                    sizeBytes: 923552, width: 640, height: 960 }]
✓ E2E PASS — real image produced, routing correct, model is local, $0 cloud spend.
```

## Agent reach (no extension change needed)

The `movie` tool's `generate` command already does
`selectAndGenerate(capability, {command, options})`. So the agent now calls:

```
movie generate { capability:"image_generation", command:"controlnet",
                 options:{ prompt:"...", inputImage:"...", controlnetType:"pose" } }
```

→ selector command-routes to `runpy-image` → `realRunPyImage` → real local image.

## Notes / limits

- `extraArgs` is allowlist-gated (`EXTRA_ARG_ALLOW_RUNPY_IMAGE`); unlisted
  leading-dash flags are rejected (mirrors the runpy.ts video discipline; the
  high-frequency image flags are modeled in `RunPyImageOptions`).
- `i2i` is in the commands list (run.py owns the rich i2i+ControlNet path);
  the Swift flux2 director also has an i2i but declares no `commands`, so a
  caller wanting flux2 for i2i passes `provider:"flux2"` (soft hint wins).
