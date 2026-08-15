import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  consecutiveIdenticalFailures,
  DEFAULT_RETRY_CIRCUIT_BREAK,
  failureClass,
  shouldCircuitBreak,
  taskSignature,
} from "../src/retry-loop-detector.js";
import type { SubagentRunRecord } from "../src/subagent-run-persistence.js";

/** Build a minimal record (only the fields the detector reads). */
function rec(opts: {
  task: string;
  status: SubagentRunRecord["status"];
  error?: string;
  startedAt: string;
}): SubagentRunRecord {
  return {
    id: "r",
    toolCallId: "c",
    task: opts.task,
    model: "m",
    cwd: "/r",
    status: opts.status,
    startedAt: opts.startedAt,
    elapsedMs: 1,
    output: "",
    ...(opts.error !== undefined ? { error: opts.error } : {}),
  } as SubagentRunRecord;
}

// NOTE: anchored to real Date.now() (not a hardcoded calendar date) because the
// implementation's cutoff is `Date.now() - windowMs` — a fixed past date would
// make every fixture record fall outside the window and flip 1/2 → 0.
const NOW = Date.now();
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const SIG = taskSignature("Fix the memory store bootstrap");
const FCLASS = failureClass({ status: "failed", error: "tool 'memory' not found" });

test("taskSignature: whitespace/case-insensitive canonical form (identical-intent tasks collapse)", () => {
  assert.equal(
    taskSignature("Fix the memory store bootstrap"),
    taskSignature("  fix   THE \n memory store\tbootstrap  "),
  );
  assert.notEqual(taskSignature("Fix the memory store"), taskSignature("Fix the memory store bootstrap"));
});

test("failureClass: status + bucketed error text; '' for non-failures (done is not a failure)", () => {
  assert.equal(failureClass({ status: "failed", error: "tool 'memory' not found" }), "failed:tool 'memory' not found");
  assert.equal(failureClass({ status: "failed", error: undefined }), "failed:");
  assert.equal(failureClass({ status: "timedout", error: "agent timed out" }), "timedout:agent timed out");
  assert.equal(failureClass({ status: "done" }), "");
  assert.equal(failureClass({ status: "aborted" }), "");
});

test("consecutiveIdenticalFailures: 0 / 1 / 2 matching (newest-first) → 0 / 1 / 2", () => {
  assert.equal(consecutiveIdenticalFailures([], SIG, FCLASS, 60_000), 0);
  assert.equal(
    consecutiveIdenticalFailures(
      [
        rec({
          task: "Fix the memory store bootstrap",
          status: "failed",
          error: "tool 'memory' not found",
          startedAt: iso(1_000),
        }),
      ],
      SIG,
      FCLASS,
      60_000,
    ),
    1,
  );
  assert.equal(
    consecutiveIdenticalFailures(
      [
        rec({
          task: "Fix the memory store bootstrap",
          status: "failed",
          error: "tool 'memory' not found",
          startedAt: iso(2_000),
        }),
        rec({
          task: "Fix the memory store bootstrap",
          status: "failed",
          error: "tool 'memory' not found",
          startedAt: iso(1_000),
        }),
      ],
      SIG,
      FCLASS,
      60_000,
    ),
    2,
  );
});

test("consecutiveIdenticalFailures: different failure class resets the streak", () => {
  // newest-first: [same-sig/class-X, same-sig/class-Y] → streak of class-X is 1.
  const records = [
    rec({
      task: "Fix the memory store bootstrap",
      status: "failed",
      error: "tool 'memory' not found",
      startedAt: iso(2_000),
    }),
    rec({
      task: "Fix the memory store bootstrap",
      status: "timedout",
      error: "agent timed out",
      startedAt: iso(1_000),
    }),
  ];
  assert.equal(consecutiveIdenticalFailures(records, SIG, FCLASS, 60_000), 1);
});

test("consecutiveIdenticalFailures: different task signature resets the streak", () => {
  const records = [
    rec({
      task: "Fix the memory store bootstrap",
      status: "failed",
      error: "tool 'memory' not found",
      startedAt: iso(2_000),
    }),
    rec({
      task: "Completely different task",
      status: "failed",
      error: "tool 'memory' not found",
      startedAt: iso(1_000),
    }),
  ];
  assert.equal(consecutiveIdenticalFailures(records, SIG, FCLASS, 60_000), 1);
});

test("consecutiveIdenticalFailures: records older than windowMs are not counted", () => {
  const records = [
    rec({
      task: "Fix the memory store bootstrap",
      status: "failed",
      error: "tool 'memory' not found",
      startedAt: iso(120_000),
    }), // 2min ago > 60s window
  ];
  assert.equal(consecutiveIdenticalFailures(records, SIG, FCLASS, 60_000), 0);
});

test("shouldCircuitBreak: count >= threshold (default 2)", () => {
  assert.equal(shouldCircuitBreak(0), false);
  assert.equal(shouldCircuitBreak(1), false);
  assert.equal(shouldCircuitBreak(2), true);
  assert.equal(shouldCircuitBreak(5), true);
  assert.equal(shouldCircuitBreak(2, 3), false); // explicit higher threshold
  assert.equal(DEFAULT_RETRY_CIRCUIT_BREAK, 2);
});

// The detector buckets by `status:<failure text>`. That text lives on the
// SubagentRunRecord, which renamed `stderr` → `error`. Reading the old key here
// is invisible to tsc (the parameter type makes it optional and structural), and
// the damage is silent: EVERY failure collapses into the single bucket
// "failed:", so two unrelated failures look like a repeat and the circuit
// breaker trips on a task that never actually looped.
test("failureClass reads the record's `error` field, so distinct failures stay in distinct buckets", () => {
  const a = failureClass({ status: "failed", error: "tool 'memory' not found" });
  const b = failureClass({ status: "failed", error: "connection reset" });
  assert.equal(a, "failed:tool 'memory' not found");
  assert.notEqual(a, b, "two different failures must not share a bucket");
});
