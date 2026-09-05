# gui-flux2-director

Bun web UI (expert studio) over the [`swift/flux2-image-director`](../../swift/flux2-image-director)
and [`swift/ltx-video-director`](../../swift/ltx-video-director) CLIs —
generate good-quality images with **Flux2 Klein 9B** and multi-scene **story
videos with voice** (LTX-2.3 joint audio-video) on Apple Silicon MLX, without
hand-assembling CLI flags.

## Run

```bash
# one-time: build both binaries (ALWAYS release — debug hits a metallib crash)
swift build -c release --package-path swift/flux2-image-director
bash swift/flux2-image-director/scripts/build-metallib.sh
swift build -c release --package-path swift/ltx-video-director
bash swift/ltx-video-director/scripts/setup-metallib.sh release

( cd bun-apps && bun install )           # workspace link
( cd bun-apps/gui-flux2-director && bun run dev )
# → http://127.0.0.1:3123  (PORT env overrides; walks up on conflict)
```

## Story mode (flux2 × LTX, with voice)

The **Story** tab runs a three-stage pipeline as one job:

1. **Keyframes** — one `flux2 t2i` per scene (shared cinematic style prefix +
   seed family `seed+i`), giving consistent panels.
2. **Grid** — ffmpeg `hstack` stitches the panels into the shared NxN grid
   image the storyboard relay pins identity with.
3. **Render** — `ltx-video native-storyboard` (hard-cut relay): each segment
   T2Is its frame 0, pins its grid panel (strength 0.525), animates with
   LTX-2.3 distilled **generating synchronized audio/voice from the scene
   prompt** (rain, thunder, meows, wind — write voice cues into the prompt),
   and concatenates everything into one H.264+AAC mp4 (AVAssetWriter, no
   ffmpeg on the LTX side).

The default story ("Miko in the Lighthouse", 4 scenes) ships in the UI — edit
any scene, pick 1–4 scenes × 1–8s, landscape/portrait, seed, and Generate
Story. Past runs appear under the player (`GET /api/story`). A 4×2s story
renders in roughly 10 minutes on this machine; cancel works mid-pipeline.

## What the UI gives you

- **Quality presets** — Draft (4 steps) / Balanced (6) / Quality (8 steps +
  Realism & Detail LoRA stack + auto 4× RealPLKSR upscale).
- **LoRA stack builder** — every LoRA under `mlx-models/lora/` with per-LoRA
  scale sliders; one-click stacks (`Realism & Detail`, the README's scene-tuned
  `Full 12-stack`). Stacks are filtered to what exists on disk.
- **Expert sampling controls** — steps, CFG (1.0 = distilled-recommended),
  seed with dice/lock, transformer picker, 16-px-aligned size presets.
- **Live job panel** — SSE stage stream (queued → loading → diffusing → done)
  with the raw flux2 log and a cancel button. Generations are single-flight
  (the server 409s while the 9B transformer owns the GPU).
- **Gallery** — every output the CLI ever wrote (it reads the `.run.json` /
  `.manifest.json` audit sidecars), prompt filter, click-through preview, and
  a one-click `Upscale 4×` that lands `.4x.png` next to the source.

## Server surface

| Route | What |
|---|---|
| `GET /api/health` | binary/models/output paths + running flag |
| `GET /api/models` | transformer / lora / upscale / vae inventory |
| `POST /api/generate` | validated `flux2 t2i` (incl. `--lora`/`--lora-scale`/`--strict-gate`) → `{jobId}` |
| `POST /api/upscale` | `flux2 upscale` on an output-dir image → `{jobId}` |
| `POST /api/story` | keyframes → grid → `native-storyboard` (voiced) → `{jobId}` |
| `GET /api/story` | default story + past story runs |
| `GET /api/jobs/:id/events` | SSE job stream (`state` / `stage` / `log`) |
| `POST /api/jobs/:id/cancel` | SIGTERM the child tree |
| `GET /api/gallery` | manifest-backed history, newest first |
| `GET /api/media?path=` | output-dir-contained image/mp4 serving |

Path safety: client-supplied paths must resolve inside the output dir; model
names must be bare path components (the CLI joins them onto the models root).

## Swift-side enhancement this UI assumes

`flux2 t2i` gained `--lora`/`--lora-scale` (rank-stacked via
`Flux2LoRALoaderCLI.loadMerged`, identical to `scene`) and `--strict-gate`
(ImageGate before save) — that is what makes the quality stack available to
plain text-to-image.

## Tests

```bash
( cd bun-apps/gui-flux2-director && bun run test )   # typecheck + bun test
```
