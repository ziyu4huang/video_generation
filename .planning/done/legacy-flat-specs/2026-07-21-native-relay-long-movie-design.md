# Native-relay long-movie generation — design

**Date:** 2026-07-21
**Scope:** `bun-apps/pi-agent-ext-movie-director/`, `bun-apps/pi-agent-ext-ltx/`, `swift/ltx-video-director/`

## Problem

The movie-director agent pipeline still cannot produce long, coherent movies via
relay I2V (LTX). Investigation of the current codebase found two independent
"relay" implementations:

- `python/mlx-movie-director/app/commands/video-relay.py` — a standalone manual
  Prompt-Relay CLI. Not invoked by the agent pipeline.
- The agent's production path: `assets-encoder.ts` (`planAssetGeneration`) +
  `driver-wiring.ts` (`produceAssets`/`produceEdit`/`produceCompose`). Splits each
  scene's duration into `t2i2v` links (≤ `maxCallSeconds`, default 8s), chains
  links *within* a scene via ffmpeg last-frame extraction, but every scene
  boundary is a hard T2I2V cut with zero cross-scene continuity.

Concrete evidence of the failure mode:

- `receipts/real-e2e-20260711-optical-hall-detective.md`: a 120s script /
  162.9s synthesized narration composed into a flat 7×8.04s = 56.28s video.
  Every existing gate passed because the two duration-mismatch checks
  (`narrative_duration_vs_script`, `motion_coverage_vs_scene` in
  `precompose-gate.ts`) are implemented but never receive
  `opts.narrativeDurationSeconds` from `driver-wiring.ts` — they are silently
  skipped in the automated path.
- `precompose-gate.ts` documents a rerun (`optical-hall-effect-150yr`) where
  ~72% of delivered runtime was Ken-Burns-panned freeze-frame filler instead of
  real generated motion.
- The only fully-verified end-to-end chain (`receipts/run-pipeline-full-chain-20260714-rainbows.md`)
  produced 13.2s total — nowhere near "long movie."
- `script-pacing-gate.ts` already detects the "compress narration rate instead
  of extending video" anti-pattern but is advisory-only; the driver can ignore it.

Separately, `swift/ltx-video-director/` has a pure-Swift, zero-Python/zero-ffmpeg
`native-relay` command (`NativeRelayStage.swift`) that already does real
cross-segment last-frame reseed + native AVFoundation concatenation — but it is
registered in the agent's provider bridge (`registry.ts:305`, `swift:ltx`) and
never actually reached: the release binary isn't built, and even if it were, the
pipeline's `t2i2v` command name has no mapping to any Swift subcommand
(`native-i2v`/`native-relay`/`i2v`).

## Decisions (confirmed with user)

1. **Target path**: the agent's automated pipeline (`assets-encoder.ts` /
   `driver-wiring.ts`), not the manual Python CLI.
2. **Generation backend**: wire Swift `native-relay` in as the primary
   long-movie generation mechanism, replacing the `t2i2v`-per-link dispatch to
   `run.py`.
3. **Continuity scope**: the *entire movie* is one continuous relay by
   default — every scene's first segment reseeds from the previous scene's
   last frame, unless the scene_plan explicitly marks a `transition: "cut"`
   (a genuine scene change: new location/time/subject).
4. **Duration gate**: auto-probe the synthesized narration's real duration and
   wire it into `precompose-gate.ts` as `narrativeDurationSeconds`, upgrading
   `narrative_duration_vs_script` and `motion_coverage_vs_scene` from
   advisory-only to **blocking** (a `fail` verdict stops the pipeline; no
   silent `overridePreCompose`).
5. **Quality trade-off**: `native-relay` is distilled-transformer-only today.
   Accepted for v1 — continuity across a long movie matters more than
   per-clip quality. `dev`/`dasiwa` transformer support for `native-relay` is
   explicitly out of scope, a follow-up epic.
6. **Execution architecture**: a single `native-relay` dispatch call for the
   whole movie (flattened prompts/durations/continuity arrays), not one
   dispatch per scene. Rationale: the ~21GB model loads once per process: N
   separate dispatch calls for a long movie would mean N model reloads, which
   is the dominant cost at long-movie scale. The trade-off (coarser
   checkpoint/retry granularity — one failure anywhere fails the whole call)
   is accepted.
