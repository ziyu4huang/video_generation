# Wayfinder map: 2026-07-26-phase2-pilot-writing-skills-restructure

## Destination

**Phase-2 pilot**: cut the on-demand load cost of `writing-skills` (the heaviest
superpowers skill, 679 lines) without losing methodology. Resolved via 4 grilling
rounds → **structural restructure** (not a content cut). Executed inline
(grilling-then-execute; fully-decided single-skill, no ticketed map needed).

## The 4 grilling decisions (each one-question-at-a-time, with recommendation)

1. **Value axis** = **on-demand / execution-context** (NOT per-request baseline).
   Fact: only `using-superpowers` is per-request-injected; the heavy `SKILL.md`
   load on-demand (when invoked). Phase-2 cuts "load-when-invoked" + execution
   context, not baseline. → Phase-2 is the right lever for this axis.
2. **Posture** = **accept fork, narrowly scoped**. Rewriting byte-pinned skills =
   forking by definition. Honest mechanism is NOT "rebaseline" (that script is
   upstream-re-sync only + would lie about provenance) — it's **remove the
   rewritten skill from the ADR-0004 `PORTED_SKILLS` pin set** (becomes an owned
   local fork, stops auto-tracking upstream). Supersede ADR-0004 to record it.
3. **Scope** = **pilot writing-skills first** (validate approach + fork-mechanism
   + ROI before scaling). Densities: writing-skills 679, SDD 503 (high ROI);
   TDD 320, debug 283 (moderate); brainstorming 151 (low ROI — skip).
4. **Shape** = **structural restructure** (lean core + `references/`), NOT a
   content cut. Research found writing-skills dense/interwoven (same profile as
   the already-audited anthropic-best-practices; easy fat harvested in `30773d5d`).
   Content-cut = modest/risky ROI. But the skill's OWN File Organization pattern
   ("heavy reference 100+ → separate file") authorized a structural split →
   **~54% core reduction with ZERO methodology loss** (content relocated).

## Outcome (executed + verified)

- **SKILL.md**: 679 → **313 lines** (common-case on-demand ~6.1k → ~2.8k tok, **−54%**).
- **`references/skill-discovery-optimization.md`** (167 lines): the full SDO
  section (description field, keywords, naming, token efficiency, cross-ref) +
  Discovery Workflow.
- **`references/skill-testing.md`** (222 lines): skill-type test approaches,
  rationalization table, Match-the-Form-to-the-Failure, bulletproofing toolkit,
  micro-test wording, full creation checklist.
- **3 inline cross-ref stubs** preserve each topic's KEY insight (description ≠
  workflow summary; match-form-to-failure; micro-test variance-as-metric) + point
  to the references.
- **Fork**: `writing-skills` removed from `PORTED_SKILLS` (14 → 13); baseline
  fixture deleted; ADR-0004 partial-supersession note added. Other 13 skills stay
  pinned + faithful to upstream.
- **Verify**: 127 tests pass (fidelity now checks 13; CSO rules pass on the new
  SKILL.md; bootstrap/skill-exclude/sdd pass). biome clean on changed files
  (4 pre-existing infos in untouched `binary-mode.test.ts`). All cross-refs resolve.

## False premise surfaced (and corrected)

- **"Phase-2 cuts per-request tokens."** Wrong axis (the option's own framing was
  imprecise). Heavy SKILL.md are on-demand, not per-request. Corrected to
  on-demand/execution-context before execution — this is what made the structural
  restructure (relocate, don't cut) the obviously-right shape.
- **"Rewriting a pinned skill = rebaseline."** The rebaseline script is upstream
  re-sync only; using it for an intentional local edit would falsify `UPSTREAM.ref`
  provenance. Correct mechanism = remove from pin set + supersede ADR.

## Footguns for whoever extends Phase-2 to other skills

- **Don't reach for content cuts first.** These skills are dense/interwoven
  (audited twice now). Check for a structural split (core + `references/`) first —
  it's higher-ROI + zero methodology loss, and uses the skill's own pattern.
- **The fork is permanent + per-skill.** Each rewritten skill leaves the pin set
  individually; the remaining pinned skills still enforce byte-equality. Don't
  fork-all-then-rebuild — keep the pin set maximal.
- **Preserve the key insight inline.** When relocating a section to `references/`,
  leave a stub that carries the one-sentence essence (so the lean core still
  teaches the principle; the reference carries the depth).
- **brainstorming (151) is not worth a Phase-2 pass** — already lean.

## Out of scope (follow-up candidates)

- **Extend Phase-2 to SDD (503) / TDD (320) / systematic-debugging (283)** —
  **RESEARCHED 2026-07-26; lever does NOT transfer.** These are process/workflow
  skills whose bulk IS the core methodology (SDD's Task Loop ~197 lines; TDD's
  Red-Green-Refactor ~150 lines; debug's Four Phases ~169 lines) — NOT separable
  heavy reference like writing-skills' SDO/checklist. All three have ALREADY
  delegated their separable content (SDD: 3 prompt templates + `scripts/`; TDD:
  `testing-anti-patterns.md`; debug: 7 files incl. `root-cause-tracing.md` /
  `condition-based-waiting.md` / `defense-in-depth.md`). They are already
  optimally split. Forcing the shape = methodology degradation, or ~11% low-ROI
  (worked-example relocation only). **P2 structural-restructure lever is
  EXHAUSTED — writing-skills was the unique clean win.** Do not re-attempt without
  a genuinely new lever (e.g. a new heavy-reference section growing inline).
- **Content-cut variant** — only if a skill is genuinely padded (none found so
  far; all candidates audited as dense/interwoven).
