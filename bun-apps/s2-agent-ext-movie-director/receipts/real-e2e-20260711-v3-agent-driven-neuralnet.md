# Receipt — real e2e #3: "How Neural Networks Learn" (agent-driven, `movie` tool, zero override)

## Setup

- Story: "How Neural Networks Learn" — same 2-scene creative content as the
  deterministic script `scripts/run-real-e2e-neuralnet.ts`
  (`real-e2e-20260711-v2-neuralnet.md`), reused verbatim as creative grounding
  in the prompt, but driven this time by an LLM calling the `movie` tool
  itself — no hand-written orchestration script.
- Pipeline: `animated-explainer`, project `neuralnet-agent-driven-v1` (new,
  disjoint from `neuralnet-real-e2e-v1`, the scripted run's project).
- Driver: `bun bun-apps/s2-agent/src/cli.ts --model deepseek-v4-flash -e
  bun-apps/s2-agent-ext-movie-director/extensions/movie-director.ts
  --no-extensions -p "<task prompt>"`, run from repo root
  `/Users/huangziyu/proj/video_generation__ltx` (not a worktree).
- Assets: real local MLX Z-Image T2I (invoked directly via `python/venv/bin/python
  python/mlx-movie-director/run.py image t2i`, see Process notes below) + real
  macOS `say` (Samantha voice) narration.
- Compose: `movie compose-motion` (ffmpeg zoompan + xfade), plus one manual
  ffmpeg audio-overlay fix (see below).
- Wall-clock: session started `2026-07-11T02:14:13.922Z`, last write-checkpoint
  (`publish`) at `02:20:24.147Z` — **~6 minutes** end to end. 91 total tool
  calls (27 `movie`, 21 `bash`, 10 `read`, 4 `movie_help`, 29 `todo`).

## Result: PASS, independently re-verified

All 8 stages reached `status=completed`; the transcript's self-reported
override table (`❌ NEVER` for both `overrideArtifactValidation` and
`overrideFinalReview`) was independently confirmed by grepping every
`write-checkpoint` tool-call's arguments in the raw session log — neither
flag appears in any actual tool call, only in tool-description text the
agent read.

Independently re-verified against the filesystem in this session (per the
standing lesson that this local model's self-reported summaries can't
always be trusted):

```
ffprobe output_how_neural_networks_learn_audio_fixed.mp4
  → duration=19.000000s, size=820203 bytes
  → video: h264 1280x720; audio: aac 22050Hz mono
ffmpeg volumedetect → mean_volume=-16.1dB, max_volume=-1.3dB (not silent)
```

Real mp4 path:
`/Users/huangziyu/video_generation__output/movie-director/projects/neuralnet-agent-driven-v1/output_how_neural_networks_learn_audio_fixed.mp4`

Project directory confirmed on disk with all 8 `checkpoint_*.json` files
(research, proposal, script, scene_plan, assets, edit, compose, publish), 2
real T2I PNGs (`scene1_neural_network.png`, `scene2_synapse_closeup.png`,
~980 KB each — real MLX output, not stubs), and a real narration AIFF/WAV
pair (19.18s, macOS `say` Samantha voice).

| Stage | Status | Gated (humanApproved) |
|-------|--------|------------------------|
| research | ✅ completed | not required |
| proposal | ✅ completed | ✅ true |
| script | ✅ completed | ✅ true |
| scene_plan | ✅ completed | ✅ true |
| assets | ✅ completed | ✅ true |
| edit | ✅ completed | not required |
| compose | ✅ completed | not required |
| publish | ✅ completed | ✅ true |

## Round-by-round validation (from raw session log)

| Stage | `validate-artifact` rounds | Notes |
|-------|------------------------------|-------|
| research | 1 (ok:true first try) | reused the well-grounded sources from the prior scripted run |
| proposal | 2 | round 1: `render_runtime` placed at wrong nesting level (top-level instead of inside `production_plan`) → "additional properties" + "missing required" errors; round 2 fixed |
| script | 1 | — |
| scene_plan | 1 | — |
| assets | 1 | — |
| edit | 1 (not schema-gated) | — |
| compose | 1 render pass, 1 fix pass | `pre-compose` gate returned `warn` (not `fail`) → proceeded; `compose-motion` rendered the mp4 without audio (near-silent, -91dB) → `final-review` correctly caught it (verdict=`fail`, `audio_level` check failed) → agent manually overlaid the real narration WAV via `ffmpeg -map 0:v:0 -map 1:a:0`, re-ran `final-review` on the fixed file → verdict=`pass` (6/6 checks) |
| publish | 1 | — |

8 `validate-artifact` calls total, 10 `write-checkpoint` calls (one extra
`write-checkpoint` call preceded the final compose write — see raw
transcript around the pre-compose/compose-motion tool calls), 2
`final-review` calls (fail → pass after the audio fix).

## Process notes (honest)

- **Real generation confirmed, but not through the `runpy-image` provider
  path.** The agent never called `movie generate` with a `runpy-image`
  provider option; instead it dropped to the raw `bash` tool and invoked
  `python/venv/bin/python python/mlx-movie-director/run.py image t2i
  --prompt ... --seed ... --pipeline zimage --width 1280 --height 720`
  directly, twice (once per scene). This is still **real** MLX Z-Image T2I
  generation (9 steps, ~21–25s each, verified in the tool-result log: "Pipeline
  Finished in 21.33s" / "24.58s", real PNGs saved to disk, non-stub file
  sizes ~980KB) — but it bypasses whatever `movie generate`/`runpy-image`
  wiring exists in the extension. Preflight's report did list `runpy-image`
  as available; the agent chose the lower-level path instead of the
  extension's own dispatcher, which the task prompt hadn't ruled out but
  hadn't explicitly wanted either. Worth flagging as a gap between "the tool
  the extension exposes" and "the tool the agent actually reaches for."
  The first `run.py t2i` call also didn't honor `--output` (image landed at
  `../video_generation__output/output_20260711_101749.png` instead of the
  requested project asset path); the agent recovered by `cp`-ing the file
  into the project's `assets/` dir, first hitting a `mkdir` miss (bash exit
  code 1, the only error in the whole run) then fixing it with `mkdir -p`.
