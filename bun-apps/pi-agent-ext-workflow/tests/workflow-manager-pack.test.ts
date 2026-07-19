import { test } from "bun:test";
import assert from "node:assert/strict";
import { runWorkflow } from "../src/workflow.js";

/** A mock agent that returns a canned string without any provider call. */
const mockAgent = {
  async run(_prompt: string) {
    return "mocked";
  },
};

test("onAgentJournal entries carry the assigned phase (T4)", async () => {
  const seen: Array<{ index: number; phase?: string }> = [];
  await runWorkflow(
    `export const meta = { name: 't4', description: 'phase emit', phases: [{ title: 'research' }] }
     phase('research')
     await agent('do research')
     return {}`,
    {
      agent: mockAgent,
      onAgentJournal: (e) => seen.push({ index: e.index, phase: e.phase }),
    },
  );
  assert.equal(seen.length, 1);
  assert.equal(seen[0].phase, "research");
});
