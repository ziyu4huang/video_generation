## Question

The drift-guard test is currently scoped to 3 pilot extensions (power-tool, core-task, tool-gate). Stand it up as the rollout regression net: parameterize the "migrated set" so adding an extension auto-includes that extension's tools in the drift check (every migrated tool has a non-dead owner-declared `gating`). While here, fold in minor hardening: reject a non-core gate with empty `requires:{}` + no keywords (dead gate, FOLLOWUPS #8), and add an augmentation-agreement test pinning the 3 `types/tool-gating.d.ts` files (FOLLOWUPS #9). This is the gate every rollout ticket must pass before its extension leaves the fallback.

type: task
blocked by:
