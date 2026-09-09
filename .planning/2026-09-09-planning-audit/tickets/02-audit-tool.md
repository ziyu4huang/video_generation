# t02 — the audit tool (census of record)

`bun-apps/s2-agent-ext-wayfind`:
- `src/effort-audit.ts` — pure classifier: walks `.planning/2026-*/`, reuses
  `parseMapFrontmatter`/`parseMapBody`, applies D3 vocabulary + D4 red
  conditions; `verifyPr` injected as a function so tests need no git.
- `scripts/effort-audit.ts` — CLI twin: Bun.spawnSync `git log --grep`
  implementation of verifyPr; `--json`, `--md`, `--stale-days N` (default 14),
  exit 1 on any red row; hardcoded dated live-exempt list (self-arc-17/18).
- `tests/effort-audit.test.ts` — fixture maps covering: all status tokens,
  missing status, unknown token, terminal-without-Shipped-as, bogus PR,
  unresolvable-citation, duplicate-arc info, live-exempt, stale-with-park-note
  vs stale-without.

Acceptance: `( cd bun-apps/s2-agent-ext-wayfind && bun run check && bun run
typecheck && bun test )` green.
