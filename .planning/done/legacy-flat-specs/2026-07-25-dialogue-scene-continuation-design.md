# Kai/Dov Deal Aftermath — Dialogue + Action Continuation — Design

**Goal:** Extend `dialogue-scene-v4.mp4` (12-line Kai/Dov package-deal dialogue,
all static-camera talking-head shots) with a continuation beat that mixes
lip-synced dialogue with non-dialogue action shots — proving the pipeline can
cut between "talking" and "moving" coverage, not just talking heads back to
back. No new characters: reuses Kai's and Dov's existing portraits/voices to
avoid re-triggering the identity-naturalness problems solved for v4.

**Architecture:** Two shot types sharing the same source portraits and
native-i2v backend, diverging after that:
1. **Dialogue shots** — unchanged `produce_line_v4.sh` pipeline (TTS →
   native-i2v base → LipDub → `lipsync_metrics.py` gate → 501/511 retry).
2. **Action shots** — new `produce_action_v1.sh`: native-i2v only (no TTS, no
   LipDub), driven by a motion-specific prompt per beat, with an ambient
   night-street audio bed instead of dialogue audio.

**Tech stack:** Same as v4 (MLX TTS, Swift `native-i2v`, `run.py video
lipdub`, `lipsync_metrics.py`) plus `run.py video quality --vlm-score` as the
action-shot sanity check, and the newly-merged `evaluate-lipsync` CLI
(`bun-apps/pi-agent-ext-movie-director/src/cli.ts evaluate-lipsync`) as a
deterministic, no-LLM way to reuse the self-learning scoring contract from
this session's earlier work.

---

## Story beats

Continues immediately after v4's closing line ("Don't you ever call this
number again."). No new characters — the escalation is conveyed by ambient
threat (siren/headlights) referenced in dialogue and body language, not by a
third face on camera.

**Revision (post-prototype):** the original beats below described
discrete physical actions (glancing back, turning, jogging). A prototype
round tested four independent hypotheses for driving that kind of motion —
strengthened prompt wording, boosted CFG/STG guidance, a non-speech
`--audio-track` (synthetic noise-envelope SFX), and a camera dolly-in prompt
— against the same portrait/seed. All four produced frame-1-vs-frame-N
output that was visually indistinguishable (see `cont_action1*` prototype
files in the scratch dir). Conclusion: `native-i2v` in this configuration
(distilled transformer, portrait-crop, static camera) has no working driver
for discrete large-scale motion — audio drives mouth articulation only, and
prompt text does not meaningfully steer body/camera motion without a
dedicated (unverified-in-this-repo) camera-move LoRA. Action beats are
revised below to idle-tier micro-motion — the same visual register already
proven to work for the dialogue shots (subtle breathing, gaze shift, jaw
tension, blinking) — with the narrative escalation carried by the dialogue
lines and cut pacing, not by the silent shots.

| # | Type | Character | Content |
|---|------|-----------|---------|
| 1 | action | Dov | stands wary, jaw tight, eyes scanning slightly |
| 2 | action | Kai | grip tightens on the package, gaze drops briefly |
| 3 | dialogue | Kai | "Did you hear that?" |
| 4 | dialogue | Dov | "That's not for us. Keep walking." |
| 5 | action | Kai | eyes shift toward the light, brow furrows |
| 6 | dialogue | Kai | "It's slowing down." |
| 7 | dialogue | Dov | "Then we are not standing here arguing about it." |
| 8 | action | Dov | tense stance, breath held, ready to move |
| 9 | dialogue | Kai | "Go. I will lose them by the river." |
| 10 | dialogue | Dov | "Don't die stupid tonight." |
| 11 | action | Kai | jaw tense, breathing quickens, eyes darting |

## Component 1: Action-shot pipeline (`produce_action_v1.sh`)

