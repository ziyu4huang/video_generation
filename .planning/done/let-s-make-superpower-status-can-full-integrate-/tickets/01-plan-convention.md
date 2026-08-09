# 01 — Plan convention

## Question

What is the canonical plan-file **location + format** the superpowers coordination layer will parse to sync methodology progress into goal-todo?

The strongest candidate is to **adopt `writing-plans`' existing convention** — `docs/superpowers/plans/YYYY-MM-DD-<feature>.md`, header `# [Feature] Implementation Plan`, checkbox `- [ ] **Step N: …**` tasks — because the agent already writes there and the format is parseable. Decide whether to adopt it as-is, or extend it with a richer schema (stable step IDs, an explicit goal line the `/goal` consumer can read, status fields).

Also settle, in the same decision:

- **Scope:** which methodology artifacts fall under the convention — `writing-plans` + `executing-plans` only, or also `brainstorming` (spec), `subagent-driven-development` (sub-plans), and a `verification-before-completion` pass signal?
- **wayfind reconciliation:** ignore the separate `.planning/<effort>/` system, coexist, or unify?

### Context (pre-gathered — don't re-investigate)

- `writing-plans/SKILL.md` line 18: *"Save plans to: `docs/superpowers/plans/YYYY-MM-DD-<feature-name>.md`"* + *"(User preferences for plan location override this default)"*.
- Plan header (line 54–61): `# [Feature Name] Implementation Plan` + a blockquote naming the executing sub-skill; steps use `- [ ] **Step N: …**`.
- wayfind uses `.planning/<effort>/{map.md, tickets/, task_plan.md}` — different artifact shape, different methodology.

type: grilling
claimed: pi-agent
blocked by: —
status: closed

## Resolution (closed 2026-07-18)

**Adopt `writing-plans`' existing convention wholesale.**

- **Location:** `docs/superpowers/plans/YYYY-MM-DD-<feature>.md` (the default `writing-plans` already writes to — `SKILL.md` line 18).
- **Goal source:** the `# [Feature] Implementation Plan` header line → `/goal`.
- **Todo source:** `- [ ] **Step N: …**` checkboxes → todos (one todo per step).
- **Scope is location-driven & skill-agnostic:** the layer syncs any format-matched plan file under `docs/superpowers/plans/`, regardless of which skill produced it. Specs (brainstorming), verification artifacts, and wayfind's `.planning/` tickets are OUT — different artifact shapes / different methodology.
- **Stable step-ID across re-parses is NOT solved here** (checkboxes are ordinal only) → deferred to [04 — Sync mapping](04-sync-mapping.md).
- **Soft-instruction is near-free** (the agent already writes to the default location) → [03 — Bootstrap soft-instruction](03-bootstrap-soft-instruction.md) shrinks to neutralizing the "user preferences override" escape hatch.
