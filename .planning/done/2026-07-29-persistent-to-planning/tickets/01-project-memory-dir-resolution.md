# 01 — Project-memory-dir resolution mechanism

---
type: grilling
status: closed
claimed: wayfinder-session
---

## Question

How does the memory store resolve the `project` target's directory to `.planning/memory/`? The store currently routes ALL targets through one `memoryDir` (`config.memoryDir ?? ~/.pi/agent/pi-hermes-memory`, `memory-store.ts` L251-258). Routing `project` to a separate per-repo dir needs a new resolution path.

## What to build

A grilled decision on the resolution mechanism. Candidates:

- **Config knob** `projectMemoryDir` (default `.planning/memory/`, overridable — null/empty falls back to the global dir). Explicit, opt-out-able, survives across checkouts that set the config.
- **Auto-detect**: if `<cwd>/.planning/` exists (a wayfinder repo), use `<cwd>/.planning/memory/` for `project`; else global. Implicit, no config, but couples memory-location to wayfinder presence.
- **Hardcoded**: `project` always → `<cwd>/.planning/memory/`. Simplest, no opt-out — but forces in-repo memory on every project, even those that don't want it tracked in git.

## Acceptance

- [x] Resolution mechanism chosen, with rationale (explicit-config vs implicit-auto-detect vs hardcoded; how opt-out works).
- [x] The decision names where the dir is anchored (`<cwd>/.planning/memory/` cwd-relative vs absolute vs AGENT_ROOT-relative) + how a project opts out.
- [x] Notes implications for the write-path routing (ticket 04 depends on this).

## Resolution

**Mechanism: config knob `projectMemoryDir`** — a new config, defaulting to `<cwd>/.planning/memory/`; `null`/empty falls back to the global dir (current behavior = explicit opt-out). Explicit + predictable + survives across checkouts that set the config; a project that doesn't want in-repo memory sets it to null.

**Anchoring**: `<cwd>/.planning/memory/` — **cwd-relative** (the project's own `.planning/`, resolved at memory-store init from the process cwd). Rejected: **auto-detect** `.planning/` presence (couples memory-location to wayfinder presence — memory would move just because `.planning/` exists, surprising + no clean per-project opt-out); **hardcoded** `project` → `.planning/memory/` (forces in-repo memory on every project with no opt-out — some projects don't want memory committed to git).

**Opt-out**: `projectMemoryDir: null`/empty → `project` entries stay in the global store (current behavior unchanged). Escape hatch for projects that want memory to follow the user, not the repo.

**Write-path implication (ticket 04 depends)**: the per-target file resolution in `memory-store.ts` (L256-258 — currently `user`→USER.md, `failure`→failures.md, else→MEMORY.md, all under one `memoryDir`) gains a branch: **if `target === "project"` AND `projectMemoryDir` is set → `<projectMemoryDir>/MEMORY.md`; else → global `memoryDir/MEMORY.md`**. The write path (`add`/`replace`/`remove`) + the proper-lockfile advisory lock must work on the projectMemoryDir (verify the consolidator child + lock path). `user` / global `memory` / `failure` are unchanged → global.

*(Resolves ticket 01. 04 still blocked by 02; frontier becomes {02, 03}.)*
