---
effort: 2026-08-29-slash-surface-consistency
created: 2026-08-29
last: 2026-08-30 (t01–t04 done)
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
- **`/compact` collision — RESOLVED as false premise (ticket 01,
  2026-08-29)**: `registry-config.ts:590` registers the extension LOAD KEY,
  not a slash command; s2-agent-ext-compact registers no command at all (it
  rides `session_before_compact`). The pi builtin `/compact` is the only
  `/compact`; TUI `onSubmit` intercepts it before extension dispatch
  (`interactive-mode.js:2481`), and CC-style semantics survived 0.84.3/4
  routing via the hook (`agent-session.js:1490` manual, `:1751` auto).
  Receipt + decision in `tickets/01-compact-collision.md`; pinned by
  `s2-agent-ext-compact/extensions/__tests__/no-command-collision.test.ts`.
- **Help banner — RESOLVED (ticket 04, D6, 2026-08-30)**: source face
  `./s2-agent.sh --help` prints `pi - AI coding assistant …` + `pi
  install/remove/update/...` (upstream CLI in dev mode); the DEPLOYED face
  already prints `s2-agent - …` via the upstream `piConfig.name` seam
  (measured on dist 0.8.0). Document-only; no patch.
- **`pi-` naming residue — RESOLVED (ticket 02, 2026-08-29)**:
  `pi-memory-bulk-dedup` → `memory-bulk-dedup` (renamed, 9 sites); the
  `grill-memory` claim was STALE (no "pi" text exists); `research-pi-packages`
  KEPT (D4 — names the upstream Pi.dev ecosystem it researches).
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

- [x] **01-compact-collision** — DONE (2026-08-29): no collision exists
  (extension is a hook rider, not a command); no rename; pinned by
  `no-command-collision.test.ts`. See D3 + ticket receipt.

### Phase B — naming (choice, depends on 01's convention outcome only loosely)

- [x] **02-pi-residue-rename** — DONE (2026-08-29): `memory-bulk-dedup`
  renamed (9 sites, golden re-pinned); grill-memory claim was STALE (no "pi"
  text exists); `research-pi-packages` KEPT (D4 — names the upstream Pi.dev
  ecosystem it researches).
- [x] **03-family-prefix-convention** — DONE (2026-08-29): D5 = FLAT by
  default, prefix only on collision/ambiguity/vendored; written into
  extension-naming SKILL.md; devops stragglers explicitly exempt; uniqueness
  lint added to `bun-apps/tests/skill-frontmatter.test.ts`.

### Phase C — docs face

- [x] **04-help-banner-adjudication** — DONE (2026-08-30): D6 =
  document-only. Deployed face ALREADY says `s2-agent` (upstream
  `piConfig.name` seam, measured on dist 0.8.0); source face's `pi` banner
  is upstream's own CLI in dev mode — patch refused (churn > dev-only
  value). Receipt in ticket.
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
- D3 (2026-08-29, ticket 01 measurement): `/compact` needs NO rename — the
  audit's "collision" conflated the extension load key
  (`registry-config.ts:590`) with a command registration. s2-agent-ext-compact
  deliberately registers NO slash command; it rides `session_before_compact`
  so the pi builtin `/compact` (and auto-compaction) both flow through the
  CC-style summarizer with built-in fallback. Precedent for 03: when an
  extension wants to EXTEND a builtin rather than replace it, the hook seam
  is the correct surface — a same-named command could never win in the TUI
  anyway (`onSubmit` intercepts builtins before extension dispatch).
- D4 (2026-08-29, ticket 02): `research-pi-packages` KEPT — its "pi" names
  the upstream Pi.dev / Pi Coding Agent ecosystem the skill researches
  (`pi.dev/packages`), so it is semantically correct, not rename residue.
  Corollary for 03/04: "pi" is residue only where it names OUR agent (the
  rename), never where it names the upstream ecosystem or factual paths
  (`PI_CODING_AGENT_DIR`, `~/.pi/agent`, `pi-hermes-memory/` store dir —
  unchanged by design). Also: the audit's grill-memory claim ("description
  says 'pi memory'") was STALE — zero "pi" strings in that SKILL.md.
- D5 (2026-08-29, ticket 03): skill names are **FLAT by default**; a family
  prefix only on collision / palette ambiguity / vendored upstream names.
  Measured: 62 skills, hyperframes 7/8 (vendored), devops 1/10, superpowers
  0/16, wayfind 0/16 — flat already de-facto; all-prefixed = ~50 renames
  incl. two upstream families for zero gain. `devops-workflow` keeps its
  prefix (bare `workflow` is palette-ambiguous); the devops nine are
  conformant-unprefixed. Guard: cross-package skill-name uniqueness test in
  `bun-apps/tests/skill-frontmatter.test.ts` (skills have no suffixing or
  dispatch patch — a collision is a silent shadow, unlike commands in D3).
- D6 (2026-08-30, ticket 04): help-banner = DOCUMENT-ONLY, no patch. The
  deployed face already introduces the agent as `s2-agent` via the upstream
  `piConfig.name` seam (`bun-apps/s2-agent/package.json`; measured on dist
  `0.8.0+gb894dc9`), and every residual "pi" string on that face is a D4
  non-residue class (upstream binary name in `update self|pi`, factual
  `~/.pi/agent` path, `pi.dev` ecosystem URL). The source face's `pi`
  banner is upstream's own CLI in dev mode — patching it through the patches
  seam would churn every bump for a dev-only surface. Documented in
  extension-naming SKILL.md alongside the `S2-AGENT_CODING_AGENT_DIR` dash
  consequence.

## Frontier

**05-doctor-family-doc** — 01–04 closed the behavioral, naming, and
help-face slices; 05 unifies the five diagnostic surfaces in one doc
surface (domain-docs / CONTEXT.md), zero or near-zero code.

## Fog of war

- ~~`/compact` coexistence behavior under 0.84.4~~ RESOLVED (ticket 01
  receipt): no collision; extension is a hook rider; CC-style semantics
  intact via `session_before_compact`.
- ~~`research-pi-packages` may be semantically correct~~ RESOLVED (D4):
  KEEP — names the upstream Pi.dev ecosystem it researches.
- ~~Help-banner patch cost across bumps~~ RESOLVED (D6): no patch — the
  deployed face renames via the upstream `piConfig.name` seam; the source
  face is upstream's own dev-mode CLI name.
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
