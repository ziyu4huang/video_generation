# Camera-control-LoRA integration into `native-relay` (Phase 2)

## Context

Phase 0/1 (PR #890, #896, merged) proved Cseti's Cameraman v2 IC-LoRA gives a
real directional improvement over prompt-only camera-movement text, in both
the Python spike and Swift's `native-restyle` command — with zero new Swift
engine code needed for that isolated single-shot case.

That conclusion does not carry over to the actual movie-director production
path. The real pipeline (`assets-encoder.ts` → `driver-wiring.ts`) issues
exactly ONE `native-relay` call per movie: every scene's video is one chained
sequence of I2V segments, each segment's last decoded frame feeding the next
segment's start, concatenated natively inside Swift. `native-relay` already
has a `--lora` flag, but it is a flat weight-fusion LoRA applied uniformly to
the whole chain — it has no per-segment reference-video-to-latent conditioning
step, which is what an IC-LoRA (like Cameraman v2) actually requires (`[2/5]
VideoEncoder: encoding reference video to latent (IC-LoRA conditioning)`, only
present in `native-restyle`'s code path today).

Standing architecture rule (reaffirmed 2026-07-27): Python is dev/spike-only;
production CLI surfaces the TS agent bridge calls into must be Swift-native.
This design is entirely Swift + TS wiring — no `run.py` involvement.

`scene_plan.schema.json` already defines `shot_language.camera_movement` per
scene (18-value enum matching `shotLanguage.ts`'s `CAMERA_MOVEMENTS`), but
`assets-encoder.ts`'s `SceneLike`/`RelayLink` never reads it — today
`camera_movement` only reaches generation as flattened prompt text (via
`applyShotLanguage`, used elsewhere in `pi-agent-ext-ltx`, not in the
production movie-director path at all).

## Scope (v1)

Only two movement types ship in v1: **`dolly_in`** and **`tilt_up`** — the two
that measured cleanly in both the Python (PR #890) and Swift (PR #896) spikes.
`pan_right` (messier result) and the 5 untested-but-affine-mappable movements
(`dolly_out`, `pan_left`, `tilt_down`, `zoom_in`, `zoom_out`) are explicitly
OUT of v1 — those scene/segments continue to get text-only prompt rendering,
same as today. The other 11 movement types (`tracking_*`, `crane_*`,
`handheld`, `steadicam`, `whip_pan`, `orbital`, `rack_focus`) have no simple
2D-affine synthetic-reference equivalent and stay text-only indefinitely
(not part of this or a future phase without a different reference-sourcing
strategy).

## 1. Data flow (scene_plan → TS wiring)

- `assets-encoder.ts`: `SceneLike` gains `shot_language?: { camera_movement?: string }`
  (reads existing scene_plan data, no schema change needed). `RelayLink` gains
  `cameraMovement?: string`. `planAssetGeneration` copies
  `scene.shot_language?.camera_movement` onto every link belonging to that
  scene.
- `driver-wiring.ts`: the `native-relay` dispatch call gains a new parallel
  array option, `cameraMovements: plan.relayLinks.map(l => l.cameraMovement ?? "none")`,
  same length/order as `prompts`/`secondsPerSegment`/`segmentContinuity`.
- `pi-agent-ext-ltx/src/commands.ts`: `native-relay`'s `fields` gains
  `cameraMovements: { flag: "--camera-movements", type: "string[]", description: "..." }`.

## 2. Swift engine change

New CLI flags on `native-relay`:
- `--camera-movements <v1,v2,...>` — per-segment array aligned with `--prompts`.
  Values outside the v1-supported set (`dolly_in`, `tilt_up`) or `none`/omitted
  are no-ops — that segment generates exactly as it does today.
- `--camera-lora <path>` — path to the Cameraman v2 checkpoint. Defaults to
  the bundled-import location (see Section 3) when omitted.

New component: `SyntheticCameraReference.swift` — given a single starting
frame (that segment's T2I output / previous segment's last decoded frame /
`--first-image`), a movement type, and the segment's frame count/resolution,
produces an in-memory synthetic reference frame sequence natively (vImage/
Core Graphics — no ffmpeg, consistent with `native-relay`'s existing "no
ffmpeg" design):
- `dolly_in`: per-frame linear scale-up + center crop.
- `tilt_up`: per-frame crop-window sliding upward along the vertical axis.

Wiring: inside `native-relay`'s existing per-segment loop, when
`cameraMovements[i]` is a v1-supported value, the engine synthesizes the
reference sequence, encodes it to latent via the existing `VideoEncoder`
reference-conditioning path (the same one `native-restyle` already uses),
fuses the Cameraman v2 IC-LoRA weights for that segment's generation call
only, and runs generation with that conditioning. Segments with `none`/
unsupported values are entirely unaffected — no shared state changes, no
change to the last-frame continuity mechanism between segments.

## 3. Cameraman v2 checkpoint storage

This is now a real feature dependency, not a measurement-only spike asset.
Import it properly via the existing model-import convention: external store
symlink at `mlx-models/lora/camera-control/cameraman-v2/` →
`../video_generation__models/<md5>`. Unlike `native-restyle --lora` (a
general-purpose user-supplied style adapter with no bundled default),
`--camera-lora` ships with a bundled default pointing at this imported
checkpoint, since this feature is built around exactly one reference LoRA.

## 4. Verification plan

- Unit: `SyntheticCameraReference`'s synthesis logic — given a starting frame
  + movement type, assert output frame count and crop-window/scale trajectory
  match the intended movement (reuse the Farneback optical-flow direction
  classifier approach from the Python spike, ported to a Swift test, or
  invoked as an external check against exported frames).
- Integration/regression: a 2-3 segment `native-relay` chain with one segment
  marked `dolly_in`, one marked `none` — assert only the marked segment
  differs from a baseline run without `--camera-movements`/`--camera-lora` at
  all (byte-identical output for the `none` segment).
- Real-generation cross-check: run a real chain with `dolly_in` and `tilt_up`
  segments, measure with the same optical-flow methodology used in PR #896,
  confirm the signal matches what was measured calling `native-restyle`
  directly (i.e., wiring into the chain doesn't degrade the effect).

## Explicitly out of scope

- `pan_right` and the 5 untested affine-mappable movements — may become v2 if
  v1 ships clean and someone runs the missing spike measurements first.
- The 11 non-affine-mappable movement types — no reference-sourcing strategy
  exists for these; stays text-only prompting indefinitely.
- Any Python-side work — this feature is Swift + TS only, per the standing
  architecture rule.
