# Receipt — Item I agent-driven captions re-run + tool-scope guard

**Date:** 2026-07-05 08:44–08:49 UTC (≈5 min wall clock)
**Goal:** Prove the Item I captions primitive integrates with the repo's
**agent-first thesis** — a real **gemma-4-26b agent** drives the full captions
chain through the `movie` tool to a captioned mp4 (not the deterministic
`run-whisper-e2e.ts` script) — AND land the **tool-scope guard** that prevents
the ungrounded-edit class recur from #291.

## Verdict: SUCCESS

Both done-when gates met:

| Gate | Result |
|---|---|
| Agent-driven captioned mp4 (gemma issues every `movie` call) | ✅ 7 `movie` tool calls; captioned mp4 has a `mov_text` subtitle stream |
| final_review PASS + transcript advisory green | ✅ verdict `pass`; transcript advisory surfaced 19 words |
| Tool-scope guard fires on a denied `python/` edit | ✅ live agent probe blocked; file NOT created |
| Guard unit + wiring tests | ✅ 18 guard tests + extension wiring test; full suite 116 pass |

## A. Agent-driven captions (primary)

### Runtime configuration
- `bun bun-apps/s2-agent/src/cli.ts --no-extensions -e …/movie-director.ts`
- Provider `lm-studio`, model `google/gemma-4-26b-a4b-qat`, **thinking `medium`**
- `--exclude-tools bash,edit,write,read,grep,find,ls` → the agent had **only**
  the `movie` tool. The thesis ("the agent drives `movie`") is exercised pure.
- `BUN_PI_LOAD_RUN_DIR=FALSE` (sidesteps the JITI NameTooLong splice per #291).

### Setup (NOT the captions primitive — pre-built so the agent stays on-thesis)
A narration fixture (`data/fixtures/narration.m4a`, macOS `say` → aac, 7.44 s)
was copied into the workspace and a plain source mp4 (lavfi solid color + the
narration audio, no captions) pre-built with ffmpeg. The agent received both
absolute paths and the workspace; its job was the captions chain only.

### The 7 `movie` calls the agent made (full trace: `agent-captions-trace.jsonl`)
1. `movie generate` — schema-discovery probe (empty command).
2–4. `movie generate {capability:analysis, command:transcribe, options:{audio}}` —
   the agent converged on the right input shape over 3 attempts (the
   tool-adherence signal the goal's "honest risks" anticipated; it recovered
   unaided at thinking `medium`). Produced `transcript.txt` + `words.json`.
5. `movie generate {capability:subtitle, options:{wordsPath, wordsPerCue:4}}` —
   **new agent path**: the `subtitleAdapter` now derives cues from the whisper
   `words.json` itself, so the agent does NO timestamp math. Produced `subtitles.srt`.
6. `movie compose {editDecisions, captions:{srtPath, burn:true}}` → `captioned_<hash>.mp4`.
7. `movie final-review {mp4Path, transcriptPath}` → verdict + transcript advisory.

### Generated artifacts (proof)
- **Captioned mp4** — 84 KB, 7.47 s, streams: `h264` + `aac` + **`mov_text` subtitle**.
  Captions embedded as a **soft sidecar** (this Homebrew ffmpeg lacks libass →
  `compose.ts` honestly falls back to `mov_text`; hard-burn path stays a tail).
- `subtitles.srt` — 5 cues, 19 words, correct word-level timing:
  ```
  3
  00:00:02,900 --> 00:00:04,940
  demonstrates native transcription with
  ```
- Transcript: "Welcome to the movie director pipeline. This clip demonstrates
  native transcription with word level timestamps burned in as captions."

### final_review
`verdict: pass` — `container_valid`, `duration_positive`, `has_video_stream`,
`has_audio_stream`, `midpoint_frame` all `pass`; `audio_level` + `transcript`
are advisory `warn` (mean −15.8 dB; 19 transcript words) — neither blocks.

### Honest blemishes
1. **Transcript/words landed in the repo root**, not `<WS>/transcribe/`. The
   agent omitted `outputDir` on the successful transcribe call. Benign — the
   chain used the absolute artifact paths returned in the result JSON — but a
   future `transcribe` default `outputDir` (or a sharper prompt) would tidy it.
2. **Soft sidecar, not hard-burn.** libass is absent on this ffmpeg; the
   goal accepts sidecar. Hard-burn remains a tail.

## B. Tool-scope guard (fold-in sub-task)

**What.** A s2-agent `tool_call` PreToolUse handler registered by the
movie-director extension blocks the built-in `edit`/`write` tools when the
target path resolves under a repo infra root (`python/`, `swift/`, `mlx-models/`,
`comfyui_data/`, `bun-apps/`, `.claude/`, `.githooks/`, `scripts/`). Pure logic
in `src/tool-scope.ts` (override via `MD_TOOL_SCOPE_DENY`; bypass via
`MD_TOOL_SCOPE_DISABLE=1`); wired in `extensions/movie-director.ts`.

**Why.** The #291 H-real agent-driven run produced one ungrounded edit to
`python/mlx-movie-director/app/config.py` (a wrong Python-3.9 diagnosis,
reverted). This guard prevents that class recur during hands-off `movie` runs.

**Live-fire proof.** A minimal agent run (gemma-4-26b, thinking medium, the
movie extension loaded) was instructed to `edit python/agent-probe.txt`. The
guard blocked it verbatim:

> `movie-director tool-scope guard: editing ".../python/agent-probe.txt" is out
> of scope (matches denied prefix "python/"). The movie-director agent may only
> write to the project workspace; python/ is repo infra it must not touch during
> a movie run.`

`python/agent-probe.txt` was **NOT created**. The block reason propagated to the
agent's own summary, so a hands-off run self-reports the violation.

**Tests.** `src/tool-scope.test.ts` (18 tests): the #291 path denied, every
default prefix blocks, repo-relative/absolute/`..`-traversal all match, paths
outside the repo allowed, the denied root itself blocked, `MD_TOOL_SCOPE_DISABLE`
+ `MD_TOOL_SCOPE_DENY` honored, non-guarded tools never blocked, malformed input
safe. The extension wiring test proves the factory registers the handler and it
blocks/allow as expected. Full suite: **116 pass, 1 skip, 0 fail**.

## Conclusion
Item I graduates from "deterministic chain works" (#292) to **"the agent drives
it"**: gemma-4-26b at thinking `medium` drove the 7-stage `movie` captions
sequence end-to-end, produced a real captioned mp4 (subtitle stream present),
and passed `final_review` with the transcript advisory — with no model swap and
no escalation. The tool-scope guard that the prior goal flagged for three goals
running finally lands, with both unit tests and a live agent probe proving it
fires. The captions primitive and the loop's guardrails are both validated.
