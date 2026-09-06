/**
 * agents-viewer.test.ts — the `/agents` list dialog (agents-manager t01).
 * Covers the grouping/precedence order, row + detail rendering, navigation,
 * render totality on partial definitions, and the command factory's ctx
 * contract (mode gate + registry load from the injected cwd).
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { AgentRegistry } from "@repo/s2-agent-core-runtime";
import { createAgentsCommand } from "../src/agents-command.js";
import { AgentsViewer } from "../src/agents-viewer.js";

const T = {
  fg: (_c: string, s: string) => s,
  bg: (_c: string, s: string) => s,
  bold: (s: string) => s,
} as never;

const W = 100;

function def(
  partial: Partial<
    ConstructorParameters<typeof AgentsViewer>[0]["registry"] extends Map<string, infer D> ? D : never
  > & { name: string },
) {
  return {
    prompt: "",
    source: "builtin",
    ...partial,
  } as never as ConstructorParameters<typeof AgentsViewer>[0]["registry"] extends Map<string, infer D> ? D : never;
}

function viewerWith(defs: Array<Record<string, unknown>>): AgentsViewer {
  const registry = new Map<string, never>();
  for (const d of defs) registry.set(d.name as string, d as never);
  return new AgentsViewer({ registry: registry as AgentRegistry, onClose: () => {} }, T);
}

describe("AgentsViewer grouping + order", () => {
  test("groups by source precedence (project → pack → user → builtin), names A→Z inside a group", () => {
    const v = viewerWith([
      { name: "zeta", source: "user", prompt: "" },
      { name: "alpha", source: "builtin", prompt: "" },
      { name: "mid", source: "user", prompt: "" },
      { name: "local", source: "project", prompt: "" },
    ]);
    const out = v.render(W).join("\n");
    const iLocal = out.indexOf("local");
    const iMid = out.indexOf("mid");
    const iZeta = out.indexOf("zeta");
    const iAlpha = out.indexOf("alpha");
    expect(iLocal).toBeGreaterThan(-1);
    expect(iLocal).toBeLessThan(iMid);
    expect(iMid).toBeLessThan(iZeta);
    expect(iZeta).toBeLessThan(iAlpha);
  });

  test("renders section headers with the registry's source labels", () => {
    const out = viewerWith([{ name: "a", source: "project", prompt: "" }])
      .render(W)
      .join("\n");
    expect(out).toContain("project");
    expect(out).toContain(".pi/agents");
  });

  test("row carries description, model/tier, tools count, worktree glyph", () => {
    const out = viewerWith([
      {
        name: "auditor",
        source: "project",
        description: "audits the tree",
        model: "zai/glm-5.3-flash",
        tools: ["read", "bash"],
        isolation: "worktree",
        prompt: "",
      },
    ])
      .render(W)
      .join("\n");
    expect(out).toContain("auditor");
    expect(out).toContain("audits the tree");
    expect(out).toContain("glm-5.3-flash");
    expect(out).toContain("2 tools");
    expect(out).toContain("⎇ worktree");
  });

  test("tier renders as tier:<name> when no model", () => {
    const out = viewerWith([{ name: "scout", source: "user", tier: "small", prompt: "" }])
      .render(W)
      .join("\n");
    expect(out).toContain("tier:small");
  });
});

describe("AgentsViewer navigation + detail", () => {
  test("down + enter opens the detail pane; esc returns; esc closes", () => {
    let closed = false;
    const v = new AgentsViewer(
      {
        registry: new Map([["a", { name: "a", source: "project", prompt: "body line" }]]) as AgentRegistry,
        onClose: () => (closed = true),
      },
      T,
    );
    v.handleInput("\x1b[B"); // down
    v.handleInput("\r"); // enter → detail
    const detail = v.render(W).join("\n");
    expect(detail).toContain("body line");
    expect(detail).toContain("source:");
    v.handleInput("\x1b"); // esc → list
    expect(v.render(W).join("\n")).toContain("Agent types");
    v.handleInput("\x1b"); // esc → close
    expect(closed).toBe(true);
  });

  test("j/k aliases move the cursor", () => {
    const v = viewerWith([
      { name: "a", source: "project", prompt: "" },
      { name: "b", source: "project", prompt: "" },
    ]);
    v.handleInput("j");
    const out = v.render(W).join("\n");
    // cursor marker sits on b's row: find the selected line
    const selected = out.split("\n").find((l) => l.includes("▶"));
    expect(selected).toContain("b");
  });

  test("detail of a definition with an empty prompt degrades to (empty)", () => {
    const v = new AgentsViewer(
      { registry: new Map([["e", { name: "e", source: "user", prompt: " " }]]) as AgentRegistry, onClose: () => {} },
      T,
    );
    v.handleInput("\r");
    expect(v.render(W).join("\n")).toContain("(empty)");
  });
});

describe("AgentsViewer render totality", () => {
  test("partial definitions (missing everything optional) render without throw", () => {
    const v = viewerWith([{ name: "minimal" }]);
    expect(() => v.render(20).join("\n")).not.toThrow();
    expect(v.render(20).length).toBeGreaterThan(0);
  });

  test("narrow width still renders (no throw, content capped)", () => {
    const v = viewerWith([{ name: "wide-name-here", source: "project", description: "x".repeat(300), prompt: "" }]);
    expect(() => v.render(10).join("\n")).not.toThrow();
  });
});

describe("createAgentsCommand", () => {
  test("mode gate: non-tui ctx is refused with a notify, ui.custom never called", async () => {
    let notified = "";
    let customCalled = false;
    const cmd = createAgentsCommand({ cwd: "/tmp" });
    await cmd.handler(undefined, {
      mode: "print",
      ui: {
        notify: (m: string) => (notified = m),
        custom: async () => {
          customCalled = true;
        },
      },
    });
    expect(notified).toContain("requires interactive mode");
    expect(customCalled).toBe(false);
  });

  test("tui ctx: loads the registry from the injected cwd and mounts the viewer", async () => {
    // seeded project dir: one definition file the loader must find
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const cwd = mkdtempSync(join(tmpdir(), "agents-cmd-"));
    mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "agents", "probe.md"),
      "---\nname: probe-agent\ndescription: seeded for the test\ntools: read, bash\n---\nDo the probe.",
    );
    let mounted: { render: (w: number) => string[] } | undefined;
    const cmd = createAgentsCommand({ cwd });
    await cmd.handler(undefined, {
      mode: "tui",
      ui: {
        notify: () => {},
        custom: async (factory) => {
          mounted = factory({ requestRender: () => {} }, T, undefined, () => {}) as {
            render: (w: number) => string[];
          };
        },
      },
    });
    expect(mounted).toBeDefined();
    const out = mounted?.render(W).join("\n") ?? "";
    expect(out).toContain("probe-agent");
    expect(out).toContain("seeded for the test");
  });
});
