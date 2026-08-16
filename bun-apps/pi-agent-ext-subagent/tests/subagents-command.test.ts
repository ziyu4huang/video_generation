import { afterEach, beforeEach, test } from "bun:test";
import assert from "node:assert/strict";
import { SubagentInFlightRegistry } from "@repo/pi-agent-core-runtime";
import { createSubagentsCommand } from "../src/subagents-command.js";

// Identity theme so render() returns plain text we can assert on.
const T = { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s, bold: (s: string) => s } as never;

// A fake tui with a spy requestRender so we can confirm the live timer drives
// re-renders.
function fakeTui() {
  let renders = 0;
  return {
    tui: {
      requestRender: () => {
        renders += 1;
      },
    },
    renders: () => renders,
  };
}

// Fake host context: captures the viewer factory pi would invoke, and resolves
// the custom() promise when `done` is called (so the handler can complete).
function harness(branch: unknown[], mode = "tui") {
  let factory: ((tui: unknown, theme: unknown, kb: unknown, done: () => void) => unknown) | undefined;
  let resolveDone: () => void = () => {};
  let lastNotify = "";
  const custom = (f: typeof factory) => {
    factory = f;
    return new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
  };
  return {
    ctx: {
      mode,
      ui: {
        notify: (m: string) => {
          lastNotify = m;
        },
        custom,
      },
      sessionManager: { getBranch: () => branch },
    } as never,
    getFactory: () => factory,
    done: () => resolveDone(),
    lastNotify: () => lastNotify,
  };
}

// Stub the 1s live timer so tests never leak real intervals, and so we can
// assert create/clear counts.
const realSI = globalThis.setInterval;
const realCI = globalThis.clearInterval;
let createdTimers = 0;
let clearedTimers = 0;
beforeEach(() => {
  createdTimers = 0;
  clearedTimers = 0;
  globalThis.setInterval = (() => {
    createdTimers += 1;
    return 1 as never;
  }) as never;
  globalThis.clearInterval = (() => {
    clearedTimers += 1;
  }) as never;
});
afterEach(() => {
  globalThis.setInterval = realSI;
  globalThis.clearInterval = realCI;
});

test("command: non-tui mode notifies and never opens the viewer", async () => {
  const cmd = createSubagentsCommand({ subagentInFlight: new SubagentInFlightRegistry() });
  const h = harness([], "cli");
  await cmd.handler([], h.ctx);
  assert.match(h.lastNotify(), /interactive mode/);
  assert.equal(h.getFactory(), undefined, "ui.custom was not invoked outside tui mode");
});

test("command: a running subagent renders in the Running section with live elapsed", async () => {
  const reg = new SubagentInFlightRegistry();
  reg.start({ id: "r1", agent: "implementer", model: "x/flash", taskPreview: "doing X", startedAt: Date.now() - 1500 });
  const cmd = createSubagentsCommand({ subagentInFlight: reg });
  const h = harness([]);
  const p = cmd.handler([], h.ctx);
  const factory = h.getFactory();
  assert.ok(factory, "ui.custom was invoked in tui mode");
  const { tui, renders } = fakeTui();
  const ret = factory(tui, T, undefined, h.done) as {
    render: (w: number) => string[];
    handleInput: (d: string) => void;
  };
  const out = ret.render(80).join("\n");
  assert.match(out, /Running/);
  assert.ok(out.includes("implementer"), "running entry shows the agent role");
  assert.ok(out.includes("flash"), "running entry shows the (shortened) model");
  assert.match(out, /\d+\.\d+s/, "running entry shows live elapsed");
  ret.handleInput("\x1b"); // esc from list view → onClose → done → handler completes
  await p;
  assert.equal(renders(), 1, "handleInput drove a re-render");
});

test("command: getRunning is live — a subagent added after the viewer opens still appears", async () => {
  const reg = new SubagentInFlightRegistry();
  const cmd = createSubagentsCommand({ subagentInFlight: reg });
  const h = harness([]);
  const p = cmd.handler([], h.ctx);
  const factory = h.getFactory();
  const { tui } = fakeTui();
  const ret = factory(tui, T, undefined, h.done) as {
    render: (w: number) => string[];
    invalidate: () => void;
  };
  assert.ok(!ret.render(80).join("\n").includes("Running"), "no Running section when registry is empty");
  // a subagent starts later — the next render must pick it up (getRunning reads live).
  // The 1s live timer calls invalidate() before re-rendering; simulate that here
  // (the viewer caches by width, so a stale cache would hide the new entry).
  reg.start({ id: "late", agent: "researcher", model: "z/pro", taskPreview: "looking up X", startedAt: Date.now() });
  ret.invalidate();
  const out = ret.render(80).join("\n");
  assert.ok(out.includes("Running"), "Running section appears after a late start");
  assert.ok(out.includes("researcher"), "late-started subagent is listed");
  ret.handleInput("\x1b");
  await p;
});

test("command: the 1s live timer is created on open and cleared on close", async () => {
  const reg = new SubagentInFlightRegistry();
  const cmd = createSubagentsCommand({ subagentInFlight: reg });
  const h = harness([]);
  const p = cmd.handler([], h.ctx);
  const factory = h.getFactory();
  const { tui } = fakeTui();
  const ret = factory(tui, T, undefined, h.done) as { handleInput: (d: string) => void };
  assert.equal(createdTimers, 1, "a live-render timer is created when the viewer opens");
  assert.equal(clearedTimers, 0, "timer is alive while the viewer is open");
  ret.handleInput("\x1b"); // close
  assert.equal(clearedTimers, 1, "timer is cleared when the viewer closes");
  await p;
});
