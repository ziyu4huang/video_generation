import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerCommands } from "../src/commands.js";
import { WAYFIND_ACTIVE_KEY } from "../src/constants.js";
import { isWayfindActivePublished } from "../src/coordination.js";
import { createRuntimeState, isGrillActive, type RuntimeState } from "../src/state.js";

/** Minimal ExtensionAPI mock: captures registered commands into a Map and
 *  records sendUserMessage calls. commands.ts only type-imports the real API,
 *  so no mock.module is needed. */
interface MockPi {
  commands: Map<string, (args: string, ctx: any) => Promise<void>>;
  sent: string[];
  registerCommand: (name: string, cmd: { handler: (args: string, ctx: any) => Promise<void> }) => void;
  sendUserMessage: (content: string) => void;
}

function createPi(): MockPi {
  const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
  const sent: string[] = [];
  return {
    commands,
    sent,
    registerCommand: (name, cmd) => {
      commands.set(name, cmd.handler);
    },
    sendUserMessage: (content) => {
      sent.push(content);
    },
  };
}

function makeCtx(cwd: string): any {
  return {
    cwd,
    sessionManager: { getSessionId: () => "test-session" },
    ui: {
      notify: () => {},
      setStatus: () => {},
    },
  };
}

const tempRoots: string[] = [];

function makeCwd(): string {
  const cwd = mkdtempSync(join(tmpdir(), "wayfind-cmd-"));
  tempRoots.push(cwd);
  return cwd;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
  // Clean the published seam between tests.
  delete (globalThis as Record<string, unknown>)[WAYFIND_ACTIVE_KEY];
});

function setup(): { pi: MockPi; state: RuntimeState } {
  const state = createRuntimeState();
  const pi = createPi();
  registerCommands(pi as unknown as Parameters<typeof registerCommands>[0], state);
  return { pi, state };
}

const run = (pi: MockPi, name: string, args = "", ctx?: any) =>
  pi.commands.get(name)?.(args, ctx ?? makeCtx(makeCwd()));

describe("registerCommands — command surface", () => {
  it("registers grill-me, grill-me-with-docs, grill-done, domain-modeling", () => {
    const { pi } = setup();
    for (const name of ["grill-me", "grill-me-with-docs", "grill-done", "domain-modeling"]) {
      expect(pi.commands.has(name)).toBe(true);
    }
  });
});

describe("grill-me / grill-me-with-docs — kickoff", () => {
  it("grill-me sets the active flag, publishes the seam, and sends a priming message", async () => {
    const { pi, state } = setup();
    const ctx = makeCtx(makeCwd());
    await run(pi, "grill-me", "pick a database", ctx);
    expect(isGrillActive(state, "test-session")).toBe(true);
    expect(isWayfindActivePublished()).toBe(true);
    expect(pi.sent.length).toBe(1);
    expect(pi.sent[0]).toContain("grilling session");
    expect(pi.sent[0]).toContain("pick a database");
  });

  it("grill-me-with-docs priming includes the domain-modeling capture discipline", async () => {
    const { pi } = setup();
    await run(pi, "grill-me-with-docs", "auth redesign");
    expect(pi.sent[0]).toContain("grill-me-with-docs");
    expect(pi.sent[0]).toContain("CONTEXT.md");
    expect(isWayfindActivePublished()).toBe(true);
  });
});

describe("grill-done — end + handoff", () => {
  it("clears the active flag and unpublishes the seam when no sessions remain", async () => {
    const { pi, state } = setup();
    await run(pi, "grill-me", "topic");
    expect(isWayfindActivePublished()).toBe(true);
    await run(pi, "grill-done", "");
    expect(isGrillActive(state, "test-session")).toBe(false);
    expect(isWayfindActivePublished()).toBe(false);
  });

  it("notifies 'no active grill' when none is running", async () => {
    const { pi } = setup();
    // No grill started → handler returns early; no message sent.
    await run(pi, "grill-done", "");
    expect(pi.sent.length).toBe(0);
  });

  it("--seed-plan writes a task_plan.md with at least one phase + sends an expand message", async () => {
    const { pi } = setup();
    const cwd = makeCwd();
    const ctx = makeCtx(cwd);
    // Start a with-docs grill + write a CONTEXT.md so the glossary is picked up.
    await pi.commands.get("grill-me-with-docs")?.("orders service", ctx);
    writeFileSync(join(cwd, "CONTEXT.md"), "**Order**: a request to purchase.\n", "utf-8");
    // End with --seed-plan.
    await pi.commands.get("grill-done")?.("--seed-plan", ctx);

    const seedPath = join(cwd, "task_plan.md");
    expect(existsSync(seedPath)).toBe(true);
    const seed = readFileSync(seedPath, "utf-8");
    expect(seed).toContain("### Phase");
    expect(seed).toContain("Order"); // glossary term carried through
    // an expansion message was sent to the agent
    expect(pi.sent.some((m) => m.includes("task_plan.md"))).toBe(true);
  });

  it("--seed-plan with no with-docs grill and no CONTEXT.md still seeds (skeleton from topic)", async () => {
    const { pi } = setup();
    const cwd = makeCwd();
    const ctx = makeCtx(cwd);
    await pi.commands.get("grill-me")?.("some topic", ctx); // plain grill, no CONTEXT.md
    await pi.commands.get("grill-done")?.("--seed-plan", ctx);
    const seed = readFileSync(join(cwd, "task_plan.md"), "utf-8");
    expect(seed).toContain("some topic");
    expect(seed).toContain("### Phase");
  });
});

describe("domain-modeling — direct kickoff", () => {
  it("sends a domain-modeling priming message", async () => {
    const { pi } = setup();
    await run(pi, "domain-modeling", "");
    expect(pi.sent.length).toBe(1);
    expect(pi.sent[0]).toContain("domain-modeling");
    expect(pi.sent[0]).toContain("CONTEXT.md");
  });
});
