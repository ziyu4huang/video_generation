# Study: adding LTX-2.3 `dev` transformer support to `native-i2v`

Research pass only — no code changed. Answers "what would it take to run
`native-i2v` (and everything built on it: `native-relay`, `StoryboardConfig`
grid-guide) against the `dev` checkpoint instead of only `distilled`."

## Current state: `native-i2v` is hardcoded to `distilled`, everywhere

Five files hardcode the distilled checkpoint path directly — none of them
go through `LTXModelRegistry`:

| File | Line(s) | What's hardcoded |
|---|---|---|
| `Sources/LTXVideoDirector/NativeI2VStage.swift` | 465 | `transformer/ltx-2.3-distilled-q8/transformer-distilled-1.1.safetensors` |
| `Sources/LTXVideoDirector/NativeI2VStage.swift` | 500 | `SigmaSchedule.distilledSigmas` (fixed 8-step schedule) |
| `Sources/LTXVideoDirector/NativeI2VStage.swift` | 57, 13-18 | error text / header prose say "distilled" only |
| `Sources/LTXVideoDirector/NativeT2AStage.swift` | 147 | same hardcoded distilled path (native text-to-audio) |
| `Sources/LTXVideoDirector/NativeUpscaleStage.swift` | 443, 604, 777, 951 | same hardcoded distilled path, ×4 (post-upscale refinement passes triggered by `native-i2v --refine`) |
| `Sources/LTXVideoDirectorCLI/NativeI2VCommand.swift` | 61, 188 | CLI help text + status print say "distilled"; no `--transformer` flag exists at all |

`NativeRelayStage.swift` has no hardcode of its own — it calls
`NativeI2VStage.generate` for every segment (`NativeRelayStage.swift:178-200`),
so it inherits whatever `NativeI2VStage` does. `StoryboardConfig.swift`
(`toCameraMoveRequest`/`toHardCutRequest`) never sets a transformer-variant
field, because `NativeI2VStage.Request` doesn't have one to set.

## Good news: the loader and config are already variant-generic

- `Transformer/TransformerCheckpointLoader.swift` and
  `Transformer/QuantizedWeights.swift` operate purely on raw key/shape
  dictionaries — nothing distilled-specific in either file.
- `NativeI2VStage.swift`'s `distilledConfig(numLayers:)` (lines 230-247) is
  misleadingly named: `mlx-models/ltx-mlx/distilled/embedded_config.json`
  and `mlx-models/ltx-mlx/dev/embedded_config.json` are **byte-identical**
  (same 48 blocks, same dims/heads/rope). The values it hardcodes are
  correct for `dev` too.
- `LTXModelRegistry.swift` already models the three variants
  (`.dev`/`.distilled`/`.dasiwa`, `defaultForI2V = .dasiwa`) and can
  discover installed checkpoints (`installedVariants()`, `variantDir()`),
  but its own comment (line 41) admits "the actual load happens inside
  run.py today" — it's discovery-only, never wired into `NativeI2VStage`.
- `I2VCommand.swift` (the older, non-native, `RunPyBridge`-backed `i2v`
  command) already threads `--transformer <variant>` plus optional
  `--stage1-steps`/`--stage2-steps`/`--cfg-scale`/`--stg-scale` overrides
  into `run.py` (`I2VCommand.swift:31-32, 37-47, 62-77`) — a ready template
  for the same flag on `NativeI2VCommand`.
- `Sampling/SigmaSchedule.swift` already has `ltx2Schedule`/
  `dynamicShiftSchedule` (lines 31-77) — the token-count-adaptive schedule
  `dev` needs per its manifest (`stage1_steps: 30`) — fully ported and unit
  tested, just **dead code** from `NativeI2VStage`'s perspective (no
  Swift caller outside tests).
- `EulerDiffusionStep.swift` / `DenoiseLoop.swift`'s step loop is
  step-count-agnostic (iterates `sigmas.count - 1` pairs) — no hardcoded
  distilled step count there.

