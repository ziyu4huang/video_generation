# Multi-Reference Ingredients (native-ingredients N-image extension) Design

## Goal

Extend Swift `ltx-video native-ingredients` to accept multiple reference
images (instead of exactly one) as a first, concrete step toward closing
the `reference_to_video` gap documented in
`docs/openmontage-capability-matrix.md` — OpenMontage's premium providers
(Seedance 2.0 etc.) condition on up to 9 simultaneous reference images
(identity/wardrobe/setting/style); this repo's native MLX stack currently
has no simultaneous-multi-image conditioning path that hasn't already been
tried and confirmed negative.

This is explicitly framed as an experiment with an honest pass/fail
outcome, not a guaranteed feature. Whether it is ever wired into the
`pi-agent-ext-movie-director` pipeline depends on the empirical result
(see Phase 2).

## Background

`bun-apps/pi-agent-ext-movie-director`'s assets stage
(`assets-encoder.ts`) drives video generation exclusively through Swift's
`ltx-video native-relay` (via `pi-agent-ext-ltx`'s CLI-flag registry,
`commands.ts`), not Python `run.py`. Swift is therefore the stack where
new pipeline-usable capability must land.

Two prior multi-image experiments are already documented as failures in
the capability matrix, and this design must not repeat either:

1. **Same-frame-0 multi-anchor via `VideoConditionByLatentIndex`**
   (`run.py --image A 0 1.0 --image B 0 0.5`): confirmed negative —
   `combined_image_conditionings()` resolves same-index anchors to
   last-registered-anchor-wins. `VideoConditionByLatentIndex` is a
   **replace**-at-fixed-position mechanism, so same-position anchors
   genuinely collide.
2. **Composited multi-panel reference sheet fed to `native-ingredients`**
   (one image containing 2 panels): also negative, but differently — the
   output collapsed to a near-static replay of the input sheet, and even
   the single-reference control showed weak identity preservation.

Neither experiment tested what this design proposes: N **separate**
reference images, each independently encoded and passed through the
existing `VideoConditionByReferenceLatent` mechanism, which is
architecturally an **append** (not replace) operation —
`swift/ltx-video-director/Sources/LTXVideoDirector/Sampling/
LatentConditioning.swift:93-122`. It appends a whole reference clip's
clean latent tokens to the end of the token sequence as always-preserved
(`denoiseMask=0`) context that generation tokens attend to via ordinary
self-attention (`Attention.swift`/`DenoiseLoop.swift` already thread a
per-state `attentionMask` for exactly this). This is a different
mechanism from the one that collided in experiment 1, so experiment 1's
negative result does not predict this design's outcome one way or the
other.

**Known open risk, stated up front:** in the single-reference case today
(`NativeUpscaleStage.generateIngredients`,
`NativeUpscaleStage.swift:744-747`), the reference image is tiled to the
full target frame count and VAE-encoded, and its patchified positions
(`Positions.computeVideoPositions(numFrames: dims.f, height: dims.h,
width: dims.w, ...)`) land on the **exact same** (frame, height, width)
coordinate grid as the generation's own tokens — same `dims.f/h/w` because
both are derived from the same target frame count and resolution. If a
second reference is encoded the same way and appended with the same
position grid, both references occupy identical RoPE positions. Whether
the model (an IC-LoRA trained, as far as is known, only with a single
reference at this position scheme) can usefully distinguish/composite two
same-position reference blocks — versus averaging or ignoring one — is
unknown and exactly what Phase 1's empirical test measures. No temporal
position offset or other disambiguation scheme is implemented in this
pass; if the naive same-position concat fails, that failure mode is
recorded in the capability matrix and a position-offset variant is noted
as unstarted future work, not built speculatively here (YAGNI).

## Architecture

### Phase 1 — engine extension + empirical verification (Swift only)

**`NativeUpscaleStage.generateIngredients`**
(`swift/ltx-video-director/Sources/LTXVideoDirector/NativeUpscaleStage.swift:693`):