New script, sibling to `produce_line_v4.sh`, same `$D` scratch dir. Usage:
`produce_action_v1.sh <out_name> <portrait> <seed> <action_prompt> <duration_s>`.

Steps:
1. No TTS. `native-i2v` runs without an `--audio-track` for these shots (no
   dialogue to sync). The ambient night-street bed is mixed in once, globally,
   at assembly time (Component 4) — not per shot.
2. `native-i2v --prompt "<action_prompt>" --input-image <portrait> --seconds <duration_s> --seed <seed> --no-upscale --no-refine -o <out>-base` — same backend as dialogue shots, but the prompt describes the specific motion (e.g. "the man glances back over his shoulder warily, then faces forward again, camera static, night street with neon glow") instead of talking.
3. No LipDub pass (no audio to sync to).
4. Quality check: `run.py video quality --quality-inputs <out>-base/video.mp4 --vlm-score --quality-json <out>_quality.json`, plus a manual frame-grab spot-check (start/mid/end) — there is no established automatic pass/fail threshold for action motion the way `lipsync_metrics.py` has one for lip sync, so this stage is judgment-based, not gated.

## Component 2: Dialogue shots (lines 3, 4, 6, 7, 9, 10)

Unchanged `produce_line_v4.sh`, same as v4's lines 1-12: same `BASE_PROMPT`
(the prompt that avoids mouth-motion suppression), same voices (`am_michael`
for Kai, `am_onyx` for Dov), same 501→511 retry-on-inadequate logic.

## Component 3: Self-learning application (scoped)

`evaluate-lipsync` was built this session for the pi-agent runtime (an LLM
agent calls it as a tool, then calls hermes-memory's `memory` tool to persist
the lesson). This session is Claude Code, which does not have those pi-agent
tools loaded. To still get the accumulation benefit without misrepresenting
the mechanism:

- After each dialogue shot's `lipsync_metrics.py` run, additionally invoke
  the CLI directly: `bun bun-apps/pi-agent-ext-movie-director/src/cli.ts
  evaluate-lipsync --videoPath <shot.mp4> --seed <seed> --identityRef
  <kai|dov> --voice <am_michael|am_onyx> --json` (deterministic, no LLM
  call — same `dispatch()` used by the CLI's other commands).
- Take the returned `lesson.content` and write it into Claude Code's own
  project-scoped auto-memory (not hermes-memory) — same intent (future
  dialogue-scene work in this repo can recall which seed/prompt/identity
  combos worked), different storage, since that is the memory system
  actually available in this session.
- Action shots skip this — no lipsync verdict exists to feed the lesson
  builder.

## Component 4: Assembly

Extend v4's `-filter_complex concat` approach (11 new segments appended after
the existing 12) with one addition: mix a single continuous ambient
night-street bed under the concatenated track at low volume (`-filter_complex
... amix=inputs=2:duration=first:weights='1 0.15'` after the dialogue/action
segments are concatenated to one audio stream), so action-shot silence and
dialogue-shot voice both sit on the same bed with no audible seams. Verify the
same way v4 did: `ffmpeg -v error -i final.mp4 -f null -` (zero output) and an
`ffprobe` video/audio duration match.

## Testing / acceptance

- Each dialogue shot: `lipsync_metrics.py` verdict `adequate`, or explicitly
  flagged best-effort with actual `pearson_r`/`mouth_ratio_std` reported (no
  silent downgrade) — same bar as v4.
- Each action shot: `run.py video quality --vlm-score` report generated, plus
  a manual spot-check confirming no hallucinated artifacts and the described
  motion is visibly present (not a static/frozen frame passed off as motion).
- Final `dialogue-scene-v5.mp4`: `ffmpeg -f null -` zero errors, `ffprobe`
  video/audio duration match, continuous ambient bed audible with no gap at
  the v4→continuation splice point.
- Each dialogue shot's `evaluate-lipsync` lesson is written to project
  auto-memory (verifiable by re-reading the memory file after the run).
