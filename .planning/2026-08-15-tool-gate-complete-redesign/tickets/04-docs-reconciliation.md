# 04 — Docs reconciliation (README / PRD / CONTEXT)

type: task

## Question

`README.md`, `PRD.md`, and `CONTEXT.md` describe the **pre-2026-08-10 model** — a hardcoded `GATES` array, a `CORE_TOOLS` set, a 12-gate table, and a `TRACKED_TOOLS` term — none of which exist in the code (owner-declared `gating` replaced them in tickets 02–15). The savings prose is stale too: "~18,000 → ~10,000 / ~9,800 saved" vs measured **OFF 22,588 → ON 10,871 / 11,717 saved (51.9%), net 11,474**.

Rewrite all three to the owner-declared model:
- README "Gate Configuration" → how owner-declared `gating` works + how to add a gate (declare `gating` on the tool's own definition, not a central array).
- README/PRD "Core tools (always active)" → the `core:true` owner-declared set (post ticket 02's re-triage, if landed).
- CONTEXT ubiquitous language → replace `GATES`/`CORE_TOOLS`/`TRACKED_TOOLS` terms with the contract terms ticket 01 settles (`Gate`, `core:true`, `tracked`).
- Refresh every savings figure to the live `qa:savings` numbers, and point to `qa:savings` as the single source of truth.

**Root cause (encode this):** the docs were fixed once (`.planning/done/2026-07-30-…/tickets/05-context-md-and-readme-claim-correction.md`) then re-broke because the 2026-08-02/08-10 owner-declaration migration changed the model **without a docs ticket in its rollout**. Record in `CONTEXT.md` the invariant: *any future gating-contract/model change must ship a docs ticket in the same rollout.*

## Acceptance

README/PRD/CONTEXT describe the code as-is (owner-declared `gating`), every savings number matches `bun run qa:savings` output, and the no-drift invariant is written into CONTEXT.md.

blocked by: 01, 02 (docs must reflect the settled contract + re-triaged core)
