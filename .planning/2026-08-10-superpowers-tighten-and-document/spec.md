---
effort: 2026-08-10-superpowers-tighten-and-document
title: "Superpowers — Tighten & Document"
status: Draft (pending review)
date: 2026-08-10
approach: "A — Tighten & Document (brainstormed; B/C deferred)"
---

# Superpowers — Tighten & Document

## Background

`pi-agent-ext-superpowers` is a mature, fidelity-locked port of upstream Superpowers v6.2.0 (14 skills, byte-pinned per ADR-0004). A measurement pass surfaced three coupled issues:

1. **A token double-count.** `using-superpowers` is injected as the bootstrap body (`getBootstrapContent()` reads `skills/using-superpowers/SKILL.md`) AND advertised as one of the 13 skills via `resources_discover` (it is not in `DEFAULT_SKILL_EXCLUDE`). The bootstrap even instructs the agent: *"Do not try to load using-superpowers again."* Net effect: ~763 tok/req of duplicate content plus a confusing invokable skill the agent is told not to use.
2. **An undocumented policy + a stale comment.** Only `verification-before-completion` is default-excluded; the rationale lives in an inline code comment (no ADR). That comment claims "~139 tok/req saved" — the actual figure is ~900 tok (the skill is 3,646 bytes).
3. **A fragile CI guard.** `tests/artifact-leak.test.ts` (ADR-0007) walks the *raw filesystem* under `docs/superpowers/` and `.superpowers/`. `.superpowers/` is gitignored (`.gitignore:91`); local SDD scratch placed there false-reds the suite on otherwise-clean main. Current local state: 130 pass / 1 fail (23 stale pre-`a5a0864a` orphans under `.superpowers/sdd/plan/`).

A fact-check also confirmed: **no code writes to `.superpowers/`** — all routing (specs, plans, SDD scratch, brainstorm) already resolves under `.planning/<effort>/` or flat `.planning/{specs,plans,sdd}/` (ADR-0007). The `.superpowers/` presence is purely stale-local files plus fidelity-locked upstream prose.

## Goal

One low-risk, coherent effort that:

- **G1** — Cuts a real token waste (de-advertise the double-counted `using-superpowers`).
- **G2** — Documents the default-exclude policy in an ADR with accurate figures.
- **G3** — Makes the leak test reliably green on any worktree.
- **G4** — Fully realizes "no `.superpowers/` — everything under `.planning/`."

## Non-goals

- Editing fidelity-locked skill text (ADR-0004).
- Lazy-load / advertised-set re-shaping (Approach B) or profile knobs (Approach C) — deferred; this effort's ADR + test work is the foundation they would build on.
- Changing which *other* skills are advertised.
- Re-enabling `verification-before-completion` (its default-off is unchanged; only documented).

## Design

### D1 — De-advertise `using-superpowers` (token cut)

Add `using-superpowers` to `DEFAULT_SKILL_EXCLUDE`:

```ts
export const DEFAULT_SKILL_EXCLUDE = [
  "verification-before-completion",
  "using-superpowers",
] as const;
```

- **Rationale:** its full body is already the bootstrap; advertising it duplicates ~763 tok/req and contradicts the bootstrap's own "do not load again" instruction.
- **Safety:** content stays present via the bootstrap (injected on `session_start`/`session_compact` until first `agent_end`, re-armed on compact). De-advertising only removes the redundant system-prompt skill entry and the `/skill:using-superpowers` command. The bootstrap read path (`resolveBootstrapSkillPath`) is untouched.
- **Effect:** advertised set 13 → 12; ~763 tok/req saved.

### D2 — Document the policy (comment fix + ADR-0008)

- Replace the stale "~139 tok" comment in `src/superpowers.ts` with accurate figures (`verification-before-completion` ≈ 900 tok; `using-superpowers` ≈ 763 tok) and a pointer to ADR-0008.
- Write **ADR-0008 — Default skill-exclusion policy** at `docs/adr/0008-default-skill-exclusion-policy.md`:
  - Lists both default-excluded skills with **distinct rationales**: `verification-before-completion` = Phase-3 clean-pass (behavior); `using-superpowers` = bootstrap dedup (its content is already injected).
  - Real token figures and how they were measured.
  - Override knobs: `PI_SUPERPOWERS_SKILL_EXCLUDE` (additive comma-list), `PI_SUPERPOWERS_SKILL_EXCLUDE_DEFAULTS=0` (suppress defaults).
  - Trade-off note: disabling defaults re-advertises both (restoring the `using-superpowers` double-count) — acceptable as an explicit opt-out.