- Signature changes from `referenceImageURL: URL` to
  `referenceImageURLs: [URL]` (plural, non-empty — empty array throws a
  new `StageError.noReferenceImages` case, mirroring `noFramesFound`'s
  existing style).
- For each URL in `referenceImageURLs`, run today's existing per-image
  steps unchanged: existence check (`StageError.referenceImageNotFound`,
  now on the specific failing URL, not just "the" reference), load, resize
  to `outW`/`outH` via `FrameLoad.resizeAspectFillCenterCrop`, tile to
  `frames` copies, VAE-encode via the same shared `VideoEncoder` instance
  (load the encoder weights once, reuse across all N images — avoid
  reloading the same checkpoint N times), patchify via
  `VideoLatentPatchifier.patchify`.
- Concatenate the N resulting `(tokens, dims)` pairs along the token axis
  (`MLX.concatenated([...], axis: 1)`) into one `referenceTokens` tensor,
  and concatenate their (identical-shape, since all N share the same
  `dims.f/h/w`) position tensors the same way into one `positions` tensor
  — both are now `N × (dims.f * dims.h * dims.w)` long instead of `1 ×`.
- Single `VideoConditionByReferenceLatent` call, unchanged otherwise
  (`strength: 1.0`), now receiving the concatenated `referenceTokens` /
  `referencePositions`.
- Everything downstream (LoRA fusion, denoise loop, audio, decode, mux) is
  unchanged — the denoise loop already handles an arbitrary
  reference-token count via the existing attention-mask plumbing.
- `IngredientsResult` is unchanged.

**`NativeIngredientsCommand.swift`**
(`swift/ltx-video-director/Sources/LTXVideoDirectorCLI/
NativeIngredientsCommand.swift`):

- `@Option(name: .shortAndLong, help: ...) var input: String` becomes
  `@Option(name: .customLong("input"), parsing: .upToNextOption) var
  input: [String]`, repeatable — same `parsing: .upToNextOption` pattern
  already used for `--lora`/`--anchor-image` in `NativeI2VCommand.swift:
  78-80,124-126` and `NativeRelayCommand.swift:66-68`. Empty-array
  validation happens in `NativeUpscaleStage.generateIngredients` itself
  (`StageError.noReferenceImages`), not in the CLI layer.
- `run()` maps `input.map { URL(fileURLWithPath: $0) }` into the new
  `referenceImageURLs:` parameter. Single-image invocations
  (`--input a.png`) keep working unchanged — this is a strict superset of
  the current CLI contract, not a breaking change.

### Phase 1 empirical test (manual, not an XCTest)

Run `native-ingredients` with 2 maximally-distinct reference images (same
technique as the capability matrix's existing negative tests — e.g. a
close-up portrait for identity + a distinct object/setting with no faces
for style/setting), a real Ingredients IC-LoRA checkpoint, and a prompt
that would plausibly draw on both if compositing works. Inspect the
output (VLM caption of extracted frames, same method the matrix already
uses elsewhere) for whether traces of **both** references appear, versus
one reference dominating/replacing the other (matching or worse than the
already-negative composited-sheet result), versus a degenerate/garbage
output. Record the verdict — positive, negative, or inconclusive — as a
new dated entry under the `reference_to_video` row (or a new subsection)
in `docs/openmontage-capability-matrix.md`, in the same evidence-first
style as every existing entry. No specific outcome is assumed here.

### Phase 2 — pipeline wiring (conditional on Phase 1 being a real positive)

Only if Phase 1's empirical test shows genuine multi-reference
compositing (not just "didn't crash"):

