## Question

Build the **living reference pack** (instantiated from the template) + **test coverage** for the new manifest fields, pack-local state resolver, bundled-agent registration, and clean/purge surface.

type: task
status: closed
claimed: work-session (2026-07-19)  — execution handoff; TDD build + subagent breakdown (per user)

blocked by: 05(closed), 06(closed), 07(closed), 09(closed), 11(closed), 12(closed), 13(closed)

**Execution plan:** [`ticket-14-plan.md`](../ticket-14-plan.md) — 8 independent TDD tasks (T1 manifest io · T2 packId · T3 agent-registry fix+packDirs · T4 pack-state · T5 clean · T6 run-state packId · T7 scaffolder+template+files · T8 reference pack). Out-of-14-scope (runner hooks for intermediates 12 / repeat-runs 11, CLI/TUI wiring) flagged as follow-on tickets.
**Resume (fresh session):** read `ticket-14-plan.md` → use `superpowers:subagent-driven-development` → create todos + `.superpowers/sdd/progress.md` ledger → dispatch implementer+reviewer per task, continuous. Do NOT start in the planning session that wrote this (it's deep).

## Context

The destination is a full in-place change, so it needs a concrete exemplar pack proving the template is buildable + runnable + cleanable, plus tests. The reference pack should exercise every new capability: a manifest with the I/O contract, ≥2 bundled `agents/*.md` roles (multi-role), a repeatable run producing versioned `outputs/`, on-disk `intermediate/`, and a cleanable `runs/` history. Tests via `( cd bun-apps/pi-agent-ext-workflow && bun test )` (Bun only); cover `validateManifest` new fields, `resolveWorkflowPack` pack-local state wiring, agentType register/unregister, and the clean/purge command. Follow `test-driven-development` — write the test first.
