# s2-agent-ext-ltx

A [s2-agent](https://github.com/earendil-works/pi-coding-agent) extension that wraps the
`swift/ltx-video-director` CLI (`ltx-video`) as **one agent-optimized tool**.

`ltx-video` is LTX-2.3 image-to-video generation on Apple Silicon (MLX) — the standing
native-Swift-port effort tracked in this repo's `project-ltx-swift-native-port` memory. This
extension exposes its 15 subcommands through a single `ltx` dispatcher tool with typed
per-command parameters, stdout-regex result parsing (ltx-video writes no manifest sidecar,
unlike `s2-agent-ext-flux2`), progress streaming, abort support, and path-safety guards.

## What it does

- **One tool, 15 commands.** `ltx({ command, options })` — `command` is one of
  `t2i · native-i2v · native-upscale · native-t2a · native-relay · native-ingredients ·
  native-restyle · segment · i2v · upscale · gate · verify · models · audio-decode ·
  video-decode`.
- **Typed options.** `options` is camelCase keys mapped to ltx-video flags
  (`t2iTransformer`→`--t2i-transformer`). Defaults come from the CLI itself — omit a field to
  use it. Tri-state booleans backed by ArgumentParser's `.prefixedNo` inversion (e.g.
  `upscale`/`refine`) emit `--no-x` when set to `false`, not just omission.
- **Structured results.** Every command returns `details.output` (the primary generated
  path — video file / frame directory / image, whichever applies) parsed from the CLI's own
  stdout prints, plus `details.extraOutputs` for secondary paths a command also produces
  (e.g. `native-i2v`'s `audio`, `upscaledFrames`). Chain `native-i2v → gate` by reusing
  `details.output`.
- **Binary auto-build.** Resolves `.build/release/ltx-video`; if missing, streams
  `swift build -c release` once, colocates `mlx.metallib` via the package's
  `scripts/setup-metallib.sh`, and caches it.
- **Safe by default.** All paths validated under repo / output-dir / models-tree roots;
  flag-like values rejected (anti-argv-injection); `native-i2v`'s `--lora path[:strength]`
  specs are validated on the path portion only.

## `native-i2v` vs `i2v`

- **`native-i2v`** — the pure-Swift/MLX experimental path, **zero run.py anywhere**. Distilled
  transformer only, no VLM prompt expansion, PNG frame sequence + WAV + real `.mp4` (on by
  default via `mp4`, muxed with `AVAssetWriter`). Supports First-Last-Frame conditioning
  (`lastFrame`, plus `lastFrameStrength`/`lastFrameAutoResize`/`lastFrameDerivesResolution`),
  custom audio injection (`audioTrack`), an arbitrary supplied frame-0 image instead of a
  T2I-generated one (`inputImage` — used by `native-relay` to chain segments), LoRA fusion
  (`loras`), an automatic post-upscale refine pass (`upscale`/`refine`, both on by default),
  and an optional chained second upscale+refine pass (`secondStage: "x1.5" | "x2"`).
- **`i2v`** — the production pipeline (ZImage T2I → VLM prompt → LTX I2V). Still bridges
  through `run.py` internally for the VLM/quality-check/vlm-score stages. Higher default
  quality/duration, writes a real `.mp4`.

## `native-t2a` and `segment`

- **`native-t2a`** — audio-only generation, 100% native Swift/MLX, no video at all (no T2I,
  no I2V, no `run.py`). Use when the deliverable is just a voice/sound WAV.
- **`segment`** — scene-cut detection on an existing video (HSV-histogram correlation, no VLM
  scoring, no generation). Returns `details.scenes` (start/end frame + duration per cut) and,
  if `json` is given, writes the same report to disk as `details.output`.

## `native-relay`, `native-ingredients`, `native-restyle`

- **`native-relay`** — multi-segment prompt-relay video, 100% native Swift/MLX, no `run.py`,
  no ffmpeg (experimental, distilled-only). Chains N `native-i2v`-style generations via
  `inputImage`, each segment's last decoded frame feeding the next segment's start, then
  concatenates them. `prompts` (one per segment), `loras` (applied to every segment),
  `relayAudio`/`relayTtsText` (final-video audio replace/TTS narration), and `variant`
  (A/B comparison — runs the whole relay once per named LoRA variant).
- **`native-ingredients`** — single-reference-image video generation via a user-supplied
  Ingredients IC-LoRA adapter (character/product/scene conditioning). `lora` has no bundled
  default — bring your own IC-LoRA checkpoint.
- **`native-restyle`** — V2V restyle of an existing `native-i2v` frame sequence via a
  user-supplied style IC-LoRA adapter. Also no bundled `lora` default.

## Load

```bash
# Source mode (hot):
bun bun-apps/s2-agent/src/cli.ts \
  -e bun-apps/s2-agent-ext-ltx/extensions/ltx.ts \
  -p "list installed LTX-2.3 transformer variants"
```

```bash
# Bundle:
cd bun-apps/s2-agent-ext-ltx && bun scripts/build-bundle.ts   # → dist/pi-extensions/s2-agent-ext-ltx.bundle.js
```

## Env overrides

| Var | Purpose |
| --- | --- |
| `LTX_VIDEO_BIN` | Prebuilt binary path (skip resolution/build). |
| `LTX_VIDEO_REPO_ROOT` | Repo root (required in bundle/binary mode). |
| `MLX_OUTPUT_DIR` | Output directory. |
| `MLX_MODELS_DIR` | Models tree root (path-safety only — ltx-video has no `--models-root` CLI flag; the model tree location is baked in at build time via `RepoPaths.mlxModelsRoot`). |

## Development

```bash
bun run check:flags     # drift guard: every ltx-video flag modeled or allow-listed
bun run build:bundle    # produce the single-file bundle
```

`src/commands.ts` is the single source of truth for the command surface; it is curated against
`swift/ltx-video-director/Sources/LTXVideoDirectorCLI/*Command.swift` and verified by
`check:flags`. When the CLI adds/renames a flag, `check:flags` fails until `commands.ts` is
updated.

See [TODO.md](TODO.md) for open work on this wrapper (result-parsing gaps, error-surfacing,
untested paths — not the underlying Swift CLI's own roadmap, which lives in
`swift/ltx-video-director/PLAN.md`).

## Layout

```
extensions/ltx.ts     # the dispatcher tool (thin wrapper around runLtx)
src/index.ts              # runLtx() — pure, pi-free pipeline
src/commands.ts           # 15 commands: typed params + flag map (source of truth)
src/binary.ts              # resolve / auto-build the ltx-video binary
src/invoke.ts              # spawn + stream + abort
src/result.ts               # stdout-regex parsing → structured details (no manifest sidecar)
src/paths.ts                # path-safety / argv-injection guards
scripts/check-flags.ts     # drift guard
scripts/build-bundle.ts    # single-file bundle
```
