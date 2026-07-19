# 03 — Story pipeline scope

## Question

What shape is the new **`story.yaml`** pipeline manifest — and does it carry a
**character-consistency** stage?

The destination needs a story/short-film pipeline; today only `animated-explainer`
and `talking-head` exist. OpenMontage offers two relevant references:
`animation.yaml` (lean 8-stage: research→proposal→script→scene_plan→assets→edit→
compose→publish) and `character-animation.yaml` (richer: adds `character_design` +
`rig_plan` + `pose_library` for SVG-rig motion). Decide:

1. **Lean vs richer stage chain.** Recommendation: **lean 8-stage**, mirroring
   `animated-explainer`'s shape but with **story-oriented review foci** (narrative
   arc, emotional beats, recurring-character handling, shot-to-shot readability)
   and the proposal stage's `render_runtime` selection pointing at the new
   `Story` compose (from [06](06-story-compose-composition.md)). SVG rigs are
   ruled out by the map — so `character_design`/`rig_plan` stages are NOT carried.
   Confirm or override.
2. **Is character consistency a stage or a per-asset technique?** A recurring
   protagonist must look the same cut-to-cut. flux2 has `faceswap` + `scene`/`style`
   multi-ref conditioning. Options: (a) bake consistency into the `assets` stage's
   review focus (every recurring character references a locked reference image via
   faceswap) — recommended; (b) add a lightweight `character_lock` stage. This is
   the **map's #1 fog** ("Not yet specified") — this grill settles whether it's
   in-scope as a stage or stays a technique, which controls whether the fog
   graduates into its own ticket.
3. **Compose-tier selection in `proposal`.** The proposal stage must record a
   `render_runtime` decision (rich Remotion `Story` vs compose-motion fallback),
   mirroring OpenMontage's `animation-runtime-selector`. Confirm the selector's
   story variant.

### Context (pre-gathered — don't re-investigate)

- `animated-explainer.yaml` + `talking-head.yaml` are the only manifests today
  (`data/pipeline_defs/`); both pass `pipeline_manifest.schema.json`.
- `story_generation` provider exists (`mlx:runpy-story`, `bun:lmstudio-story`) —
  idea/script text generation is NOT a gap; only the manifest is.
- The map ruled **SVG rig-based character animation out of scope**; this ticket
  should not resurrect `rig_plan`/`pose_library` without an explicit override.
- The full 8-stage chain is proven on `animated-explainer` (rainbows receipt) —
  a lean story manifest inherits that proven spine.

type: grilling
claimed: pi-agent
blocked by: —
status: closed

## Resolution (closed 2026-07-19)

**Lean 8-stage spine + a conditional `character_design` stage; render_runtime
selector in proposal.** Two decisions settled by grilling:

### D1 — Stage chain: lean + conditional character_design

- **Spine** (mirrors `animated-explainer.yaml`): `research → proposal → script →
  scene_plan → assets → edit → compose → publish`.
- **+ conditional `character_design` stage**, inserted **between `script` and
  `scene_plan`**, activating only when the script declares recurring characters
  (`condition: "recurring_characters_declared"`). The conditional-stage pattern is
  **schema-supported** (`pipeline_manifest.schema.json:99-108`) and **already
  proven** in this repo (`animated-explainer`'s `sample` sub-stage). It produces
  **locked reference images** per recurring character via flux2 `t2i`.
- **Consistency enforcement:** `scene_plan` references the locked refs;
  `assets` applies flux2 **`faceswap`** for per-scene consistency. So character
  consistency is **a conditional stage for lock-in + a technique in assets for
  application** — not one or the other.
- **No `rig_plan` / `pose_library`** — SVG rigs stay out of scope (map).
- **This retires the map's #1 fog** ("character consistency across recurring-
  character scenes").

### D2 — Compose tier: selector in proposal

- The **`proposal` stage presents a `render_runtime` choice**: `Story` (rich —
  particles + word-pop from [06](06-story-compose-composition.md), needs a
  Remotion browser) vs `compose-motion` (ffmpeg, always-available fallback),
  **defaulting to `Story` when a browser resolves**, `compose-motion` otherwise.
  Recorded in `decision_log`. Mirrors OpenMontage's `animation-runtime-selector`.
  The fallback is explicit, never silent.

### Deferred to [07](07-story-yaml-manifest.md) (execution sub-decision, not a grill)

- **`character_design` artifact schema.** The repo has 9 artifact schemas today;
  none for `character_design`. [07](07-story-yaml-manifest.md) settles during
  authoring: **recommend adding a minimal `character_design` schema** (a gated
  stage should produce a schema-valid artifact, consistent with the other 9) over
  embedding it in `proposal_packet`. Not a separate ticket — it's inside 07's
  manifest-authoring scope.
