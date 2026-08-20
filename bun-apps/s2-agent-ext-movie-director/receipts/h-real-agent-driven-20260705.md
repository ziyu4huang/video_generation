# Receipt — Item H-real re-proof: agent-driven real generation

**Date:** 2026-07-05 07:29–07:49 UTC (≈20 min wall clock)
**Goal:** Re-prove pipeline item H-real, but driven by the **gemma-4-26b agent
through the `movie` tool** — not the deterministic driver
(`scripts/run-h-real.ts`). #283 proved the pipeline code path produces a real
mp4; this run proves the **agent-first orchestration thesis** for real
generation.

## Verdict: SUCCESS

All four done-when gates met:

| Gate | Result |
|---|---|
| Agent-driven run (gemma issues every `movie` call) | ✅ 36 `movie` tool calls in the transcript |
| Real generation in the loop | ✅ 2 real flux2 Klein PNGs, 1024×576, 956 KB + 684 KB |
| final_review PASS + all 7 checkpoints | ✅ verdict `pass` (6/6 checks); proposal, script, scene_plan, assets, edit, compose, publish |
| Tool-adherence receipt | ✅ see below |

## Runtime configuration
- `bun bun-apps/s2-agent/src/cli.ts --no-extensions -e .../movie-director.ts`
- Provider `lm-studio`, model `google/gemma-4-26b-a4b-qat`, **thinking `medium`**
- `BUN_PI_LOAD_RUN_DIR=FALSE` (the run-dir manifest splices `s2-agent-ext-power-tool`,
  which currently trips the JITI `NameTooLong` bug; disabling the splice and
  loading only the explicit `-e` sidesteps it — this run does not need the
  other extensions)
- `MLX_OUTPUT_DIR=../video_generation__output`, flux2 binary pre-built.

## Tool-adherence receipt (the goal's #1 risk)
Transcript: 132 messages, **36 `movie` calls, 26 `bash`, 2 `read`, 1 `edit`**.
- **Zero model swaps** (stayed gemma-4-26b the entire run).
- **Zero thinking-level escalation** (stayed `medium`; no high/xhigh needed).
- The agent followed the recipe cleanly: `preflight → pipeline-show →
  init-project → write-checkpoint ×7 (one per checkpointed stage) → validate-artifact
  (used as a schema probe before writing) → generate ×3 (2 shots + 1 retry) →
  pre-compose → compose-remotion → final-review → read-checkpoint`.
- It used `validate-artifact` and `schema-defaults` as safety nets before
  writing checkpoints — exactly the intended pattern.
- Full per-call trace: `h-real-agent-driven-trace.jsonl` alongside this file.

### Honest blemishes (the unvarnished signal)
1. **Workspace split.** `init-project` returned a placeholder projectDir
   (`"(created on first write-checkpoint)"`), so the agent guessed `outputDir`
   and placed assets under `<MLX_OUTPUT_DIR>/<projectId>/assets/` while the
   checkpoints landed under `<MLX_OUTPUT_DIR>/movie-director/projects/<projectId>/`.
   The run still succeeded because the agent passed absolute paths to
   `compose-remotion`. **Fix applied this PR:** `init-project` now returns the
   resolved `projectDir` + `assetsDir` so the agent can place files inside the
   workspace. This is the "tool-description tweak" the goal anticipated.
2. **One ungrounded edit.** The agent edited `python/mlx-movie-director/app/config.py`
   (`str | None` → `Optional[str]`) on a wrong Python-3.9 diagnosis. That file is
   irrelevant to the Bun movie pipeline and `str | None` is correct for the
   repo's Python 3.13 venv. The edit was **reverted** (not committed). A
   reminder that an unsupervised agent will occasionally wander — a scope
   guard (tool denylist, or a sharper system prompt) would help hands-off runs.

## Generated artifacts (proof)
- mp4: `<MLX_OUTPUT_DIR>/agent-h-real-20260705/final.mp4` — 13.3 MB, 1920×1080,
  h264 + aac, 17.05 s, `final_review` verdict `pass`.
- Real PNGs: `<MLX_OUTPUT_DIR>/agent-h-real-20260705/assets/shot1.png` (1024×576),
  `shot2.png` (1024×576) — produced by native swift/MLX Flux2 Klein T2I driven
  via `movie generate { capability:"image_generation", provider:"flux2", command:"t2i" }`.
- 7 checkpoints under `<MLX_OUTPUT_DIR>/movie-director/projects/agent-h-real-20260705/`.
- Narration: macOS `say` → ffmpeg aac (the agent ran this itself via `bash`;
  no TTS provider is configured).

## Conclusion
The agent-first orchestration thesis holds for **real** generation: gemma-4-26b
at thinking `medium` drove the full 7-stage `movie` tool sequence end-to-end,
produced real flux2 Klein images, rendered a real mp4, and passed `final_review`
— with no model swap and no escalation. This closes the honest gap left by #283.