- `bun-apps/pi-agent-ext-ltx/src/commands.ts`'s `"native-ingredients"`
  entry: change `input: { flag: "--input", type: "string", isPath: true,
  ... }` to `referenceImages: { flag: "--reference", type: "string[]",
  isPathArray: true, description: "..." }` — reusing the existing plain
  repeatable-path-array pattern already used by `inputs` (review/quality
  commands) and `videos` (gate), NOT `isPathSpecArray` (that suffix
  syntax is for `path[:strength]`/`path:frameIndex[:strength]` specs,
  which reference images don't need).
  - Note: this renames the CLI flag from `--input`/`input` to
    `--reference`/`referenceImages`. Since `native-ingredients` has no
    existing callers in the movie-director pipeline yet (assets stage
    only calls `native-relay` today), this is not a breaking change to
    any wired consumer — just the CLI's own surface.
- Whether/how the movie-director assets stage (`assets-encoder.ts`) ever
  invokes `native-ingredients` at all is a separate, larger design
  question (a new asset-generation mode alongside `native-relay`) —
  explicitly out of scope for this design. Phase 2 here is limited to
  making the capability CLI-reachable with the same shape conventions as
  the rest of `pi-agent-ext-ltx`, not to pipeline integration.

If Phase 1 is negative or inconclusive: skip Phase 2 entirely. Document
the finding in the capability matrix and stop — same disposition as the
CelebV-HQ lip-sync result (best-measured, not wired as a default) and the
composited-sheet negative before it.

## Testing

**Unit tests** (`swift/ltx-video-director/Tests/LTXVideoDirectorTests/
NativeUpscaleStageRealCheckpointTests.swift`, extending the existing
`testGenerateIngredientsMissing*` pattern at lines 357/386):

- `generateIngredients(referenceImageURLs: [])` throws
  `StageError.noReferenceImages`.
- `generateIngredients(referenceImageURLs: [validURL, missingURL])`
  throws `StageError.referenceImageNotFound(missingURL)` — confirms
  per-image existence checking still identifies the specific bad path in
  a multi-image list, not just "some" image.
- A synthetic (non-real-checkpoint) test asserting that concatenating 2
  same-shape `(tokens, dims)` pairs produces a reference tensor with
  exactly `2 ×` the single-image token count, and that
  `VideoConditionByReferenceLatentParityTests.swift`'s existing
  single-reference parity assertions still pass unchanged when only 1 URL
  is supplied (regression guard for the signature change).

**CLI-level test** (`swift/ltx-video-director/Tests/
LTXVideoDirectorCLITests` or equivalent, if one exists for
`native-ingredients`'s argument parsing today — otherwise add one): a
single `--input a.png` invocation still parses into a 1-element array
(backward-compat check on the flag's `parsing: .upToNextOption` change).

**Empirical verification**: the Phase 1 manual 2-reference generation
described above — this is evidence-gathering, not a pass/fail unit test,
and its result is recorded in the capability matrix rather than asserted
in CI.

**`bun test` regression** (only if Phase 2 proceeds): existing
`pi-agent-ext-ltx` schema tests (`commands.test.ts`) plus a new case
confirming `referenceImages` parses as a repeatable plain path array, same
shape as the existing `inputs`/`videos` fields.

## Out of scope

- Any Python `run.py` / `ltx_pipeline.py` changes — Swift is the only
  consumer the movie-director pipeline actually drives (see Background).
- A temporal-position-offset (or any other) disambiguation scheme between
  references — noted as a possible follow-up only if the naive
  same-position concat in Phase 1 turns out negative.
- Wiring `native-ingredients` (multi-reference or otherwise) into
  `assets-encoder.ts`/the movie-director pipeline's actual asset
  generation — a separate design decision, gated on Phase 1's result.
- Reference-video and reference-audio anchors (motion/camera/voice/music)
  — still completely absent from this repo per the capability matrix;
  unrelated to this design's image-only scope.
- Raising `strength` above the hardcoded `1.0` on any conditioning call
  site — a pre-existing, separately-tracked gap
  (`docs/openmontage-capability-matrix.md`'s `reference_to_video` row
  already flags "no conditioning-strength CLI knob exists").
