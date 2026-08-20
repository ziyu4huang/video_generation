import { test } from "bun:test";
import assert from "node:assert/strict";
import { ComposerComponent } from "../src/composer-component.js";

// ── hotfix: render-time exception barrier (frame loop has none of its own) ──
// Repro of the host crash: a composer closure that throws mid-render (here:
// the undefined-task path that used to throw `task.split` inside
// workIntentPreview) must NOT propagate out of render(width) — the TUI frame
// loop calls render() with no exception barrier, so a throw kills the host.

test("ComposerComponent.render never throws — composer throw degrades to an error line", () => {
  const comp = new ComposerComponent(() => {
    throw new TypeError("undefined is not an object (evaluating 'task.split')");
  });
  let lines: string[] = [];
  assert.doesNotThrow(() => {
    lines = comp.render(80);
  });
  assert.ok(Array.isArray(lines));
  assert.ok(lines.length >= 1, "at least one line renders");
  assert.match(lines.join("\n"), /task\.split/, "error message surfaces as the degraded line");
});

test("ComposerComponent.render handles non-Error throws (string / null)", () => {
  const stringThrow = new ComposerComponent(() => {
    throw "boom"; // eslint-disable-line no-throw-literal -- deliberate non-Error throw
  });
  assert.doesNotThrow(() => stringThrow.render(80));
  assert.match(stringThrow.render(80).join("\n"), /boom/);
  const nullThrow = new ComposerComponent(() => {
    throw null;
  });
  let lines: string[] = [];
  assert.doesNotThrow(() => {
    lines = nullThrow.render(80);
  });
  assert.ok(lines.length >= 1, "renders a fallback line even for a thrown null");
});

test("ComposerComponent.render still delegates the happy path to Text at render width", () => {
  const comp = new ComposerComponent((width) => `hello ${width}`);
  assert.match(comp.render(80).join("\n"), /hello 80/);
});

test("setComposer swaps the closure on a reused component", () => {
  const comp = new ComposerComponent(() => "first");
  comp.setComposer(() => "second");
  assert.match(comp.render(80).join("\n"), /second/);
});

test("invalidate is a no-op (Component contract)", () => {
  assert.doesNotThrow(() => new ComposerComponent(() => "x").invalidate());
});