Per-variant recommended params today live **only in JSON**, not Swift:

```
mlx-models/transformer/ltx-2.3-dev-q8/manifest.json:
  stage1_steps: 30, stage2_steps: 3, cfg_scale: 5.0, stg_scale: 1.0

mlx-models/transformer/ltx-2.3-distilled-q8/manifest.json:
  stage1_steps: 8,  stage2_steps: 3, cfg_scale: 1.0, stg_scale: 0.0
```

## The real gap: CFG is not implemented in native Swift at all

Grepped all of `swift/ltx-video-director/Sources` for "cfg" (case
insensitive) — zero functional hits. Confirmed by a full read of
`DenoiseLoop.swift`: `run(...)`/`runStreaming(...)` (lines 37-192) call the
transformer **exactly once per sigma step**, conditional (positive-prompt)
embeddings only. No unconditional/negative branch, no `cfg_scale`
parameter, no doubled batch, no blend step anywhere.

By contrast the vendored Python path implements real CFG: a second
"uncond" forward pass gated on `cfg_scale`
(`ltx-2-mlx/packages/ltx-pipelines-mlx/src/ltx_pipelines_mlx/utils/samplers.py:390-398, 786-799`),
exposed to `run.py` via `python/mlx-movie-director/app/ltx_pipeline.py:304-434`.
STG (`stg_scale`, spatial-temporal guidance) has no native Swift
counterpart either — no "stg" references anywhere in `Sources/`.

`dev`'s manifest-recommended `cfg_scale=5.0` needs real classifier-free
guidance to mean anything. Loading the `dev` checkpoint into today's
`DenoiseLoop` would silently run at effective `cfg=1.0` (no guidance at
all) — very likely degraded/incoherent output relative to what `dev` is
tuned for, not a working "dev mode."

## Wiring change vs. real feature gap

**Small, mechanical** (loader/config are already variant-generic):
- Add `transformerVariant: LTXTransformerVariant` to
  `NativeI2VStage.Request`, default `.distilled` (no behavior change for
  existing callers).
- Swap `NativeI2VStage.swift:465`'s hardcoded URL for a
  variant-selected path via `LTXModelRegistry.variantDir(_:)`.
- Pick `SigmaSchedule.distilledSigmas` vs.
  `SigmaSchedule.ltx2Schedule(steps: 30, ...)` based on variant — code
  already exists, just needs to be called conditionally instead of the
  hardcoded 8-step table.
- Add `--transformer <dev|distilled|dasiwa>` to `NativeI2VCommand.swift`,
  mirroring `I2VCommand.swift`'s existing flag.
- Update the hardcoded status print (`NativeI2VCommand.swift:188`) and
  header/error prose that currently say "distilled" unconditionally.

**Real feature work** (net-new, not a wiring change):
- Implement classifier-free guidance in `DenoiseLoop.swift` /
  `EulerDiffusionStep.swift`: an unconditional (empty/negative-prompt)
  text-embedding path, a second per-step transformer forward pass,
  `uncond + cfg_scale * (cond - uncond)` blending. Roughly doubles
  per-step transformer cost when `cfg_scale != 1.0`.
- STG (`stg_scale`) has no native equivalent either — `dev`'s recommended
  `stg_scale: 1.0` would need its own new implementation if it's to be
  ported faithfully rather than silently dropped.

## Recommendation

Treat this as two separable milestones, not one PR:

1. **Variant plumbing** (mechanical): thread `LTXTransformerVariant`
   through `Request`/CLI/checkpoint-path selection, defaulting to today's
   `.distilled` behavior unchanged. Low risk, testable immediately against
   the already-installed `dev`/`dasiwa` checkpoints for anything that
   doesn't need real guidance (e.g. `dasiwa`, which per its "distilled+DPO'd
   dev variant, fast like distilled" description in
   `LTXModelRegistry.swift:19-20` may not need CFG at all — worth
   confirming its own manifest cfg_scale before assuming).