7. **Binary availability**: build `ltx-video` is a hard setup requirement.
   Missing/failed build → the pipeline errors out with a clear message
   pointing at `swift build -c release` / `scripts/setup.sh`. No silent
   fallback to the Python `run.py video t2i2v` bridge for this entry point
   (existing generic provider-selection fallback in `providers.ts` is
   untouched for other, non-long-movie call sites).
8. **Edit/compose architecture**: keep `edit_decisions`/`precompose-gate` but
   simplify their semantics — `native-relay` returns one final mp4 plus each
   scene's `[startSeconds, endSeconds)` boundary within it. `edit_decisions`
   cuts become scene-boundary markers into ONE shared source file, not
   separate per-clip source files. `compose-motion`'s ffmpeg concat step is no
   longer needed (nothing to concatenate) — `produceCompose` shrinks to:
   run `preComposeGate`/`enforcePreCompose` over the boundary-marker cuts,
   then `final-review` directly on the relay output.

## Design

### 1. Swift extensions (`swift/ltx-video-director/`)

`NativeRelayStage.Request` currently has a single scalar `seconds: Double`
applied to every segment (`NativeRelayStage.swift:66,200-201`) — no
per-segment duration array exists. Add, following the existing optional-array
pattern already used for `segmentGridPanels`/`segmentGridStrengths`:

- `secondsPerSegment: [Double]?` — one duration per segment; length must equal
  `prompts.count` when given. Omitted → falls back to the existing uniform
  `seconds` behavior (backward compatible).
- `segmentContinuity: [Bool]?` — one bool per segment; `true` = continue from
  the previous segment's last decoded frame (current default behavior),
  `false` = ignore `nextInputImage` and generate fresh via T2I from that
  segment's own prompt (a hard cut). Omitted → defaults to all `true` (segment
  0 has no previous regardless). Mirrors the existing `segmentGridPanels`
  hard-cut branch in `NativeRelayStage.generate` (`NativeRelayStage.swift:207-231`)
  but generalizes it — no grid image required.
- `NativeRelayStage.Result` gains `segmentDurations: [Double]` — the ACTUAL
  generated duration per segment (frame count / fps), not the requested value
  (LTX's 8k+1 frame-stride alignment means requested and actual can differ).

New validation errors (mirroring `StageError.segmentGridPanelsCountMismatch`):
`secondsPerSegmentCountMismatch`, `segmentContinuityCountMismatch`.

CLI (`NativeRelayCommand.swift`): add `--seconds-per-segment` (`.upToNextOption`,
`[Double]`), `--segment-continuity` (`.upToNextOption`, `[Bool]` via
`true`/`false` or `1`/`0` strings), and `--json-out <path>` (mirrors `i2v`'s
`jsonOut` field) writing:

```json
{
  "finalVideoPath": "…/relay.mp4",
  "segments": [
    { "path": "…/seg01/segment.mp4", "durationSeconds": 8.04, "startSeconds": 0, "endSeconds": 8.04 },
    { "path": "…/seg02/segment.mp4", "durationSeconds": 7.96, "startSeconds": 8.04, "endSeconds": 16.0 }
  ]
}
```

`bun-apps/pi-agent-ext-ltx/src/commands.ts`: add `secondsPerSegment`,
`segmentContinuity`, `jsonOut` field definitions to the `native-relay` command
spec. `bridge.ts`'s `realLtx` result parsing gains a branch to read the
`--json-out` file when present (precedent: no command currently does this for
`native-relay`, but the flag-generation/field-definition machinery already
supports `isOutputPath`/`jsonOut`-style fields elsewhere, e.g. `i2v.jsonOut`).

### 2. TS driver redesign

`assets-encoder.ts`'s `planAssetGeneration` changes from "N t2i2v calls" (one
chain per scene) to a single `AssetGenCall` with `command: "native-relay"`:

```ts
{
  capability: "video_generation",
  command: "native-relay",
  options: {
    prompts: string[],            // one entry per link across ALL scenes, in order
    secondsPerSegment: number[],  // matching per-link durations
    segmentContinuity: boolean[], // false at each scene's first link when scene.transition === "cut"
    relayAudio: string,           // path to the already-generated narration wav
  },
}
```

Scenes whose planned duration exceeds the practical per-link quality ceiling
(`maxCallSeconds`, still defaulting to 8s) are still split into multiple
sub-links, exactly as today — the only change is that all sub-links across
the whole movie flatten into ONE array instead of separate per-scene chains
dispatched separately.

