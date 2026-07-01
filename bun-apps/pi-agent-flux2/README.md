# pi-agent-flux2

A [pi-agent](https://github.com/earendil-works/pi-coding-agent) extension that wraps the
`swift/flux2-image-director` CLI (`flux2`) as **one agent-optimized tool**.

`flux2` is a pure-Swift/MLX image generator (Flux2 Klein 9B + SAM3.1) with 18 subcommands.
This extension exposes them through a single `flux2` dispatcher tool with typed per-command
parameters, structured manifest parsing, progress streaming, abort support, and path-safety
guards — so an agent can generate, gate, and chain images without memorizing flags.

## What it does

- **One tool, 18 commands.** `flux2({ command, options })` — `command` is one of
  `t2i · scene · edit · style · angle · swap · expand · upscale · gate · segment · story ·
  models · verify-vae/encoder/tokenizer/transformer/e2e/edit`.
- **Typed options.** `options` is camelCase keys mapped to flux2 flags (`cfgScale`→`--cfg-scale`).
  Defaults come from the CLI itself — omit a field to use it.
- **Structured results.** Every generation returns `details.output` (PNG path), `outputs[]`,
  dimensions, seed, `gate` (auto-runs `flux2 gate` on the output), and `perf` — parsed from the
  `.manifest.json` sidecar. Chain `scene → gate → upscale` by reusing `details.output`.
- **Binary auto-build.** Resolves `.build/release/flux2`; if missing, streams
  `swift build -c release` once and caches it.
- **Safe by default.** All paths validated under repo / output-dir / models-tree roots; flag-like
  values rejected (anti-argv-injection).
- **Multi-seed `scene` pipeline.** `scene` refs are global tokens (no identity→region binding),
  so placement/pose is prompt-driven & reliable-but-probabilistic. Pass `scenePipeline: { seeds }`
  to render the same scene across N seeds, gate each, optionally VLM-verify each (via a shared
  pi-vlm subagent), and auto-pick a winner — instead of looping single `scene` calls yourself.
  See [§ Multi-seed scene pipeline](#multi-seed-scene-pipeline) below.

## Load

```bash
# Source mode (hot):
bun bun-apps/pi-agent/src/cli.ts \
  -e bun-apps/pi-agent-flux2/extensions/pi-flux2.ts \
  -p "generate a 1024×1024 t2i image of a cat, seed 42"
```

```bash
# Bundle:
cd bun-apps/pi-agent-flux2 && bun scripts/build-bundle.ts   # → dist/pi-extensions/pi-agent-flux2.bundle.js
```

## Multi-seed scene pipeline

`flux2({ command: "scene", options: {...}, scenePipeline: { seeds: [11, 22, 33] } })` renders
the SAME `options` once per seed, gates each, and picks a winner:

- `seeds` (required) — one render per seed, in order.
- `verifyPrompt` — question asked of a VLM subagent about each rendered candidate (e.g.
  `"Describe each person's LEFT/RIGHT position and pose."`). Reuses pi-vlm's shared subagent
  (`askImage`/`resolveLLM`, default `lm-studio/google/gemma-4-26b-a4b-qat`) — not a new LM Studio
  client. Omit to skip VLM verification (candidates are still generated + gated).
- `verifyMatch` — case-insensitive substrings that must ALL appear in a candidate's VLM reply to
  win (first matching seed, in order). Falls back to the best-gated candidate if omitted or
  nothing matches.
- `vlmModel` — `"provider/modelId"` override for the VLM subagent.
- `handRepairWinner` — re-render the winning seed once more with `--hand-repair`.

`details.output` is the winner's (or hand-repaired winner's) PNG path — chains exactly like a
single `scene` call. `details.scenePipeline.candidates[]` has every seed's output/gate/VLM verdict.
Per-seed outputs are auto-suffixed (`name` → `name_seed<N>`) so seeds never overwrite each other's
file even when you pass a fixed `name`/`output`.

This formalizes the workflow `scripts/multi-seed-autoselect.sh` / `scripts/scene-classroom-demo.sh`
already do by hand (render N seeds → VLM-verify placement/activity → rank → pick), as a
first-class, testable tool capability instead of a bash script with hardcoded absolute paths.

## Env overrides

| Var | Purpose |
| --- | --- |
| `FLUX2_BIN` | Prebuilt binary path (skip resolution/build). |
| `FLUX2_REPO_ROOT` | Repo root (required in bundle/binary mode). |
| `MLX_OUTPUT_DIR` | Output directory. |
| `MLX_MODELS_DIR` | Models tree root. |

## Development

```bash
bun run check:flags     # drift guard: every flux2 flag modeled or allow-listed
bun run build:bundle    # produce the single-file bundle
```

`src/commands.ts` is the single source of truth for the command surface; it is curated against
`swift/flux2-image-director/Sources/Flux2DirectorCLI/*Command.swift` and verified by
`check:flags`. When the CLI adds/renames a flag, `check:flags` fails until `commands.ts` is updated.

## Layout

```
extensions/pi-flux2.ts   # the dispatcher tool (thin wrapper around runFlux2)
src/index.ts             # runFlux2() — pure, pi-free pipeline
src/commands.ts          # 18 commands: typed params + flag map (source of truth)
src/binary.ts            # resolve / auto-build the flux2 binary
src/invoke.ts            # spawn + stream + abort
src/result.ts            # manifest parsing → structured details
src/paths.ts             # path-safety / argv-injection guards
src/scenePipeline.ts     # multi-seed scene pipeline (render/gate/verify/pick-winner loop)
src/vlm.ts               # thin adapter over pi-vlm's shared VLM subagent
scripts/check-flags.ts   # drift guard
scripts/build-bundle.ts  # single-file bundle
```
