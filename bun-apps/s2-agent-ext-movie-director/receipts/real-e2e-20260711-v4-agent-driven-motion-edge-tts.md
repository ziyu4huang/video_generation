# Receipt — real e2e #4: "How Neural Networks Learn" (agent-driven, real LTX I2V motion + auto edge-tts, zero override)

## Setup

- Story: "How Neural Networks Learn" — same 2-scene creative content as
  `real-e2e-20260711-v2-neuralnet.md` (deterministic script) and
  `real-e2e-20260711-v3-agent-driven-neuralnet.md` (agent-driven, T2I-only
  stills + `say` narration), reused verbatim as creative grounding, but this
  run closes the two axes those prior runs left open: real I2V motion (not
  zoompan-over-a-still) AND the new edge-tts-first-by-default fallback
  (`bridge.ts`, wired in PR #463) — driven entirely by an LLM agent calling
  the `movie` tool, with zero schema overrides, and the agent never told
  which TTS provider to use.
- Pipeline: `animated-explainer`, project `neuralnet-agent-driven-v2-motion`
  (new, disjoint from both prior projects).
- Driver: `bun bun-apps/s2-agent/src/cli.ts --model deepseek-v4-flash
  --thinking medium -e
  bun-apps/s2-agent-ext-movie-director/extensions/movie-director.ts
  --no-extensions -p "<task prompt>"`, run from repo root
  `/Users/huangziyu/proj/video_generation__ltx`. Model choice: deepseek-v4-flash,
  matching what converged cleanly on the schema-strict full pipeline in the
  v3 receipt (per standing note: gemma stalls on deep artifact nesting).
- Task prompt explicitly required: (1) a real still + real I2V motion clip
  per scene via `movie generate` (capability `image_generation` then
  `video_generation`, `options.fromImage` chaining the still into the video
  call), (2) `compose-motion` (not `compose-remotion`), (3) narration text
  written by the agent with **no TTS provider specified anywhere** — the
  point being to observe what the runtime picks with zero hints.
- Wall-clock: session `2026-07-11T05:25:40.761Z` → `05:47:59.020Z` — **~22
  minutes** end to end (dominated by 4 real LTX I2V generations, see Process
  notes). 176 total session lines; toolCalls: 35 `movie`, 27 `todo`, 16
  `bash`, 10 `movie_help`, 8 `read`, 3 `ltx`, 2 `ltx_help`, 1 `goal_complete`
  (rejected — no active `/goal`, harmless).

## Result: PASS, independently re-verified

All 8 stages reached `status=completed` with `humanApproved=true` on every
gated stage (proposal, script, scene_plan, assets, publish); zero
`overrideArtifactValidation`/`overrideFinalReview` in any `write-checkpoint`
call (grepped every one — all `None`/absent, confirmed programmatically, not
just from the transcript's self-report).

### The two open questions this run answers

1. **Does an agent that never asks for `provider:"edge-tts"` get it
   automatically?** Yes. The `generate` call for `capability: "tts"`
   (session line 114) carries **no `provider` key at all** in its arguments
   — the agent wrote narration text and called `generate` with only `text`
   and voice-neutral options. The result (line 115) reports
   `"provider": "edge-tts"`, confirming `bridge.ts`'s edge-tts-first fallback
   fired with zero explicit steering, exactly as designed in PR #463.
2. **Is the motion genuinely real (LTX I2V), not zoompan-over-a-still?**
   Yes, independently confirmed two ways:
   - Both `assets/scene{1,2}-video.mp4` are real files (1.4MB / 1.3MB, h264
     video + aac audio, `ffprobe`-confirmed 10.04s each), produced via
     `movie generate capability=video_generation provider=ltx-runpy
     command=i2v` with `options.fromImage` pointing at the just-generated
     T2I still.
   - SSIM between frames pulled at different timestamps *within* the final
     published mp4 (not just "the file exists"): frame@1s vs frame@4s
     (scene 1) → `SSIM All=0.627`; frame@4s vs frame@8s (scene 1) →
     `0.525`; frame@12s vs frame@16s (scene 2) → `0.523`. A static frame
     panned/zoomed by ffmpeg's `zoompan` over one source image would still
     show much higher structural similarity across a few seconds than these
     numbers — this is real generated motion, not a re-composited still.

### Independent filesystem/ffprobe verification (this session, not the agent's self-report)

```
final.mp4: /Users/huangziyu/proj/video_generation__output/movie-director/projects/neuralnet-agent-driven-v2-motion/final.mp4
  ffprobe: duration=19.056s, 640x960, h264 (yuv420p, 24fps) + aac (24kHz mono)
  volumedetect: mean_volume=-27.5dB, max_volume=-9.3dB (real narration audio, not silence)
  size: 2,066,865 bytes
```

Checkpoint files (8/8, all `status: "completed"`) found at
`/Users/huangziyu/video_generation__output/movie-director/projects/neuralnet-agent-driven-v2-motion/checkpoint_{research,proposal,script,scene_plan,assets,edit,compose,publish}.json`
— note this is a **different root** than where `assets/`/`final.mp4` landed
(`/Users/huangziyu/proj/video_generation__output/...`), reproducing the exact
"workspace split" footgun first flagged in `h-real-agent-driven-20260705.md`
(init-project's checkpoint store and the agent's chosen asset/output paths
diverge under `~/video_generation__output` vs `~/proj/video_generation__output`).
The agent used absolute paths throughout so the run still succeeded — this is
a recurring rough edge, not a new bug, and still worth a real fix (return one
canonical root from `init-project` that the agent can't diverge from).

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

## Process notes (honest)

- **First I2V attempt used the wrong runtime and failed.** The agent first
  tried the Swift-native `ltx i2v`/`native-i2v` path directly (bypassing the
  `movie generate` dispatcher) and hit a Metal-library load failure (exit
  255) — a pre-existing environment issue with the unbuilt/broken Swift LTX
  binary, not something this run's changes touched. It correctly recovered
  by switching to `movie generate capability=video_generation
  provider=ltx-runpy`, which uses the `run.py video t2i2v` MLX path (the
  same provider PR #463's `v4-motion` script exercises) — this succeeded.
- **First-pass motion clips were the wrong duration (~4s instead of the
  requested ~10s)** because the agent's initial `generate` call for
  `video_generation` didn't pass an explicit frame count, so `run.py`
  defaulted to a shorter clip. The agent diagnosed this itself (`ffprobe`'d
  the output, saw 4.04s, checked `run.py video --help`, found `--frames`)
  and regenerated both scenes at `--frames 241` (10.04s @ 24fps) — a
  legitimate self-correction, not a schema override or a silent short-clip
  ship. This is a rough discoverability edge (the `movie generate` options
  schema doesn't obviously surface "duration ⇒ frames" the way `run.py
  video`'s own CLI help does) worth a follow-up, but not a correctness bug.
- **Path-safety rejections on first `ltx`/`native-i2v` attempts.** Both the
  output path and the input image path were initially outside the allowed
  sandbox roots (`/Users/huangziyu/proj/video_generation__output/...` vs the
  project's own `assets/` dir) — the agent recovered by copying files into
  the project `assets/` directory. This matches the `PathSafetyError`
  finding already fixed in PR #463 for `s2-agent-ext-ltx`'s sandbox
  (movie-director's own workspace); this session's occurrence is the same
  family of friction re-surfacing on ad hoc paths the agent picked itself,
  not a regression.
- **`goal_complete` was called and rejected** ("no active goal") at the very
  end — harmless; the agent had no `/goal` active in that session, this is
  just a leftover tool-adherence habit from other work, not a task failure.
- **No overrides, no fabricated paths for the core pipeline artifacts.**
  Every `research_brief`, `proposal_packet`, `script`, `scene_plan`,
  `asset_manifest`, `edit_decisions`, `render_report`/`final_review`, and
  `publish_log` validated cleanly against its canonical schema before being
  written (11 `validate-artifact` calls across 7 distinct artifact types,
  same discipline as the v3 receipt).

## Significance

Fourth fully-real, agent-driven, zero-override movie-director run, and the
first to combine real LTX I2V motion AND the edge-tts-default fallback in
one agent-driven session — closing item 1 of
`next-goal-20260711-v2-motion-voice.md`. Confirms both PR #463 upgrades
(real motion, edge-tts-first) hold up under LLM-agent orchestration, not
just the deterministic script (`run-real-e2e-neuralnet-v4-motion.ts`) that
originally proved them. Two real, reproducible findings carried forward:
(1) the workspace-split footgun (`init-project` checkpoint root vs.
agent-chosen asset root diverging) is still open and has now bitten two
separate agent-driven runs eight days apart — worth an actual fix, not just
a repeated note; (2) `movie generate`'s `video_generation` options schema
doesn't make "how do I control clip duration" as discoverable as `run.py
video --help` does directly, which is why the agent burned one full 4-minute
generation on the wrong duration before self-correcting.
