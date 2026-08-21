import { test, expect, describe } from "bun:test";
import { captureTools } from "@repo/perf-harness";
import kcardFactory from "../../extensions/knowledge-card.ts";

const tools = captureTools(kcardFactory);

describe("zk_ingest distill actions", () => {
  test("distill tool is gone (folded into zk_ingest)", () => {
    expect(tools.distill).toBeUndefined();
  });

  test("zk_ingest parameters include optional action/entries/notes/metrics", () => {
    const params = (tools.zk_ingest as any).parameters as Record<string, unknown>;
    const props = (params as any).properties as Record<string, unknown>;
    expect(props.action).toBeDefined();
    expect(props.entries).toBeDefined();
    expect(props.notes).toBeDefined();
    expect(props.metrics).toBeDefined();
  });

  test("zk_ingest action='gate' returns survivors + killed (read-only)", async () => {
    const execute = (tools.zk_ingest as any).execute;
    const res = await execute(
      "t1",
      {
        action: "gate",
        vault: "/nonexistent-vault-zk-test",
        entries: [
          { id: "a", target: "memory", content: "short", created: "2026-01-01" },
          { id: "b", target: "memory", content: "well-formed real entry content", created: "2026-07-18" },
        ],
      },
      undefined,
      undefined,
      { cwd: process.cwd() },
    );
    expect(res.isError).toBe(false);
    const data = JSON.parse((res.content as any)[0].text);
    expect(data.candidates).toBe(2);
    expect(Array.isArray(data.survivors)).toBe(true);
    expect(data.killed).toBeGreaterThanOrEqual(1); // the "short" malformed entry
    // positive assertion: the well-formed entry "b" survives (catches a gate that wrongly kills both)
    expect(data.survivors.some((s: any) => s.id === "b")).toBe(true);
  });

  test("zk_ingest action='status' returns threshold + history shape", async () => {
    const execute = (tools.zk_ingest as any).execute;
    const res = await execute(
      "t2",
      { action: "status", vault: "/nonexistent-vault-zk-test-status" },
      undefined,
      undefined,
      { cwd: process.cwd() },
    );
    expect(res.isError).toBe(false);
    const data = JSON.parse((res.content as any)[0].text);
    expect(typeof data.threshold).toBe("number");
    expect("lastRun" in data).toBe(true);
    expect("historyEntries" in data).toBe(true);
  });
});
