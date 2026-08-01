# 01 — Opt-in contract & config knob

---
type: grilling
status: closed
claimed: wayfinder-session
---

## Question

How does an effort **opt into** autonomous memory auto-commit, and what is the config
surface that enables it? Auto-committing unattended is a behavior change — it must be
explicitly turn-on-able per effort (or per repo), and turn-off-able.

## What to build

A grilled decision on the opt-in mechanism. Candidates:

- **Env var** `PI_MEMORY_AUTOCOMMIT=1` (or `=session`/`=goal` to also pin batch granularity
  in ticket 02). Fits the existing `PI_PLANNING_EFFORT` / `PI_HERMES_CONSOLIDATING` /
  `PI_MEMORY_FILE_LOCK` pattern; trivially set per worktree/effort.
- **Config flag** in `hermes-memory-config.json` (e.g. `autoCommitProjectMemory: true`).
  Repo-resident, persists across sessions without re-exporting an env var — but applies
  repo-wide, not per-effort.
- **Per-effort marker file** (e.g. `.agents/memory/.autocommit`). Co-located with the SoT,
  opt-in travels with the checkout.
- **Always-on with opt-out** (`PI_MEMORY_AUTOCOMMIT=0` to disable). Maximizes durability;
  loses the "explicit consent" property.

## Acceptance

- [ ] Opt-in mechanism chosen, with rationale (env vs config vs marker vs default-on).
- [ ] Names how an effort turns it **on** and how it turns it **off**, and the scope
      (per-effort worktree vs per-repo vs global).
- [ ] States how it composes with the existing `projectMemoryDir` config (relocation knob)
      — the two must not contradict (e.g. opt-in but `projectMemoryDir=null` → in the
      global store, where commit is meaningless).
- [ ] Notes cwd/worktree anchoring: opt-in must be detectable from the worktree writing
      the memory, not only the main checkout.

## Resolution

**Decision (grilled 2026-08-01): per-repo opt-in via a narrow-overlay repo-local config flag.**

- **Granularity — per-repo (set once).** Opting in is a property of the *repo*, not one
  effort. This refines the chart-time "effort opts in" framing: durability is a repo-level
  property, and per-effort opt-in would reintroduce the "forgets to commit / forgets to
  opt in" recurrence the destination exists to close.
- **Mechanism — repo-local config flag `autoCommitProjectMemory: true`.** Explicit consent
  for autonomous git commits; set once; travels with the repo; and consolidates the knobs
  tickets 02 (batch granularity) and 03 (commit message) will introduce into one file.
  Chosen over a tracked marker file (boolean — would fragment the 02/03 knobs into env
  vars) and over overloading `projectMemoryDir` (conflates location with commit behavior;
  removes a consent layer).
- **Scope + location — narrow overlay at `<repo-root>/.agents/memory/config.json`.** The
  repo-local config holds ONLY project-memory keys (`autoCommitProjectMemory`,
  `projectMemoryDir`, and the future batch/message knobs), merged ON TOP of the global
  `~/.pi/agent/hermes-memory-config.json`. Global settings (`dbBackend`, `surreal.*`, …)
  stay global and CANNOT be overridden per-repo — so a repo can't silently repoint its DB.
  Co-located with the MEMORY.md SoT it governs.

**Composition with `projectMemoryDir` (acceptance #3).** Auto-commit fires only when
project memory is in-repo (`projectMemoryDir` non-null). If opted-in but
`projectMemoryDir=null` (memory in the global store), the hook is a **no-op + a one-time
warning** — nothing in the repo to commit. The opt-in flag and the location knob share the
same repo-local config file.

**Worktree anchoring (acceptance #4).** The config is discovered by the SAME cwd-relative
resolver that already finds the SoT (`resolveProjectStoreDir` → `<cwd>/.agents/memory/`) —
i.e. `path.join(resolveProjectStoreDir(...), "config.json")`. No separate repo-root logic;
each worktree's checkout includes the tracked config, so the worktree writing the memory
always sees the opt-in.

**Build implications for ticket 06 (downstream).** Extend `loadConfig()` to read the
repo-local overlay (cwd-relative, via the existing project-store resolver) and deep-merge
the allowed project-memory keys over the global config; add `autoCommitProjectMemory`
(boolean, default `false`) to `MemoryConfig`. The repo-local file is tracked (committed) so
"set once" travels with the repo.

**Cross-ref.** The opted-in-but-`projectMemoryDir=null` no-op is a config-consistency
skip (distinct from ticket 04's git-state aborts); ticket 06 implements it alongside 04's
guards. No fog graduated; tickets 02/03/06 are sharpened (02/03 knobs now have a config
home; 06 has a clear discovery + merge task).
