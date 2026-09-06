/**
 * agents-viewer.test.ts — the `/agents` manager dialog (agents-manager t01
 * list/detail + t02 CRUD). Covers the grouping/precedence order, row + detail
 * rendering, navigation, render totality on partial definitions, the
 * create/edit/delete flows against real temp dirs, and the command factory's
 * ctx contract (mode gate + registry load from the injected cwd).
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRegistry } from "@repo/s2-agent-core-runtime";
import { loadAgentRegistry } from "@repo/s2-agent-core-runtime";
import { createAgentsCommand } from "../src/agents-command.js";
import { AgentsViewer } from "../src/agents-viewer.js";

const T = {
  fg: (_c: string, s: string) => s,
  bg: (_c: string, s: string) => s,
  bold: (s: string) => s,
} as never;

const W = 100;

/** Real temp dirs + a live registry, so CRUD tests assert on actual files. */
function crudSetup(seed?: { file: string; content: string }) {
  const root = mkdtempSync(join(tmpdir(), "agents-crud-"));
  const projectDir = join(root, "project-agents");
  const userDir = join(root, "user-agents");
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(userDir, { recursive: true });
  if (seed) writeFileSync(join(projectDir, seed.file), seed.content, "utf-8");
  const dirs = { project: projectDir, user: userDir, packDirs: [] as string[] };
  const load = () => loadAgentRegistry(root, { projectDir, userDir });
  const viewer = new AgentsViewer({ registry: load(), onClose: () => {}, dirs, onReload: load }, T);
  return {
    viewer,
    dirs,
    projectDir,
    userDir,
    read: (name: string): string | undefined => {
      const p = join(projectDir, name);
      return existsSync(p) ? readFileSync(p, "utf-8") : undefined;
    },
    readUser: (name: string): string | undefined => {
      const p = join(userDir, name);
      return existsSync(p) ? readFileSync(p, "utf-8") : undefined;
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** Feed a string to the dialog one char at a time (how a pty delivers it). */
function type(v: AgentsViewer, s: string): void {
  for (const ch of s) v.handleInput(ch);
}

function viewerWith(defs: Array<Record<string, unknown>>): AgentsViewer {
  const registry = new Map<string, never>();
  for (const d of defs) registry.set(d.name as string, d as never);
  return new AgentsViewer(
    {
      registry: registry as AgentRegistry,
      onClose: () => {},
      dirs: { project: "/tmp/agents-viewer-none", user: "/tmp/agents-viewer-none2", packDirs: [] },
      onReload: () => registry as AgentRegistry,
    },
    T,
  );
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
    const registry = new Map([["a", { name: "a", source: "project", prompt: "body line" }]]) as AgentRegistry;
    const v = new AgentsViewer(
      {
        registry,
        onClose: () => (closed = true),
        dirs: { project: "/tmp/agents-viewer-none", user: "/tmp/agents-viewer-none2", packDirs: [] },
        onReload: () => registry,
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
    const registry = new Map([["e", { name: "e", source: "user", prompt: " " }]]) as AgentRegistry;
    const v = new AgentsViewer(
      {
        registry,
        onClose: () => {},
        dirs: { project: "/tmp/agents-viewer-none", user: "/tmp/agents-viewer-none2", packDirs: [] },
        onReload: () => registry,
      },
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

describe("AgentsViewer create/edit/delete (t02, real dirs)", () => {
  test("c opens the create form; filling name + description saves a project file", () => {
    const s = crudSetup();
    try {
      const v = s.viewer;
      v.handleInput("c");
      expect(v.render(W).join("\n")).toContain("New agentType");
      type(v, "flow-agent");
      v.handleInput("\t"); // → description
      type(v, "created by the test");
      v.handleInput("\r"); // save
      const file = s.read("flow-agent.md");
      expect(file).toBeDefined();
      expect(file).toContain("name: flow-agent");
      expect(file).toContain("description: created by the test");
      const out = v.render(W).join("\n");
      expect(out).toContain("saved");
      expect(out).toContain("flow-agent");
    } finally {
      s.cleanup();
    }
  });

  test("invalid name renders the kebab-case error inline and writes nothing", () => {
    const s = crudSetup();
    try {
      const v = s.viewer;
      v.handleInput("c");
      type(v, "Bad Name");
      v.handleInput("\r");
      expect(v.render(W).join("\n")).toContain("kebab-case");
      expect(s.read("Bad Name.md")).toBeUndefined();
      // esc cancels back to the list
      v.handleInput("\x1b");
      expect(v.render(W).join("\n")).toContain("Agent types");
    } finally {
      s.cleanup();
    }
  });

  test("e preloads the selected definition; edited description + preserved prompt land on disk", () => {
    const s = crudSetup({
      file: "seeded.md",
      content: "---\nname: seeded\ndescription: before edit\n---\nKEEP THIS BODY",
    });
    try {
      const v = s.viewer;
      v.handleInput("e"); // first row = seeded (project group sorts first)
      const form = v.render(W).join("\n");
      expect(form).toContain("Edit seeded");
      expect(form).toContain("before edit");
      v.handleInput("\t"); // → description
      v.handleInput("\x15"); // ctrl+u clears the field
      type(v, "after edit");
      v.handleInput("\r"); // save
      const file = s.read("seeded.md");
      expect(file).toContain("description: after edit");
      expect(file).toContain("KEEP THIS BODY");
    } finally {
      s.cleanup();
    }
  });

  test("d asks y/N; n keeps the file, y removes it and the list reloads", () => {
    const s = crudSetup({ file: "doomed.md", content: "---\nname: doomed\n---\nbody" });
    try {
      const v = s.viewer;
      v.handleInput("d");
      const confirm = v.render(W).join("\n");
      expect(confirm).toContain("Delete definition");
      expect(confirm).toContain("y confirm delete");
      v.handleInput("n");
      expect(s.read("doomed.md")).toBeDefined();
      v.handleInput("d");
      v.handleInput("y");
      expect(s.read("doomed.md")).toBeUndefined();
      expect(v.render(W).join("\n")).toContain("deleted");
      expect(v.render(W).join("\n")).not.toContain("doomed");
    } finally {
      s.cleanup();
    }
  });

  test("builtin rows refuse e/d with a view-only status line", () => {
    const s = crudSetup();
    try {
      const v = s.viewer;
      // registry with only temp dirs → builtin tier present (explore/plan);
      // navigate past nothing — builtins come last, walk down to one.
      let refused = false;
      for (let i = 0; i < 10 && !refused; i++) {
        v.handleInput("j");
        v.handleInput("e");
        refused = v.render(W).join("\n").includes("view-only");
      }
      expect(refused).toBe(true);
      v.handleInput("d");
      expect(v.render(W).join("\n")).not.toContain("Delete definition");
    } finally {
      s.cleanup();
    }
  });

  test("scope row: tab to scope, space toggles to user, save lands in the user dir", () => {
    const s = crudSetup();
    try {
      const v = s.viewer;
      v.handleInput("c");
      type(v, "user-scoped");
      for (let i = 0; i < 7; i++) v.handleInput("\t"); // name → … → scope
      v.handleInput(" "); // toggle project → user
      v.handleInput("\r");
      expect(s.readUser("user-scoped.md")).toBeDefined();
      expect(s.read("user-scoped.md")).toBeUndefined();
    } finally {
      s.cleanup();
    }
  });

  test("renaming in edit mode moves the definition (old canonical file removed)", () => {
    const s = crudSetup({ file: "old-name.md", content: "---\nname: old-name\n---\nbody" });
    try {
      const v = s.viewer;
      v.handleInput("e"); // preload old-name
      v.handleInput("\x15"); // clear the name field
      type(v, "new-name");
      v.handleInput("\r");
      expect(s.read("old-name.md")).toBeUndefined();
      expect(s.read("new-name.md")).toBeDefined();
    } finally {
      s.cleanup();
    }
  });
});

describe("wiring guard (t03)", () => {
  test("/agents is registered by the subagent extension through createAgentsCommand", () => {
    // Source pin: the registration is one line — if it moves or renames, the
    // /agents surface silently vanishes while every unit test stays green.
    const src = readFileSync(join(import.meta.dir, "..", "extensions", "subagent.ts"), "utf8");
    expect(src).toContain('pi.registerCommand("agents"');
    expect(src).toContain("createAgentsCommand");
  });
  // The host-shadow half of the guard (a host builtin claiming /agents) can't
  // be pinned from source — it is proven LIVE by the tui-drive `agents`
  // scenario: `dialogOpened` asserts the screen that /agents opens is THIS
  // dialog ("Agent types" + the seeded project row), not a host builtin.
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
