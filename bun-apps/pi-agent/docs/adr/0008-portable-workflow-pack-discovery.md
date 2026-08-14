**ID:** `ADR-pi-agent-0008` — ADR numbers restart per context, so this number alone is ambiguous; cite this ID. Index: `bun-apps/docs/adr/INDEX.md`

# ADR 0008 — Portable workflow-pack discovery (cwd/bin tiers above repo)

- Status: proposed
- Date: 2026-07-19

## Context

A portable single-exec binary (in 2026-07 that was `pi-agent-cli` built via its
own `bun scripts/build.ts --compile`; today it is `pi-agent` built via
`bun scripts/deploy.ts --exe`, invoked as `pi-agent cli workflow run …`) must run a user-supplied workflow-pack by NAME on a machine without
this repo. The resolver's existing name-resolution walks UP from cwd for a repo
root (`.pi/workflows/` or `bun-apps/`); on a repo-less machine `findRepoRoot`
returns undefined, so only an absolute path works — name-resolution fails.

The engine itself is already portable: the resolver + `node:vm` engine are
inlined into the compile build, packs are self-contained (`manifest.json` + one
entry, no imports), and a foreign-cwd real run was verified end-to-end
(2026-07-19 build probe: `echo` pack, `agents=1 1232ms`, exit 0, pi-default
model). Only name-discovery was missing.

## Decision

Add two name-resolution tiers that need no repo root, ranking ABOVE the repo
walk-up ("most local wins"):

1. absolute path (literal file/dir — unchanged)
2. `<cwd>/workflows/<name>` — a bare `workflows/` dir in the current working dir
3. `<binDir>/workflows/<name>` — a `workflows/` dir next to the binary, where
   `binDir = dirname(process.execPath)` (the reliable exe-location primitive in
   `bun --compile`; `Bun.executable` is undefined, `import.meta.url` is virtual)
4. `<repoRoot>/.pi/workflows/<name>` (existing)
5. `<repoRoot>/bun-apps/<pkg>/workflows/<name>` (existing)

A pack folder wins over a same-name `.js` at every tier. cwd-local and
binary-bundled packs therefore shadow repo packs even when cwd is inside a repo.

## Alternatives considered

- **`~/.pi/workflows` (mirror of `.pi/agents` + `~/.pi/agents`):** rejected —
  user preferred location-coupled discovery (cwd / next-to-binary) over a
  home-dir user library.
- **absolute-path-only:** rejected — too bare ergonomically; `workflow run echo`
  must work with zero config.
- **new tiers as fallback (below repo):** rejected — would not let cwd/bin-dir
  shadow repo packs; "most local wins" was chosen explicitly.

## Consequences

- `ResolvedWorkflow["source"]` gains `"cwd-workflows" | "bin-workflows"`.
- `resolveWorkflowScript` + `listWorkflows` gain an injectable `binDir` opt
  (default `dirname(process.execPath)`) for hermetic tests.
- The change lives in the engine (`pi-agent-ext-workflow/src/workflow-pack.ts`),
  the single source of truth shared by the headless CLI and any future
  interactive `workflow` tool.
