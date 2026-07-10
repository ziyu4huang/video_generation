/**
 * Regression guards for the pi-agent-ext-workflow root-cause analysis (RCA).
 *
 * Each test pins the CORRECT behavior of a defect found in the RCA pass, so the
 * bug cannot silently return. Tests are grouped by RCA finding number:
 *   - Green guards (#1, #4, #5): the defect is fixed; the test asserts the fix
 *     and will fail if the fix is reverted.
 *   - .todo targets (#3, #6, #7, #8, #10, #11): the defect needs a design
 *     decision; the expected correct behavior is documented as a pending test so
 *     it is a visible regression target, not a silent gap.
 */

import { describe, it, test } from "bun:test";
import assert from "node:assert/strict";
import { WorkflowErrorCode, wrapError } from "../src/errors.js";
import type { JournalEntry } from "../src/workflow.js";
import { runWorkflow } from "../src/workflow.js";

// ─── RCA #1 — classifyProviderLimit must not match benign billing/quota text ─
//
// A tool error whose message merely MENTIONS quota/billing (an agent analyzing
// a billing document, summarizing a quota report, etc.) used to be matched by the
// bare `\bbilling\b` / `\bquota\b` alternatives and misclassified as a
// non-recoverable PROVIDER_USAGE_LIMIT — which halts + checkpoints the whole run.
// The regex was narrowed to specific provider phrases; these guards prevent the
// broad bare-word alternatives from coming back.
describe("RCA#1 classifyProviderLimit — benign billing/quota text stays recoverable", () => {
  for (const msg of [
    "TypeError: cannot read 'amount' of billing row",
    "failed to summarize the customer's billing statement",
    "the quota allocation report rendered with no rows",
    "invalid billing address for customer 42",
  ]) {
    it(`does not pause the run for: ${msg}`, () => {
      const e = wrapError(new Error(msg));
      assert.equal(e.code, WorkflowErrorCode.AGENT_EXECUTION_ERROR, "must stay a normal recoverable error");
      assert.equal(e.recoverable, true);
      assert.notEqual(e.code, WorkflowErrorCode.PROVIDER_USAGE_LIMIT);
    });
  }

  // The real provider wordings MUST still match (guard against over-narrowing).
  it("still matches genuine provider usage/rate-limit wordings", () => {
    for (const msg of [
      "Codex usage limit reached. Resets in ~3h.",
      "You exceeded your current quota, please check your plan and billing details.",
      "Error 429: too many requests",
      "rate limit exceeded",
      "GoUsageLimitError",
    ]) {
      const e = wrapError(new Error(msg));
      assert.equal(e.code, WorkflowErrorCode.PROVIDER_USAGE_LIMIT, `should still match: ${msg}`);
      assert.equal(e.recoverable, false);
    }
  });
});

// ─── RCA #5 — resume hash must include isolation ─────────────────────────────
//
// toggling `isolation: "worktree"` changes which filesystem the agent runs in.
// The resume journal hash previously omitted isolation, so resuming after the
// toggle replayed the stale result from the non-isolated run. The hash now
// includes isolation; this guard ensures a toggle invalidates the cache entry.
describe("RCA#5 resume hash includes isolation", () => {
  test("toggling isolation: 'worktree' changes the journal hash", async () => {
    const script = (isoLit: string) => `export const meta = { name: 'iso_hash', description: 'iso' }
const r = await agent('summarize the repo', { label: 'a', isolation: ${isoLit} })
return r`;

    async function hashFor(isoLit: string): Promise<string> {
      const journal: JournalEntry[] = [];
      await runWorkflow(script(isoLit), {
        agent: {
          async run() {
            return "x";
          },
        },
        persistLogs: false,
        onAgentJournal: (e) => journal.push(e),
      });
      assert.equal(journal.length, 1, "one agent call → one journal entry");
      return journal[0].hash;
    }

    const hNone = await hashFor("undefined");
    const hWorktree = await hashFor("'worktree'");
    assert.notEqual(
      hNone,
      hWorktree,
      "isolation must be part of the resume hash so the cache is invalidated on toggle",
    );
  });
});

