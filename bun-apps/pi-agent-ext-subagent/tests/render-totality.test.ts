/** Render-layer totality tests (2026-08-16 crash fixes): composer closures
 *  capture RAW tool-call args and run EVERY frame — nullish/partial args must
 *  never throw (an uncaught render exception kills the whole TUI). */
import { test } from "bun:test";
import assert from "node:assert";
import { renderSubagentCall } from "../src/subagent-tool-render.js";
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
  assert.ok(out.includes('""'));
});
