import { test } from "bun:test";
import assert from "node:assert/strict";
import { createEffortState, effortDirective, isSubstantive, registerEffortCommand } from "../src/effort-command.js";
import { buildForcedWorkflowPrompt } from "../src/workflow-editor.js";

test("effortDirective returns a tier nudge for high/ultra, nothing for off", () => {
  assert.equal(effortDirective("off"), undefined);
  assert.match(effortDirective("high") ?? "", /HIGH/);
  assert.match(effortDirective("ultra") ?? "", /ULTRA/);
});

// ultracode-cc-parity t01: directives carry the CC-parity content — scale
// ladder, quality-pattern names inline, solo/budget framing — not just
// adjectives.
test("effort directives carry the CC-parity scale ladder and pattern names", () => {
  const high = effortDirective("high") ?? "";
  const ultra = effortDirective("ultra") ?? "";
  for (const d of [high, ultra]) {
    assert.match(d, /token thrift is not the constraint/i);
    assert.ok(/\bverify\(/.test(d), "directive must name verify( inline");
  }
  assert.match(high, /single-vote verify\(item\)/, "ladder low end: few finders + single-vote");
  assert.match(ultra, /reviewers: 3-5/, "ladder high end: 3-5-vote adversarial verify");
  assert.match(ultra, /one workflow per phase/, "ultra carries multi-phase sequencing");
  assert.match(ultra, /completenessCheck\(\)/, "ultra names the completeness critic");
  assert.match(ultra, /judgePanel\(\)/, "ultra names judgePanel");
  assert.match(ultra, /loopUntilDry\(\)/, "ultra names loopUntilDry");
});

test("isSubstantive accepts real requests, rejects terse text and slash commands", () => {
  assert.equal(isSubstantive("audit the auth module for race conditions"), true);
  assert.equal(isSubstantive("ok"), false);
  assert.equal(isSubstantive("/workflows"), false);
  assert.equal(isSubstantive("    "), false);
});

test("buildForcedWorkflowPrompt appends the extra directive only when provided", () => {
  const base = buildForcedWorkflowPrompt("do X");
  assert.ok(!/ULTRA/.test(base), "no directive by default");
  assert.ok(base.startsWith("do X"));
  const ultra = buildForcedWorkflowPrompt("do X", effortDirective("ultra"));
  assert.match(ultra, /ULTRA/, "ultra directive appended");
  assert.ok(ultra.startsWith("do X"));
});

type CmdDef = { handler: (a: string, c: unknown) => Promise<void> };

function registerAndCapture(state: ReturnType<typeof createEffortState>) {
  const cmds = new Map<string, CmdDef>();
  const pi = {
    registerCommand: (name: string, d: unknown) => cmds.set(name, d as CmdDef),
    sendMessage: () => {},
  };
  registerEffortCommand(pi as never, state);
  return cmds;
}

test("registerEffortCommand: /effort toggles the shared state", async () => {
  const state = createEffortState();
  const effort = registerAndCapture(state).get("effort");
  assert.ok(effort, "/effort registered");
  assert.equal(state.level, "off");

  await effort?.handler("ultra", {});
  assert.equal(state.level, "ultra");
  await effort?.handler("high", {});
  assert.equal(state.level, "high");
  await effort?.handler("off", {});
  assert.equal(state.level, "off");
  await effort?.handler("bogus", {});
  assert.equal(state.level, "off", "unknown arg leaves the level unchanged");
});

test("registerEffortCommand: /ultracode turns ultra on, /ultracode off turns it off", async () => {
  const state = createEffortState();
  const ultracode = registerAndCapture(state).get("ultracode");
  assert.ok(ultracode, "/ultracode registered");

  await ultracode?.handler("", {});
  assert.equal(state.level, "ultra", "/ultracode (no arg) sets ultra");
  await ultracode?.handler("off", {});
  assert.equal(state.level, "off", "/ultracode off turns it off");
  await ultracode?.handler("anything", {});
  assert.equal(state.level, "ultra", "/ultracode <anything-but-off> sets ultra");
});
