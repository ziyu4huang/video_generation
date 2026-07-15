// tests/grill-decision.test.ts
import { test, expect } from "bun:test";
import { evaluateGrillSignal, lexicalOverlap, composeMemoryContent } from "../src/tools/grill-decision-tool.js";

test("reject → FIRE as correction", () => {
  const r = evaluateGrillSignal({ signal: "reject", content: "prefers httpOnly cookies", existingEntries: [] });
  expect(r.fire).toBe(true);
  expect(r.category).toBe("correction");
});

test("preference → FIRE as preference", () => {
  const r = evaluateGrillSignal({ signal: "preference", content: "always avoid localStorage tokens", existingEntries: [] });
  expect(r.fire).toBe(true);
  expect(r.category).toBe("preference");
});

test("insight → FIRE as insight", () => {
  const r = evaluateGrillSignal({ signal: "insight", content: "values simplicity over configurability", existingEntries: [] });
  expect(r.fire).toBe(true);
  expect(r.category).toBe("insight");
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
