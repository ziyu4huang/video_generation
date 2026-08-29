# 06 — TUI command grouping

blocking: none (but do LAST: benefits from 02/03 renames landing first)

## What

68 slash commands with no grouping signal. Check upstream 0.84.x for existing
grouping support first (pi-coding-agent docs/skills.md, TUI command
registry). If none: manifest-driven listing fed by registry-config.ts
(derived, freshness-gated — never a hand list).

## Receipt (2026-08-30)

**Upstream check: NOT FOUND.** pi-coding-agent 0.84.4 ships no palette/command
grouping — `docs/skills.md` knows "grouping" only as nested skill FOLDER
discovery (filesystem layout, not palette navigation); `docs/tui.md`'s
"groups" are TUI layout components; CHANGELOG has no grouping feature. The
palette builds FLAT (`interactive-mode.js:531`:
`[...slashCommands, ...templateCommands, ...extensionCommands,
...skillCommandList]`), and the autocomplete source tag is scope/provenance
(`t/p/u`, `npm:…`, `git:…` — `getAutocompleteSourceTag`), not family.

**Skill-count reconciliation** (resolves the audit's "68"): the repo tree
ships **64** skill dirs with SKILL.md; the LIVE registry-loaded surface is
**56** across 13 families — the hyperframes family (8 skills) is `enabled:
false` in the registry (disabled VALUES, not deletions — registry D2). The
audit's 68 over-counted (pre-rename landscape + counting mode); 64/56 are
the measured numbers of record.

**Implemented (D8): `s2-agent ext list --skills`** — one offline command
answering "what can I invoke + which family": grouped inventory derived
from the SAME registry rows `devExtListResult` reads (never a hand list;
manifest freshness stays guarded by the existing manifest-consistency test)
+ the skills/ dir contents (name = dir, enforced by
`bun-apps/tests/skill-frontmatter.test.ts`). Text (default) or `--json`.
Extension slash-COMMANDS deliberately stay with `ext doctor` — deriving
them requires evaluating extension code, exactly what this offline
diagnostic refuses to do. NO palette patch (upstream has no grouping seam;
a patches-seam autocomplete patch would churn every bump for a surface the
D5 flat convention already keeps navigable).

Code: `src/ext-list.ts` (`devSkillInventory` + `formatSkillInventory` +
`formatDevSkillInventory`), intercept in `src/cli.ts` (`ext list --skills`),
unit tests in `src/ext-list.test.ts` (pure projection: registry order,
unresolved-dir empty, empty-dir omission, header counts).

## Done when

- [x] Upstream-support check recorded (found / not found + source)
- [x] One command answers "what can I invoke + which family"
- [x] Data source derived from registry/manifest, gated by freshness test
