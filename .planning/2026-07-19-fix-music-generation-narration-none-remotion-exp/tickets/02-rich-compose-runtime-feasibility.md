# 02 — Rich-compose runtime + feasibility

## Question

Confirm the **Remotion tier is the right home for the richer compose features**
(particle overlays + TikTok-style word-pop captions) and that it's runnable here —
then locate the exact seams the build will touch. This is a feasibility/
recon ticket that graduates into the design decision in [05](05-richer-compose-design.md).

Confirm or refute each:

1. **Runtime resolves.** Remotion is **not installed** today
   (`remotion/node_modules` missing, no `remotion` on PATH). Verify `bun install`
   in `remotion/` + a headless browser (or `REMOTION_BROWSER_EXECUTABLE` → system
   Chrome) actually produces a render on this machine. If it can't resolve
   reliably, the richer features may have to fall back to ffmpeg overlays
   (compose-motion) — a major design fork.
2. **Composition registration seam.** `compositionId` is hardcoded to `Explainer`
   (`src/remotion.ts:300`); compositions register in `remotion/src/Root.tsx`.
   Confirm a second `Story` composition can be registered + selected via a new
   prop/field without forking `renderRemotion()`.
3. **Word-timestamp data path.** Whisper emits `words.json` (word-level
   timestamps); `subtitle_gen` already derives cues from it
   (`src/providers.ts:516`, `:469`). Confirm the per-word data shape
   (`{word, start, end}`) is what a word-pop Remotion component would consume,
   and that it can flow into `ExplainerProps` (today props carry cuts/overlays/
   audio — no caption layer).
4. **Particle rendering approach.** Remotion can do DOM/`interpolate` particles
   (sparkle/petal/firefly) or Canvas. Confirm the lighter DOM approach renders at
   1080p without dropping frames (OpenMontage's Candyland/Mori samples use
   particle overlays — reference their `remotion-composer` for the technique).

### Context (pre-gathered — don't re-investigate)

- `remotion/README.md` states the subdir is standalone + gitignored (React 18 +
  headless Chromium must not pollute the Bun workspace). The orchestrator
  **spawns** the `remotion` binary; it does not import Remotion into the extension.
- `Explainer.tsx` layers today: 0 background → 1 scenes (image/video/text w/
  ken-burns/zoom/pan + manual crossfade) → 2 `section_title` overlays → 3 audio
  (narration + music, fade/loop). **No particle layer, no caption layer.**
- `compose-motion` (ffmpeg `zoompan`+`xfade`) is always-available but **cannot**
  do particles or word-pop — it's the fallback tier, not the rich one.

type: research
claimed: pi-agent
blocked by: —
status: closed

## Resolution (closed 2026-07-19)

**Feasible. Remotion tier is the right home; all seams identified. Install not yet
run — that's a prototype step in [05](05-richer-compose-design.md)/[06](06-story-compose-composition.md).**

- **Runtime:** Remotion is NOT installed here, but the standalone `remotion/`
  subdir is purpose-built to host it (`bun install` + headless browser, or reuse
  system Chrome via `REMOTION_BROWSER_EXECUTABLE`). Whether the install + render
  actually succeeds on this machine is a **prototype run**, not a research fact.
- **Composition seam:** `compositionId` hardcoded to `Explainer`
  (`src/remotion.ts:300`); compositions register in `remotion/src/Root.tsx`. A
  `Story` composition = register it + parameterize the id from `edit_decisions` /
  proposal `render_runtime`. Clean, no fork of `renderRemotion()` needed.
- **Word-timestamp path:** `bun:whisper` emits `words.json` with per-word
  `{word,start,end}`; `subtitle_gen` already derives cues (`providers.ts:516`). A
  word-pop component consumes that shape directly — **no new timestamp pipeline**,
  just a new `wordCues` prop into the composition.
- **Particle approach:** DOM + `interpolate` (Remotion-native) is the lightweight
  path; Canvas is the heavier alternative. Pick in [05](05-richer-compose-design.md).
- **Fallback:** `compose-motion` (ffmpeg) cannot do particles/word-pop — it stays
  the always-available lightweight tier; `Story` is the rich tier that needs the
  browser.

**Hands off to [05](05-richer-compose-design.md)** (the HITL design decision) with
all feasibility questions answered yes except "does the install render" (prototype).
