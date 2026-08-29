---
effort: 2026-08-29-slash-surface-consistency
created: 2026-08-29
last: 2026-08-29
status: open
---

# Slash-surface consistency — s2-agent command face cleanup

## Destination

The s2-agent command surface (TUI slash commands, skills, CLI subcommands,
diagnostic entry points) is consistently named, collision-free, and
discoverable: no two commands fight over one name, the help face does not
introduce the tool as "pi", and a user can find the right command without
knowing the upstream lineage of each skill family.

## Context

MEASURED 2026-08-29 on this machine, main `8d588d50` / dist `0.8.0+g8d588d5`
(pi core 0.84.4), via skills-dir enumeration + registry-config.ts +
pi-coding-agent@0.84.4 dist/core/slash-commands.js:

- Surface sizes: **23 pi builtin** TUI slash commands (settings model tree
  thinking scoped-models export import share copy name session changelog
  hotkeys fork clone trust login logout new compact resume reload quit …),
  **68 repo skills** across 15 s2-agent-ext-* packages, **22 CLI
  subcommands + 5 pipelines** (`-to-vault` suffix family).
- **`/compact` collision**: `bun-apps/s2-agent/src/registry-config.ts:590`
  registers extension name `compact` (s2-agent-ext-compact, CC-style
  compaction) while pi 0.84.4 ships builtin `/compact` (upstream
  compaction; 0.84.3 added compaction routing). Coexistence behavior
  unmeasured.
- **Help banner**: `./s2-agent.sh --help` prints `pi - AI coding assistant
  with read, bash, edit, write tools` + `pi install/remove/update/...`
  (measured on the source face; the deploy face wraps the same core).
- **`pi-` naming residue**: skills `pi-memory-bulk-dedup`
  (hermes-memory), `research-pi-packages` (research-tool — NOTE: it
  researches the upstream Pi ecosystem, so the "pi" may be semantically
  correct; see Fog of war), `grill-memory` description text says "pi
  memory".
- **Family prefix inconsistency**: hyperframes-* prefixes all 6; devops
  family prefixes 1 of 10 (`/devops-workflow` but not `/issue-tracker`
  `/domain-docs` `/learnings` …); superpowers (19) and wayfind (22)
  families prefix none.
- **Diagnostic entry points**: `s2-agent doctor` (sh face, cli-sh.ts),
  `ext doctor`, `cli doctor`, devops `session-doctor-cli.ts`, plus the
  `debug-s2-session` skill — five surfaces.
- **/autocompact is DONE**: #2144 (merged, in dist 0.8.0) ships
  `/autocompact <N>k | <N> | off | status` in power-tool —
  `bun-apps/s2-agent-ext-power-tool/src/autocompact.ts:9`, absolute
  per-session threshold, Claude-Code semantics.

## Tickets

**Execution order:** 01 → 02 → 03 → 04 → 05 → 06 (user-confirmed
2026-08-29; 01 first = behavioral risk + naming precedent for 03, 06 last =
listing derives after renames land).

### Phase A — behavioral (no-choice first)

- [ ] **01-compact-collision** — measure + adjudicate the `/compact`
  name fight (builtin vs s2-agent-ext-compact) under pi 0.84.4; rename or
  document replacement semantics; pin with a test.

### Phase B — naming (choice, depends on 01's convention outcome only loosely)

- [ ] **02-pi-residue-rename** — rename `pi-memory-bulk-dedup` (and
  grill-memory's "pi memory" description); adjudicate
  `research-pi-packages` (may keep — it names the upstream ecosystem).
- [ ] **03-family-prefix-convention** — ONE convention decision for
  family prefixes (all-prefixed vs documented flat), recorded in the
  `extension-naming` skill + applied to the devops family's stragglers.

### Phase C — docs face

- [ ] **04-help-banner-adjudication** — decide which "pi" strings we own
  (patch `--help` face via the patches seam vs document-only); implement
  the minimal slice.
- [ ] **05-doctor-family-doc** — unify the five diagnostic surfaces in
  one doc surface (domain-docs / CONTEXT.md), zero or near-zero code.

### Phase D — discoverability

- [ ] **06-tui-command-grouping** — a listing/grouping mechanism for the
  68 slash commands (manifest-driven; check upstream 0.84.x skills.md for
  existing support FIRST).

## Decisions

- D1 (2026-08-29, user — grill): `/autocompact <token size>` request is
  ALREADY SATISFIED by #2144 (verified `src/autocompact.ts` — absolute
  threshold, per-session, power-tool). No ticket; recorded so the ask is
  not re-derived.
- D2 (2026-08-29, user — multi-select): effort scope = ALL audit slices
  (T1 compact, T3 naming, T4 discoverability, T2+T5 docs), form = effort
  folder.

## Frontier

**01-compact-collision** — it is the only behavioral risk (two compaction
semantics on one name can silently pick the wrong one for users), and its
outcome (how we name/namespace a colliding command) feeds 03's convention
decision.

## Fog of war

- `/compact` coexistence behavior under 0.84.4 (which wins in the TUI
  command registry? does either break?) — unmeasured.
- `research-pi-packages`: "pi" names the upstream Pi.dev ecosystem the
  skill researches — renaming may be semantically WRONG; needs its own
  mini-adjudication inside 02.
- Does pi 0.84.x already offer skill/command grouping in TUI (check
  pi-coding-agent docs/skills.md + tui command list before building 06)?
- Help-banner patch cost: `--help` text lives in the upstream binary;
  patching it adds a patch to maintain across bumps (0.84.2→0.84.4
  already churned internals once this week).

## Cross-effort links

- Shares-decision-with: `.planning/done/`-era skill-family boundaries
  (ADR-wayfind-0007 methodology consolidation) — 03's prefix convention
  must not contradict the "one methodology home" split.
- Builds-on: #2144 `/autocompact` (power-tool command face precedent).
