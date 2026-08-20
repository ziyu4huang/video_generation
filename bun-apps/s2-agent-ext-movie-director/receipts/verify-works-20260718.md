# Receipt — "does the movie-director agent+tool really work?" end-to-end verification

**Date:** 2026-07-18 · **Worktree:** `video_generation__movie` (branch `video_generation__movie`)
**Goal:** Verify the s2-agent-ext-movie-director agent+tool genuinely builds a story and
generates real image + video on this machine, from a clean (no-venv) state.

## TL;DR

**The infrastructure works and genuinely generates real media.** Story waypoints are
produced, real T2I PNGs and a real LTX video are emitted **through the `movie` tool**,
and the agent drives the tool autonomously. The one soft spot is the **fully-autonomous
gemma-driven end-to-end chain** — gemma's tool-adherence is the bottleneck (it stops early
/ confuses stage-names with commands), matching every prior agent-driven receipt (v3/v4
converged on `deepseek-v4-flash`, not gemma). This is a model-quality issue, NOT an
infrastructure defect.

## Layer 1 — deterministic tool layer ✅

- `bun test` in `bun-apps/s2-agent-ext-movie-director`: **679 pass / 0 fail / 8 skip**.
- `movie` tool + dispatch + 20 host-fns + 4 workflows wired into the eager run-dir
  manifest (#616). tsc clean.
- ffmpeg 8.1.2 present; LM Studio `google/gemma-4-26b-a4b-qat` loaded + idle.

## Layer 2 — native swift/MLX backends built + smoke-tested ✅

Both backends were **unbuilt on this branch** (no `.build/release`, no `python/venv`).
Built from source (~100s each, mlx-swift 0.31.4 resolved from SPM cache, zero network):

| Director | Build | Real smoke result |
|---|---|---|
| `swift/flux2-image-director` (release) | 98s | `flux2 t2i` → real **768×432 PNG** in 5.7s (klein-9b, 4 steps) |
| `swift/ltx-video-director` (release) | 101s | `ltx-video native-i2v` → 25 frames + audio.wav, upscaled to 2048×1216, muxed **video.mp4** (1.9MB) |

`mlx.metallib` copied from homebrew
(`/opt/homebrew/lib/python3.13/site-packages/mlx/lib/mlx.metallib` → each `.build/release/`)
per the swift-directors SOP. Re-confirms the 2026-07-17 verification.

## Layer 3 — the `movie` TOOL really generates image + video ✅ (deterministic, zero-LLM)

Drove the SAME dispatch path the agent's `movie generate` lands on, directly
(`scripts/verify-tool-video.ts`):

```
dispatch("generate", { capability:"video_generation", command:"native-i2v",
  options:{ prompt:"...", seconds:1 } })
→ { ok:true, provider:"ltx", invoke:"swift:ltx", command:"native-i2v",
   artifacts:[ video.mp4 1280×1920 h264+aac 24fps 1.04s 1.1MB, source.png ] }
```

ffprobe-confirmed real video. This closes "can the tool really generate video?" — yes,
through the real selector → swift:ltx adapter → native binary, with no LLM in the loop.
(The one papercut: `outputDir` must resolve under repo root or its parent — the sandbox
rejects arbitrary `/var/folders/...` tmp dirs.)

## Layer 4 — agent-driven (gemma) ⚠️ partial

Three `s2-agent` runs (`BUN_PI_LOAD_RUN_DIR=FALSE --no-structions -e ...movie-director`,
gemma-4-26b @ thinking=medium):

1. **Bad prompt** → gemma brainstormed + asked the user a style question, then exited
   (`-p` print mode ends on a non-tool text turn).
2. **Manual command sequencing** → gemma autonomously drove `movie init-project → research
   → proposal → script → scene_plan → write-checkpoint` and produced **2 real T2I PNGs**
   via the movie→flux2 path. Then it (a) hit `movie assets` — **`assets` is a STAGE, not a
   valid command** (8× "command: must be equal to constant"), and (b) went off-script to
   `bash` trying to invoke the absent `python/venv/.../run.py`. Stopped before video/compose.
3. **`movie run-pipeline` (one-shot full-chain)** → died at the **research waypoint**:
   the waypoint sub-session's output failed clean-to-schema validation, exhausting 2 retries.

**Root cause = gemma tool-adherence, not infrastructure.** The tool, the selector, the
swift adapters, and real MLX generation all work (Layers 1–3). gemma stalls/loiters on the
autonomous full chain — the exact pattern every prior receipt reports; v3/v4 only converged
after switching to `deepseek-v4-flash`.

4. **Precise command-mapping retry** (stage→exact-command checklist, bash/run.py forbidden,
   `scripts/verify-agent-driven-prompt.md`) — **could not get a clean run: blocked by
   environmental contention.** The box had 3–5 other concurrent s2-agent sessions (deploy /
   workflow / video_generation worktrees) all touching the shared `pi-hermes-memory/sessions.db`;
   the gemma run stalled 12+ min with no TCP:1234 connection, no checkpoint, empty log, and was
   killed. Matches [[s2-agent-headless-p-hang]] — "works on a quiet box; 'hang' = contention."
   The precise prompt is staged and ready to re-run on a quiet box (or with deepseek-v4-flash
   loaded in LM Studio instead of gemma-only).

5. **Auto-rerun on a quiet box (cron 536b46f7, 2026-07-18→19, ~1h45m wall).** FAILED.
   gemma-4-26b drove `init → research`, then:
   - **research waypoint exhausted retries** — the research-director skill pushed the agent
     to `web_search`/`fetch_content` (ignoring the prompt's "movie-tool-only" rule; the skill
     overrides it), and the resulting web-fetched brief failed clean-to-schema validation 2×.
     ~80 min burned on research alone (rate-limited web fetches).
   - **`movie generate {video_generation, native-i2v}` → `Missing expected argument
     '--prompt <prompt>'` (ltx-video exit 64)** — the agent did not pass `options.prompt`
     correctly. Note: `dispatch("generate", {video_generation, native-i2v, options:{prompt}})`
     is PROVEN to work (Layer 3) — so this is agent arg-passing, not the tool/adapter.
   - Only artifact produced: 1 real T2I PNG (flux2, via the movie tool). No video, no compose.
   **Definitive conclusion (3 gemma full-chain attempts):** the infrastructure (tool, selector,
   swift adapters, real MLX image+video generation) is sound and genuinely produces media
   (Layers 1–4). The fully-autonomous gemma-driven END-TO-END chain is NOT viable — gemma
   stalls on creative-waypoint schema validation and mis-passes generate args. v3/v4 receipts
   confirm only `deepseek-v4-flash` converged. Cron deleted; no further gemma retries.

### Discoverability defect worth a follow-up

Stage names `research`/`proposal`/`script`/`scene_plan` ARE valid `movie` commands, but
`assets`/`edit`/`compose`/`publish` are NOT (they advance via `generate` / `compose-motion`
/ `final-review` + `write-checkpoint`). An agent naturally over-generalizes and tries
`movie assets`, then falls off the command surface. Same class as the #321
`video_understand` discoverability fix — the command reference should explicitly map each
pipeline stage to the exact command(s) that advance it.

## Repro

```bash
# backends (one-time per worktree)
( cd swift/flux2-image-director && swift build -c release )
( cd swift/ltx-video-director && swift build -c release )
cp /opt/homebrew/lib/python3.13/site-packages/mlx/lib/mlx.metallib \
   swift/flux2-image-director/.build/release/mlx.metallib
cp /opt/homebrew/lib/python3.13/site-packages/mlx/lib/mlx.metallib \
   swift/ltx-video-director/.build/release/mlx.metallib

# deterministic tool→video proof (no LLM)
MLX_MODELS_DIR=$(pwd)/mlx-models \
  bun bun-apps/s2-agent-ext-movie-director/scripts/verify-tool-video.ts

# agent-driven (gemma; expect partial — use deepseek-v4-flash for a clean full chain)
BUN_PI_LOAD_RUN_DIR=FALSE MLX_OUTPUT_DIR=<out> MLX_MODELS_DIR=$(pwd)/mlx-models \
  bun bun-apps/s2-agent/src/cli.ts --no-extensions \
    -e bun-apps/s2-agent-ext-movie-director/extensions/movie-director.ts \
    --provider lm-studio --model google/gemma-4-26b-a4b-qat --thinking medium \
    --name <run> -p "<task>"
```

## Verdict

| Question | Answer |
|---|---|
| Does the `movie` tool + dispatch work? | ✅ Yes (679 tests, routing proven) |
| Can it really build a story? | ✅ Yes (agent drove research→proposal→script→scene_plan checkpoints) |
| Can it really generate an image? | ✅ Yes (real flux2 PNGs, via tool and via agent) |
| Can it really generate a video? | ✅ Yes (real LTX video.mp4 via the tool's dispatch→swift:ltx path) |
| Does the full gemma-driven chain finish autonomously? | ⚠️ No — gemma adherence stalls it; use deepseek-v4-flash (per v3/v4 receipts) |
