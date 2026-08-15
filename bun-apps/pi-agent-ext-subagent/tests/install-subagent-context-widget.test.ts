import { test } from "bun:test";
import assert from "node:assert/strict";
import { buildRunView } from "@repo/pi-agent-ext-core-runtime";
import { installSubagentContextWidget, isCtrlO } from "../src/subagent-context-widget.js";

const T = { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s, bold: (s: string) => s } as never;

/** Minimal fake registry: only `.views()` is read (raw records projected the
 *  way the real registry's views() does — buildRunView + foreground filter). */
function fakeRegistry(list: () => unknown[]) {
  return {
    views: (opts?: { foreground?: boolean }) =>
      list()
        .map((r) => buildRunView(r as never, Date.now()))
        .filter((v) => opts?.foreground === undefined || v.foreground === opts.foreground),
  } as never;
}

/**
 * Narrow a value captured by a callback (the widget factory, a timer callback)
 * to non-undefined. Throws loudly when the code under test never handed it over,
 * which is itself the failure these tests are checking for — unlike `?.`, which
 * would silently skip the call and let the assertions below pass vacuously.
 */
function captured<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`expected ${what} to have been captured`);
  return value;
}

test("(d) install mounts the widget once, ABOVE the editor, keyed 'subagents'", () => {
  const calls: Array<{ key: string; opts: { placement?: string } }> = [];
  const ui = { setWidget: (key: string, _f: unknown, opts: { placement?: string }) => calls.push({ key, opts }) };
  const { dispose } = installSubagentContextWidget(ui as never, {
    registry: fakeRegistry(() => []),
    setInterval: (() => "id") as never,
    clearInterval: () => {},
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].key, "subagents");
  assert.equal(
    calls[0].opts.placement,
    "aboveEditor",
    "default placement is aboveEditor (replaces old belowEditor box)",
  );
  dispose();
});

test("placement can be overridden (e.g. back to belowEditor)", () => {
  const calls: Array<{ opts: { placement?: string } }> = [];
  const ui = { setWidget: (_k: string, _f: unknown, opts: { placement?: string }) => calls.push({ opts }) };
  const { dispose } = installSubagentContextWidget(ui as never, {
    registry: fakeRegistry(() => []),
    placement: "belowEditor",
    setInterval: (() => "id") as never,
    clearInterval: () => {},
  });
  assert.equal(calls[0].opts.placement, "belowEditor");
  dispose();
});

test("factory render reads the registry live and is empty when idle (invisible)", () => {
  let factory: ((tui: unknown, theme: unknown) => { render: () => string[] }) | undefined;
  const ui = {
    setWidget: (_k: string, f: unknown) => {
      factory = f as typeof factory;
    },
  };
  installSubagentContextWidget(ui as never, {
    registry: fakeRegistry(() => []),
    setInterval: (() => "id") as never,
    clearInterval: () => {},
  });
  const comp = captured(factory, "the widget factory")({ requestRender: () => {} }, T);
  assert.deepEqual(comp.render(), []);
});

test("factory render shows a BACKGROUND run and EXCLUDES a foreground run", () => {
  const list: unknown[] = [
    {
      id: "bg",
      agent: "implementer",
      model: "x/flash",
      taskPreview: "doing X",
      startedAt: Date.now() - 1500,
      foreground: false,
      history: [],
    },
    {
      id: "inline",
      agent: "reviewer",
      model: "y/pro",
      taskPreview: "inline task",
      startedAt: Date.now(),
      foreground: true,
      history: [],
    },
  ];
  let factory: ((tui: unknown, theme: unknown) => { render: () => string[] }) | undefined;
  const ui = {
    setWidget: (_k: string, f: unknown) => {
      factory = f as typeof factory;
    },
  };
  installSubagentContextWidget(ui as never, {
    registry: fakeRegistry(() => list),
    setInterval: (() => "id") as never,
    clearInterval: () => {},
  });
  const comp = captured(factory, "the widget factory")({ requestRender: () => {} }, T);
  const out = comp.render().join("\n");
  assert.match(out, /1 background subagent running/, "only the background run is counted");
  assert.ok(out.includes("doing X"), "background run's task appears");
  assert.ok(!out.includes("inline task"), "foreground run is excluded");
});

test("factory render reflects registry changes live (a run appearing mid-flight)", () => {
  const list: unknown[] = [];
  let factory: ((tui: unknown, theme: unknown) => { render: () => string[] }) | undefined;
  const ui = {
    setWidget: (_k: string, f: unknown) => {
      factory = f as typeof factory;
    },
  };
  installSubagentContextWidget(ui as never, {
    registry: fakeRegistry(() => list),
    setInterval: (() => "id") as never,
    clearInterval: () => {},
  });
  const comp = captured(factory, "the widget factory")({ requestRender: () => {} }, T);
  assert.deepEqual(comp.render(), []);
  list.push({
    id: "bg",
    agent: "implementer",
    model: "x/flash",
    taskPreview: "doing X",
    startedAt: Date.now() - 1500,
    foreground: false,
    history: [],
  });
  assert.ok(comp.render().length > 0, "row appears once the registry lists a background run");
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
  // mutable registry list so the tick can flip between idle and live states
  const list: unknown[] = [];
  installSubagentContextWidget(
    ui as never,
    {
      registry: fakeRegistry(() => list),
      setInterval: (fn: () => void) => {
        scheduled = fn;
        return "id";
      },
      clearInterval: () => {},
    } as never,
  );
  captured(factory, "the widget factory")(
    {
      requestRender: () => {
        rendered += 1;
      },
    },
    T,
  );
  assert.ok(scheduled, "a timer callback was registered");
  captured(scheduled, "the timer callback")();
  assert.equal(rendered, 0, "idle tick (no background runs) skips the render (P4 guard)");
  list.push({
    id: "bg",
    agent: "implementer",
    model: "x/flash",
    taskPreview: "doing X",
    startedAt: Date.now() - 1500,
    foreground: false,
    history: [],
  });
  captured(scheduled, "the timer callback")();
  assert.equal(rendered, 1, "the timer tick calls requestRender while a background run is live");
});

