/**
 * Pure-data unit tests for reduceSkillKey — the key dispatcher extracted from
 * SkillsManagerModal.handleInput. Every handleInput branch -> >=1 reducer test.
 * Plain objects only (no fake TUI, no pi-tui widgets).
 */

import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import {
  reduceSkillKey,
  type SkillKeyEffect,
  type SkillModalState,
} from "../../src/handlers/skill-key-reducer.js";

/** A baseline list-focus state used by most list-keymap tests. */
function listState(overrides: Partial<SkillModalState> = {}): SkillModalState {
  return {
    focusArea: "list",
    busy: false,
    closed: false,
    pendingDeleteConfirm: null,
    sortMode: "updated",
    selectedIndex: 0,
    selectedIds: new Set<string>(),
    query: "",
    rowCount: 3,
    terminalRows: 42,
    summaryLines: ["baseline"],
    currentSkillId: "global:alpha",
    currentDisplayName: "Alpha",
    filteredSkillIds: ["global:alpha", "project:beta", "external:gamma"],
    ...overrides,
  };
}

function esc(): string {
  return "\u001b";
}

function assertNoChange(result: { state: SkillModalState; effects: SkillKeyEffect[] }, original: SkillModalState): void {
  assert.strictEqual(result.effects.length, 0, "expected no effects");
  assert.strictEqual(result.state, original, "expected state object identity preserved (no change)");
}

describe("reduceSkillKey — guards", () => {
  it("closed guard is a no-op for every key", () => {
    const state = listState({ closed: true });
    for (const key of ["g", " ", esc(), "y", "/", "s"]) {
      assertNoChange(reduceSkillKey(state, key), state);
    }
  });

  it("busy + escape emits close; busy + any other key is a no-op", () => {
    const state = listState({ busy: true });
    const closed = reduceSkillKey(state, esc());
    assert.deepStrictEqual(closed.effects, [{ effect: "close" }]);
    assert.strictEqual(closed.state, state);

    const ignored = reduceSkillKey(state, "g");
    assertNoChange(ignored, state);
  });
});

describe("reduceSkillKey — pendingDeleteConfirm guard", () => {
  const pending = listState({
    pendingDeleteConfirm: { skillIds: ["global:alpha", "project:beta"] },
  });

  it("y / Y clears pending and emits deleteRun with the captured ids", () => {
    for (const key of ["y", "Y"]) {
      const result = reduceSkillKey(pending, key);
      assert.strictEqual(result.state.pendingDeleteConfirm, null);
      assert.deepStrictEqual(result.effects, [
        { effect: "deleteRun", ids: ["global:alpha", "project:beta"] },
      ]);
    }
  });

  it("n / N / escape clears pending, sets the cancel summary, requests a render", () => {
    for (const key of ["n", "N", esc()]) {
      const result = reduceSkillKey(pending, key);
      assert.strictEqual(result.state.pendingDeleteConfirm, null);
      assert.deepStrictEqual(result.state.summaryLines, ["Delete cancelled."]);
      assert.deepStrictEqual(result.effects, [{ effect: "requestRender" }]);
    }
  });

  it("any other key while confirming is a no-op", () => {
    for (const key of ["g", " ", "x"]) {
      assertNoChange(reduceSkillKey(pending, key), pending);
    }
  });
});

describe("reduceSkillKey — filters / search routing", () => {
  it("filters focus always routes to the filter sub-panel regardless of key", () => {
    const state = listState({ focusArea: "filters" });
    for (const key of [" ", "g", esc(), "x"]) {
      const result = reduceSkillKey(state, key);
      assert.strictEqual(result.state, state);
      assert.deepStrictEqual(result.effects, [{ effect: "routeFilters" }]);
    }
  });

  it("escape from search focus closes (esc is checked before search routing)", () => {
    const state = listState({ focusArea: "search" });
    const result = reduceSkillKey(state, esc());
    assert.deepStrictEqual(result.effects, [{ effect: "close" }]);
    assert.strictEqual(result.state, state);
  });

  it("search + tab / down focuses the list", () => {
    const state = listState({ focusArea: "search" });
    for (const key of ["\t", "\u001b[B"]) {
      const result = reduceSkillKey(state, key);
      assert.deepStrictEqual(result.effects, [{ effect: "focusList" }]);
      assert.strictEqual(result.state, state);
    }
  });

  it("search + any other key delegates the raw data to the search input", () => {
    const state = listState({ focusArea: "search" });
    for (const key of ["z", "a", "1", "q"]) {
      const result = reduceSkillKey(state, key);
      assert.deepStrictEqual(result.effects, [{ effect: "delegateSearch", data: key }]);
      assert.strictEqual(result.state, state);
    }
  });
});

