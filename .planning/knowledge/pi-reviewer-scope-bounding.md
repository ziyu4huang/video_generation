# Skill candidate: pi-reviewer-scope-bounding

**Candidate skill-name:** efficient-pi-review-dispatch

**Trigger/symptom:** A pi review subagent (task-reviewer / final code-reviewer) times out (exit 124, 15-min wall-clock) on an open-ended "review the whole feature" prompt — especially when pointed at a large package diff (e.g. ~4k lines incl. .planning audit trail) and told to read reference files + all tests.

**Lesson:** The timeout is caused by the OPEN-ENDED framing + over-reading, NOT by single-reviewer being inherently unfeasible. A/B-tested during the batch-tui final review (PR #1289): two open-ended reviewers (big tier, then medium) BOTH timed out; then a SINGLE bounded medium reviewer (code-only diff, 6 enumerated checks, "<=2 greps each, don't read whole files") completed efficiently and self-reported "a fan-out would have been overhead." The fix is BOUNDING, not fan-out. Fan-out (subagents plural) remains useful for parallelism or when no single bounded framing fits, but is unnecessary overhead for a moderate (~600-line) code diff.

**Proposed procedure:** For a pi final/holistic review: (1) scope the diff to CODE-ONLY (exclude .planning audit trail); (2) give an ENUMERATED list of specific checks, not "review the feature"; (3) add an explicit efficiency nudge ("<=2 greps/reads per check, don't read whole files, don't re-derive"); (4) prefer a single bounded medium reviewer; only fan out (subagents plural) if the bounded single pass times out OR you genuinely want parallel concern-coverage. Bump tier to big only if the diff is large or the checks need deep reasoning.

**Evidence:** batch-tui SDD final review (PR #1289, effort 2026-08-10-improve-subagents-batch-tui): 2 open-ended timeouts -> 1 bounded single-pass success (all 6 checks PASS). The over-claim "always fan out" was caught by this A/B BEFORE being memorialized.
