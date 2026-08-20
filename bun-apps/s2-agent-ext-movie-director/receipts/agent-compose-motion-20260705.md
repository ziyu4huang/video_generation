# Receipt — Item J: agent-driven compose_motion (thesis validation)

**Date:** 2026-07-05 14:25 UTC
**Goal:** Prove the new ffmpeg motion compositor (`compose_motion`, Item J)
integrates with the repo's **agent-first thesis** — a real **gemma-4-26b agent**
drives the director through the `movie` tool to a real motion-composed .mp4
(not the deterministic `run-compose-motion-e2e.ts` script). This is the
"agent-driven receipt" gate Item J set.

## Verdict: SUCCESS

| Gate | Result |
|---|---|
| Agent-driven motion mp4 (gemma issues the `movie` call) | ✅ 1 `movie compose-motion` call; `motion_audio_1783262236.mp4` produced (543 KB, 640×360, 5.5s) |
| Real motion compositor ran (ffmpeg zoompan + xfade + audio mix) | ✅ render_grammar `motion`; h264 video + aac narration-mixed audio, ffprobe-verified |
| Converged unaided at thinking `medium` | ✅ single `movie` call — prompt pre-empted the double-nesting friction |

## Runtime configuration
- `bun bun-apps/s2-agent/src/cli.ts --no-extensions -e …/movie-director.ts`
- Provider `lm-studio`, model `google/gemma-4-26b-a4b-qat`, **thinking `medium`**
- `--no-builtin-tools` → the agent had **only** the `movie` tool. The thesis
  ("the agent drives `movie`") is exercised pure.
- `BUN_PI_LOAD_RUN_DIR=FALSE` (sidesteps the JITI NameTooLong splice per #291).
- Full agent stdout: `agent-compose-motion-stdout.txt` (this dir's fixture copy at
  `/tmp/md-agent-compose-motion/agent-stdout.txt`).

## Setup (NOT the composition — pre-built so the agent stays on-thesis)
Two 3s clips (`testsrc` + `mandelbrot`, 640×360, ffmpeg lavfi) and a 6s sine-tone
narration were pre-built under `/tmp/md-agent-compose-motion/`. The agent received
their absolute paths + the exact tool input shape; its job was the compose call
only (the same division of labor as the ESRGAN receipt).

## Tool-adherence (the friction the goal anticipated)
`compose-motion` takes `editDecisions` **one level deep** in `options` (not two
levels — the double-nesting only applies to `generate`, whose director options
live in `options.options`). The prompt stated this explicitly, so the agent
converged in a **single `movie` call** — better than the ESRGAN run's first
mis-nest. The agent's final report (verbatim):

> The motion composition has been successfully rendered.
> - **Output Path:** `/tmp/md-agent-compose-motion/motion_audio_1783262236.mp4`
> - **Outputs non-empty:** Yes
> - **Duration:** 5.5 seconds  • **Resolution:** 640x360  • **Codec:** h264

Note the agent correctly reported the **audio-mixed** path
(`motion_audio_*.mp4`), not the silent-bed intermediate — confirming it read the
`render_report.outputs[0].path` field, which points at the post-mix deliverable.

## Generated artifact (proof)
- **`motion_audio_1783262236.mp4`** — 543 KB, 640×360, 5.5s, h264 video + aac
  audio. Produced by the motion compositor (ffmpeg `zoompan` ken-burns on cut a,
  `zoompan` zoom-in on cut b, `xfade` 0.5s crossfade, narration mixed at 0.8
  volume) via the `compose:motion` adapter → `movie compose-motion`.
- Independent `ffprobe` confirms: `codec_name=h264` (video) + `codec_name=aac`
  (audio), `duration=5.500000` (3+3 − 0.5 crossfade = 5.5 ✓).

## Runtime decision (why Motion Canvas / swift were NOT shipped)
- **Motion Canvas REJECTED:** `npx --yes @motioncanvas/cli@latest --version` →
  npm E404. The canonical `@motion-canvas/cli` also 404s; only `@motion-canvas/core`
  (3.17.2) exists. MC has no standalone render CLI — it requires a full
  scaffolded Vite+browser project (`npm init @motion-canvas`), heavier than
  Remotion (which itself is not installed on this machine: `remotion not found`).
- **swift/MLX compositor REJECTED:** too heavy for this goal (new Package.swift +
  metallib build).
- **Shipped instead:** the Bun-native ffmpeg motion compositor (`compose_motion`)
  — genuinely distinct from `compose.ts` (straight cuts, no motion) and
  `remotion.ts` (React/Chromium). Callable wherever ffmpeg+zoompan+xfade resolve.
- **`compose_hyperframes`:** stays a documented vendor-gated GAP (browser-only
  React frameworks — HyperFrames/Motion Canvas — not callable headless here).

## Conclusion
Item J closes the composition "new director" gap the way Item I closed the
analysis/enhancement gap: a real gemma-4-26b agent at thinking `medium` drove
the native `movie compose-motion` director end-to-end and produced a real
motion-composed mp4 (zoompan + xfade + narration), with no model swap and no
escalation. Combined with the deterministic `run-compose-motion-e2e.ts` receipt
(6/6 final_review checks pass), the composition capability now has THREE callable
runtimes (ffmpeg straight-cut, remotion templated, motion) with hyperframes the
sole documented vendor-gated gap — the goal's explicit "hyperframes documented-
vendor-gated" branch, satisfied.
