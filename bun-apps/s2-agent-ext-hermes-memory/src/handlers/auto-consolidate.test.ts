import { describe, expect, test } from "bun:test";

import type { SpawnSubagentOptions, SpawnSubagentResult } from "@repo/s2-agent-core-runtime";

import { buildSnapshot } from "../store/merge-plan.js";
import { produceMergePlan } from "./auto-consolidate.js";

// A fixed encoded entry used across tests: content + the trailing metadata
// comment the store/codec stamp on every entry.
const ENCODED_ENTRY = "alpha\n<!-- created=2026-08-01, last=2026-08-01 -->";

describe("produceMergePlan", () => {
  test("returns the validated plan and spawns read+plan only (tools: [], schema set)", async () => {
    const snapshot = buildSnapshot("failure", [ENCODED_ENTRY], 40_000);
    const validPlan = {
      snapshotBaseHash: snapshot.snapshotBaseHash,
      ops: [
        { op: "merge", fromKeys: snapshot.entries.map((e) => e.key), content: "merged alpha" },
      ],
    };

    let captured: SpawnSubagentOptions | undefined;
    const spawnStub = async (opts: SpawnSubagentOptions): Promise<SpawnSubagentResult> => {
      captured = opts;
      return { output: JSON.stringify(validPlan) };
    };

    const res = await produceMergePlan(snapshot, { timeoutMs: 30_000, spawn: spawnStub });

    // Result carries the parsed + validated plan with the right ops.
    expect("plan" in res).toBe(true);
    if ("plan" in res) {
      expect(res.plan.snapshotBaseHash).toBe(snapshot.snapshotBaseHash);
      expect(res.plan.ops).toHaveLength(1);
      expect(res.plan.ops[0].op).toBe("merge");
    }

    // READ+PLAN ONLY — the subagent is handed NO memory tool (no writes).
    expect(captured).toBeDefined();
    expect(captured?.tools).toEqual([]);
    // Structured-output schema is set so the child returns a validated MergePlan.
    expect(captured?.schema).toBeDefined();
    // No transient retry — a timed-out plan is best-effort, never re-held.
    expect(captured?.retryOnTransient).toBe(false);
    expect(captured?.timeoutMs).toBe(30_000);
    // Default model path: tier "small" when no override is provided.
    expect(captured?.tier).toBe("small");
    expect(captured?.model).toBeUndefined();
    // The snapshot is embedded in the task prompt (target + budget + KEY=...).
    expect(captured?.task).toContain("Target store: failure");
    expect(captured?.task).toContain("limit 40000");
    expect(captured?.task).toContain(`KEY=${snapshot.entries[0].key}`);
  });

  test("returns { error, terminated: true } on a timed-out spawn", async () => {
    const snapshot = buildSnapshot("failure", [ENCODED_ENTRY], 40_000);
    const spawnStub = async (): Promise<SpawnSubagentResult> => ({ output: "", failure: { kind: "timedout", message: "Subagent was aborted" } });

    const res = await produceMergePlan(snapshot, { timeoutMs: 30_000, spawn: spawnStub });

    expect("error" in res).toBe(true);
    if ("error" in res) {
      expect(res.terminated).toBe(true);
      expect(typeof res.error).toBe("string");
      expect(res.error.length).toBeGreaterThan(0);
    }
  });
});