describe("reduceSkillKey — list keymap (movement)", () => {
  it("escape closes the modal", () => {
    const state = listState();
    const result = reduceSkillKey(state, esc());
    assert.deepStrictEqual(result.effects, [{ effect: "close" }]);
    assert.strictEqual(result.state, state);
  });

  it("up / down move the cursor by one and request a render", () => {
    const state = listState({ selectedIndex: 1, rowCount: 3 });

    const up = reduceSkillKey(state, "\u001b[A");
    assert.strictEqual(up.state.selectedIndex, 0);
    assert.deepStrictEqual(up.effects, [{ effect: "requestRender" }]);

    const down = reduceSkillKey(state, "\u001b[B");
    assert.strictEqual(down.state.selectedIndex, 2);
    assert.deepStrictEqual(down.effects, [{ effect: "requestRender" }]);
  });

  it("up / down clamp at the edges but still render", () => {
    const top = listState({ selectedIndex: 0, rowCount: 3 });
    const upAtTop = reduceSkillKey(top, "\u001b[A");
    assert.strictEqual(upAtTop.state.selectedIndex, 0);
    assert.deepStrictEqual(upAtTop.effects, [{ effect: "requestRender" }]);

    const bottom = listState({ selectedIndex: 2, rowCount: 3 });
    const downAtBottom = reduceSkillKey(bottom, "\u001b[B");
    assert.strictEqual(downAtBottom.state.selectedIndex, 2);
    assert.deepStrictEqual(downAtBottom.effects, [{ effect: "requestRender" }]);
  });

  it("up / down are no-ops (no state change, no render) when rowCount is 0", () => {
    const empty = listState({ rowCount: 0, selectedIndex: 0, currentSkillId: null, currentDisplayName: null, filteredSkillIds: [] });
    assertNoChange(reduceSkillKey(empty, "\u001b[A"), empty);
    assertNoChange(reduceSkillKey(empty, "\u001b[B"), empty);
  });

  it("cursor clamps when selectedIndex exceeds rowCount (shrink after filter)", () => {
    const shrunk = listState({ selectedIndex: 5, rowCount: 3 });
    const down = reduceSkillKey(shrunk, "\u001b[B");
    // 5 + 1 = 6 clamped to rowCount - 1 = 2
    assert.strictEqual(down.state.selectedIndex, 2);
    assert.deepStrictEqual(down.effects, [{ effect: "requestRender" }]);
  });

  it("pageUp / pageDown move by the viewport page size derived from terminalRows", () => {
    // terminalRows = 42 -> maxVisible = max(6, min(14, 20)) = 14 -> pageSize = max(5, 13) = 13
    const state = listState({ selectedIndex: 13, rowCount: 40, terminalRows: 42 });

    const up = reduceSkillKey(state, "\u001b[5~"); // pageUp
    assert.strictEqual(up.state.selectedIndex, 0);
    assert.deepStrictEqual(up.effects, [{ effect: "requestRender" }]);

    const fromZero = listState({ selectedIndex: 0, rowCount: 40, terminalRows: 42 });
    const down = reduceSkillKey(fromZero, "\u001b[6~"); // pageDown
    assert.strictEqual(down.state.selectedIndex, 13);
    assert.deepStrictEqual(down.effects, [{ effect: "requestRender" }]);
  });

  it("pageUp / pageDown clamp at edges", () => {
    const state = listState({ selectedIndex: 0, rowCount: 40, terminalRows: 42 });
    const up = reduceSkillKey(state, "\u001b[5~");
    assert.strictEqual(up.state.selectedIndex, 0);

    const bottom = listState({ selectedIndex: 39, rowCount: 40, terminalRows: 42 });
    const down = reduceSkillKey(bottom, "\u001b[6~");
    assert.strictEqual(down.state.selectedIndex, 39);
  });

  it("pageUp / pageDown are no-ops when rowCount is 0", () => {
    const empty = listState({ rowCount: 0 });
    assertNoChange(reduceSkillKey(empty, "\u001b[5~"), empty);
    assertNoChange(reduceSkillKey(empty, "\u001b[6~"), empty);
  });

  it("home sets selectedIndex to 0 and renders (even with rowCount 0)", () => {
    const state = listState({ selectedIndex: 2, rowCount: 3 });
    const home = reduceSkillKey(state, "\u001b[H");
    assert.strictEqual(home.state.selectedIndex, 0);
    assert.deepStrictEqual(home.effects, [{ effect: "requestRender" }]);

    const empty = listState({ rowCount: 0, selectedIndex: 0 });
    const homeEmpty = reduceSkillKey(empty, "\u001b[H");
    assert.strictEqual(homeEmpty.state.selectedIndex, 0);
    assert.deepStrictEqual(homeEmpty.effects, [{ effect: "requestRender" }]);
  });

  it("end sets selectedIndex to rowCount-1 and renders", () => {
    const state = listState({ selectedIndex: 0, rowCount: 3 });
    const end = reduceSkillKey(state, "\u001b[F");
    assert.strictEqual(end.state.selectedIndex, 2);
    assert.deepStrictEqual(end.effects, [{ effect: "requestRender" }]);

    const empty = listState({ rowCount: 0 });
    const endEmpty = reduceSkillKey(empty, "\u001b[F");
    assert.strictEqual(endEmpty.state.selectedIndex, 0);
    assert.deepStrictEqual(endEmpty.effects, [{ effect: "requestRender" }]);
  });
});

