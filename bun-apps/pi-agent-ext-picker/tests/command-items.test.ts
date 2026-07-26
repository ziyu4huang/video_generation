/**
 * command-items.test.ts — the slash-command → SelectItem mapping (consumer data shape).
 */
import { test, expect } from "bun:test";
import { toCommandItems } from "../src/command-items.ts";

test("normalizes names to a single leading slash", () => {
  const items = toCommandItems([
    { name: "help" },
    { name: "/subagents" },
    { name: "clear", description: "clear history" },
  ]);
  expect(items.map((i) => i.value)).toEqual(["/help", "/subagents", "/clear"]);
  expect(items.map((i) => i.label)).toEqual(["/help", "/subagents", "/clear"]);
});

test("preserves descriptions", () => {
  const items = toCommandItems([{ name: "model", description: "switch model" }]);
  expect(items[0].description).toBe("switch model");
});

test("empty input → empty output", () => {
  expect(toCommandItems([])).toEqual([]);
});
