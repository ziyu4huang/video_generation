/**
 * loop-command.ts (cc-parity-2 ticket 06): pure parse pinning (fixed vs
 * dynamic vs off vs usage) + the registered command's registry effects through
 * a fake ExtensionAPI.
 */

import { test } from "bun:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parseLoopArgs, registerLoopCommand } from "../src/loop-command.js";
import { WAKEUP_DEFAULT_DELAY_S, WakeupRegistry } from "../src/wakeup-registry.js";

const T0 = Date.parse("2026-08-23T12:00:00Z");

test("parse: fixed with explicit interval (unit REQUIRED — s/m/h)", () => {
  assert.deepEqual(parseLoopArgs("30s check CI"), {
    kind: "fixed",
    prompt: "check CI",
    delaySeconds: 60,
    clamped: true,
  });
  assert.deepEqual(parseLoopArgs("5m check CI"), {
    kind: "fixed",
    prompt: "check CI",
    delaySeconds: 300,
    clamped: false,
  });
  assert.deepEqual(parseLoopArgs("1h check CI"), {
    kind: "fixed",
    prompt: "check CI",
    delaySeconds: 3600,
    clamped: false,
  });
  assert.deepEqual(parseLoopArgs("2h check CI"), {
    kind: "fixed",
    prompt: "check CI",
    delaySeconds: 3600,
    clamped: true,
  });
  assert.deepEqual(parseLoopArgs("100ms fast"), { kind: "usage" });
});

test("parse: default cadence, dynamic, off, usage", () => {
  assert.deepEqual(parseLoopArgs("check the logs"), {
    kind: "fixed",
    prompt: "check the logs",
    delaySeconds: WAKEUP_DEFAULT_DELAY_S,
    clamped: false,
  });
  assert.deepEqual(parseLoopArgs("DYNAMIC watch the deploy"), { kind: "dynamic", prompt: "watch the deploy" });
  assert.deepEqual(parseLoopArgs("dynamic   "), { kind: "usage" });
  assert.deepEqual(parseLoopArgs("off"), { kind: "off" });
  assert.deepEqual(parseLoopArgs("OFF"), { kind: "off" });
  assert.deepEqual(parseLoopArgs(""), { kind: "usage" });
  assert.deepEqual(parseLoopArgs("0m nothing"), { kind: "usage" });
  // A prompt that merely STARTS with digits stays a prompt (no unit + no split).
  assert.deepEqual(parseLoopArgs("404 is a fine status code to check"), {
    kind: "fixed",
    prompt: "404 is a fine status code to check",
    delaySeconds: WAKEUP_DEFAULT_DELAY_S,
    clamped: false,
  });
});

interface FakeCommand {
  name: string;
  handler: (args: string) => Promise<void>;
}

function fakePi() {
  const commands = new Map<string, FakeCommand>();
  const messages: string[] = [];
  const pi = {
    registerCommand(name: string, cmd: { handler: (args: string) => Promise<void> }) {
      commands.set(name, { name, handler: cmd.handler });
    },
    sendMessage(msg: { content: string }) {
      messages.push(msg.content);
    },
  };
  return { pi: pi as unknown as ExtensionAPI, commands, messages };
}

test("command: /loop 5m arms a fixed wakeup; /loop off clears everything", async () => {
  const { pi, commands, messages } = fakePi();
  const registry = new WakeupRegistry();
  const activeLoop: { id?: string } = {};
  registerLoopCommand(pi, { registry, activeLoop, now: () => new Date(T0) });

  await commands.get("loop")!.handler("5m check CI");
  const entry = registry.get("loop-1")!;
  assert.ok(entry);
  assert.equal(entry.mode, "fixed");
  assert.equal(entry.delaySeconds, 300);
  assert.equal(entry.dueAt, T0 + 300_000);
  assert.equal(activeLoop.id, "loop-1");
  assert.match(messages.at(-1)!, /loop-1.*started/);

  await commands.get("loop")!.handler("off");
  assert.equal(registry.list().length, 0);
  assert.equal(activeLoop.id, undefined);
  assert.match(messages.at(-1)!, /Stopped 1 loop/);
});

test("command: /loop dynamic arms a due-NOW wakeup (first tick fires it)", async () => {
  const { pi, commands, messages } = fakePi();
  const registry = new WakeupRegistry();
  const activeLoop: { id?: string } = {};
  registerLoopCommand(pi, { registry, activeLoop, now: () => new Date(T0) });

  await commands.get("loop")!.handler("dynamic watch the deploy");
  const entry = registry.get("loop-1")!;
  assert.equal(entry.mode, "dynamic");
  assert.ok(entry.dueAt <= T0, "dynamic is due immediately — the next tick delivers the prompt");
  assert.match(messages.at(-1)!, /dynamic/);

  // A second loop gets its own id; off reports both.
  await commands.get("loop")!.handler("dynamic watch something else");
  assert.ok(registry.get("loop-2"));
  await commands.get("loop")!.handler("off");
  assert.match(messages.at(-1)!, /Stopped 2 loops/);
});

test("command: bare /loop prints usage and arms nothing", async () => {
  const { pi, commands, messages } = fakePi();
  const registry = new WakeupRegistry();
  registerLoopCommand(pi, { registry, activeLoop: {}, now: () => new Date(T0) });
  await commands.get("loop")!.handler("");
  assert.match(messages.at(-1)!, /Usage: \/loop/);
  assert.equal(registry.list().length, 0);
});

// --- status subcommand + bare-word guard (2026-08-24 live incident) ---------

test("parse: bare status/help are subcommands, never prompts", () => {
  assert.deepEqual(parseLoopArgs("status"), { kind: "status" });
  assert.deepEqual(parseLoopArgs("STATUS"), { kind: "status" });
  assert.deepEqual(parseLoopArgs("help"), { kind: "usage" });
  assert.deepEqual(parseLoopArgs("HELP"), { kind: "usage" });
  // NON-bare words stay prompts (the incident guard must not over-reach).
  assert.deepEqual(parseLoopArgs("status of the deploy, please"), {
    kind: "fixed",
    prompt: "status of the deploy, please",
    delaySeconds: WAKEUP_DEFAULT_DELAY_S,
    clamped: false,
  });
});

test("command: /loop status lists armed loops and arms nothing", async () => {
  const { pi, commands, messages } = fakePi();
  const registry = new WakeupRegistry();
  const activeLoop: { id?: string } = {};
  registerLoopCommand(pi, { registry, activeLoop, now: () => new Date(T0) });

  // Empty state: read-only report, nothing armed.
  await commands.get("loop")!.handler("status");
  assert.match(messages.at(-1)!, /No active loops/);
  assert.equal(registry.list().length, 0);

  // Armed state: id, mode, next fire, fire count/cap — and read-only.
  await commands.get("loop")!.handler("5m check CI");
  await commands.get("loop")!.handler("status");
  const report = messages.at(-1)!;
  assert.match(report, /Active loops \(1\)/);
  assert.match(report, /loop-1 \[fixed\] next fire in 300s/);
  assert.match(report, /fire 0\/50/);
  assert.equal(registry.list().length, 1);
  assert.equal(activeLoop.id, "loop-1");

  // /loop help is usage, not a loop named "help".
  await commands.get("loop")!.handler("help");
  assert.match(messages.at(-1)!, /Usage: \/loop/);
  assert.equal(registry.list().length, 1);
});
