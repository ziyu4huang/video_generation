# 07 — story.yaml manifest

## Question

Author and register the **`story.yaml`** pipeline manifest per [03](03-story-pipeline-scope.md)'s
decisions. What's the manifest's final shape + how does it integrate?

Concretely:

1. **`data/pipeline_defs/story.yaml`** — the 8-stage story/short-film manifest
   (research→proposal→script→**[character_design if recurring]**→scene_plan→
   assets→edit→compose→publish) with **story-oriented review foci** (narrative
   arc, emotional beats, recurring-character consistency, shot readability) and
   the proposal stage's `render_runtime` **selector** pointing at the `Story`
   compose from [06](06-story-compose-composition.md) (default Story when a
   browser resolves, `compose-motion` fallback otherwise) per [03](03-story-pipeline-scope.md) D2.
2. **Character-consistency handling** — [03](03-story-pipeline-scope.md) RESOLVED
   this: add the **conditional `character_design` stage** between `script` and
   `scene_plan` (`condition: "recurring_characters_declared"`); it produces locked
   flux2 `t2i` reference images per recurring character; `scene_plan` references
   them; `assets` applies flux2 **`faceswap`** for per-scene consistency.
3. **`character_design` artifact schema** (deferred from [03](03-story-pipeline-scope.md))
   — **recommend adding a minimal `character_design.schema.json`** (a gated stage
   should produce a schema-valid artifact, consistent with the other 9) over
   embedding in `proposal_packet`. Settle + author it as part of this ticket.
3. **Schema-valid.** Pass `pipeline_manifest.schema.json` + `bun run
   check:schemas`. Human-approval gates mirror `animated-explainer` (proposal/
   script/scene_plan/assets gated; edit/compose not).
4. **CLI/tool discovery.** Confirm `pipeline-list` / `pipeline-show` surface the
   new pipeline with no code change (manifest-driven) — the `story` pipeline should
   just appear.

### Context (pre-gathered — don't re-investigate)

- Only `animated-explainer.yaml` + `talking-head.yaml` exist today; both are
  schema-valid references for the manifest shape.
- `story_generation` provider exists — idea/script generation is NOT a gap; the
  manifest just references the existing capability.
- SVG rigs are out of scope (map) — do NOT add `rig_plan`/`pose_library` unless 03
  explicitly overrode.

type: task
claimed: pi-agent
blocked by: 03 — Story pipeline scope
status: closed

## Resolution (closed 2026-07-19)

**`story.yaml` + `character_design.schema.json` landed + schema-valid.**

- **`data/pipeline_defs/story.yaml`** — lean 8-stage (research→proposal→script→
  **[character_design if recurring]**→scene_plan→assets→edit→compose→publish),
  `category: cinematic`, story-oriented review foci, proposal's `render_runtime`
  selector (Story vs compose-motion). The conditional `character_design` stage uses
  a **new optional `condition:` field added to the stage schema**
  (`pipeline_manifest.schema.json` — backward-compatible, mirrors sub_stages'
  condition) so the stage is advisory-conditional on `recurring_characters_declared`.
- **`data/schemas/artifacts/character_design.schema.json`** — NEW; minimal schema
  (version + characters[], each with reference_image + style anchors). Empty
  characters[] is valid (stage ran, no recurring chars). This resolves the
  deferred sub-decision from 03 (own schema, not embedded in proposal_packet).
- **Discovered + verified:** `pipeline-list` surfaces `story`; `pipeline-show
  story` shows the character_design stage with its `condition`; `check:schemas`
  green (all bundled data valid); schema/pipeline/manifest tests 17/0.
- No SVG rigs (out of scope per map). Consistency via locked flux2 refs + assets
  faceswap, documented in the assets stage's review_focus.