test("timer starts exactly once even if the app invokes the factory twice", () => {
  let starts = 0;
  let factory: ((tui: unknown, theme: unknown) => unknown) | undefined;
  const ui = {
    setWidget: (_k: string, f: unknown) => {
      factory = f as typeof factory;
    },
  };
  installSubagentContextWidget(
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
  const invoke = captured(factory, "the widget factory");
  invoke(tui, T);
  invoke(tui, T); // second invocation (e.g. theme change) must NOT start a second interval
  assert.equal(starts, 1);
});

test("dispose clears the refresh interval returned by setInterval", () => {
  let cleared: unknown;
  let factory: ((tui: unknown, theme: unknown) => unknown) | undefined;
  const ui = {
    setWidget: (_k: string, f: unknown) => {
      factory = f as typeof factory;
    },
  };
  const { dispose } = installSubagentContextWidget(
    ui as never,
    {
      registry: fakeRegistry(() => []),
      setInterval: (() => "id-42") as never,
      clearInterval: (id: unknown) => {
        cleared = id;
      },
    } as never,
  );
  // The timer starts when the app invokes the factory (NOT at install time) —
  // mirror that lifecycle before asserting dispose clears it. dispose() before
  // any factory invocation is a no-op (timerId never set).
  captured(factory, "the widget factory")({ requestRender: () => {} }, T);
  dispose();
  assert.equal(cleared, "id-42", "dispose clears the interval id once the factory has started it");
});

test("dispose before factory invocation is a safe no-op (timer never started)", () => {
  let cleared = 0;
  const { dispose } = installSubagentContextWidget(
    { setWidget: () => {} } as never,
    {
      registry: fakeRegistry(() => []),
      setInterval: (() => "id-42") as never,
      clearInterval: () => {
        cleared += 1;
      },
    } as never,
  );
  dispose();
  assert.equal(cleared, 0, "no interval to clear when the factory was never invoked");
});

test("install is a safe no-op when ui has no setWidget (headless/RPC)", () => {
  const handle = installSubagentContextWidget(undefined as never, { registry: fakeRegistry(() => []) });
  assert.doesNotThrow(() => handle.dispose());
  // ticket 03: the headless no-op handle also exposes a safe toggle().
  assert.doesNotThrow(() => handle.toggle());
});

// --- ticket 03: the installer handle exposes toggle() (drives Ctrl-O) ---

test("handle.toggle() flips the box to expanded and requests a re-render", () => {
  let rendered = 0;
  let factory: ((tui: unknown, theme: unknown) => unknown) | undefined;
  const ui = {
    setWidget: (_k: string, f: unknown) => {
      factory = f as typeof factory;
    },
  };
  const handle = installSubagentContextWidget(ui as never, {
    registry: fakeRegistry(() => []),
    setInterval: (() => "id") as never,
    clearInterval: () => {},
  });
  // The host invokes the factory with the TUI; toggle() needs that reference
  // to request a render. Before that, toggle() still flips state but cannot
  // requestRender (no TUI yet) — it must not throw.
  assert.doesNotThrow(() => handle.toggle());
  captured(factory, "the widget factory")(
    {
      requestRender: () => {
        rendered += 1;
      },
    },
    T,
  );
  // Sanity: the internal expanded flag flipped once above; flip again and a
  // render must be requested via the captured TUI.
  handle.toggle();
  assert.equal(rendered, 1, "toggle() drives tui.requestRender once the factory has run");
});

test("Ctrl-O input toggles the box via the onTerminalInput handler shape", () => {
  // Mirrors the handler registered in extensions/subagent.ts: on a chunk
  // containing 0x0F the handle's toggle() is invoked; on other input it is not.
  // The handler always returns { consume: false } so the byte ALSO reaches the
  // editor's `app.tools.expand` keybinding (coexistence — both surfaces toggle).
  let toggles = 0;
  let factory: ((tui: unknown, theme: unknown) => unknown) | undefined;
  const ui = {
    setWidget: (_k: string, f: unknown) => {
      factory = f as typeof factory;
    },
  };
  const handle = installSubagentContextWidget(ui as never, {
    registry: fakeRegistry(() => []),
    setInterval: (() => "id") as never,
    clearInterval: () => {},
  });
  // wrap toggle() to count invocations (simulates the onTerminalInput body)
  const fire = (data: string): { consume: boolean } => {
    if (isCtrlO(data)) {
      handle.toggle();
      toggles += 1;
    }
    return { consume: false };
  };
  captured(factory, "the widget factory")({ requestRender: () => {} }, T);
  fire("hello");
  fire("\x1b[A");
  assert.equal(toggles, 0, "non-Ctrl-O input does not toggle");
  fire("\x0f");
  assert.equal(toggles, 1, "bare Ctrl-O toggles once");
  fire("ab\x0fcd");
  assert.equal(toggles, 2, "Ctrl-O inside a larger chunk still toggles");
});
