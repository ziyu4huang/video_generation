import { describe, test, expect } from "bun:test";
import { resolveTestMode } from "./l2-test-mode";

describe("resolveTestMode", () => {
  test("no blockers -> run", () => {
    const result = resolveTestMode("todo", [], true, false);
    expect(result.mode).toBe("run");
    expect(result.title).toBe("L2: todo");
  });

  test("blocked, L2 not enabled -> skip", () => {
    const result = resolveTestMode("todo", ["set PI_RUN_L2=1 to run L2 e2e"], false, false);
    expect(result.mode).toBe("skip");
    expect(result.title).toBe("L2: todo — skipped (set PI_RUN_L2=1 to run L2 e2e)");
  });

  test("blocked, L2 enabled, not required -> skip", () => {
    const result = resolveTestMode("todo", ["LM Studio not reachable on :1234"], true, false);
    expect(result.mode).toBe("skip");
    expect(result.title).toBe("L2: todo — skipped (LM Studio not reachable on :1234)");
  });

  test("blocked, L2 enabled AND required -> fail", () => {
    const result = resolveTestMode("todo", ["LM Studio not reachable on :1234"], true, true);
    expect(result.mode).toBe("fail");
    expect(result.title).toBe("L2: todo — REQUIRED but blocked (LM Studio not reachable on :1234)");
  });

  test("blocked, L2 NOT enabled but required flag set anyway -> skip (PI_REQUIRE_L2 only matters when L2 is enabled)", () => {
    const result = resolveTestMode("todo", ["set PI_RUN_L2=1 to run L2 e2e"], false, true);
    expect(result.mode).toBe("skip");
  });

  test("multiple blockers joined with semicolons in title", () => {
    const result = resolveTestMode(
      "knowledge_query",
      ["LM Studio not reachable on :1234", "vault-mind not reachable on :8000"],
      true,
      false,
    );
    expect(result.title).toBe(
      "L2: knowledge_query — skipped (LM Studio not reachable on :1234; vault-mind not reachable on :8000)",
    );
  });
});
