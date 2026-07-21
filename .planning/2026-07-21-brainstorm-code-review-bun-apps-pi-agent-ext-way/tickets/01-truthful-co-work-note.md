---
type: task
status: closed
---

# 01 — Truthful co-work SOP note (coordination framing only)

## Question

How should the study-news SOP note (`/Users/huangziyu/proj/study-news/content/agents-develop-sop-wayfind-superpowers.md`) be corrected so its COORDINATION framing matches the code's reality — the manual skill-layer protocol and the designed-not-built plan coordinator — instead of the aspirational automatic loop? (Artifact PATHS are out of scope — already synced 2026-07-19 by `2026-07-19-brainstorm-how-to-improve-wayfind-extension-fina` ticket `04-sync-docs-to-reality`.)

## What to build

Revised note that:
- Reframes the "兩大支柱的協調縫" — superpowers has zero coordination code; the seam is wayfind ⇄ the (unbuilt) plan coordinator; the two extensions co-work via `task_plan.md` on disk, with no live seam between them.
- Rewrites Stage 6/7 around the MANUAL protocol (agent prompts `/goal`, seeds `todo`s, calls `goal_complete`) per ADR-0003 / PR #678; marks `/wayfind sync` + the `goal_complete` phase-gate as graceful no-ops until a coordinator exists (cross-ref sibling effort `2026-07-19-build-plan-coordinator`).
- Keeps everything the note got RIGHT untouched (three-layer ticket model ①②③, Stage 1–5, TDD/verification/finishing chapters, artifact map, red-flags table — verified accurate).
- Adds a dated "reality vs design" callout citing ADR-0003 (2026-07-19) so future readers know the coordination framing was aspirational until now.

`blocking: 02` closes the re-drift loop: the note derives from wayfind's own docs, so correct the source ([02]) first, then re-derive the note from the truthful source.

## Acceptance

- [x] The "協調縫" section no longer implies superpowers participates in a live seam.
- [x] Stage 6/7 describe the manual `/goal`+`todo`+`goal_complete` protocol as the working path; `/wayfind sync` is noted as a no-op today.
- [x] A "designed-not-built" callout cites ADR-0003 and explains why every `__piPlan*` reader is a graceful no-op.
- [x] No factual claim contradicts grep-verified code behavior.
- [x] NO artifact-path references are changed (out of scope — already synced); preserved-accurate sections untouched.

## Resolution

Corrected the study-news note's COORDINATION framing only (artifact paths untouched — already synced 2026-07-19 by the path-unification effort). 9 edits:

- Added a top **「現況校正（2026-07-21, ADR-0003）」 callout** — marks the coordinator designed-not-built + names the manual protocol as the working path + states wayfind⇄superpowers have no live seam.
- Rewrote the **「協調縫」 paragraph** — superpowers is pure skills (zero coordination code); the two co-work via `task_plan.md` on disk; the wayfind⇄coordinator seam is designed-not-built (no-op today).
- Marked the **三個銜接點 「執行→回饋」 row**, the **mermaid SYNC node**, and added a **flow-diagram correction caption**.
- Rewrote **Stage 7 「`/wayfind sync`（閉環回程）」** — split 設計 vs 現況; sync is a no-op today; documented the manual protocol (prompt `/goal` → seed `todo` → `goal_complete`).
- Qualified **Stage 5a** (task_plan.md consumed by superpowers `writing-plans`/SDD today) + the **產物地圖 「執行脊柱」 consumer cell** + the **速查表 sync line**.

Every changed spot tagged 🔧 設計中 to separate design-contract from current behavior.

Verified: **8** 🔧 markers; **all 3 old aspirational phrases gone** (grep=0); **6** designed-not-built/ADR-0003 framing mentions; **artifact paths UNCHANGED** (`.planning/<effort>/` ×18, `plans/<NN>-<slug>.md` ×3, `task_plan.md` ×13, `CONTEXT.md` ×6, `docs/adr` ×4); code-fence balance even (16); H2 structure intact (33). Preserved-accurate sections (ticket model ①②③, Stages 1–5, TDD chapter, red-flags) untouched.
