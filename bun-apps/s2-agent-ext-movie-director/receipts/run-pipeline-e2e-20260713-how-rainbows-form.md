# Receipt — run-pipeline real e2e #1: "How rainbows form" (driver core proof + findings)

**Date:** 2026-07-13 · **branch:** `feat/movie-director-run-pipeline` · **worktree:** `video_generation__driver`
**Driver model:** `deepseek-v4-flash` · **pipeline:** `animated-explainer` · **project:** `how-rainbows-form`

## Purpose

First real end-to-end exercise of the deterministic `run-pipeline` driver (Phases 1–5
shipped, unit-tested). Goal: prove the driver's core mechanics for real, surface
integration friction, and verify the frozen-frame fix path — mirroring the
`ancient-quasars` receipt's role for the agent-driven path.

## What is PROVEN (real, this run)

1. **Bounded-session spawn + NDJSON capture works.** `runBoundedSession` spawns
   `bun s2-agent/src/cli.ts --mode json …`; `extractFinalAssistantText` correctly
   parses the real `turn_end.message.content[]` / `agent_end.messages[]` block-array
   shape (validated independently against a live `{"ok":true}` session).
2. **The research waypoint produces a real, schema-valid, web-grounded artifact.**
   `checkpoint_research.json` → `status:"completed"`, `research_brief` with all 13
   canonical keys, **7 data_points, 4 angles_discovered, 9 sources** (exceeds the
   schema minimums 3/3/5). This is the same research-grounding quality the
   `ancient-quasars` receipt validated for the agent-driven path — now produced by a
   **deterministic driver waypoint**, not the free-form agent.
3. **Driver sequencing + checkpoint + feed-forward works.** After research, the
   driver wrote the checkpoint, advanced to `proposal`, and the proposal session's
   prompt contained `"research_brief": {…}` — i.e. the prior artifact was fed
   forward exactly as designed.
4. **Resume works.** Killing the run and re-invoking
   `run-pipeline --projectId how-rainbows-form` re-entered at `proposal` (research
   already completed) and re-ran only the in-progress stage.

## Findings (real, actionable — NOT driver bugs)

- **Completion waypoints must have zero tools.** Initially only `movie` was
  excluded; the `proposal` session looped on `web_search` for 6+ min (idle on
  network). Fixed: completion → `--no-tools all`; research → `--tools
  web_search,fetch_content,get_search_content,read,write` allowlist. (commit 401e6ed2)
- **Waypoint prompts must carry the target schema structure.** "Produce a
  schema-valid X" with no shape hint → the model guesses and fails. Fixed:
  `readSchemaSpec` loads each artifact's bundled `required` + property summary into
  the prompt. (commit 401e6ed2)
- **`proposal_packet` schema-compliance friction (the remaining blocker).** The
  driver reaches `proposal`, but the waypoint **exhausts 3 retries** on
  `/approval: must NOT have additional properties` — the schema sets
  `additionalProperties:false` on nested objects (e.g. `approval`) and the model
  persistently adds extra fields. The validation feedback is fed back but the model
  doesn't fully comply within the bound. This is LLM/schema-engineering work, not a
  driver defect.

  Candidate follow-ups (not done): (a) deeper nested-schema guidance in the prompt
  (walk `approval`'s allowed sub-fields); (b) a deterministic "clean-to-schema"
  step that strips unknown properties before validation; (c) a stronger model
  (`deepseek-v4-pro`) for the complex proposal/script waypoints; (d) raise
  `maxRetries` for the high-cardinality artifact stages.

## Not yet exercised (blocked on the proposal follow-up)

- `script` / `scene_plan` / `edit` waypoints (downstream of proposal).
- **`assets` stage with the proactive encoder** — the frozen-frame fix itself
  (`frames=ceil(duration×fps)`, chaining) is unit-proven, but not yet exercised on
  real GPU via the driver (the encoder emits `t2i2v` with computed frames; verified
  the command/capability contract against `bridge.ts`/`runpy_tts`).
- `compose-motion` → `final.mp4`, SSIM no-frozen-frame check, resume-from-crash demo.

## Status

Driver + waypoint runtime: **implemented, 515 unit/integration tests green,
committed (6 commits)**. Core mechanism **proven end-to-end through research**
(this run). Full pipeline-to-video **deferred** to the `proposal_packet`
schema-compliance follow-up above.

## Reproduce the proven path

```bash
# from the video_generation__driver worktree
bun bun-apps/s2-agent-ext-movie-director/src/cli.ts run-pipeline \
  --topic "how rainbows form" --model deepseek-v4-flash --pipeline animated-explainer
# → research waypoint runs (web_search), checkpoint_research.json lands with a
#   schema-valid, web-grounded brief; driver advances to proposal.
# proposal currently exhausts retries on /approval additionalProperties (see Findings).
```
