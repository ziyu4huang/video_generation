// tests/grill-decision.test.ts — direct `executeGrillDecision(store, cardStore, params)`
// calls (kp14: registerGrillDecisionTool retired; the handler is the internal
// execute export returning a plain JSON string). Pure gate helpers stay covered as-is.
import { test, expect } from "bun:test";
import { evaluateGrillSignal, lexicalOverlap, composeMemoryContent, executeGrillDecision } from "../src/tools/grill-decision-tool.js";
import type { MemoryStore } from "../src/store/memory-store.js";

test("reject → FIRE as preference", () => {
  const r = evaluateGrillSignal({ signal: "reject", content: "prefers httpOnly cookies", existingEntries: [] });
  expect(r.fire).toBe(true);
  expect(r.category).toBe("preference");
});

test("preference → FIRE as preference", () => {
  const r = evaluateGrillSignal({ signal: "preference", content: "always avoid localStorage tokens", existingEntries: [] });
  expect(r.fire).toBe(true);
  expect(r.category).toBe("preference");
});

test("insight → FIRE as preference", () => {
  const r = evaluateGrillSignal({ signal: "insight", content: "values simplicity over configurability", existingEntries: [] });
  expect(r.fire).toBe(true);
  expect(r.category).toBe("preference");
});

test("confirm → SUPPRESS", () => {
  const r = evaluateGrillSignal({ signal: "confirm", content: "ok", existingEntries: [] });
  expect(r.fire).toBe(false);
});

test("refine → SUPPRESS", () => {
  const r = evaluateGrillSignal({ signal: "refine", content: "almost right but tweak", existingEntries: [] });
  expect(r.fire).toBe(false);
});

test("duplicate (overlap >= 0.8) → SUPPRESS", () => {
  const existing = ["Prefers httpOnly cookies; rejected JWT-in-localStorage during auth decision."];
  const r = evaluateGrillSignal({ signal: "reject", content: "Prefers httpOnly cookies; rejected JWT-in-localStorage during auth decision.", existingEntries: existing });
  expect(r.fire).toBe(false);
  expect(r.reason).toContain("duplicate");
});

test("distinct content → still FIRE", () => {
  const existing = ["Prefers httpOnly cookies over browser tokens."];
  const r = evaluateGrillSignal({ signal: "preference", content: "always uses Bun over npm in this monorepo", existingEntries: existing });
  expect(r.fire).toBe(true);
});

test("project-scoped notes → SUPPRESS (belongs in CONTEXT.md)", () => {
  const r = evaluateGrillSignal({ signal: "preference", content: "this project uses tabs", notes: "project-scoped repo convention", existingEntries: [] });
  expect(r.fire).toBe(false);
  expect(r.reason).toContain("project-scoped");
});

test("lexicalOverlap: identical → 1, disjoint → 0", () => {
  expect(lexicalOverlap("foo bar baz", "foo bar baz")).toBe(1);
  expect(lexicalOverlap("foo bar", "qux zip")).toBe(0);
});

test("composeMemoryContent produces a durable behavioral line", () => {
  const c = composeMemoryContent({
    decision: "session storage",
    recommendation: "JWT in localStorage",
    userAnswer: "No — httpOnly cookies",
    notes: "Prefers stateless auth; avoids browser-stored tokens.",
  });
  expect(c).toContain("Prefers stateless auth");
});

// Minimal stub of the MemoryStore surface the handler touches: it writes
// user-traits via add(target, content, {category}) and reads getUserEntries()
// for dedup.
function makeStubStore(userEntries: string[]) {
  const writes: { target: string; content: string; category?: string }[] = [];
  return {
    writes,
    store: {
      getUserEntries: () => userEntries,
      add: async (target: string, content: string, options?: { category?: string }) => {
        writes.push({ target, content, category: options?.category });
        return { success: true };
      },
    } as unknown as MemoryStore,
  };
}

test("executeGrillDecision: FIRE writes to user target as preference (JSON string)", async () => {
  const { store, writes } = makeStubStore([]);
  const out = await executeGrillDecision(store, null, {
    decision: "auth storage", recommendation: "JWT in localStorage",
    userAnswer: "no", signal: "reject", notes: "prefers httpOnly cookies",
  });
  expect(typeof out).toBe("string");
  const parsed = JSON.parse(out);
  expect(writes).toHaveLength(1);
  expect(writes[0].target).toBe("user");
  expect(writes[0].category).toBe("preference");
  expect(parsed.written).toBe(true);
  expect(parsed.category).toBe("preference");
});

test("executeGrillDecision: SUPPRESS (confirm) writes nothing", async () => {
  const { store, writes } = makeStubStore([]);
  const out = await executeGrillDecision(store, null, {
    decision: "x", recommendation: "y", userAnswer: "ok", signal: "confirm",
  });
  const parsed = JSON.parse(out);
  expect(writes).toHaveLength(0);
  expect(parsed.written).toBe(false);
});
