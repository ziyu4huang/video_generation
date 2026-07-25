import { test } from "bun:test";
import assert from "node:assert/strict";
import { installSubagentProgressWidget } from "../src/subagent-progress-widget.js";

const T = { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s, bold: (s: string) => s } as never;

/** Minimal fake registry: only `.list()` is read. */
function fakeRegistry(list: () => unknown[]) {
  return { list } as never;
}

test("install mounts the widget once, below the editor, keyed 'subagents'", () => {
  const calls: Array<{ key: string; opts: { placement?: string } }> = [];
  const ui = { setWidget: (key: string, _f: unknown, opts: { placement?: string }) => calls.push({ key, opts }) };
  const { dispose } = installSubagentProgressWidget(ui as never, {
    registry: fakeRegistry(() => []),
    setInterval: (() => "id") as never,
    clearInterval: () => {},
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].key, "subagents");
  assert.equal(calls[0].opts.placement, "belowEditor");
  dispose();
});

test("factory render reads the registry live and is empty when idle", () => {
  let factory: ((tui: unknown, theme: unknown) => { render: () => string[] }) | undefined;
  const ui = {
    setWidget: (_k: string, f: unknown) => {
      factory = f as typeof factory;
    },
  };
  installSubagentProgressWidget(ui as never, {
    registry: fakeRegistry(() => []),
    setInterval: (() => "id") as never,
    clearInterval: () => {},
  });
  const comp = factory!({ requestRender: () => {} }, T);
  assert.deepEqual(comp.render(), []);
});

test("factory render shows a running subagent once the registry has one", () => {
  const list: unknown[] = [];
  let factory: ((tui: unknown, theme: unknown) => { render: () => string[] }) | undefined;
  const ui = {
    setWidget: (_k: string, f: unknown) => {
      factory = f as typeof factory;
    },
  };
  installSubagentProgressWidget(ui as never, {
    registry: fakeRegistry(() => list),
    setInterval: (() => "id") as never,
    clearInterval: () => {},
  });
  const comp = factory!({ requestRender: () => {} }, T);
  assert.deepEqual(comp.render(), []);
  list.push({
    id: "r1",
    agent: "implementer",
    model: "x/flash",
    taskPreview: "doing X",
    startedAt: Date.now() - 1500,
    history: [{ role: "assistant", kind: "toolCall", toolName: "read", text: "{}" }],
  });
  assert.ok(comp.render().length > 0, "row appears once the registry lists a run");
});

test("the timer callback calls tui.requestRender (elapsed ticks between events)", () => {
  let scheduled: (() => void) | undefined;
  let rendered = 0;
  let factory: ((tui: unknown, theme: unknown) => unknown) | undefined;
  const ui = {
    setWidget: (_k: string, f: unknown) => {
      factory = f as typeof factory;
    },
  };
  installSubagentProgressWidget(
    ui as never,
    {
      registry: fakeRegistry(() => []),
      setInterval: (fn: () => void) => {
        scheduled = fn;
        return "id";
      },
      clearInterval: () => {},
    } as never,
  );
  factory!(
    {
      requestRender: () => {
        rendered += 1;
      },
    },
    T,
  );
  assert.ok(scheduled, "a timer callback was registered");
  scheduled!();
  assert.equal(rendered, 1, "the timer tick calls requestRender");
});

test("timer starts exactly once even if the app invokes the factory twice", () => {
  let starts = 0;
  let factory: ((tui: unknown, theme: unknown) => unknown) | undefined;
  const ui = {
    setWidget: (_k: string, f: unknown) => {
      factory = f as typeof factory;
    },
  };
  installSubagentProgressWidget(
    ui as never,
    {
      registry: fakeRegistry(() => []),
      setInterval: () => {
        starts += 1;
        return "id";
      },
      clearInterval: () => {},
    } as never,
  );
  const tui = { requestRender: () => {} };
  factory!(tui, T);
  factory!(tui, T); // second invocation (e.g. theme change) must NOT start a second interval
  assert.equal(starts, 1);
});

test("install is a safe no-op when ui has no setWidget (headless/RPC)", () => {
  const { dispose } = installSubagentProgressWidget(undefined as never, { registry: fakeRegistry(() => []) });
  assert.doesNotThrow(() => dispose());
});
