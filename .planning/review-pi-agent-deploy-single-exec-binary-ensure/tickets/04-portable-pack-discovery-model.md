---
type: grilling
status: closed
blocked by: 01, 02, 03
resolved: 2026-07-19
---

# 04 — Portable pack-discovery model (provisioning + name-resolution)

## Question

**How does a repo-less portable binary locate and name-resolve a user-supplied
self-contained pack?** This is the core design decision the spec must lock.

Today `resolveWorkflowScript` (`workflow-pack.ts`) resolves by (1) literal path
relative to cwd, then walks up from cwd via `findRepoRoot` looking for
`.pi/workflows/` or `bun-apps/`, reading `manifest.json` + entry from disk. On a
repo-less machine `findRepoRoot` returns **undefined** → name-resolution (branch
2/3) fails; only an **absolute path** (branch 1) works. Packs are self-contained
2-file folders (ticket 02), fully relocatable — so this is purely a *where does
the binary look* question.

## Context (facts this decision stands on)

- Tickets 01–03 are closed: the resolver + engine are inlined and portable;
  execution needs only the 2 pack files on disk.
- Current resolution tiers: literal path (absolute/relative-to-cwd),
  `<repoRoot>/.pi/workflows/<name>`, `<repoRoot>/bun-apps/<pkg>/workflows/<name>`.
- The `workflow run <name>` ergonomics depend on at least one non-absolute tier
  working portably; otherwise portable use degrades to `workflow run /abs/path`.

## Options to grill (recommend one; user decides)

- **(a) Absolute path only** — no new tier. Portable = `workflow run /abs/path/to/pack`. Zero code change; weakest ergonomics. May be acceptable as the v1 contract.
- **(b) Exe-relative `workflows/` dir** — new tier keyed on the binary's own location (`pathToFileURL` of the exe), so shipping `pi-agent-cli` next to a `workflows/` folder works with no config. Robust for bundled distributions.
- **(c) User-config / env root** — resolve a packs root from `PI_WORKFLOWS_DIR` env or `~/.pi/workflows` (mirrors the existing pi-settings convention) as a new tier.
- **(d) Hybrid** — (c) as the name-resolution tier + (a) always available + optionally (b) for bundled demos.

## How to resolve

Grill the user one sub-question at a time (grilling + grill-memory): first the
ergonomics bar (is absolute-path-only acceptable, or must `workflow run <name>`
work with zero config?), then the tier(s) that meet it. Record the chosen model
as a `## Resolution`, then surface any newly-specifiable fog (e.g. precedence
order among multiple tiers) as follow-ups. Capture the locked decision in
`bun-apps/pi-agent-cli/CONTEXT.md` (+ an ADR if it is hard to reverse).

## Resolution

**Decision: add two new name-resolution tiers, ranking ABOVE the existing repo
walk-up — "most local wins".** Full precedence:

1. **absolute path** (literal file/dir — resolver branch 1, unchanged; always).
2. **`<cwd>/workflows/<name>`** — a bare `workflows/` directory in the current
   working directory (NOT `.pi/workflows`; immediate cwd).
3. **`<binDir>/workflows/<name>`** — a `workflows/` directory next to the binary,
   where `binDir = dirname(process.execPath)`. **Verified feasible** in the
   2026-07-19 probe: `process.execPath` returns the compiled exe's real path
   (`/private/tmp/...`); `Bun.executable` is `undefined` and `import.meta.url`
   is a virtual `/$bunfs/root/...` path, so those are NOT usable.
4. `<repoRoot>/.pi/workflows/<name>` (existing, repo walk-up).
5. `<repoRoot>/bun-apps/<pkg>/workflows/<name>` (existing, repo walk-up).

Semantic: cwd-local and binary-bundled packs **shadow** repo packs even when cwd
is inside a repo. `workflow run echo` therefore works on a repo-less machine as
long as a `workflows/echo/` folder sits in the cwd or next to the binary.

**Rejected alternatives.**
- *`~/.pi/workflows` (convention-mirror of `.pi/agents` + `~/.pi/agents`):*
  user preferred **location-coupled** discovery (cwd / next-to-binary) over a
  home-dir user library. (Project-scoped design choice — record in CONTEXT.md,
  not portable memory.)
- *absolute-path-only (option a):* too bare ergonomically.
- *new-tiers-as-fallback (below repo tiers):* would not let cwd/bin-dir shadow
  repo packs — user explicitly chose "most local wins".

**Implementation notes (for the build/handoff session).** The change lives in
the engine resolver `resolveWorkflowScript` in
`bun-apps/pi-agent-ext-workflow/src/workflow-pack.ts` (single source of truth,
shared by headless Path A and any future Path B). Restructure: after the
absolute-path branch, check `<cwd>/workflows` then `<binDir>/workflows` BEFORE
the `findRepoRoot` walk-up. Also update `listWorkflows` (so `workflow list`
enumerates the two new dirs) and the not-found error message. `findRepoRoot`
stays — it now serves the lower-precedence repo tiers.

**ADR warranted.** Hard-to-reverse (users may come to rely on the shadowing),
surprising (most resolvers put project tiers first), and a real trade-off (three
alternatives rejected). Record in `bun-apps/pi-agent-cli/CONTEXT.md` +
`docs/adr/` during the handoff.