describe("reduceSkillKey — list keymap (selection)", () => {
  it("space toggles the current skill in selectedIds and writes the Selected/Cleared summary", () => {
    const state = listState({
      selectedIndex: 0,
      currentSkillId: "global:alpha",
      currentDisplayName: "Alpha",
      selectedIds: new Set<string>(),
    });

    const select = reduceSkillKey(state, " ");
    assert.ok(select.state.selectedIds.has("global:alpha"));
    assert.deepStrictEqual(select.state.summaryLines, ["Selected Alpha."]);
    assert.deepStrictEqual(select.effects, [{ effect: "requestRender" }]);

    const clear = reduceSkillKey(select.state, " ");
    assert.ok(!clear.state.selectedIds.has("global:alpha"));
    assert.deepStrictEqual(clear.state.summaryLines, ["Cleared Alpha."]);
  });

  it("space is a no-op when there is no current row (rowCount 0)", () => {
    const empty = listState({ rowCount: 0, currentSkillId: null, currentDisplayName: null });
    assertNoChange(reduceSkillKey(empty, " "), empty);
  });

  it("'a' unions filteredSkillIds into selectedIds and reports the visible count", () => {
    const state = listState({
      selectedIds: new Set<string>(["global:alpha"]),
      filteredSkillIds: ["global:alpha", "project:beta", "external:gamma"],
    });

    const result = reduceSkillKey(state, "a");
    assert.deepStrictEqual(result.state.selectedIds, new Set(["global:alpha", "project:beta", "external:gamma"]));
    assert.deepStrictEqual(result.state.summaryLines, ["Selected 3 visible skills."]);
    assert.deepStrictEqual(result.effects, [{ effect: "requestRender" }]);
  });

  it("'a' with a single visible row uses the singular summary", () => {
    const state = listState({
      selectedIds: new Set<string>(),
      filteredSkillIds: ["project:beta"],
      rowCount: 1,
    });
    const result = reduceSkillKey(state, "a");
    assert.deepStrictEqual(result.state.summaryLines, ["Selected 1 visible skill."]);
  });

  it("'a' preserves previously selected ids that are no longer filtered in", () => {
    const state = listState({
      selectedIds: new Set<string>(["global:alpha", "other:hidden"]),
      filteredSkillIds: ["project:beta"],
      rowCount: 1,
    });
    const result = reduceSkillKey(state, "a");
    assert.deepStrictEqual(result.state.selectedIds, new Set(["global:alpha", "other:hidden", "project:beta"]));
  });

  it("'n' clears all selectedIds and writes the cleared summary", () => {
    const state = listState({
      selectedIds: new Set<string>(["global:alpha", "project:beta"]),
    });
    const result = reduceSkillKey(state, "n");
    assert.deepStrictEqual(result.state.selectedIds, new Set<string>());
    assert.deepStrictEqual(result.state.summaryLines, ["Cleared all selections."]);
    assert.deepStrictEqual(result.effects, [{ effect: "requestRender" }]);
  });
});

