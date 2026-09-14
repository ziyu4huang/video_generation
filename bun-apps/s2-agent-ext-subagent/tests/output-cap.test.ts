import { test } from "bun:test";
import assert from "node:assert/strict";
import { CHILD_OUTPUT_CAP, capChildOutput, OUTPUT_CAP_MARKER } from "../src/output-cap.js";
import type { SubagentsToolDetails } from "../src/subagent-tool-schema.js";
import { renderBatchResult } from "../src/subagents-tool.js";

function bigOutput(units: number): string {
  return "x".repeat(units);
}

function batchWith(output: string): SubagentsToolDetails {
  return {
    results: [
      {
        status: "done" as const,
        output,
        id: "slot-a",
        elapsedMs: 10,
        taskPreview: "t",
      },
    ],
    elapsedMs: 10,
    skipped: [],
  } as unknown as SubagentsToolDetails;
}

test("capChildOutput: under cap passes through untouched", () => {
  const out = capChildOutput("hello");
  assert.equal(out.text, "hello");
  assert.equal(out.capped, false);
});

test("capChildOutput: exactly at the cap passes through untouched", () => {
  const out = capChildOutput(bigOutput(CHILD_OUTPUT_CAP));
  assert.equal(out.capped, false);
  assert.equal(out.text.length, CHILD_OUTPUT_CAP);
});

test("capChildOutput: over cap truncates to the cap and appends the marker", () => {
  const out = capChildOutput(bigOutput(CHILD_OUTPUT_CAP + 1));
  assert.equal(out.capped, true);
  assert.ok(out.text.startsWith(bigOutput(CHILD_OUTPUT_CAP)));
  assert.ok(out.text.endsWith(OUTPUT_CAP_MARKER));
  // Marker rides on its own line after the truncated body.
  assert.ok(out.text.slice(CHILD_OUTPUT_CAP).startsWith("\n["));
});

test("capChildOutput: marker names where the full output lives", () => {
  assert.match(OUTPUT_CAP_MARKER, /full output preserved in tool details and list_subagent_runs/);
});

test("renderBatchResult: under-cap slot renders byte-identical body (no marker)", () => {
  const small = batchWith("found 2 files\ndone");
  const rendered = renderBatchResult(small);
  assert.ok(rendered.includes("### [0] (slot-a) done\nfound 2 files\ndone"));
  assert.ok(!rendered.includes(OUTPUT_CAP_MARKER));
});

test("renderBatchResult: over-cap slot body is capped but details keep the full text", () => {
  const full = `${bigOutput(CHILD_OUTPUT_CAP + 5)}TAIL`;
  const details = batchWith(full);
  const rendered = renderBatchResult(details);
  assert.ok(rendered.includes(OUTPUT_CAP_MARKER));
  assert.ok(!rendered.includes("TAIL"));
  // The parent-visible body is exactly cap + marker (header aside).
  assert.ok(rendered.includes(bigOutput(CHILD_OUTPUT_CAP)));
  // Details slot retains the full output for UI expand / durable replay.
  assert.equal((details.results[0] as { output: string }).output, full);
});

test("renderBatchResult: failure/skipped slots are unaffected by the cap", () => {
  const details = {
    results: [null],
    elapsedMs: 5,
    skipped: [],
  } as unknown as SubagentsToolDetails;
  const rendered = renderBatchResult(details);
  assert.ok(rendered.includes("### [0] failed"));
  assert.ok(!rendered.includes(OUTPUT_CAP_MARKER));
});

test("renderBatchResult: empty output placeholder survives capping", () => {
  const details = batchWith("");
  const rendered = renderBatchResult(details);
  assert.ok(rendered.includes("_(empty output)_"));
});
