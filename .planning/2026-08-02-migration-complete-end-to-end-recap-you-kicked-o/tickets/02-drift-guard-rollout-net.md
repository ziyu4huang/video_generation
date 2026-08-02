## Question

The drift-guard test is currently scoped to 3 pilot extensions (power-tool, core-task, tool-gate). Stand it up as the rollout regression net: parameterize the "migrated set" so adding an extension auto-includes that extension's tools in the drift check (every migrated tool has a non-dead owner-declared `gating`). While here, fold in minor hardening: reject a non-core gate with empty `requires:{}` + no keywords (dead gate, FOLLOWUPS #8), and add an augmentation-agreement test pinning the 3 `types/tool-gating.d.ts` files (FOLLOWUPS #9). This is the gate every rollout ticket must pass before its extension leaves the fallback.

type: task
blocked by:
claimed: main-session

## Resolution

Drift-guard is now the rollout regression net. The migrated-extensions set is a
single extensible source of truth — `MIGRATED_EXTENSIONS` in
`extensions/drift-guard.test.ts`, a per-extension entry list (`{ name, register }`)
chosen over a flat tool-name list because a tool's gating is OWNED by its
extension, so the extension's registrar is the authoritative way to capture its
real defs and a NEW tool the extension later registers is caught automatically
(not silently missed by a hand-maintained name list). The net
(`runDriftGuardNet`) iterates this set and validates every captured tool for
non-dead owner-declared gating; appending an entry is all a rollout ticket
(03–12) does to put its tools behind the gate. Currently the 3 pilots
(power-tool `inspect_*`, core-task `ask_user_question`/`todo`/`goal_complete`,
tool-gate `enable_tool`) — pilot coverage preserved exactly via the per-pilot
characterization tests, which now capture through the same entries.

Folded in:
- **Dead-gate rejection (FOLLOWUPS #8)** — lives in the drift-guard net's
  `validateGating` (the rollout-time signal, per the preferred home). The check
  now mirrors `gateFires`: a non-core gate must carry ≥1 keyword OR a `requires`
  with ≥1 noun AND ≥1 verb. The prior check treated ANY non-null object as "has
  requires", letting `requires:{}` (and noun-only / verb-only) slip through as
  non-dead; all three now fail the net.
- **Augmentation-agreement test (FOLLOWUPS #9)** — new
  `extensions/augmentation-agreement.test.ts` pins the 3 `types/tool-gating.d.ts`
  copies (byte-identical + the expected `gating?: Gating` / `Gating{keywords,
  requires, core}` shape). Diverging any one copy fails. (Also fulfills the
  copies' own header comment, which had overclaimed such a test existed.)

Full package suite green: 251 pass / 0 fail across 12 files (baseline 238 / 11).

status: closed
