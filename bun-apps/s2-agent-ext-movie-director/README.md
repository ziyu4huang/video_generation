# s2-agent-ext-movie-director

The movie-director **orchestration extension** — an instruction-driven (agent-first)
video production pipeline, rewritten from [OpenMontage](https://github.com/jieg9341-lab/ComfyUI-Krea2-StyleTransfer-adjacent) (Python) into pure Bun + Swift-MLX-native.

> Iteration 1 (foundation): pipeline manifest loader, gate-enforced checkpoints,
> artifact schema validation, budget tracker, provider registry. Media generation
> bridges (native directors + ffmpeg + cloud) land in later iterations.

## Why

OpenMontage is **agent-first**: Python is only tools + persistence; the agent
(reading YAML pipeline manifests + MD stage-director skills) IS the orchestrator.
`s2-agent` is already an agent runtime — so the rewrite is a 1:1 fit: the
orchestration becomes a Bun pi-extension, and the Python tools become the repo's
existing native Swift/MLX directors (`krea2-image-director`, `flux2-image-director`,
`ltx-video-director`) + ffmpeg/cloud bridges.

Pipeline: `idea/research → proposal → script → scene_plan → assets → edit → compose → publish`,
with 7 canonical artifacts, style playbooks, an advisory reviewer, checkpoint gates
with human-approval policy, and a cost tracker. See `output/new-goal-20260704-2238.md`
for the full long-term goal + roadmap.

## What's here (iteration 1)

```
extensions/movie-director.ts    # ONE `movie` dispatcher tool (18 commands)
src/pipeline.ts                    # manifest loader + stage accessors (port of lib/pipeline_loader.py)
src/checkpoint.ts                  # gate-enforced checkpoint writer/reader (port of lib/checkpoint.py)
src/schema.ts                      # ajv validation over bundled OpenMontage schemas
src/cost.ts                        # budget tracker: estimate → reserve → reconcile (port of tools/cost_tracker.py)
src/registry.ts                    # explicit provider registry + provider-menu rollup
src/paths.ts                       # data dir + project workspace resolution
data/                              # manifests + schemas + playbooks (copied verbatim, MIT)
```

### The gate (the binding rule)
`write-checkpoint` with `status="completed"` on a stage whose manifest
`human_approval_default=true` is **rejected** unless `humanApproved=true`. This is
the one hard enforcement — the agent cannot silently skip a human-approval gate.
Match-checked against `talking-head` (idea/script/scene_plan/assets/publish gated;
edit/compose not).

## Standalone CLI

A self-contained CLI mirrors `s2-agent`'s shape, exposing the 18
orchestration commands as **deterministic, no-LLM** top-level commands (each a
direct call to the same `dispatch()` the `movie` agent tool calls), plus an
`agent` command for natural-language runs. This makes orchestration workflows
scriptable and CI-friendly without spinning up an LLM for the parts that don't
need one (preflight, pipeline introspection, checkpoint reads/writes, cost,
compose, final-review).

```bash
# from repo root
bun bun-apps/s2-agent-ext-movie-director/src/cli.ts <command> [options]
# or via the package script / short alias
bun run --cwd bun-apps/s2-agent-ext-movie-director md <command> [options]
```

### Deterministic commands (no LLM — direct orchestration-core calls)

| Command | Summary |
|---------|---------|
| `preflight` | provider-menu summary (capabilities, composition runtimes, gaps) |
| `pipeline-list` | available pipeline manifests |
| `pipeline-show` | `{pipeline}` → stages, approval gates, produces |
| `init-project` | `{projectId, pipeline}` → project workspace + projectDir + assetsDir |
| `next-stage` | `{pipeline, stage?}` → next stage + its human-approval policy |
| `write-checkpoint` | `{projectId, pipeline, stage, status, …}` — ENFORCES THE GATE |
| `read-checkpoint` | `{projectId, pipeline, stage?}` → checkpoint + completed stages |
| `validate-artifact` | `{artifact, data}` → schema validation |
| `generate` | `{capability, command, options?, …}` → native director (krea2/flux2/ltx) |
| `compose` | `{editDecisions, …}` → ffmpeg straight-cut .mp4 |
| `compose-remotion` | `{editDecisions, …}` → Remotion templated compose |
| `compose-motion` | `{editDecisions, …}` → ffmpeg zoompan/xfade motion compose |
| `pre-compose` | `{editDecisions, …}` → deterministic pre-render gate |
| `final-review` | `{mp4Path, …}` → delivery + advisory transcript checks |
| `cost-estimate` / `cost-reserve` / `cost-reconcile` / `cost-snapshot` | budget lifecycle |

### Passing options

Options map straight onto the `dispatch()` call:

```bash
# loose --key value flags (value-coerced: number/bool/JSON/string)
.../cli.ts write-checkpoint \
  --projectId demo --pipeline talking-head --stage idea --humanApproved

# --options '<JSON>' merge (escape hatch for nested values)
.../cli.ts generate --capability image_generation --command t2i \
  --options '{"options":{"prompt":"a red cube","width":1024}}'

# --json wraps the result in {ok, command, result|error} for scripts
.../cli.ts pipeline-list --json
```

### `agent` — natural-language orchestration

`agent` shells out to the pi binary (`bun bun-apps/s2-agent/src/cli.ts`) with
this extension baked in (`-e`) — the same invocation documented above for
agent-driven runs. Override the pi entry via `PI_BIN`. Use it only when you
need the LLM to map a free-form concept onto the pipeline:

```bash
.../cli.ts agent produce a 30s ad: red sports car on a coastal road
.../cli.ts agent --model sonnet "3-scene product demo"
# a bare unknown prompt is treated as an agent prompt (passthrough):
.../cli.ts "plan a 30s animated explainer"
```

## Use

```bash
bun install                                # at repo root (workspace member)
bun test                                   # in this package
bun run check:schemas                      # validate every bundled manifest + schema
```

Load the extension (source mode):
```bash
bun bun-apps/s2-agent/src/cli.ts \
  -e bun-apps/s2-agent-ext-movie-director/extensions/movie-director.ts \
  -p "run preflight, then plan a 30s animated-explainer"
```

The `movie` tool's commands: `preflight`, `pipeline-list`, `pipeline-show`,
`init-project`, `next-stage`, `write-checkpoint`, `read-checkpoint`,
`validate-artifact`, `generate`, `compose`, `compose-remotion`, `compose-motion`,
`pre-compose`, `final-review`, `cost-estimate`, `cost-reserve`, `cost-reconcile`,
`cost-snapshot`. See the tool description for the per-command options.

## Workflow integration (`s2-agent-ext-ultracode`)

When loaded alongside `s2-agent-ext-ultracode`, this extension also exposes the
20 `dispatch()` commands as **`movie.*` host-fns** callable from any workflow
script via `call('movie.<command>', args)` (deterministic, zero-token,
journaled), and registers **four saved workflow commands** that run the
pipeline as parallel, background-able, **journaled-resumable** workflows:

| Command | What it does |
|---------|--------------|
| `/produce-video` | Full pipeline (idea→publish) as one resumable workflow; composes the other three |
| `/scene-assets` | Parallel per-scene T2I→I2V (chained)→TTS generation |
| `/research-first` | Web research (parallel angles) → cross-check → proposal_packet |
| `/review-cut` | Adversarial review of a composed cut; gates publish |

```bash
# prerequisite: keep workflow dist in sync with src after workflow src changes
( cd bun-apps/s2-agent-ext-ultracode && bun run build )

# load both extensions; the /commands + movie.* host-fns become available
bun bun-apps/s2-agent/src/cli.ts \
  -e bun-apps/s2-agent-ext-movie-director \
  -e bun-apps/s2-agent-ext-ultracode \
  -p "/produce-video concept='a 15s animated explainer about how tides work'"
```

Deterministic steps use `call('movie.*')`; creative steps use `agent()` with
real model routing; review uses `verify()`. Two-layer cost: workflow `budget`
tracks agent tokens; movie-director's cost lifecycle tracks media `$`. Each run
persists a durable journal and is crash-resumable — see **Crash-resumability**
below. See `receipts/workflow-redesign-20260712.md` for the full design +
keystone findings.

### Crash-resumability

Each `/command` runs through a `WorkflowManager` that persists a journal to
disk after every `agent()` and `call('movie.*')` step (via
`onAgentJournal → save`). A run killed mid-flight — `kill -9`, a kernel panic
under sustained GPU load, or power loss — leaves the journal intact on disk:

- **Auto-recovery on next start:** `WorkflowManager.recoverStaleRuns()` detects
  any persisted run still marked `"running"` and reconciles it to `"paused"`
  (never `"failed"`), so its journal survives and the run is resumable.
- **Resume:** `/workflows resume <runId>` replays the completed prefix from the
  journal (zero re-cost — cached results are returned, not regenerated) and runs
  only the remaining work. Find the `runId` via the `/workflows` navigator.
- **Partial media is safe:** `dispatch.generate` has no skip-if-exists cache —
  it always re-renders, so an interrupted `call('movie.generate')` (which never
  journaled, since `onAgentJournal` fires only on success) simply re-runs on
  resume and overwrites any partial file.

This directly addresses the 2026-07-12 kernel-panic data-loss class. Permanent
proof: `src/resume.test.ts` (deterministic, CI-able — `recoverStaleRuns` +
real-journal-prefix replay that deep-equals a clean run). Real-world GPU
kill→resume receipt: `receipts/resume-robustness-20260712.md`.

### Compose — ffmpeg foundation vs Remotion templated tier

- `compose` — ffmpeg straight-cut: trims each cut to its `[in,out]` window and
  concatenates. Always available (only needs ffmpeg on PATH). No animation.
- `compose-remotion` — templated compose via a Remotion subprocess
  (`remotion/` subdir): per-cut ken-burns/zoom/pan motion, crossfade
  transitions, `section_title` overlays, narration/music audio. Each cut takes an
  optional `animation` (`"ken-burns" | "zoom-in" | "zoom-out" | "pan-left" |
  "pan-right" | "static"`); `type:"text"` cuts render a title card (no source
  needed). Set `REMOTION_BIN` or install `remotion` on PATH (fallback `bunx`) and
  run `bun install` once in `remotion/`. See `remotion/README.md`.
- `compose-motion` — lightweight ffmpeg motion composer: bakes a per-cut
  ken-burns/zoom/pan animation via `zoompan`, then joins cuts with `xfade`
  crossfades — no React, no browser, no swift build. Same `RenderReport` shape
  and `RemotionEditDecisions` input as `compose-remotion`, so it's a drop-in on
  machines where a browser-based composer doesn't resolve.
- `pre-compose` — deterministic gate run before the expensive render: delivery
  promise (cuts/duration/sources/audio) + slideshow risk (static-image
  fraction) + cut-duration-vs-source (a video cut's `out_seconds - in_seconds`
  exceeding the source clip's real remaining length, which `compose-motion`
  otherwise silently freeze-extends — one ffprobe call per video cut).
  `verdict:"fail"` → don't render.

## Roadmap (later iterations)

2. Native director bridge — registry → `krea2`/`flux2`/`ltx` via the shared
   `ToolResult` JSON contract; `image`/`video` selectors wire the `assets` stage.
3. FFmpeg + cloud HTTP providers (audio_mixer, color_grade, video_stitch,
   subtitle_gen, TTS/music/stock via `fetch`).
4. Compose (templated) — Remotion as a Node subprocess; `final_review` self-checks.
5. First end-to-end pipeline (`animated-explainer`) → a shipped video.
6. Native gap closure — ~~Whisper (captions)~~ ✓ (Item I — `mlx-whisper` director
   via `bun:whisper`: word-level timestamps → `subtitle_gen` SRT → burned/sidecar
   captions; `final_review` advisory transcript check), CLIP, upscale.
7. More pipelines + the native atelier compose arc.

## Status
Iteration 1 of a multi-iteration rewrite. Foundation only — no media calls yet.

## Native transcriber (Item I — `mlx-whisper`)

The `transcriber` provider (`capability:"analysis"`, `invoke:"bun:whisper"`)
runs `mlx-whisper` on Apple Silicon via a small python entry
(`python/whisper_transcribe.py`). It produces a transcript + word-level
timestamps that flow into `subtitle_gen` (SRT) and burned/sidecar captions, and
an advisory transcript check in `final_review`.

One-time setup (the venv is gitignored infra, like `python/venv`):

```bash
uv venv --python 3.13 python/whisper-venv
uv pip install --python python/whisper-venv/bin/python mlx-whisper
```

Override the python binary via `MD_WHISPER_PYTHON`; the model via
`MD_WHISPER_MODEL` (default `mlx-community/whisper-small-mlx`, auto-downloads
from HuggingFace on first use). The end-to-end proof is reproducible:

```bash
bun run --cwd bun-apps/s2-agent-ext-movie-director scripts/run-whisper-e2e.ts
```

The agent-driven path (gemma-4-12b drives the chain via the `movie` tool, no
deterministic script) feeds the transcribe `words.json` straight into
`generate {capability:"subtitle", options:{wordsPath}}` — `subtitle_gen` derives
the cues itself, so the agent does no timestamp math. See
`receipts/agent-captions-20260705.md`.

## Tool-scope guard (agent guardrail)

When the extension is loaded, it registers a s2-agent `tool_call` PreToolUse
handler that **blocks the built-in `edit`/`write` tools from touching repo infra
roots** (`python/`, `swift/`, `mlx-models/`, `comfyui_data/`, `bun-apps/`,
`.claude/`, `.githooks/`, `scripts/`) during a `movie` run. This prevents the
ungrounded-edit class observed in the #291 agent-driven run (a wrong
`python/.../config.py` edit). Pure logic in `src/tool-scope.ts` (override the
denylist via `MD_TOOL_SCOPE_DENY`; bypass via `MD_TOOL_SCOPE_DISABLE=1`).