### D3 — Harden `artifact-leak.test.ts` (CI) + clean local orphans

- Change the leak walk from raw-FS (`readdirSync`) to **git-tracked files** (`git ls-files` filtered to the `docs/superpowers/` and `.superpowers/` roots). This tests the real risk — a *committed* leak — and no longer false-reds on local gitignored scratch.
- Keep both roots in the guard list (defense-in-depth); keep the `ALLOWED` grandfathered set.
- One-time hygiene: `rm -rf .superpowers/` (gitignored; nothing recreates it post-`a5a0864a`).
- **Effect:** suite 130/1-red → 131/0, reliably green on any worktree.

### D4 — `.superpowers/` elimination (constraint)

Confirmed via audit: no write paths exist; all routing → `.planning/`. Residuals: (a) stale orphans [deleted in D3], (b) the guard list [kept in D3], (c) fidelity-locked upstream prose [unchangeable per ADR-0004; redirected by pi-port overrides]. All intentional — no code redirect needed.

### D5 — Artifact home

This effort's planning lives under `.planning/2026-08-10-superpowers-tighten-and-document/` (committed; wayfind-style layout: `spec.md` → `plan.md` / tickets via the writing-plans step).

## Testing

- `skill-exclude.test.ts`: default exclude = {`verification-before-completion`, `using-superpowers`}; advertised count 13 → 12; both excluded skills' `SKILL.md` remain byte-identical (still shipped, just not auto-advertised).
- `artifact-leak.test.ts`: git-tracked scope (D3); add a case that places a local *untracked* file under `.superpowers/` and asserts the suite no longer fails on it.
- `bootstrap.test.ts`: verify it still asserts the `using-superpowers` content is loaded via the bootstrap (guard that D1 did not break the bootstrap path); extend coverage if thin.
- `skills-fidelity.test.ts`: unchanged (14 fixtures still match — de-advertising touches no files).
- `ADR-0008` deliverable check: the file exists at `docs/adr/0008-default-skill-exclusion-policy.md` and covers both excluded skills with distinct rationales, real token figures, the two override knobs (`PI_SUPERPOWERS_SKILL_EXCLUDE`, `PI_SUPERPOWERS_SKILL_EXCLUDE_DEFAULTS`), and the disable-defaults trade-off note.
- Comment-fix check: `src/superpowers.ts` no longer contains the stale "~139 tok" string; accurate figures (~900 tok `verification-before-completion`, ~763 tok `using-superpowers`) and an ADR-0008 pointer are present.
- Full package green: `( cd bun-apps/pi-agent-ext-superpowers && bun run typecheck && bun test )`.

## Risks & trade-offs

- **Negligible behavior change:** `using-superpowers` content remains ever-present via the bootstrap; only the redundant `/skill:` command + system-prompt entry is removed. The one edge case — manually reloading `using-superpowers` via `/skill:` between `agent_end` and the next compact — is lost; the agent can still `read` the file if ever needed.
- **Disabling defaults restores the double-count** (documented in ADR-0008; explicit opt-out).
- **Leak test scoped to tracked files** means a regression that writes to a *gitignored* `.superpowers/` path would not be caught by this test — but routing is covered by `sdd-workspace.test.ts` golden tests plus the bootstrap/boundary tests, so the risk is low and defense-in-depth remains.

## Rollout

1. Branch `feat/superpowers-tighten-and-document` from `synced-main` (== `origin/main`).
2. Implement D1, D3, and the Testing section; write ADR-0008 (D2); fix the comment (D2).
3. Local CI green: `( cd bun-apps/pi-agent-ext-superpowers && bun run typecheck && bun test )`.
4. Squash-merge via `gh ship` (no remote-CI wait; remote CI disabled by design).
5. Fast-forward `synced-main`.

## Out of scope / future

Approach B (core/on-demand lazy-load) and C (profile knobs) are natural follow-ups that build on this ADR + test base, to be pursued only if per-request token cost proves the dominant pain.