// ─── RCA #4 — verify() must surface all-reviewer failure ─────────────────────
//
// When every reviewer fails (recoverable error → null → filtered out), verify()
// previously returned { real: false, total: 0 } — a caller checking `!real`
// would treat a claim as "refuted" when it was merely "could not verify". The
// return now carries `requested` (asked-for reviewer count) and `failed` (count
// that returned no verdict) so the silent-verdict path is observable.
describe("RCA#4 verify() surfaces all-reviewer failure", () => {
  test("every reviewer failing → failed === requested, observable", async () => {
    const result = await runWorkflow(
      `export const meta = { name: 'verify_all_fail', description: 'verify all fail' }
const v = await verify('the earth is flat', { reviewers: 3 })
return v`,
      {
        // Every reviewer call throws a recoverable error → agent() returns null.
        agent: {
          async run() {
            throw new Error("transient network error");
          },
        },
        agentRetries: 0,
        persistLogs: false,
      },
    );
    const v = result.result as { real: boolean; total: number; requested: number; failed: number };

    assert.equal(v.requested, 3, "verify must report how many reviewers were requested");
    assert.equal(v.failed, 3, "all 3 reviewers failed — must be observable, not silent");
    assert.equal(v.total, 0, "no verdicts survived");
    // A caller can now distinguish "could not verify" (failed === requested) from
    // "verified false" (failed < requested && real === false). Previously it could not.
    assert.ok(v.failed === v.requested, "all-failed must be detectable via failed === requested");
  });
});

// ─── RCA design-level findings — pending regression targets (.todo) ──────────
//
// These defects need a design decision (return-contract change, cancellation
// semantics, or a validation policy). They are recorded here as pending tests
// describing the CORRECT behavior, so they are explicit regression targets
// rather than silent gaps. Implement the fix, then promote each to a real test.
describe("RCA design-level findings (regression targets — not yet fixed)", () => {
  // RCA#3: phase() mutates the shared global `state.currentPhase`. A parallel
  // thunk that calls phase('B') runs its synchronous prefix before a sibling
  // thunk reads currentPhase, so the sibling is assigned 'B' too — wrong phase
  // grouping AND wrong phase-routed model. The guideline tells authors to use
  // opts.phase per agent (an admission of the hazard); an engine-level guard is
  // the real fix.
  it.todo("RCA#3: phase() inside a parallel thunk must not pollute sibling phases");

  // RCA#6: resolveAgentModelSpec({ tier: "lage" |typos| unknown }) silently falls
  // back to mainModel (often the most expensive model) with no warning, despite
  // the guideline claiming opts.tier is "enforced at runtime". Correct: an
  // unknown/misspelled tier must warn (or reject), not silently escalate cost.
  it.todo("RCA#6: resolveAgentModelSpec must warn on unknown/misspelled tier");

  // RCA#7: judgePanel scores a candidate whose judges ALL failed as 0 —
  // indistinguishable from a genuine zero score — and may rank it below worse
  // candidates. Correct: a failed-judging candidate must be observable as
  // unscored, not coerced to 0.
  it.todo("RCA#7: judgePanel must not coerce all-judges-failed to score 0");

  // RCA#8: loopUntilDry catches TOKEN_BUDGET_EXHAUSTED / AGENT_LIMIT_EXCEEDED
  // and returns the partial array as if the loop completed dry. Correct: the
  // return must distinguish "dry" from "truncated by budget/limit" so a caller
  // does not ship an incomplete result as complete.
  it.todo("RCA#8: loopUntilDry must signal budget/limit truncation, not return partial as complete");

  // RCA#10: withTimeout races the agent promise with a timer but does not cancel
  // the underlying session, which keeps consuming provider tokens never recorded
  // in shared.spent (amplified by agentRetries). Correct: a timed-out agent must
  // not leave an orphaned session burning uncounted tokens.
  it.todo("RCA#10: withTimeout must not orphan the agent session with uncounted tokens");

  // RCA#11: checkpoint() awaits options.confirm() with no abort signal; an abort
  // during a pending checkpoint orphans the run promise in-memory (throwIfAborted
  // only runs after confirm resolves). Correct: checkpoint must thread the abort
  // signal into confirm().
  it.todo("RCA#11: checkpoint() must thread the abort signal into confirm()");
});
