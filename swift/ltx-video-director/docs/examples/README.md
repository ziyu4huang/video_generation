# Storyboard config examples

`storyboard_camera_move.json` / `storyboard_hard_cut.json` are example inputs
for `ltx-video native-storyboard --config <file>` (see
`StoryboardConfig.swift` for the full schema and
`NativeStoryboardCommand.swift` for the CLI).

Both reference a placeholder `storyboard_grid.png` — a real NxN grid image
(e.g. a 2x2 four-panel storyboard image) must exist next to the config file,
or `grid.image` must point at one. Asset paths inside the JSON (`grid.image`,
`loras[].path`, `audio.overlayPath`) resolve relative to the config file's
own directory, not the process's working directory.

## `transitionMode`

- `"camera-move"` — ONE continuous shot. Every grid panel is pinned as a
  keyframe guide at its own `frameIndex` within a single clip's timeline
  (dispatches to `NativeI2VStage`/`native-i2v` under the hood). Every panel
  in the grid must be covered by exactly one segment. There is only one
  text-conditioning prompt for the whole clip (the top-level `prompt`, or —
  if omitted — the segments' own `prompt`s joined with `". "`) since a
  single LTX-2.3 generation call has one text-encode pass, not one per
  keyframe.
- `"hard-cut"` — N discrete segments, each its own independent I2V
  generation conditioned on its own storyboard panel, concatenated with a
  true cut (no cross-fade). Dispatches to `NativeRelayStage`/`native-relay`
  under the hood, using the new `segmentGridPanels`/`segmentGridStrengths`
  fields to pin each segment to a different panel instead of the default
  relay behavior (feeding the previous segment's last frame forward).

## Field reference

| Field | Meaning |
|---|---|
| `transitionMode` | `"camera-move"` \| `"hard-cut"` |
| `prompt` | camera-move only: the single overall generation prompt |
| `width`/`height`/`fps`/`seed`/`t2iTransformer`/`textMaxLength` | generation params, same defaults as `native-i2v`/`native-relay` |
| `seconds` | camera-move: total clip duration. hard-cut: duration PER segment (uniform across all segments) |
| `grid.image`/`grid.columns`/`grid.rows` | the shared NxN storyboard panel image |
| `segments[].panel` | row-major panel index (0 = top-left) this segment/keyframe uses |
| `segments[].prompt` | hard-cut: required, this segment's own I2V prompt. camera-move: optional, only used as a fallback prompt source |
| `segments[].frameIndex` | camera-move only: latent frame index within the single clip this panel is pinned at |
| `segments[].strength` | conditioning strength (0.0-1.0, default 1.0) for this panel in both modes |
| `loras[].path`/`loras[].strength` | LoRA(s) fused into the distilled transformer, same as `--lora path:strength` |
| `audio.overlayPath` | hard-cut only: replaces the final concatenated video's audio (mirrors `--relay-audio`) |
| `output` | default output directory (overridable with `--output`) |
