/**
 * spawn-steer-depth — self-arc-19 t02 + t03 offline contracts:
 *
 *  t02 — the `steer` verb on list_subagent_runs: delivers mid-run guidance
 *  through the in-flight registry's per-run steer lever (named dispatches
 *  only — unnamed runs honestly report not-steerable), with the same
 *  non-error posture as wait/stop for unknown/terminal ids.
 *
 *  t03 — the spawn-depth ambient scope (default cap 2, per-def `maxDepth`
 *  frontmatter override, 0 = leaf) and the def frontmatter round-trip.
 */
import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  type SubagentRunPersistence,
  type SubagentRunRecord,
  SubagentInFlightRegistry,
  currentSpawnScope,
  parseAgentDefinition,
  runWithSpawnDepth,
  serializeAgentDefinition,
  spawnDepthExceeded,
} from "@repo/s2-agent-core-runtime";
import { createSubagentRunsTool } from "../src/subagent-runs-tool.js";

const NO_SIGNAL = undefined as unknown as AbortSignal;

function fakePersistence(records: SubagentRunRecord[] = []): SubagentRunPersistence {
  return {
    save: () => {},
    list: () => [...records],
    load: (id) => records.find((r) => r.id === id) ?? null,
    delete: () => false,
    getRunsDir: () => "/tmp/fake",
  };
}

function textOf(res: { content: Array<{ type: string; text?: string }> }): string {
  return (res.content[0] as { text: string }).text ?? "";
}

// ── t02: steer verb ──────────────────────────────────────────────────────────

test("steer delivers into a live steerable run (steered:true)", async () => {
  const registry = new SubagentInFlightRegistry();
  const seen: string[] = [];
  registry.start({
    id: "bg1",
    taskPreview: "long research",
    startedAt: Date.now(),
    steer: (text) => {
      seen.push(text);
      return Promise.resolve({ steered: true });
    },
  });
  const tool = createSubagentRunsTool({ persistence: fakePersistence(), inFlight: registry });
  const res = await tool.execute("tc", { action: "steer", id: "bg1", message: "focus on the rate-limit doc" }, NO_SIGNAL, undefined, undefined);
  assert.equal(seen.length, 1);
  assert.equal(seen[0], "focus on the rate-limit doc");
  assert.match(textOf(res), /steered into run bg1/);
});

test("steer on a just-idle run runs a fresh turn and returns the reply", async () => {
  const registry = new SubagentInFlightRegistry();
  registry.start({
    id: "bg2",
    taskPreview: "long research",
    startedAt: Date.now(),
    steer: () => Promise.resolve({ steered: false, output: "OK, pivoted to the auth flow." }),
  });
  const tool = createSubagentRunsTool({ persistence: fakePersistence(), inFlight: registry });
  const res = await tool.execute("tc", { action: "steer", id: "bg2", message: "pivot" }, NO_SIGNAL, undefined, undefined);
  assert.match(textOf(res), /fresh turn/);
  assert.match(textOf(res), /pivoted to the auth flow/);
});

test("steer unknown id → actionable non-error (mirror wait/stop posture)", async () => {
  const registry = new SubagentInFlightRegistry();
  const tool = createSubagentRunsTool({ persistence: fakePersistence(), inFlight: registry });
  const res = await tool.execute("tc", { action: "steer", id: "nope", message: "x" }, NO_SIGNAL, undefined, undefined);
  assert.match(textOf(res), /unknown run "nope"/);
});

test("steer terminal run → nothing to steer (non-error)", async () => {
  const registry = new SubagentInFlightRegistry();
  registry.start({ id: "bg3", taskPreview: "t", startedAt: Date.now() });
  registry.markCompleted("bg3");
  const tool = createSubagentRunsTool({ persistence: fakePersistence(), inFlight: registry });
  const res = await tool.execute("tc", { action: "steer", id: "bg3", message: "x" }, NO_SIGNAL, undefined, undefined);
  assert.match(textOf(res), /already finished \(done\)/);
});

test("steer live run WITHOUT a lever → honestly not steerable (names the knob)", async () => {
  const registry = new SubagentInFlightRegistry();
  registry.start({ id: "bg4", taskPreview: "t", startedAt: Date.now() });
  const tool = createSubagentRunsTool({ persistence: fakePersistence(), inFlight: registry });
  const res = await tool.execute("tc", { action: "steer", id: "bg4", message: "x" }, NO_SIGNAL, undefined, undefined);
  assert.match(textOf(res), /not steerable/);
  assert.match(textOf(res), /send_message|name/);
});

test("steer requires a non-empty message", async () => {
  const registry = new SubagentInFlightRegistry();
  const tool = createSubagentRunsTool({ persistence: fakePersistence(), inFlight: registry });
  await assert.rejects(() => tool.execute("tc", { action: "steer", id: "x" }, NO_SIGNAL, undefined, undefined));
  await assert.rejects(() => tool.execute("tc", { action: "steer", id: "x", message: "   " }, NO_SIGNAL, undefined, undefined));
});

// ── t03: spawn-depth scope ───────────────────────────────────────────────────

test("root scope: depth 0, default cap 2, not exceeded", () => {
  assert.deepEqual(currentSpawnScope(), { depth: 0, maxDepth: 2 });
  assert.equal(spawnDepthExceeded(), false);
});

test("depth increments per nesting level; cap inherits unless overridden", () => {
  runWithSpawnDepth(() => {
    assert.deepEqual(currentSpawnScope(), { depth: 1, maxDepth: 2 });
    assert.equal(spawnDepthExceeded(), false);
    runWithSpawnDepth(() => {
      assert.deepEqual(currentSpawnScope(), { depth: 2, maxDepth: 2 });
      assert.equal(spawnDepthExceeded(), true); // a spawn HERE would be depth 3 > 2
    });
  });
  // scope does not leak after the callback
  assert.equal(spawnDepthExceeded(), false);
});

test("a def's maxDepth becomes its subtree's cap (0 = leaf)", () => {
  runWithSpawnDepth(
    () => {
      assert.deepEqual(currentSpawnScope(), { depth: 1, maxDepth: 0 });
      assert.equal(spawnDepthExceeded(), true); // this def may not spawn children
    },
    { maxDepth: 0 },
  );
  runWithSpawnDepth(
    () => {
      runWithSpawnDepth(() => {
        assert.equal(spawnDepthExceeded(), false); // depth 2, cap 4 — still allowed
        runWithSpawnDepth(() => {
          assert.equal(spawnDepthExceeded(), false); // depth 3, cap 4
          runWithSpawnDepth(() => {
            assert.equal(spawnDepthExceeded(), true); // depth 4, cap 4
          });
        });
      });
    },
    { maxDepth: 4 },
  );
});

test("maxDepth frontmatter: parse + serialize round-trip; junk rejected", () => {
  const def = parseAgentDefinition(
    "---\nname: coordinator\ndescription: fan-out\nmaxDepth: 3\n---\nBody.",
    "coordinator.md",
    "project",
  );
  assert.equal(def?.maxDepth, 3);
  const leaf = parseAgentDefinition("---\nname: leaf\nmaxDepth: 0\n---\nBody.", "leaf.md", "project");
  assert.equal(leaf?.maxDepth, 0);
  const junk = parseAgentDefinition("---\nname: junk\nmaxDepth: many\n---\nBody.", "junk.md", "project");
  assert.equal(junk?.maxDepth, undefined);
  const roundTrip = serializeAgentDefinition({ name: "coordinator", prompt: "Body.", maxDepth: 3 });
  assert.match(roundTrip, /^maxDepth: 3$/m);
});
