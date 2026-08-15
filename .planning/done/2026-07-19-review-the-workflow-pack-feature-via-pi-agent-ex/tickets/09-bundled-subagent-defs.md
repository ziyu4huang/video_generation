## Question

What is the **format, location, and resolver registration** of bundled subagent definitions inside a pack, such that a pack is **self-contained** and **Claude-Code-compatible** — and how are **multi-role** packs (several `<role>.md`) bound to specific `agent()` calls?

type: prototype
status: closed
claimed: work-session (2026-07-19)  — work-through, frontier #1 ("continue")

blocked by: 10(closed)

## Context

Today `agentType` defs live separately in `.pi/agents/*.md` + `~/.pi/agents/*.md` (`src/agent-registry.ts`), mirroring Claude Code's `.claude/agents`. The pack template has an `agents/` dir (04). Decide: do bundled defs reuse the `.pi/agents` frontmatter schema verbatim (so they're drop-in for both Pi and Claude Code), or does the pack carry BOTH `.pi/agents/` and `.claude/agents/` (or one canonical + a converter)? Decide how `resolveWorkflowPack` **registers** the pack's `agents/` into the agentType registry for the run's scope (and unregisters after), and how an `agent()` call inside `entry.js` references a bundled role by name. Relies on the format research in 10.

## Resolution

**Single canonical CC-string agent file + Pi parser fix (closes the interop/security trap).**

**D1 + D2 — format + interop:**
- Pack carries **ONE canonical `agents/<role>.md` per role, CC-string frontmatter form** (`tools: Write, Edit` — comma-separated string), drop-in for both Pi and Claude Code. The `.md` body = role prompt.
- **Enhance Pi's `parseAgentDefinition` / `toStringArray` to accept BOTH forms** (YAML array OR comma-separated string), normalizing internally to `string[]` (string → split on `,`, trim, drop empties; array → as-is). This:
  - Makes the CC-string canonical file parse correctly in Pi.
  - **Fixes the security trap globally** (surfaced by 10): a CC-style string was silently parsed as `undefined` → no allowlist → ALL tools (the opposite of intended). Now it's correctly split into the intended allowlist.
  - Backward-compatible (array form still works unchanged).
- Single source of truth — no dual dirs, no converter, no drift. Pi-only fields (`disallowedTools`, `isolation: "worktree"`) are optional additions ignored by CC (degraded-but-not-broken, per 10); the canonical file stays CC-valid.

**D3 — resolver registration:**
- `loadAgentRegistry(cwd, opts)` gains a `packDirs?: string[]` param; pack defs loaded with a new `source: "pack"` value (`AgentDefinition.source` extends to `"project" | "pack" | "user"`).
- **Precedence = project > pack > user.** The pack's bundled roles are the self-contained DEFAULTS for its run; project defs can still override (escape hatch, consistent with the existing project-wins rule); user is the fallback.
- `resolveWorkflowPack` passes the pack's `agents/` dir (resolved from the manifest `agents` glob, 05) into `loadAgentRegistry`. **No explicit unregister** — the registry is rebuilt per-run, so pack defs are naturally scoped to that run.

**D4 — agent() binding:**
- `agent("task", { agentType: "<role>" })` in `entry.js` resolves via `resolveAgentType("<role>", registry)` — plain name match against the registered pack roles. **No new mechanism**; multi-role packs = several `<role>.md` files, each bound by name.
- The manifest `agents` glob (05) declares which defs the pack bundles; the resolver globs + registers all. **Fail-fast validation:** if `entry.js` references an `agentType` not present in the pack's registered roles (nor in project/user), the run errors clearly rather than silently running a bare/unconstrained agent.

**Deferrals:** the `toStringArray` comma-split mechanic + `packDirs`/`source` wiring → execution (14 tests both, incl. a regression test for the security trap); CC-pure lint warnings for Pi-only fields → future (only if a pack explicitly targets CC).
