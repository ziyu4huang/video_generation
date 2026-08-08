# compose-hyperframes narration audio — design

## Problem

`hyperframes_native.ts`'s `renderHyperframes()` (and its pure generator
`buildHyperframesComposition()`) render cuts and overlays but drop `edit.audio`
entirely — any `RemotionEditDecisions.audio` (narration or music) only produces
a warning: `"hyperframes compose tier does not yet wire edit.audio..."`. Any
story-driven scene that needs narration must currently fall back to
`compose-remotion`, even though HyperFrames' `<audio>` element model can carry
narration natively.

This spec closes the narration half of that gap. `edit.audio.music` (loop,
fade in/out, offset) stays explicitly out of scope: HyperFrames has no native
loop equivalent to Remotion's `<Audio loop>` — the framework forbids driving
media playback directly ("HyperFrames owns playback"), so looping would
require tiling multiple `<audio>` clips across the timeline. That's a
separate, larger piece of work, deferred by explicit decision. A scene needing
music continues to route to `compose-remotion`.

## Design

### `hyperframes_native.ts`

**`buildHyperframesComposition`** gains narration handling, following the same
failure-tolerant pattern already used for a cut with a missing source (warn +
skip, never fail the whole composition):

- If `edit.audio?.narration` is present, validate its `src` exists locally or
  is a URL/`data:` URI (same check `valid` cuts already run). If missing, push
  `narration source missing: <src>` to `warnings` and skip emitting the audio
  element — cuts/overlays still render.
- If valid, resolve it through the same `resolveSrc(src, label)` callback cuts
  and overlays already use, so narration gets staged into
  `hyperframes-assets/` exactly like an image/video source (the `-c` sandbox
  constraint documented at the top of the file — no external/absolute paths —
  applies to `<audio src>` identically).
- Emit one `<audio>` element as a **direct child of the composition root**,
  alongside `cutBlocks`/`overlayBlocks`:
  ```html
  <audio id="narration" src="{resolved}" data-start="0" data-track-index="2" data-volume="{volume ?? 1}"></audio>
  ```
  - `data-track-index="2"`: cuts use `0`, overlays use `1` — narration gets
    its own reserved track to avoid the same-track-overlap rule (this is
    documented in a comment at the emission site).
  - No `data-duration`: an audio element without one plays its full intrinsic
    length, naturally clipped by the root's `data-duration` — mirroring how
    Remotion's `<Audio>` is bounded by the composition's frame count without
    explicit trimming. No probing of the narration file's own duration is
    needed (`renderRemotion` doesn't do this either).
  - No GSAP volume tween: `RemotionAudio.narration` has no fade fields (only
    `music` does), so a static `data-volume` is the complete contract.
  - No `class="clip"`: per the HyperFrames data-attributes contract, `<audio>`
    is exempt from the clip-visibility marker (framework drives it via a flat
    DOM query regardless of nesting/marker).

**`renderHyperframes`**'s blanket audio-gap warning narrows to music only:

```ts
if (edit.audio?.music) {
  warnings.push("hyperframes compose tier does not support edit.audio.music (loop/fade) — use compose-remotion when music is required");
}
```

The narration-missing-source warning above already surfaces through
`built.warnings` (same mechanism as cut-source-missing warnings) — no separate
check needed in `renderHyperframes` itself.

### Docstring / help-text updates

- `hyperframes_native.ts`'s top-of-file docstring (currently: `"edit.audio
  (narration/music) is NOT yet wired"`) updates to say narration is wired,
  music is not.
- `dispatch.ts`'s `compose-hyperframes` help-text block (`dispatch.ts:251`,
  currently `"v1 does NOT wire edit.audio (narration/music) — use
  compose-remotion when audio is required"`) updates to: narration is wired
  identically to compose-remotion's shape; music is not — use compose-remotion
  when music is required.

### No changes needed

- `dispatch.ts`'s `case "compose-hyperframes":` block itself — it already
  forwards `opts.editDecisions` (the full `RemotionEditDecisions`, including
  `.audio`) to `renderHyperframes()` unmodified. Narration flows through
  automatically once `hyperframes_native.ts` consumes it.
- `commands.test.ts` — dispatch-layer behavior (error contract, pre-compose
  gate enforcement) is unchanged; the new coverage belongs entirely in
  `hyperframes_native.test.ts`, which already owns cut/overlay-generation
  testing at the right layer.
- `precompose-gate.ts` — unaffected; it reasons about cuts/duration, not audio.

## Testing

Extend `hyperframes_native.test.ts`:

1. `buildHyperframesComposition` unit test: `edit.audio.narration` with a
   valid (mocked-existing) source → the generated HTML contains an `<audio
   id="narration">` tag with the expected `src` (via a fixed `resolveSrc`) and
   `data-volume` (both the default `1` and an explicit override).
2. `renderHyperframes` test: valid narration + a valid cut → output produced,
   **no** narration-related warning present.
3. `renderHyperframes` test: narration with a missing source file → output
   still produced (cuts render), warning `narration source missing: ...`
   present.
4. Replace the existing "warns (without failing) when edit.audio is present"
   test (which currently asserts a warning for narration — no longer true)
   with a music-only variant: `edit.audio.music` present → warning containing
   `"does not support edit.audio.music"`, narration absent from the edit so
   the test isolates the music case.

Full existing suite (`bun test` in `bun-apps/pi-agent-ext-movie-director/`)
must stay green throughout.

## Non-goals

- `edit.audio.music` (loop, fade in/out, offset, volume curve) — fully
  deferred to `compose-remotion`.
- No changes to `dispatch.ts`'s dispatch case, `commands.test.ts`, or
  `precompose-gate.ts`.
- No probing of narration audio duration — the render's own `data-duration`
  (derived from cuts/overlays) remains the sole source of truth for total
  length, unchanged from today.
