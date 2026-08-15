## Question

What is the **backward-compat + migration story** so inline scripts and existing global runs keep working while packs diverge to pack-local state — with zero regression?

type: task
status: closed
claimed: work-session (2026-07-19)  — work-through, frontier #1 ("continue")

blocked by: 05(closed), 07(closed)

## Context

03 split the world: inline `script` runs keep `~/.pi/workflows/projects/<key>/runs/` (`run-persistence.ts` + `workflow-paths.ts`); pack runs go pack-local. Decide the branch point in the engine (how a run knows it's pack-sourced), the resolution-precedence rule when a name resolves to both a pack and an inline saved workflow, and whether any existing global runs need migration (likely none — leave them; packs are new). Verify inline scripts, `/workflows` navigator, `workflow_control`, and resume all still behave identically for the inline path. This is the "don't break what works" ticket.

## Resolution

**`packId` branch point; pack-wins precedence; zero migration.**

1. **Branch point = `packId` on the run state** (08's pack-id). `PersistedRunState` gains an optional `packId?: string`:
   - **present** → pack-sourced → pack-local persistence (in-place under `.pi/workflows/<name>/` for `.pi/` packs; redirected to `.pi/workflows/.state/<pack-id>/` for checked-in packs, per 07).
   - **absent** → inline script → **existing `createRunPersistence(cwd)` UNCHANGED** (`~/.pi/workflows/projects/<slug>-<hash>/`).
   - Set when `resolveWorkflowPack` succeeds; absent for inline (`script:`) invocations. Durable across resume (lives in the persisted JSON), so a resumed run keeps its branch.

2. **Precedence = pack wins on collision + clear warning.** Resolution paths are already distinct (`name:` → pack folder+manifest; `script:`/saved → inline). On a genuine name collision (a name that's both a pack AND a legacy saved workflow), the **pack wins** (packs are the new self-contained canonical unit; `name:` already means pack), with a logged warning naming the shadowed saved workflow. **Zero-regression holds**: existing runs/saved WITHOUT a same-named pack are completely untouched — a collision only arises when someone deliberately creates a new pack with an already-saved name (a new, opted-into action).

3. **Migration = NONE.** Packs are new; existing global runs stay in `~/.pi/workflows/projects/<key>/` untouched, still resumable/listable via `/workflows` + `workflow_control`. No data migration, no path rewriting — the cleanest possible backward-compat story.

4. **Verification (the task core)** — the engine MUST keep these identical for the inline path (packId-absent runs):
   - Inline `script:` runs → `createRunPersistence(cwd)` unchanged; runs land in `~/.pi/workflows/projects/<key>/runs/`.
   - `/workflows` navigator → lists inline runs exactly as before (pack runs appear SEPARATELY, scoped to their pack — not mixed into the inline list).
   - `workflow_control` (stop/pause/resume/status/list/wait) → operates identically on inline runs.
   - Resume → journal-driven replay unchanged for inline (12's mirror is opt-in/pack-only; inline intermediates stay inline in the journal as today).
   - **Test gate (→ 14):** existing inline-script tests + resume tests pass WITHOUT modification — the proof of zero regression.

**Deferrals:** the `packId` field addition + the persistence-factory branch + pack-run navigator scoping → execution (14 implements + tests all four verification points).
