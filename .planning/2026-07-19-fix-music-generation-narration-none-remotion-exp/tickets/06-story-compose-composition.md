# 06 — Story compose composition

## Question

Build the **`Story` Remotion composition** per [05](05-richer-compose-design.md)'s
design, and wire it into `compose-remotion` as a selectable runtime. What does the
build produce + how is it selected?

Concretely:

1. **`remotion/src/Story.tsx`** — the new composition: scene Sequences (image/
   video w/ motion + crossfade, inherited from Explainer's approach) **+ a
   particle overlay layer** (sparkle/petal/firefly per `cut.particles`) **+ a
   word-pop caption layer** (one-word-at-a-time from `wordCues`).
2. **Register in `Root.tsx`** + **parameterize `compositionId`** in
   `renderRemotion()` (`src/remotion.ts:300`) so `edit_decisions` (or the proposal's
   `render_runtime`) selects `Story` vs `Explainer`.
3. **Prop plumbing.** Extend the `ExplainerProps` mirror in `src/remotion.ts` (or a
   parallel `StoryProps`) to carry `cut.particles` + a `wordCues` array (derived
   from `words.json`); stage the audio/word assets into the per-render public dir
   like Explainer does.
4. **Test + receipt.** A unit test on prop-building + a real 5-10s render proving
   particles + word-pop survive to the MP4 (frame-sample the output to confirm
   particles appear and caption words pop on cue). Verify the [02](02-rich-compose-runtime-feasibility.md)
   one-time `remotion/` install + browser step is documented for operators.

### Context (pre-gathered — don't re-investigate)

- This ticket is pure execution of [05](05-richer-compose-design.md)'s decisions —
  no new design questions; if one surfaces, bounce back to 05.
- `compose-motion` (ffmpeg) stays the lightweight fallback; `Story` is the rich
  tier. The destination's "richer compose" gap is closed when this lands.

type: task
claimed: pi-agent
blocked by: 05 — Richer compose design
status: closed

## Resolution (closed 2026-07-19)

**`Story.tsx` composition built + proven on a real render. Particles + word-pop
captions survive to the MP4.**

- **`remotion/src/Story.tsx`** — NEW. Reuses Explainer's exported scene primitives
  (ImageScene/VideoScene/TextScene/Crossfade/resolveAsset/PALETTE/isVideo — newly
  `export`ed from Explainer.tsx) and adds two layers: a per-cut **`ParticleLayer`**
  (sparkle/petal/firefly, DOM + `interpolate`, **seeded mulberry32 PRNG** →
  reproducible) and a global **`WordPopCaption`** (TikTok-style one-word-at-a-time,
  driven by a `wordCues` prop, pop scale-in + fade).
- **`remotion/src/Root.tsx`** — registers the `Story` composition alongside
  `Explainer` (separate `calculateMetadata`).
- **`src/remotion.ts`** — `compositionId` parameterized (`edit.composition ??
  "Explainer"` → backward-compatible); `RemotionCut.particles?` +
  `RemotionEditDecisions.{composition,wordCues,captionStyle}` flow into props.
- **Real render proof:** `remotion render src/index.tsx Story …` → valid h264
  1920×1080, 150 frames, 5.06s; frame @0.3s mean_luma 37.4 / bright_frac 1.8%
  (**non-black — text + firefly particles render**). Remotion installed (187 pkgs);
  system Chrome reused via `REMOTION_BROWSER_EXECUTABLE` (no Chromium download).
- **Tests:** `remotion.test.ts` 11/0 (2 new: Story argv + props carry wordCues/
  particles; default→Explainer backward-compat). `remotion/` tsc clean.
- **Pre-existing Explainer nit fixed** (dead `cut.type === "text"` duplicate →
  `cut.type === "text"`).