2. **CFG implementation** (real feature): only needed to make `dev` itself
   (cfg_scale=5.0) produce correct output. Should be scoped, tested, and
   reviewed as its own unit — it changes the core denoise loop and
   roughly doubles per-step cost when active, so it needs its own
   before/after quality check (e.g. a `--self-test` case), not folded
   silently into the variant-plumbing change.

Do NOT ship "dev support" as just the plumbing — running `dev` without CFG
implemented would produce silently-wrong output that looks like a working
feature but isn't; either gate `--transformer dev` behind a clear
"CFG not yet implemented, output quality not representative" warning until
milestone 2 lands, or don't expose `dev` in the CLI until then.

## Status update (2026-07-05): Milestone 1 shipped

`LTXModelRegistry.transformerCheckpointURL(_:)`, `NativeI2VStage.Request
.transformerVariant`, variant-based checkpoint loading + sigma-schedule
selection (`ltx2Schedule(steps: 30, ...)` for non-distilled), and
`NativeI2VCommand --transformer` all landed, defaulting to `.distilled`
(no behavior change for existing callers). Real-checkpoint regression
suite (grid-guide/FFLF/StoryboardConfig/ModelRegistry, 22 tests) passes.
The CLI help text and code comments explicitly warn that selecting
`dev`/`dasiwa` loads the real checkpoint but runs without CFG — Milestone 2
below is what closes that gap.

## Milestone 2 priority check (2026-07-05): no real dev-mode (cfg>1) example exists anywhere in this repo's ComfyUI reference corpus

Before treating Milestone 2 (real CFG in `DenoiseLoop.swift`) as obviously
worth building, audited all 16 files under
`docs/reference/comfyui_workflows/` programmatically (not spot-checked) —
see that directory's README, "Eighth pass." **Every single `CFGGuider`
node in all 16 files runs at `cfg=1`, with zero exceptions** — including
the 15 files whose `CheckpointLoaderSimple` loads the RAW
`ltx-2.3-22b-dev(-fp8).safetensors` weights (not a pre-fused distilled
checkpoint). Combined with the already-known `LoraLoaderModelOnly`
dev→distilled conversion LoRA, the universal pattern is "load dev weights
→ fuse the conversion LoRA → sample at cfg=1" — never "sample dev weights
directly at their own cfg>1." No `STGGuider`/`DualCFGGuider`/STG mechanism
appears anywhere in the corpus either.

**Practical consequence**: unlike every other feature this package has
ported (FFLF, grid-guide, audio-track, upscale+refine, IC-LoRA family),
real CFG has no ComfyUI reference graph in this repo to validate against —
correctness would need to be checked purely against the vendor Python
`ltx_pipelines_mlx/utils/samplers.py` implementation. This is either a
genuinely novel port (no shortcut of "match this JSON node-for-node") or a
sign that raw dev+CFG sampling isn't actually how this model is used in
practice, community-wide. Treat Milestone 2 as an open prioritization
question, not an assumed-necessary next step, until there's a concrete
reason (a specific quality complaint about `.distilled`/`.dasiwa` output,
or a specific request to match `mlx-models/transformer/ltx-2.3-dev-q8`'s
manifest params exactly) to invest in it.

## Status update (2026-07-07): a concrete reason now exists — production's own default is dasiwa+CFG, and the "no-CFG dev usage" assumption above is wrong for THIS repo