This requires a scene_plan schema addition: an optional `transition: "continue"
| "cut"` field per scene, defaulting to `"continue"` when absent (per decision
3). `planAssetGeneration` reads it to set `segmentContinuity: false` on that
scene's first link; all other links (mid-scene continuations, and any scene
without an explicit `"cut"`) get `true`.

`driver-wiring.ts`'s `produceAssets`:
1. Runs the TTS call first (unchanged), producing the narration wav.
2. Probes its real duration (`probeDuration`).
3. Builds the flattened `native-relay` call (including `relayAudio` pointing
   at the narration wav) and dispatches it ONCE.
4. Parses the `--json-out` result to populate `asset_manifest` with one video
   asset plus `scene_boundaries` metadata (per-scene `startSeconds`/`endSeconds`
   mapped back from the flattened per-link array using the same scene_id
   grouping `assets-encoder.ts` already tracks via `chainIndex`).

### 3. Duration reconciliation — two layers

1. **Proactive**: scene_plan generation must size each scene's
   `start_seconds`/`end_seconds` from the real script section's word count /
   speech rate (the same computation `script-pacing-gate.ts` already uses to
   *detect* mismatches) instead of a flat ~8-10s assumption. This is a
   scene_plan-stage prompt/logic fix, upstream of the assets stage.
2. **Enforced safety net**: `produceCompose` probes the narration wav's real
   duration and passes it as `narrativeDurationSeconds` into
   `enforcePreCompose` (`precompose-gate.ts:382`). `narrative_duration_vs_script`
   and `motion_coverage_vs_scene` go from silently-skipped to **blocking** —
   a `fail` verdict stops the pipeline; `overridePreCompose` still exists as an
   explicit escape hatch but is never applied automatically.

### 4. Edit/compose adaptation

`produceEdit` changes from "one cut per clip file" to "one cut per scene
boundary within the single relay output file":

```ts
{ id: `cut-${sceneId}`, source: relayMp4Path, in_seconds: scene.startSeconds, out_seconds: scene.endSeconds }
```

All cuts share the same `source`. `precompose-gate.ts`'s per-cut ffprobe calls
(`cut_duration_vs_source` etc.) can cache the single probe result across cuts
instead of re-probing per cut.

`produceCompose` drops the `compose-motion` ffmpeg-concat dispatch (nothing to
concatenate — `native-relay` already produced one continuous file). It becomes:
run `preComposeGate`/`enforcePreCompose` over the boundary-marker
`edit_decisions`, then `final-review` directly against the relay mp4.

### 5. Rollout / build requirement

- `swift build -c release` (in `swift/ltx-video-director/`) added to
  `scripts/setup.sh` / `scripts/setup-repo-deps.sh`.
- A preflight check before the `assets` stage verifies
  `swift/ltx-video-director/.build/release/ltx-video` exists. Missing → throws
  immediately with a message pointing at the build command. This preflight is
  specific to the long-movie relay entry point; the existing generic
  provider-selection fallback in `providers.ts` (silently picking `mlx:runpy`
  when a Swift binary probe fails) is left untouched for other call sites.

### 6. Testing

- Swift: unit tests for `secondsPerSegment`/`segmentContinuity` array
  validation (count-mismatch error paths, mirroring
  `segmentGridPanelsCountMismatch`), and a case verifying `segmentContinuity:
  false` produces a fresh-T2I segment (no `inputImagePath` set) even mid-relay.
- TS: rewrite `assets-encoder.test.ts` around the flattened single-call plan;
  `driver-wiring.test.ts` covers the TTS-probe → `narrativeDurationSeconds` →
  blocking-gate path with a fake dispatch/json-out; `precompose-gate.test.ts`
  gains a case where `narrativeDurationSeconds` is supplied by the *caller
  under test* (the driver) and actually blocks, not just the existing
  opt-in/never-blocks cases.
- End-to-end regression: rerun the `optical-hall-detective` script through the
  new pipeline and confirm composed duration now tracks narration duration
  (not the old 56.28s/162.9s mismatch).

## Explicitly out of scope

- `dev`/`dasiwa` transformer support in `native-relay` (quality upgrade,
  follow-up epic).
- Any changes to the Python `video-relay.py` manual CLI.
- `native-relay`'s audio `mix`/`keep` modes (only `replace` is used here).
- A/B variant comparison harness integration into the agent pipeline.
