---
type: task
blocking: 01, 02, 03
claimed: pi-agent (autonomous — user pre-agreed, option B)
status: closed
---

# 04 — Sync the docs to reality (vault SOP + wayfind/superpowers skill prose)

## Question / Task

Rewrite the vault SOP doc (`../study-news/content/agents-develop-sop-wayfind-superpowers.md`) so its **artifact map, flowchart, and speed-table match the unified convention** baked in by [01](01-single-home-for-spec.md) / [02](02-per-tracer-bullet-plan-files.md) / [03](03-sdd-runtime-scratch-disposition.md). This is the destination deliverable — the doc that makes the handoff contract legible.

### What the rewritten artifact map must express (three tiers, not one flat table)

1. **Effort-scoped planning docs** → `.planning/<effort>/`:
   `map.md`, `tickets/<NN>-*.md` (① + ②), `spec.md`, `task_plan.md` (wayfind seed's phase spine), `plans/<NN>-*.md` (superpowers writing-plans, one per ② — NEW from ticket 02).
2. **Cross-cutting domain artifacts** → domain root (deliberate exception — settled in the charting grill; see map *Out of scope*):
   `CONTEXT.md` glossary + `docs/adr/` — project-level ubiquitous language + architecture decisions, shared across all efforts.
3. **Runtime scratch** → repo root `.superpowers/sdd/` (ticket 03):
   `progress.md` ledger, review diffs, task briefs — ephemeral execution state, gitignored.

### Stale references to fix

- Every `docs/superpowers/plans/<date>-<feature>.md` → `.planning/<effort>/plans/<NN>-<slug>.md` (the mermaid `PLAN` node, the 三層票 table row ③, the artifact-map rows for ③ + 實作計畫, the 一頁速查表).
- The `spec.md` dual-location (`.planning/` *or* `docs/specs/`) → single home `.planning/<effort>/spec.md` (ticket 01).
- Confirm the mermaid flowchart's `PLAN` / `SEED` nodes and the three 銜接點 (handoff points) still hold — the *interface* is unchanged; only the storage root of ③ changes.

### Side-sync (not the vault doc, but must stay consistent)

- `pi-agent-ext-wayfind/README.md` + `CONTEXT.md` — already mostly correct; verify no `docs/specs/` mention remains after [01].
- The edited skill prose from [01] / [02] (`to-spec`, `writing-plans`, `requesting-code-review`, `subagent-driven-development`) — these ARE the changes; the doc reflects them.

### On resolution

The vault SOP doc reflects reality + the unified convention. The map's destination is reached; what remains is the **superpowers execution hand-off** — the actual skill-prose + doc edits, run through the standard chain (`/wayfind spec` → `/wayfind tickets` → `writing-plans` → SDD). That hand-off is the map's close, not a ticket.

## Resolution (closed 2026-07-19 — autonomous, user pre-agreed; destination deliverable)

**Vault SOP doc rewritten to reality + the unified convention.** 8 precise edits applied to `../study-news/content/agents-develop-sop-wayfind-superpowers.md`:

1. mermaid `PLAN` node: `docs/superpowers/plans/<date>-<feature>.md` → `.planning/<effort>/plans/<NN>-<slug>.md`.
2. 三層票 table ③ row path → `.planning/<effort>/plans/*.md`（與 ② 同 effort）.
3. Stage 3 spec: killed the `docs/specs/` alt; stated single-home + `to-spec` ≡ `brainstorming`.
4. Stage 5b 計畫檔落點: `plans/<NN>-<slug>.md` + 一條②一份 + 同號 + effort-from-`task_plan`.
5. 產物地圖: added **三層產物分類** (A effort-scoped / B cross-cutting domain / C runtime scratch).
6–7. 產物地圖 ③ + 實作計畫 rows → `.planning/<effort>/plans/<NN>-<slug>.md`.
8. 一頁速查表 writing-plans → `.planning/<effort>/plans/<NN>-slug.md`.

**Verified:** zero `docs/superpowers/plans` / `docs/specs` refs remain (`grep` confirms).

**Side-sync check:** `pi-agent-ext-wayfind/README.md` already routes spec to `.planning/<effort>/spec.md` (no `docs/specs/` mention); no README/CONTEXT edit needed.

**✅ Skills now match the convention** (executed 2026-07-19): the 4 skill-prose edits from the map's hand-off table are applied; wayfind `bun test` **143/0** + superpowers `bun test` **95/0**. The doc described the target; the skills now realize it — destination fully delivered.