Re-checked `LTXModelRegistry.defaultForI2V` — it's `.dasiwa`, not
`.distilled`. `mlx-models/transformer/ltx-2.3-dasiwa-golden-lace-v3-q8/manifest.json`
recommends `cfg_scale: 5.0, stg_scale: 1.0` (same shape as `dev`, not
`distilled`'s `cfg=1.0`). And `python/mlx-movie-director/app/ltx_pipeline.py`
confirms **production actually samples dasiwa/dev at real cfg>1 with the
distilled LoRA fused only at `0.999` strength for stability** — the LoRA
fusion is not a CFG-avoidance trick here, it runs genuine two-(or more-)pass
guidance on top. This means the "Milestone 2 priority check" conclusion two
sections up (no example anywhere samples dev at cfg>1, so maybe skip it) does
**not** hold for this repo's own production usage, even though it holds for
the external ComfyUI reference corpus. `native-i2v`'s hardcoded `.distilled`
default is a real, silent quality gap versus what `I2VEngine`'s `.dasiwa`
default actually produces.

**The guidance is bigger than plain 2-pass CFG.** Read
`ltx_pipeline.py:53-56` and `guiders.py` in full:

```python
_GUIDER_RESCALE_SCALE = 0.7
_GUIDER_MODALITY_SCALE = 3.0   # NOT 1.0 — modality (cross-modal A2V/V2A) guidance is ON by default
_GUIDER_STG_BLOCKS = [28]
```

Production's video guider for a joint audio+video dasiwa/dev call runs up to
**4 forward passes per step** (`samplers.py:374-442`,
`MultiModalGuider.calculate`):

1. `cond` — normal conditioned prediction (always).
2. `uncond_text` — CFG, active whenever `cfg_scale != 1.0` (dasiwa: 5.0).
3. `uncond_perturbed` — STG, active whenever `stg_scale != 0.0` (dasiwa: 1.0);
   perturbation = skip self-attention in `stg_blocks` (`[28]`) only.
4. `uncond_modality` — cross-modal guidance, active whenever
   `modality_scale != 1.0` (constant `3.0`, so **always on** for any joint
   audio+video call); perturbation = skip A2V/V2A cross-attention.

Combine formula (`guiders.py:107-135`, exact):

```
pred = cond
     + (cfg_scale - 1)      * (cond - uncond_text)
     + stg_scale             * (cond - uncond_perturbed)
     + (modality_scale - 1) * (cond - uncond_modality)

if rescale_scale != 0:
    factor = sqrt(var(cond)) / (sqrt(var(pred)) + 1e-8)
    factor = rescale_scale * factor + (1 - rescale_scale)
    pred = pred * factor
```

Audio uses its own `MultiModalGuiderParams` with `cfg_scale=7.0` (`_FLF2V_AUDIO_CFG_SCALE`
is the FLF2V-specific 7.0 override; the general audio CFG default is also 7.0
per `samplers.py:363`), same `stg_scale`/`stg_blocks`/`rescale_scale` as video.

**Revised Milestone 2 scope** (supersedes the two-milestone plan above — this
is now milestone 2a/2b, not a single "implement CFG" unit):
- **2a (CFG only, video)**: unconditional pass + `(cfg_scale-1)*(cond-uncond)`
  blend + rescale. Minimum viable — makes cfg_scale meaningful at all.
- **2b (STG)**: perturbed pass with self-attention skip on `stg_blocks`.
  Needs a way to run the transformer with block 28's self-attention masked
  out — check whether `Transformer/*.swift` has any hook for this or if it's
  net-new plumbing through the block stack.
- **2c (modality guidance)**: only relevant when audio is requested alongside
  video (native-i2v generates both by default per its joint audio+video
  design) — cross-attention skip (A2V/V2A) is a 4th pass. Given
  `modality_scale=3.0` is production's actual constant (not a knob anyone
  tunes down), this can't be skipped for parity unless a product decision is
  made to accept audio-guidance being worse in native than production.
- Each sub-milestone should get its own before/after quality check
  (a `--self-test` case), not be bundled — 2a alone is testable against a
  video-only (no-audio) dasiwa call; 2c requires an audio-bearing call.

