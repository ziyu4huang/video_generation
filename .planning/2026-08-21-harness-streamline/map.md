---
effort: 2026-08-21-harness-streamline
created: 2026-08-21
last: 2026-08-21
status: active
---

# Wayfinder map: 2026-08-21-harness-streamline

## Destination

wayfind + superpowers streamlined along four user-ratified axes — less duplication, simpler UX, better methodology, lower token cost — with ZERO public-interface breaks (`/grill`, `/wayfind`, `wayfind_effort`, skill names, env-knob semantics) and no package merging. Informed by upstream obra/superpowers v6.2.0 + 2026 harness-engineering research (progressive disclosure, Plan-Execute-Verify). The 2026-08-16 effort's ratified-but-unlanded tickets 07/08 execute HERE as phases W1–W4 / S1; everything else is this effort's own scope.

## Notes

- **User decisions (2026-08-21)**: bootstrap diet = trim-to-~900-tok (keep body injected, terse repo-owned sections + deferral pointers — NOT the ~120-tok lean pointer); D1 remove dead `__piPlanIncomplete`/`__piPlanSummary` seam fully (coordinated); D2 amend ticket 08 to KEEP + wire spec-document-reviewer-prompt.md; D3 deploy plumbing document-only this round; D4 land ratified verification-before-completion deletion (verify gate = host pipeline-gate.ts); D5 implement `!` reset sugar in PI_SUPERPOWERS_SKILL_EXCLUDE.
- **Verified baselines (2026-08-21)**: bootstrap ≈ 2,050 tok (ADR-0008 numbers: piToolMapping ~765 + piBoundaryOverrides ~502 + pinned body ~716 + intro ~62); wayfind src ≈ 3,785 LOC; superpowers src ≈ 405 LOC; loop status: 31 skills, max skill body 299 L (writing-skills, at bar).
- **Reviewer prompts exist but unwired**: `skills/brainstorming/spec-document-reviewer-prompt.md` + `skills/writing-plans/plan-document-reviewer-prompt.md` — methodology gap is wiring (ticket 03), not porting.
- **Constraints**: superpowers skill bodies byte-pinned (ADR-superpowers-0004) — pin stays intact, friction-reduced via divergence annotations only; wayfind `model.ts`/`markdown.ts` fs-free; globalThis seams contract-pinned (`bun-apps/tests/seam-contract.test.ts`); sole wayfind cross-package import = `@repo/s2-agent-core-interface`; ask-matt redirect until 0.2.0 bump; never re-port the 6 skills merged into superpowers (ADR-wayfind-0007).
- **Gates**: wayfind `check && typecheck && test` (all three); superpowers `check && test` + explicit `typecheck`; cross-cutting bun-apps seam/routing/skill-reference/adr-citation/lint-executor-coverage/extension-entry-typechecked + host static-extensions/registry-freshness/e2e.

## Decisions so far

(none closed yet — phases land as PRs; Resolutions appended per ticket.)

## Not yet specified

- Deploy-plumbing consolidation (5 duplication sites of `#pi/ext-dir` resolution) — documented-only per D3; a shared `resolveBundledAssetDir()` in core-interface is the future candidate if the docs age badly.
- Bootstrap body itself (~716 tok, byte-pinned upstream) — out of bounds without an upstream re-sync; only the two repo-owned sections diet.

## Out of scope

- Merging the two packages (user ruled incremental).
- Lean ~120-tok pointer-only bootstrap (rejected — behavior risk).
- Editing upstream-verbatim skill bodies (ADR-superpowers-0004).
- Re-advertising verification-before-completion (ratified deletion stands; ADR-0008 gets the rationale note).

## Cross-effort links

- Shares-decision-with: 2026-08-16-simplefied-redesign-make-less-code-to-archive — executes its ratified-but-unlanded tickets 07 (wayfind src trims = our W1–W4) and 08 (superpowers cuts = our S1, amended per D2 to keep spec-document-reviewer-prompt.md); its ticket-09 closeout audit covers both efforts' Δ numbers.
