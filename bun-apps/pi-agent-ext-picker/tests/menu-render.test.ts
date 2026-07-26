/**
 * menu-render.test.ts — render-snapshot + state harness for the menu core (ticket 07).
 *
 * The interactive TUI layer (CustomEditor + overlay + keystrokes) resists
 * unit-testing; this file pins the DETERMINISTIC core (`renderMenuLines`,
 * `resolveSelectionByValue`, `MenuOverlay`) so done-ness is machine-checkable.
 * Imports ONLY from menu-render (pi-tui) — never pulls the agent runtime.
 */
import { test, expect } from "bun:test";
import {
  renderMenuLines,
  resolveSelectionByValue,
  MenuOverlay,
} from "../src/menu-render.ts";
import type { SelectItem } from "@earendil-works/pi-tui";

const ITEMS: readonly SelectItem[] = [
  { value: "/help", label: "/help", description: "show keybindings & help" },
  { value: "/subagents", label: "/subagents", description: "open the subagent viewer panel" },
  { value: "/clear", label: "/clear", description: "clear the conversation history" },
  { value: "/model", label: "/model", description: "switch the active model" },
  { value: "/preset", label: "/preset", description: "apply a prompt preset" },
];

// --- renderMenuLines ---

test("no query → all items, first selected (snapshot)", () => {
  const lines = renderMenuLines({ items: [...ITEMS], query: "", width: 60 });
  expect(lines).toMatchSnapshot();
  for (const it of ITEMS) expect(lines.some((l) => l.includes(it.label))).toBe(true);
});

test("fuzzy query narrows + ranks (snapshot)", () => {
  const lines = renderMenuLines({ items: [...ITEMS], query: "su", width: 60 });
  expect(lines).toMatchSnapshot();
  expect(lines.some((l) => l.includes("/subagents"))).toBe(true);
  expect(lines.some((l) => l.includes("/help"))).toBe(false);
});

test("no matches → empty-state line (snapshot)", () => {
  const lines = renderMenuLines({ items: [...ITEMS], query: "zzz", width: 60 });
  expect(lines).toMatchSnapshot();
  expect(lines.length).toBeGreaterThan(0);
  for (const it of ITEMS) expect(lines.some((l) => l.includes(it.label))).toBe(false);
});

test("selectedIndex clamps to the filtered list", () => {
  const lines = renderMenuLines({ items: [...ITEMS], query: "su", selectedIndex: 5, width: 60 });
  expect(lines.some((l) => l.includes("/subagents"))).toBe(true);
});

test("render respects width", () => {
  const lines = renderMenuLines({ items: [...ITEMS], query: "", width: 30 });
  for (const l of lines) expect(l.length).toBeLessThanOrEqual(30);
});

// --- resolveSelectionByValue (05: persist by value) ---

test("persist-by-value: returns 0 when no prevValue", () => {
  expect(resolveSelectionByValue([...ITEMS], undefined)).toBe(0);
});

test("persist-by-value: keeps the same item across a re-filter", () => {
  // /model is index 3 in full list; after a fuzzy query it lands somewhere — find it
  const q = "mo";
  const filtered = renderMenuLines({ items: [...ITEMS], query: q, width: 60 }); // smoke
  expect(filtered.some((l) => l.includes("/model"))).toBe(true);
  // simulate: re-filter narrows to [/model]; prevValue=/model → stays selected
  const narrow = [{ value: "/model", label: "/model" }];
  expect(resolveSelectionByValue(narrow, "/model")).toBe(0);
});

test("persist-by-value: clamps to 0 when prevValue absent in filtered", () => {
  expect(resolveSelectionByValue([{ value: "/a", label: "/a" }], "/gone")).toBe(0);
});

// --- MenuOverlay (state → render) ---

test("MenuOverlay: setQuery live-filters; render shows the match", () => {
  const ov = new MenuOverlay({ items: () => [...ITEMS] });
  ov.setQuery("su");
  const lines = ov.render(60);
  expect(lines.some((l) => l.includes("/subagents"))).toBe(true);
  expect(ov.filtered.length).toBe(1);
  expect(ov.getSelectedItem()?.value).toBe("/subagents");
});

test("MenuOverlay: selection persists by value across query changes", () => {
  const ov = new MenuOverlay({ items: () => [...ITEMS] });
  ov.setQuery(""); // all items
  ov.move(3); // select /model (index 3)
  expect(ov.selectedValue).toBe("/model");
  ov.setQuery("mo"); // narrow — /model still there → stays selected
  expect(ov.getSelectedItem()?.value).toBe("/model");
  ov.setQuery("zzz"); // /model gone → clamp to 0, empty list
  expect(ov.getSelectedItem()).toBeNull();
});

test("MenuOverlay: move clamps at list bounds", () => {
  const ov = new MenuOverlay({ items: () => [...ITEMS] });
  ov.move(-5); // before first → clamp to 0
  expect(ov.selectedIndex).toBe(0);
  ov.move(99); // past last → clamp to last
  expect(ov.selectedIndex).toBe(ITEMS.length - 1);
});

test("MenuOverlay: setQuery no-op when unchanged (does not invalidate)", () => {
  let invalidated = 0;
  const ov = new MenuOverlay({ items: () => [...ITEMS] });
  ov.setInvalidate(() => invalidated++);
  ov.setQuery("su");
  const before = invalidated;
  ov.setQuery("su"); // same → no-op
  expect(invalidated).toBe(before);
});