describe("reduceSkillKey — list keymap (commands & effects)", () => {
  it("'f' opens the filter panel", () => {
    const state = listState();
    const result = reduceSkillKey(state, "f");
    assert.strictEqual(result.state, state);
    assert.deepStrictEqual(result.effects, [{ effect: "openFilters" }]);
  });

  it("'s' advances sortMode in state AND emits cycleSort (reducer does not touch rows)", () => {
    const fromUpdated = listState({ sortMode: "updated" });
    const r1 = reduceSkillKey(fromUpdated, "s");
    assert.strictEqual(r1.state.sortMode, "created");
    assert.deepStrictEqual(r1.effects, [{ effect: "cycleSort" }]);

    const fromCreated = listState({ sortMode: "created" });
    const r2 = reduceSkillKey(fromCreated, "s");
    assert.strictEqual(r2.state.sortMode, "name");

    const fromName = listState({ sortMode: "name" });
    const r3 = reduceSkillKey(fromName, "s");
    assert.strictEqual(r3.state.sortMode, "updated");
  });

  it("tab / slash focus search without prefill", () => {
    const state = listState();
    const tab = reduceSkillKey(state, "\t");
    assert.deepStrictEqual(tab.effects, [{ effect: "focusSearch" }]);
    assert.strictEqual(tab.state, state);

    const slash = reduceSkillKey(state, "/");
    assert.deepStrictEqual(slash.effects, [{ effect: "focusSearch" }]);
    assert.strictEqual(slash.state, state);
  });

  it("'g' emits move-global, 'p' emits move-project", () => {
    const state = listState();
    assert.deepStrictEqual(reduceSkillKey(state, "g").effects, [{ effect: "move", scope: "global" }]);
    assert.deepStrictEqual(reduceSkillKey(state, "p").effects, [{ effect: "move", scope: "project" }]);
    assert.strictEqual(reduceSkillKey(state, "g").state, state);
  });

  it("'d' emits promptDelete", () => {
    const state = listState();
    const result = reduceSkillKey(state, "d");
    assert.strictEqual(result.state, state);
    assert.deepStrictEqual(result.effects, [{ effect: "promptDelete" }]);
  });

  it("a printable non-command letter focuses search with that letter as prefill", () => {
    const state = listState();
    const result = reduceSkillKey(state, "z");
    assert.deepStrictEqual(result.effects, [{ effect: "focusSearch", data: "z" }]);
    assert.strictEqual(result.state, state);
  });

  it("uppercase command letters are NOT commands — they prefill search", () => {
    const state = listState();
    // "S" is not "s"; it falls through to the printable branch.
    const result = reduceSkillKey(state, "S");
    assert.deepStrictEqual(result.effects, [{ effect: "focusSearch", data: "S" }]);
  });

  it("an unrecognized non-printable key is a no-op", () => {
    const state = listState();
    assertNoChange(reduceSkillKey(state, "\u0001"), state); // Ctrl-A, single char below space
    assertNoChange(reduceSkillKey(state, "\u001b[200~"), state); // multi-char paste bracket, unmatched
  });
});

describe("reduceSkillKey — purity", () => {
  it("never mutates the input state's Set (returns a fresh Set on selection ops)", () => {
    const original = listState({ selectedIds: new Set<string>(["global:alpha"]) });
    const snapshot = original.selectedIds;
    reduceSkillKey(original, "a");
    assert.strictEqual(snapshot.size, 1, "input selectedIds set left untouched");
    reduceSkillKey(original, "n");
    assert.strictEqual(snapshot.size, 1, "input selectedIds set still untouched");
  });
});
