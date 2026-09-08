# t03 — Fix real small reds in-arc; record improvement room; ship via devops chain

Status: open · Phase 3 · Needs: t02 · Blocks: t04

## Goal

Every real-red from t02's table is either fixed in-arc (small) or recorded as
named successor material (nothing silently dropped); gates green on all touched
packages; ONE implementation PR merged through the devops chain with
redeploy + qualify sweep iff src/ changed.

## Scope & triage rules

- **Fix in-arc**: small, mechanical, single-package (or cross-package-but-one-
  line) items. Expected members: the two dormant one-liners the audit WILL
  surface (esc-settle-detector biome warning; `.distill-state.json.tmp`
  gitignore line — absorbed per the map's cross-links) + whatever real reds
  t02 reproduces in recently-merged archify/file2md.
- **Record as successor**: anything structural, risky, or needing its own
  design — including #2179 (stays dormant successor material). Record as
  tickets (issue-tracker `gh` issue or `.planning` successor note — pick one
  home per item, cite from this ticket's Resolution).
- **Improvement room**: synthesizer's `improvementRoom` notes triaged the same
  way — a note without a home is a dropped finding.

## Steps

1. Re-run D8 pre-flight (symlink health) before touching anything — don't fix
   a fake red.
2. Fix each in-arc item; per touched package run its FULL canonical gate set
   (`bun run check` + typecheck variant + `bun test` — per CLAUDE.md, never a
   hand-assembled subset); add a regression test where the fix is behavioral
   (hard-problem method: fix with a regression test).
3. Docs/artifacts: map + tickets updated same PR; `.planning/` committed per
   standing rule.
4. Devops chain: `prepare-feature-branch` → gates per touched package → ONE
   implementation PR → `merge-pr-after-ci` → `verify-merge` (full scope list)
   → `sync-default-branch` → **redeploy IF any src/ file changed** (ext bundle
   rebuilds from all ext packages) → `qualify.ts` deployed sweep when launcher
   code changed. samples/tests/docs-only ⇒ NO redeploy (D5).
5. Version bump if the merge tool nudges (`version-bump-cli.ts --package
   s2-agent --patch` when s2-agent src changed).

## Acceptance

- All touched packages' gates green; classification table from t02 fully
  dispositioned (fixed / ticketed / successor-named — counts reconcile).
- PR merged + verified; redeploy+sweep ran iff src changed (state which branch
  of the iff fired and why).

## Evidence

PR link; per-package gate outputs; successor ticket links; deploy receipt or
the explicit no-src-change statement.
