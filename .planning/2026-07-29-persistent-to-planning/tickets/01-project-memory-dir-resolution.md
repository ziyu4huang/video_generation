# 01 — Project-memory-dir resolution mechanism

---
type: grilling
status: open
---

## Question

How does the memory store resolve the `project` target's directory to `.planning/memory/`? The store currently routes ALL targets through one `memoryDir` (`config.memoryDir ?? ~/.pi/agent/pi-hermes-memory`, `memory-store.ts` L251-258). Routing `project` to a separate per-repo dir needs a new resolution path.

## What to build

A grilled decision on the resolution mechanism. Candidates:

- **Config knob** `projectMemoryDir` (default `.planning/memory/`, overridable — null/empty falls back to the global dir). Explicit, opt-out-able, survives across checkouts that set the config.
- **Auto-detect**: if `<cwd>/.planning/` exists (a wayfinder repo), use `<cwd>/.planning/memory/` for `project`; else global. Implicit, no config, but couples memory-location to wayfinder presence.
- **Hardcoded**: `project` always → `<cwd>/.planning/memory/`. Simplest, no opt-out — but forces in-repo memory on every project, even those that don't want it tracked in git.

## Acceptance

- [ ] Resolution mechanism chosen, with rationale (explicit-config vs implicit-auto-detect vs hardcoded; how opt-out works).
- [ ] The decision names where the dir is anchored (`<cwd>/.planning/memory/` cwd-relative vs absolute vs AGENT_ROOT-relative) + how a project opts out.
- [ ] Notes implications for the write-path routing (ticket 04 depends on this).