- **`compose-motion` shipped a near-silent mp4** (audio_level -91dB) on its
  first render. This mirrors the "compose-motion output-path footgun"
  flagged in the prior scripted run's receipts as an open issue — here it
  manifested as a volume/mixing bug rather than a path-swap bug, but it's
  the same family of "compose-motion's audio handling isn't fully
  trustworthy yet" finding. The agent diagnosed it correctly (compared
  source WAV volume -16.1dB vs. rendered mp4 -91dB) and fixed it with a
  manual `ffmpeg -c:v copy -c:a aac -map 0:v:0 -map 1:a:0` overlay — a
  legitimate recovery, not a schema override, and `final-review` genuinely
  passed on the corrected file (not skipped or forced).
- **Padding/minor footgun in the edit stage**: `edit_decisions.cuts` has
  3 entries (`cut_scene1`, `cut_scene2`, `cut_scene3`), but `cut_scene3`
  reuses `scene1_neural_network.png` again (as a static outro cut) rather
  than being backed by a distinct third generated asset — it's a real image
  file, not a fabricated path, but it is asset reuse to pad the edit
  structure to 3 cuts. Final mp4 duration (19.00s) matches the intended
  ~20s target regardless.
- **No overrides, no fabricated paths for the core pipeline artifacts.**
  Every `research_brief`, `proposal_packet`, `script`, `scene_plan`,
  `asset_manifest`, `edit_decisions`, `render_report`/`final_review`, and
  `publish_log` artifact validated cleanly against its canonical schema
  before being written, matching the standing bar set by
  `real-e2e-20260711-v1-skyblue.md` and `real-e2e-20260711-v2-neuralnet.md`.
- Session indexing threw a non-fatal warning (`⚠️ Live session indexing
  failed: database is locked`) at the very start of the printed stdout —
  did not affect the run; likely a concurrent session's SQLite lock.

## Significance

Third fully-real, agent-driven, zero-override movie-director run (after
`real-e2e-20260711-v1-skyblue.md`, agent-driven, and
`real-e2e-20260711-v2-neuralnet.md`, deterministic-script). Confirms the
CONCEPT-stage schema gate + full pipeline compose again converges cleanly
under LLM-agent driving on a second, disjoint story, and surfaces two real,
reproducible findings for follow-up: (1) `compose-motion`'s audio mixing is
not yet reliable enough to trust without a `final-review` gate catching it
(this run's `audio_level` check is exactly the safety net that worked as
designed), and (2) the agent will reach for raw `bash` + `run.py` over the
extension's own `runpy-image` provider wiring when given the choice — worth
checking whether `movie generate` needs a clearer preflight nudge or is
simply less discoverable than direct `bash`.
