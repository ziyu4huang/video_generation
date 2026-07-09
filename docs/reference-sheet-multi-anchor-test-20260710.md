# Reference-sheet multi-anchor compositing test — 2026-07-10

## Why this exists

`docs/lipsync-lse-metric-measurement-20260710.md` (2026-07-10) confirmed the
naive same-frame-0 multi-anchor approach (`--image A 0 1.0 --image B 0 0.5`)
collapses to last-anchor-wins, not compositing. Web research the same day
(`output/next-goal-20260710-051950.md`) found that Lightricks' own
Ingredients IC-LoRA — the adapter this repo's `native-ingredients` Swift
command already wires up — is documented to support genuine multi-reference
compositing via a **"reference sheet"**: a single composite image with one
panel per element (character close-up, prop render, location panel) on a
black background. This doc tests that mechanism directly, per priority 3 of
the next-goal file. **A real, reproducible experiment was run — this is not
a code-read-only assessment.**

## Test setup

Generated two maximally distinct reference images via the Z-Image T2I
pipeline (so any blending/compositing would be unmistakable): a studio
headshot portrait (red-haired woman) and product photography of a yellow
vintage bicycle. Composited them into a 2-panel reference sheet (1056×544,
each panel 480×480, on a solid black background, per the documented
Ingredients recipe) with a small Python/PIL script (not committed — a
throwaway compositing helper, reproducible from the description above).

Ran `native-ingredients` (`swift/ltx-video-director`, `ltx-2.3-22b-ic-lora-
ingredients-0.9.safetensors`, already present in `mlx-models/lora/`) twice:

1. **Multi-panel test**: `--input reference_sheet.png --prompt "The
   red-haired woman from the reference stands next to the yellow vintage
   bicycle from the reference, in a sunny park."` (512×512, 2s/49 frames,
   seed 42)
2. **Single-reference control**: same command with `--input portrait.png`
   only, prompt adjusted to reference just the woman, same settings —
   run to isolate whether the failure mode is specific to multi-panel
   input or present in the single-reference path too.

## How the mechanism actually works (read from source, confirmed correct)

Checked `NativeUpscaleStage.generateIngredients()`
(`swift/ltx-video-director/Sources/LTXVideoDirector/NativeUpscaleStage.swift:693-`)
before concluding anything from pixels alone. The reference image is:

1. Tiled into a static "video" (the same single frame repeated across all N
   output-length frames) — this **is** the documented Ingredients training
   convention (a looped static reference matching the output clip's
   length/fps), not a bug.
2. VAE-encoded into its own reference-latent token sequence, **separate**
   from the generation tokens — the generation tokens start as pure noise
   (`denoiseMask: ones`, i.e. fully free to denoise) and only see the
   reference via `VideoConditionByReferenceLatent`'s IC-LoRA cross-attention,
   appended then stripped after denoising (`genTokens = ...[0..<genTokenCount]`).

This is architecturally the **correct**, separate-reference-latent mechanism
research described — a materially different (and better) code path than the
`combined_image_conditionings()` same-frame-0 collision found the same day
in the ordinary multi-anchor I2V path. **This is not the same bug reappearing
under a new name.**

## Result: negative, but the specific failure mode is a new, different finding

**Multi-panel test**: the output is a near-static replay of the input
reference sheet for the full clip — frame 0, frame 24 (midpoint), and frame
48 (last) are visually indistinguishable from the input composite (still
shows both the woman panel and the bicycle panel, black divider intact, no
trace of "a sunny park," no compositing of the two subjects into one scene).
The prompt's described scene was never generated.

**Single-reference control**: the output **is** a fully novel generated
scene — a completely different visual (a man wearing headphones and a bow
tie, indoors) with zero resemblance to either the reference photo or the
prompt ("the woman... walks through a sunny park"). This confirms the
denoise loop *is* capable of departing from the reference and generating new
content — the multi-panel case's near-total staticness is not a global "this
command doesn't generate video" failure, it's specific to the composited
input. It also surfaces a second, separate finding: single-reference
identity preservation is weak-to-absent in this configuration (distilled
transformer + IC-LoRA + seed 42, no `--lora-strength` tuning attempted) —
worth flagging distinctly from the multi-panel question, not conflated with
it.

**No conditioning-strength knob exists to test as a fix.** `strength: 1.0`
is hardcoded at the `VideoConditionByReferenceLatent(...)` call site
(`NativeUpscaleStage.swift:762`, and identically at the other three
conditioning call sites in the same file) — not exposed via CLI. Confirmed
by grep, not assumed.

## Verdict: inconclusive-negative — mechanism is right, this specific test collapsed, root cause unresolved

This is **not** as clean a negative as the same-frame-0 test (which had an
unambiguous root cause — `combined_image_conditionings()`'s last-anchor-wins
collision, confirmed via code + manifest). Here the code path is
architecturally the documented-correct one, and the single-reference control
proves the denoise loop can generate novel content in this exact
configuration — so the multi-panel collapse has an unidentified cause.
Candidates, not yet tested: (a) the hard black borders/high-contrast panel
edges in the composited sheet may be an out-of-distribution input this
checkpoint's training data (real reference sheets, presumably smoother
transitions) doesn't generalize to; (b) seed 42 may be an unlucky draw for
this specific input — only one seed tested; (c) the distilled transformer's
few-step schedule may be more prone to conditioning-collapse than the full
`dev` transformer would be; (d) 512×512 / 2s may be too short/small for the
model to "escape" strong reference conditioning — the 800×800 output size
(`ResolutionResolver`-snapped) with only 49 frames may compound (a).

**This closes the immediate question ("does the reference-sheet trick just
work out of the box today?") with a clear no**, but does **not** close the
underlying multi-reference `reference_to_video` gap the way the same-frame-0
test did — that one had a definitive root cause ruling out the approach
entirely; this one leaves open whether a different seed, a softer panel
layout, or the full (non-distilled) transformer would succeed. Filing as
inconclusive rather than a hard no, to avoid the "stale capability claim in
either direction" mistake this repo's guardrails specifically warn about.

## Recommended follow-up (not attempted this pass, time-boxed out)

1. Retry with 2-3 different seeds on the same reference sheet before
   concluding anything harder.
2. Retry with the full `dev` (non-distilled) transformer if the distilled
   schedule is suspected.
3. Try a softer panel layout (gradient/blend at panel boundaries instead of
   hard black bars) matching real-world reference-sheet examples more
   closely.
4. Separately, the single-reference identity-preservation weakness found as
   a side effect here (novel scene generated but wrong identity entirely)
   is its own gap worth a dedicated pass if `native-ingredients` becomes
   load-bearing for anything — currently this capability's single-reference
   case has never had a rigorous identity-fidelity measurement either
   (mirrors the same measurement-gap class as the pre-SyncNet lip_sync row).

## Files (not committed — throwaway test assets, reproducible from this doc)

- `output/ref-sheet-test/portrait.png`, `prop.png`, `reference_sheet.png`
- `output/ref-sheet-test/gen/frames/*.png`, `gen/video.mp4` (multi-panel result)
- `output/ref-sheet-test/gen_single/frames/*.png`, `gen_single/video.mp4` (control)