**Memory cost**: 4 passes ≈ 4x per-step transformer forward cost (dev/dasiwa
already the heaviest checkpoint). The vendor Python side already documents
this is why some of ITS OWN pipelines default `stg_scale=0.0` for 32GB Macs
(`CLAUDE.md`'s "Guidance System" section) — dasiwa's manifest recommending
`stg_scale=1.0` regardless may be a copied template value, not a verified
memory-safe choice on this hardware; worth confirming empirically (does the
existing Python `run.py video t2i2v --transformer dasiwa` actually run with
stg_scale=1.0 today without OOM on this machine?) before committing the
native Swift port to replicate it exactly.

## Status update (2026-07-07, later): Milestone 2a (CFG only) shipped

`Sampling/CFGGuidance.swift` (new) implements the CFG term of
`MultiModalGuider.calculate` (`guiders.py`) — `cond + (cfgScale-1)*(cond-uncond)`
plus the optional variance-preserving rescale — and
`DEFAULT_NEGATIVE_PROMPT` copied verbatim from `utils/constants.py`.
`DenoiseLoop.runStreaming` gained `uncondVideoTextEmbeds`/`cfgScale`/
`rescaleScale` parameters (all default to off — `cfgScale: Float = 1.0`,
`uncondVideoTextEmbeds: MLXArray? = nil` — so every existing caller is
behavior-identical unless it opts in). When active, an extra unconditional
forward pass runs per step (video stream only — audio guidance is 2c, not
implemented), doubling per-step transformer cost for `.dev`/`.dasiwa`.

`NativeI2VStage.Request` gained `cfgScale: Double?` (nil = variant default:
`1.0` for `.distilled`, `5.0` for `.dev`/`.dasiwa`, matching their manifest
and `ltx_pipeline.py`'s own default) and `rescaleScale: Float = 0.7`
(matches production's `_GUIDER_RESCALE_SCALE`). `NativeI2VCommand` exposes
both as `--cfg-scale`/`--rescale-scale`. The negative prompt is encoded via
a second `NativeTextEncodeStage.encode` call, only when CFG is active.

**Not yet done** (tracked as 2b/2c above, unchanged): STG (block-28
self-attention perturbation) and modality guidance (cross-modal A2V/V2A
perturbation) — so `.dev`/`.dasiwa` output is now CFG-guided but still not
full parity with production's 4-pass guidance. No real-checkpoint parity
test has been run yet (build + existing regression suite only) — before
trusting this for quality-sensitive use, run a real `.dasiwa` generation and
visually compare against the Python `run.py` equivalent.

## Status update (2026-07-07, later still): STG mechanism confirmed — self-attention perturbation IS "blend attn output with the value projection", not a mask/shuffle

Before starting 2b, re-read the actual `ltx_core_mlx` source (not just
`guiders.py`, which only has the blend math) to resolve the open "what does
block-28 self-attention perturbation mean at the tensor level" question
carried since before 2a. Answer, confirmed at
`ltx_core_mlx/model/transformer/attention.py:129-133`:

```python
# STG perturbation: blend attn output with value projection
if perturbation_mask is not None:
    out = out * perturbation_mask + v * (1.0 - perturbation_mask)
```

i.e. for samples/blocks flagged perturbed, the self-attention output is
replaced with the raw **value projection** `v` — equivalent to collapsing
the attention map to identity (every token "attends" only to itself), NOT a
score mask, NOT a shuffle/permutation. `perturbation_mask` is computed once
per block by `BatchedPerturbationConfig.mask_like` (`guidance/perturbations.py`)
keyed on `block_idx` against `stg_blocks` (`[28]`) — one scalar per batch
sample, broadcast over the attention output's shape. This happens **before**
the per-head sigmoid gate and `to_out` projection, on both the video
(`attn1`) and audio (`audio_attn1`) self-attention calls independently
(`transformer.py`'s `BasicAVTransformerBlock.__call__`); cross-modal A2V/V2A
perturbation is applied differently ("OUTSIDE attention", per that file's own
comment) — that's 2c, unchanged.

## Status update (2026-07-07, later still): Milestone 2b (STG) shipped

Mirrors 2a's pattern exactly, additive to the existing (untested-by-fixture,
but structurally already-correct) `Attention.swift` perturbation-mask blend
from Milestone 1:

- `CFGGuidance.swift`: new `isSTGActive(stgScale:)` and a 6-arg `blend`
  overload (`cond/uncond/uncondPerturbed/cfgScale/stgScale/rescaleScale`)
  implementing the full `cond + (cfgScale-1)*(cond-uncond) +
  stgScale*(cond-uncondPerturbed)` formula; the existing 4-arg `blend` is
  now a thin wrapper (`uncondPerturbed: nil, stgScale: 0`) — no
  call-site breakage.
- `BasicAVTransformerBlock.swift`: new `videoPerturbationMask: MLXArray? =
  nil` param, forwarded straight to `attn1` (video self-attention only,
  matching 2a's video-only CFG scope — audio/cross-modal perturbation stay
  unported).
- `LTXModel.swift` (`callAsFunction` and `streamingForward`): new
  `stgBlocks: Set<Int> = []` param. Per block index, constructs a single
  scalar `MLXArray(0.0)` mask (the whole pass is uniformly perturbed or not
  — this is a separate, non-batched forward pass, unlike the reference's
  per-sample batched mask) and passes it only for blocks in `stgBlocks`.
- `DenoiseLoop.runStreaming`: new `stgScale: Float = 0.0`/`stgBlocks: Set<Int>
  = [28]` params. **STG is independent of CFG** — when only STG is active
  (`cfgScale` at its 1.0 no-op default), the "uncond" pass is skipped
  entirely and `cond` is substituted in its place before calling `blend`
  (provably safe: `blend`'s `(cfgScale-1)` factor is exactly 0 in that case,
  so the substituted value is never actually used) — avoids a wasted
  negative-prompt forward pass just to satisfy the API. When STG is active,
  a third forward pass runs with the perturbed `cond` (own text embeds, not
  the negative prompt — "uncond" in `uncond_perturbed` names the guidance
  role being subtracted, not the text conditioning) and `stgBlocks` active.
- `NativeI2VStage.Request`/`NativeI2VCommand`: `stgScale: Double?` (nil =
  variant default, `0.0` distilled / `1.0` dev-dasiwa, mirroring `cfgScale`)
  and `stgBlocks: [Int] = [28]`, exposed as `--stg-scale`/`--stg-blocks`.

**Cost**: STG active means a 3rd forward pass per step (on top of CFG's
2nd) whenever both are active — `.dev`/`.dasiwa`'s real default is now
3x per-step transformer cost, not 2x. Not yet re-measured against the
34.4GB/9-frame OOM check from the prior segment (that check predates 2b);
worth re-running before trusting memory-safety at this new pass count.

**Tests added** (all pass): `AttentionParityTests
.testSTGPerturbationMaskBlendsToValueProjection` (algebraic check of the
mask blend against a from-scratch value projection, no fixture),
`CFGGuidanceTests` (3 tests: `isSTGActive`, STG-inactive-equals-CFG-only,
manual-arithmetic match for the combined formula), and
`DenoiseLoopStreamingRealCheckpointTests
.testStreamingLoopSTGChangesOutputAndDefaultIsUnchanged` (real checkpoint,
2-block stack: `stgScale=0` is a byte-identical no-op regardless of
`stgBlocks`; `stgScale=1` produces finite output that measurably differs
from the baseline).

**Not yet done**: real-checkpoint end-to-end visual comparison against
`run.py`'s dasiwa output (same caveat 2a shipped with — build + unit tests
only), and 2c (modality guidance).

**Full-suite verification note**: the complete `swift test` run (100+
tests) could not be completed end-to-end in this session — 3 separate
attempts all hung/got killed at the identical point (`LoRAFusionTests` →
`MP4WriterTests`/`MacTTSTests` → `MelSTFTParityTests.testMelSTFT` started
but never finished), despite `MelSTFTParityTests` and its immediate
neighbors passing instantly (<0.04s) in isolation. **Confirmed pre-existing
and unrelated to this milestone**: stashed all 2b changes and re-ran the
identical full suite against the pre-2b `main` baseline (`69f67e38`) — it
hung at the exact same point. This is an environment/resource issue (likely
Metal/thread-pool exhaustion from running the same heavy real-checkpoint
suite repeatedly in one session), not a regression introduced by 2b. All
2b-specific and directly-adjacent test targets (`AttentionParityTests`,
`CFGGuidanceTests`, `BasicAVTransformerBlockParityTests`, `LTXModelParityTests`,
`LTXModelRealCheckpointTests`, `DenoiseLoopParityTests`,
`DenoiseLoopConditionedTests`, `DenoiseLoopI2VParityTests`,
`DenoiseLoopStreamingRealCheckpointTests`) were run directly (not via the
full suite) and all pass, including against real checkpoints — this is the
verification basis for calling 2b done, not a completed full-suite run.
Worth a fresh full-suite run in a later session (e.g. after a machine
restart) to confirm the whole 100+ suite is still green end-to-end.

## Status update (2026-07-08): 2b parity-verified via real generation (STG on/off) + OOM re-measured — both close clean

**OOM re-check at the new 3-pass cost** (dasiwa, real defaults `cfg_scale=5.0
stg_scale=1.0`, 320x320 request auto-snapped to 800x800, 9 frames,
`--no-upscale`, `/usr/bin/time -l`): peak memory footprint **90.99 GiB**,
maximum resident set size **22.41 GiB**, wall time 214.9s, on this 128 GB
machine — completed with no OOM/crash. This is notably higher than the
34.4 GB figure from the pre-2b (CFG-only) segment, consistent with the
3x-per-step-forward-pass cost now active for dasiwa/dev by default. The
metric type behind the old 34.4 GB number was never recorded precisely
(likely `maximum resident set size`, which this run puts at 22.4 GB — i.e.
plausibly *lower* than before, while the less-comparable "peak memory
footprint" figure is the one that's large), so treat this as a fresh
baseline rather than a strict apples-to-apples regression check. No action
needed today (well within 128 GB), but worth watching on lower-memory
hardware or if a 4th pass (2c) is added.

**STG parity check** (same prompt/seed/resolution, `--stg-scale 0.0` vs the
dasiwa default `1.0`, everything else identical): confirmed the log line
correctly reports `stg_scale=0.0 (off)` and skips the `[stg] ... active`
line; wall time dropped from 214.9s to 172.4s (~25% less, i.e. the 3rd
forward pass genuinely executes and genuinely costs real time — not a
no-op that got optimized away). Per-frame mean absolute pixel difference
(RGB, 0-255 scale) between STG-on and STG-off output frames: **0.22 → 1.75
across the 9 frames (mean 1.04)**, growing monotonically — a real, modest,
temporally-increasing effect, consistent with a self-attention
perturbation guidance term rather than either a no-op or a
content-destroying bug.

**Static re-diff against the vendor reference, now that the code is
final**: re-read `ltx_core_mlx/components/guiders.py` (`MultiModalGuider
.calculate`, confirmed formula `cond + (cfg_scale-1)*(cond-uncond_text) +
stg_scale*(cond-uncond_perturbed)` — exact match to `CFGGuidance.blend`)
and `ltx_pipelines_mlx/{cli.py,a2vid_two_stage.py}` (`stg_blocks=[28]` —
exact match to the Swift default). **Resolved the discrepancy flagged in
the prior next-goal file** ("Swift port's stg_scale default of 1.0 vs. the
Python reference's stg_scale=1.5 for dasiwa"): that "1.5" claim was
mistaken. `mlx-models/transformer/ltx-2.3-dasiwa-golden-lace-v3-q8/
manifest.json` — the actual per-variant source of truth — specifies
`"stg_scale": 1.0`, exactly matching the Swift default. No reconciliation
needed; nothing to change.

**Conclusion**: Milestone 2b is now parity-verified by real generation (not
just unit/algebraic tests) in addition to being merged (PR #343,
`b02d5b2e`). Remaining open item before considering the CFG/STG/modality
guidance gate fully closed is Milestone 2c (modality/cross-modal A2V-V2A
guidance) — still entirely unstarted.

## Status update (2026-07-08, later): Milestone 2c (modality guidance) shipped

Ported `MultiModalGuider.calculate`'s remaining term —
`(modality_scale-1)*(cond-uncond_modality)` — closing the CFG/STG/modality
guidance gate started in Milestones 2a/2b.

**Key finding: the block-level primitive already existed.**
`BasicAVTransformerBlock.callAsFunction`'s `a2vCrossAttn`/`v2aCrossAttn`
flags (added earlier for `LTXVAudioOnlyModel`'s `audioOnly` gating, see the
block's own header) turned out to be the exact mechanism the reference's
`SKIP_A2V_CROSS_ATTN` + `SKIP_V2A_CROSS_ATTN` perturbation pair needs — set
both false in every block and cross-modal attention is fully isolated,
matching `mod_perturbations = [..., blocks=None]` (all blocks, both
directions). No change to `BasicAVTransformerBlock.swift` was needed; only
`LTXModel.swift`'s `callAsFunction`/`streamingForward` needed a new
`isolateModality: Bool` parameter that forces `a2vCrossAttn`/`v2aCrossAttn`
off regardless of `audioOnly`.

**What shipped**:
- `CFGGuidance.blend` gained `uncondModality`/`modalityScale` parameters
  (default `nil`/`1.0`, source-compatible with all existing call sites) plus
  `isModalityActive(modalityScale:)`.
- `LTXModel.callAsFunction`/`streamingForward` gained `isolateModality: Bool
  = false`.
- `DenoiseLoop.runStreaming` gained `modalityScale: Float = 1.0`; when
  active, a 4th forward pass runs per step with `isolateModality: true` and
  the same conditioned text embeds as the `cond` pass (matching the
  reference's naming convention: "uncond" names the guidance role being
  subtracted, not the text conditioning — same as the STG pass).
- `NativeI2VStage.Request.modalityScale: Double?` + `--modality-scale` CLI
  flag, same default-by-variant pattern as `cfgScale`/`stgScale`: `nil` means
  `1.0` (off) for `.distilled`, `3.0` for `.dev`/`.dasiwa` (matches
  production's `LTX_2_3_PARAMS.modality_scale = 3.0`, confirmed against
  `ltx_pipelines_mlx/utils/constants.py`).
- `bun-apps/s2-agent-ext-ltx/src/commands.ts` modeled the new flag in the
  same PR (per the standing lesson from PR #359: an unmodeled guidance flag
  went unnoticed for two milestones); `check-flags.ts` still reports 16/16.

**Video-only scope, matching 2a/2b**: like CFG/STG, this port only guides
the video stream. The reference also supports an independent audio
`modality_scale`/`audio_guider_factory`; porting audio-side guidance remains
out of scope here (same boundary as 2a/2b).

**Verification**: algebraic blend tests (`CFGGuidanceTests`), a real-fixture
`LTXModelParityTests` check that `isolateModality: true` diverges from the
normal forward pass (proving the flag reaches every block), and a real
19GB-checkpoint `DenoiseLoopStreamingRealCheckpointTests` test showing
`modalityScale=3.0` changes the denoised output vs. the `1.0` no-op baseline
— same pattern as the existing STG real-checkpoint test.
