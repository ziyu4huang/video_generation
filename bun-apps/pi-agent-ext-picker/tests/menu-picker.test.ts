/**
 * menu-picker.test.ts — render-snapshot harness for the menu component (ticket 07).
 *
 * The interactive TUI layer (CustomEditor + overlay + keystrokes) resists
 * unit-testing; this file pins the DETERMINISTIC render core (`renderMenuLines`)
 * via snapshots + behaviour assertions, so the component's done-ness is
 * machine-checkable rather than eyeball-only.
 */
import { test, expect } from "bun:test";
import { renderMenuLines } from "../src/menu-picker.ts";
import type { SelectItem } from "@earendil-works/pi-tui";

const ITEMS: readonly SelectItem[] = [
  { value: "/help", label: "/help", description: "show keybindings & help" },
  { value: "/subagents", label: "/subagents", description: "open the subagent viewer panel" },
  { value: "/clear", label: "/clear", description: "clear the conversation history" },
  { value: "/model", label: "/model", description: "switch the active model" },
  { value: "/preset", label: "/preset", description: "apply a prompt preset" },
];

test("no query → all items rendered, first selected (snapshot)", () => {
  const lines = renderMenuLines({ items: [...ITEMS], query: "", width: 60 });
  expect(lines).toMatchSnapshot();
  // every item label is present
  for (const it of ITEMS) expect(lines.some((l) => l.includes(it.label))).toBe(true);
});

test("fuzzy query narrows + ranks (snapshot)", () => {
  // "su" fuzzy-matches /subagents (s…ub…) and /preset? no — only /subagents.
  const lines = renderMenuLines({ items: [...ITEMS], query: "su", width: 60 });
  expect(lines).toMatchSnapshot();
  expect(lines.some((l) => l.includes("/subagents"))).toBe(true);
  expect(lines.some((l) => l.includes("/help"))).toBe(false);
  expect(lines.some((l) => l.includes("/clear"))).toBe(false);
});

test("no matches → empty-state line (snapshot)", () => {
  const lines = renderMenuLines({ items: [...ITEMS], query: "zzz", width: 60 });
  expect(lines).toMatchSnapshot();
  expect(lines.length).toBeGreaterThan(0);
  for (const it of ITEMS) expect(lines.some((l) => l.includes(it.label))).toBe(false);
});

test("selectedIndex is clamped to the filtered list", () => {
  // query "su" → only /subagents (filtered length 1); selectedIndex 5 clamps to 0
  const lines = renderMenuLines({ items: [...ITEMS], query: "su", selectedIndex: 5, width: 60 });
  expect(lines.some((l) => l.includes("/subagents"))).toBe(true);
});

test("narrower width still renders without exceeding it", () => {
  const lines = renderMenuLines({ items: [...ITEMS], query: "", width: 30 });
  for (const l of lines) expect(l.length).toBeLessThanOrEqual(30);
});
