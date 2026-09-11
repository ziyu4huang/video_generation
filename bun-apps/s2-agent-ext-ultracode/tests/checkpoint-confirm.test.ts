import { describe, expect, test } from "bun:test";
import { type CheckpointUiSurface, createCheckpointConfirm } from "../src/checkpoint-confirm.js";

/**
 * Self-arc-24 t01 — the options-aware checkpoint UI adapter matrix. Before this
 * the tool boundary collapsed every checkpoint kind to a yes/no ui.confirm.
 */

type DialogCall = { fn: string; args: unknown[] };

/** Capture-args fake: records the last dialog invocation. */
function fakeUi(opts: Partial<CheckpointUiSurface>): { ui: CheckpointUiSurface; calls: DialogCall[] } {
  const calls: DialogCall[] = [];
  const ui: CheckpointUiSurface = {};
  const { confirm, select, input } = opts;
  if (confirm) {
    const bound = confirm;
    ui.confirm = (...args) => {
      calls.push({ fn: "confirm", args });
      return bound(...args);
    };
  }
  if (select) {
    const bound = select;
    ui.select = (...args) => {
      calls.push({ fn: "select", args });
      return bound(...args);
    };
  }
  if (input) {
    const bound = input;
    ui.input = (...args) => {
      calls.push({ fn: "input", args });
      return bound(...args);
    };
  }
  return { ui, calls };
}

function expectConfirm(
  confirm: ReturnType<typeof createCheckpointConfirm>,
): asserts confirm is NonNullable<typeof confirm> {
  if (!confirm) throw new Error("expected createCheckpointConfirm to return a callback");
}

function first<T>(arr: T[]): T {
  const v = arr[0];
  if (v === undefined) throw new Error("expected at least one captured call");
  return v;
}

const signal = new AbortController().signal;

describe("createCheckpointConfirm", () => {
  test("no ui → undefined (runtime takes its headless path)", () => {
    expect(createCheckpointConfirm(undefined)).toBeUndefined();
  });

  test("kind select routes to ui.select with choices, live timeout + abort signal", async () => {
    const { ui, calls } = fakeUi({ select: async () => "Option B" });
    const confirm = createCheckpointConfirm(ui);
    expectConfirm(confirm);
    const reply = await confirm("Pick a lane", {
      kind: "select",
      choices: ["Option A", "Option B"],
      timeoutMs: 5000,
      signal,
    });
    expect(reply).toBe("Option B");
    expect(calls).toHaveLength(1);
    expect(first(calls).fn).toBe("select");
    const [title, choices, dialogOpts] = first(calls).args as [
      string,
      string[],
      { timeout?: number; signal?: AbortSignal },
    ];
    expect(title).toContain("Pick a lane");
    expect(choices).toEqual(["Option A", "Option B"]);
    expect(dialogOpts.timeout).toBe(5000);
    expect(dialogOpts.signal).toBe(signal);
  });

  test("kind select dismissed (undefined) falls back to declared default", async () => {
    const { ui } = fakeUi({ select: async () => undefined });
    const confirm = createCheckpointConfirm(ui);
    expectConfirm(confirm);
    const reply = await confirm("Pick", { kind: "select", choices: ["a", "b"], default: "b" });
    expect(reply).toBe("b");
  });

  test("kind select without choices falls back to confirm (not select)", async () => {
    const { ui, calls } = fakeUi({ confirm: async () => true });
    const confirm = createCheckpointConfirm(ui);
    expectConfirm(confirm);
    const reply = await confirm("Proceed?", { kind: "select" });
    expect(reply).toBe(true);
    expect(first(calls).fn).toBe("confirm");
  });

  test("kind input routes to ui.input; string default becomes placeholder; dismissed → default", async () => {
    const { ui, calls } = fakeUi({ input: async () => "typed answer" });
    const confirm = createCheckpointConfirm(ui);
    expectConfirm(confirm);
    const reply = await confirm("Name the branch", { kind: "input", default: "main", timeoutMs: 1000 });
    expect(reply).toBe("typed answer");
    const [title, placeholder, dialogOpts] = first(calls).args as [
      string,
      string | undefined,
      { timeout?: number } | undefined,
    ];
    expect(title).toContain("Name the branch");
    expect(placeholder).toBe("main");
    expect(dialogOpts?.timeout).toBe(1000);

    const { ui: ui2 } = fakeUi({ input: async () => undefined });
    const confirm2 = createCheckpointConfirm(ui2);
    expectConfirm(confirm2);
    expect(await confirm2("Name the branch", { kind: "input", default: "main" })).toBe("main");
  });

  test("default kind confirm keeps the yes/no gate and threads dialog opts", async () => {
    const { ui, calls } = fakeUi({ confirm: async () => false });
    const confirm = createCheckpointConfirm(ui);
    expectConfirm(confirm);
    const reply = await confirm("Proceed?", { timeoutMs: 250, signal });
    expect(reply).toBe(false);
    const [title, message, dialogOpts] = first(calls).args as [
      string,
      string,
      { timeout?: number; signal?: AbortSignal } | undefined,
    ];
    expect(title).toBe("Workflow checkpoint");
    expect(message).toBe("Proceed?");
    expect(dialogOpts?.timeout).toBe(250);
    expect(dialogOpts?.signal).toBe(signal);
  });

  test("ui without the needed widget resolves the declared default (?? true)", async () => {
    const confirm = createCheckpointConfirm({});
    expectConfirm(confirm);
    expect(await confirm("x", { kind: "select", choices: ["a"], default: "a" })).toBe("a");
    expect(await confirm("x", {})).toBe(true);
    expect(await confirm("x", { default: false })).toBe(false);
  });

  test("select options hash stays independent of the widget reply (resume replay stability)", async () => {
    // The journal hash covers promptText/kind/choices — NOT the picked value —
    // so the same options must reach the runtime regardless of what was picked.
    const { ui, calls } = fakeUi({ select: async () => "a" });
    const confirm = createCheckpointConfirm(ui);
    expectConfirm(confirm);
    await confirm("q", { kind: "select", choices: ["a", "b"] });
    expect(first(calls).args[1]).toEqual(["a", "b"]);
  });
});
