/** Render-layer totality tests (2026-08-16 crash fixes): composer closures
 *  capture RAW tool-call args and run EVERY frame — nullish/partial args must
 *  never throw (an uncaught render exception kills the whole TUI).
 *
 *  Originally the CALL renderers only. The RESULT renderers were the same
 *  shape of hazard with none of the coverage, and ticket 03's settled-expanded
 *  Container escaped the ComposerComponent barrier entirely — so the last
 *  block here pins the barrier itself, not just the pure renderers. */
import { test } from "bun:test";
import assert from "node:assert";
import { ComposerComponent, GuardedComponent } from "../src/composer-component.js";
import {
  renderSubagentCall,
  renderSubagentResult,
  renderSubagentResultHeader,
  subagentResultText,
} from "../src/subagent-tool-render.js";
import { renderSubagentsCall } from "../src/subagents-tool.js";

const themeStub = { bold: (s: string) => s, fg: (_c: string, s: string) => s } as never;

test("renderSubagentsCall tolerates nullish args (crash fix #2)", () => {
  assert.equal(renderSubagentsCall(undefined as never, undefined as never), "");
});

test("renderSubagentsCall tolerates tasks with a task-less head element", () => {
  const out = renderSubagentsCall({ tasks: [{}] } as never, themeStub);
  assert.equal(typeof out, "string");
});

test("renderSubagentCall tolerates nullish args (defense-in-depth)", () => {
  assert.equal(renderSubagentCall(undefined as never, undefined as never), "");
});

test("renderSubagentCall tolerates a missing task field with theme stub", () => {
  const out = renderSubagentCall({ agent: "implementer" } as never, themeStub);
  assert.equal(typeof out, "string");
  assert.ok(out.includes("Task(implementer)"), "CC-shaped head still renders with an empty intent");
});

// ── result side ────────────────────────────────────────────────────────────
// Same hazard, previously uncovered: these feed the settled-expanded Container
// (built lazily inside GuardedComponent) and the settled-collapsed composer.

test("subagentResultText tolerates a nullish result and a content-less result", () => {
  assert.equal(subagentResultText(undefined as never), "");
  assert.equal(subagentResultText({} as never), "");
});

test("renderSubagentResultHeader tolerates a nullish result", () => {
  assert.equal(renderSubagentResultHeader(undefined as never, themeStub), "");
});

test("renderSubagentResult tolerates nullish result and nullish options", () => {
  assert.equal(renderSubagentResult(undefined as never, undefined as never, themeStub), "");
  assert.equal(renderSubagentResult({} as never, {} as never, themeStub), "");
});

// ── the barrier itself ─────────────────────────────────────────────────────

test("GuardedComponent survives a throwing BUILDER and retries the next frame", () => {
  let attempts = 0;
  const c = new GuardedComponent(() => {
    attempts++;
    if (attempts === 1) throw new Error("boom");
    return { render: () => ["ok"], invalidate: () => {} };
  });
  // Frame 1: the builder throws — degrade, never propagate.
  assert.deepEqual(
    c.render(40).map((l) => l.trimEnd()),
    ["boom"],
  );
  // Frame 2: a failed build is NOT latched, so recovery is possible.
  assert.deepEqual(
    c.render(40).map((l) => l.trimEnd()),
    ["ok"],
  );
  // Frame 3: a successful build IS cached — the builder does not re-run.
  assert.deepEqual(
    c.render(40).map((l) => l.trimEnd()),
    ["ok"],
  );
  assert.equal(attempts, 2);
});

test("GuardedComponent survives a throwing CHILD render", () => {
  const c = new GuardedComponent(() => ({
    render: () => {
      throw new Error("child exploded");
    },
    invalidate: () => {},
  }));
  assert.deepEqual(
    c.render(40).map((l) => l.trimEnd()),
    ["child exploded"],
  );
});

test("ComposerComponent still survives a throwing composer", () => {
  const c = new ComposerComponent(() => {
    throw new Error("composer exploded");
  });
  assert.deepEqual(
    c.render(40).map((l) => l.trimEnd()),
    ["composer exploded"],
  );
});

// ── tui-cc-parity t01 review: GuardedComponent threads render-time width ──

test("GuardedComponent rebuilds per width (width-aware builder, cached per width)", () => {
  const widths: number[] = [];
  const c = new GuardedComponent((w) => {
    widths.push(w);
    return { render: (rw: number) => [`${rw}`], invalidate: () => {} } as never;
  });
  assert.deepEqual(c.render(80), ["80"], "first render builds at 80");
  assert.deepEqual(c.render(80), ["80"], "same width reuses the cache");
  assert.deepEqual(c.render(40), ["40"], "new width rebuilds");
  assert.deepEqual(widths, [80, 40], "exactly one build per distinct width");
});
