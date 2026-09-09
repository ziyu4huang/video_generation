# Ticket 04 — declared-imports audit: clean baseline + flip to enforcing

## Goal

Clean the 4 findings of `scripts/check-declared-imports.mjs` (warn-only v1,
issue #1645), fix its two false-positive classes, and flip it to exit 1 on
findings — born green.

## Findings (measured 2026-09-09)

1. REAL — `bun-apps/s2-agent-ext-devops/src/deploy/lib/ext-build.test.ts`
   imports `fast-xml-parser`, not declared in devops package.json. Fix:
   declare in devDependencies (`^5.2.0` — same range research-tool uses; it
   is already in the store). Do NOT run `bun install` — the lead runs it
   once after all tickets; note the edge in your report.
2. FALSE POSITIVE — `}from"spec"` and `}from"x"`: minified-re-export test
   fixtures inside string literals in ext-build.test.ts (look near the
   `still resolves minified re-export` test) match the audit's import
   regex. Fix audit-side, NOT a blanket `.test.ts` skip (test-file imports
   must stay audited — that is finding 1's class). Choose: a per-(file,
   specifier) allowance list with a required comment, or smarter
   string-literal awareness. Keep it simple and documented.
3. FALSE POSITIVE — `s2-agent-ext-subagent/src/presets.ts:68` comment text
   `Renamed from "glm-lmstudio" …` matches `from "glm-lmstudio"`. Fix: port
   dep-guard's comment-line skip (trimmed lines starting with `*`, `//`,
   `/*`) — that lesson is already encoded in `bun-apps/tests/dep-guard.test.ts`
   (`importedRepos`), copy its approach.

## Constraints

- After your change the audit prints ZERO findings on today's tree.
- Keep the CLI contract: same output style; `WARN-ONLY` wording replaced by
  enforcing wording; exit 0 clean / 1 findings / 2 usage. Update the header
  comment (issue #1645 resolved-by note).
- Check who calls the audit (grep `check-declared-imports` across bun-apps,
  .github, package.json scripts) and confirm nothing depends on exit-0
  semantics that would now break; the regression-gates entry
  "Declared-imports audit (warn-only v1)" in ci.yml.disabled may need its
  label/note updated.
- NO git mutations. NO `bun install`.

## Steps

1. Read the audit + the three finding sites (above).
2. Apply fixes; add the allowance mechanism if you chose one.
3. `bun /Users/huangziyu/proj/video_generation__movie/scripts/check-declared-imports.mjs`
   → zero findings, exit 0; then scratch-inject a bad import into a random
   package, confirm exit 1, revert.
4. Update the ci.yml.disabled gate label if it names "warn-only".

## Acceptance

- Audit exits 0 clean / 1 on injected violation (show both in your report).
- Comment false-positive class dead (presets.ts passes without allowance).
- Report: mechanism chosen for string-artifact fixtures, files changed.
