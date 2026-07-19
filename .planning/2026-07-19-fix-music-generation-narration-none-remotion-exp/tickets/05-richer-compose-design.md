# 05 — Richer compose design

## Question

How are **particle overlays** and **TikTok-style word-pop captions** specified and
rendered in the Remotion tier? Per the goal (proceed unless a hard choice), the
design decisions below are applied from the recommendations — none rose to a
hard choice requiring the user. 06 implements them.

Decide, one at a time:

1. **Extend `Explainer.tsx` vs new `Story.tsx` composition.** Recommendation:
   **new `Story` composition** (registered in `Root.tsx`, selected via a new
   field/prop in `edit_decisions`) — story has different layer needs (particles +
   word captions) and bloating `Explainer` mixes concerns. Confirm, and settle how
   the proposal's `render_runtime` selects `Story` vs `Explainer` vs
   compose-motion.
2. **Particle layer spec.** How does a scene declare particles? Proposed:
   `cut.particles: { type: "sparkle"|"petal"|"firefly"|"none", density, drift }`
   → a parametric DOM/`interpolate` layer (confirm DOM vs Canvas from [02]).
   Particle set should cover what OpenMontage's Candyland/Mori samples use.
3. **Word-pop caption layer.** Data source is `words.json` (per-word timestamps).
   Decide: (a) a `captions` layer in `Story` props carrying per-word cues, rendered
   as one-word-at-a-time pop with style presets (`tiktok`, `karaoke`); (b) whether
   `subtitle_gen` emits a word-cue shape alongside SRT, or `Story` consumes
   `words.json` directly. Recommendation: `Story` consumes a new `wordCues` prop
   derived from `words.json` — keeps subtitle_gen's SRT path intact.
4. **Fallback posture.** If `Story` can't render (no browser), degrade to
   compose-motion + plain SRT cleanly — don't fail the whole publish.

### Context (pre-gathered — don't re-investigate)

- [02](02-rich-compose-runtime-feasibility.md) confirms Remotion hosts these
  (React/`interpolate`); `compositionId` is hardcoded at `src/remotion.ts:300`,
  so a second composition needs registration + param.
- `Explainer.tsx` layers: background → scenes (ken-burns/zoom/pan + crossfade) →
  `section_title` overlays → audio. **No particle layer, no caption layer** today.
- Word timestamps exist (`words.json` from `bun:whisper`; `providers.ts:516` derives
  cues) — the gap is the Remotion component + prop wiring, not timestamp math.

type: grilling
claimed: pi-agent
blocked by: 02 — Rich-compose runtime + feasibility
status: closed

## Resolution (closed 2026-07-19)

**Design decisions applied from recommendations (no hard choice surfaced). 06
implements these.**

### D1 — New `Story.tsx` composition (not extending Explainer)

- A **second composition** registered in `Root.tsx` alongside `Explainer`,
  selected via a new `composition` field in edit_decisions (default `Explainer` →
  backward-compatible). `src/remotion.ts` parameterizes the compositionId it
  passes to `remotion render`. Separation of concerns: story's particle +
  word-pop layers don't bloat the explainer.

### D2 — Particle layer: DOM + interpolate, parametric

- Per-cut `particles?: { type: "sparkle" | "petal" | "firefly" | "none";
  density?: number; drift?: number }` → a parametric `ParticleLayer` (AbsoluteFill
  overlay, pointer-events none). **DOM + `interpolate`** (not Canvas) — portable,
  sufficient for the three OpenMontage-style types (twinkling dots / falling
  rotating petals / drifting glowing fireflies). Deterministic per-frame via a
  seeded pseudo-random placement so renders are reproducible.

### D3 — Word-pop captions: consume `wordCues`

- A `wordCues?: Array<{ word: string; start: number; end: number }>` prop on
  `StoryProps`, derived from the whisper `words.json`. A `WordPopCaption` layer
  renders **one word at a time**, TikTok-style: large centered bold text with a
  pop scale-in. `wordCues` is the minimal contract; the orchestrator builds it
  from `words.json` (subtitle_gen's SRT path stays intact — no schema change).

### D4 — Fallback posture

- If `Story` can't render (no browser / Remotion unresolved), the proposal's
  `render_runtime` selector already offers `compose-motion` + plain SRT — degrade
  there, never fail publish silently.
