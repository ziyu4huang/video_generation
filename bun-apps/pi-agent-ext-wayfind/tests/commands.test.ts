import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerCommands } from "../src/commands.js";
import { WAYFIND_ACTIVE_KEY } from "../src/constants.js";
import { isWayfindActivePublished } from "../src/coordination.js";
import { readMap, writeMap, writeTicket } from "../src/map.js";
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

// ─── /chain-sync + touchpoint auto-sync (ADR-0001 feedback handle) ──────────
describe("chain-sync — close tickets whose phase completed", () => {
  const PHASES_KEY = "__piPlanPhases";
  afterEach(() => {
    delete (globalThis as Record<string, unknown>)[PHASES_KEY];
  });

  function seedEffort(cwd: string, effort: string): void {
    writeMap(cwd, {
      effort,
      destination: "demo",
      notes: "",
      decisions: [],
      fog: [],
      outOfScope: [],
      tickets: [],
    });
    writeTicket(cwd, effort, {
      id: "03",
      slug: "foo",
      title: "Foo",
      question: "q",
      type: "task",
      blocking: [],
      status: "open",
    });
  }
  function ctxWithCapturedNotify(cwd: string): { ctx: any; notifications: string[] } {
    const notifications: string[] = [];
    return {
      ctx: {
        cwd,
        sessionManager: { getSessionId: () => "test-session" },
        ui: { notify: (m: string) => notifications.push(m), setStatus: () => {} },
      },
      notifications,
    };
  }

  it("is registered", () => {
    const { pi } = setup();
    expect(pi.commands.has("chain-sync")).toBe(true);
  });

  it("closes the matching ticket and notifies the summary", async () => {
    const { pi } = setup();
    const cwd = makeCwd();
    const effort = "demo";
    seedEffort(cwd, effort);
    (globalThis as Record<string, unknown>)[PHASES_KEY] = () => [
      { id: "1", status: "complete", ticketIds: ["03-foo"] },
    ];
    const { ctx, notifications } = ctxWithCapturedNotify(cwd);

    await pi.commands.get("chain-sync")?.(effort, ctx);

    const map = readMap(cwd, effort);
    expect(map?.tickets.find((t) => t.id === "03")?.status).toBe("closed");
    expect(notifications.some((n) => n.includes("03-foo") || n.includes("Foo"))).toBe(true);
  });

  it("notifies a graceful no-op when pwf is absent (no ticket touched)", async () => {
    const { pi } = setup();
    const cwd = makeCwd();
    const effort = "demo";
    seedEffort(cwd, effort);
    delete (globalThis as Record<string, unknown>)[PHASES_KEY];
    const { ctx, notifications } = ctxWithCapturedNotify(cwd);

    await pi.commands.get("chain-sync")?.(effort, ctx);

    expect(readMap(cwd, effort)?.tickets.every((t) => t.status === "open")).toBe(true);
    expect(notifications.some((n) => n.includes("nothing") || n.toLowerCase().includes("no "))).toBe(true);
  });

  it("/wayfinder-status auto-syncs before rendering (touchpoint closure)", async () => {
    const { pi } = setup();
    const cwd = makeCwd();
    const effort = "demo";
    seedEffort(cwd, effort);
    (globalThis as Record<string, unknown>)[PHASES_KEY] = () => [
      { id: "1", status: "complete", ticketIds: ["03-foo"] },
    ];
    const { ctx } = ctxWithCapturedNotify(cwd);

    await pi.commands.get("wayfinder-status")?.(effort, ctx);

    // The touchpoint auto-call closed the ticket before status was rendered.
    expect(readMap(cwd, effort)?.tickets.find((t) => t.id === "03")?.status).toBe("closed");
  });
});

// ─── /plan-seed — route-aware forward bridge (tickets/decisions → task_plan.md) ──
describe("plan-seed — route-aware forward bridge", () => {
  function ctxWithCapturedNotify(cwd: string): { ctx: any; notifications: string[] } {
    const notifications: string[] = [];
    return {
      ctx: {
        cwd,
        sessionManager: { getSessionId: () => "test-session" },
        ui: { notify: (m: string) => notifications.push(m), setStatus: () => {} },
      },
      notifications,
    };
  }

  it("is registered", () => {
    const { pi } = setup();
    expect(pi.commands.has("plan-seed")).toBe(true);
  });

  it("flattens an effort's tickets into .planning/<effort>/task_plan.md (topo order, parseable)", async () => {
    const { pi } = setup();
    const cwd = makeCwd();
    const effort = "demo";
    writeMap(cwd, {
      effort,
      destination: "d",
      notes: "",
      decisions: [],
      fog: [],
      outOfScope: [],
      tickets: [],
    });
    writeTicket(cwd, effort, {
      id: "02",
      slug: "beta",
      title: "Beta",
      question: "q",
      type: "task",
      blocking: ["01"],
      status: "open",
    });
    writeTicket(cwd, effort, {
      id: "01",
      slug: "alpha",
      title: "Alpha",
      question: "q",
      type: "task",
      blocking: [],
      status: "open",
    });
    const { ctx, notifications } = ctxWithCapturedNotify(cwd);

    await pi.commands.get("plan-seed")?.(effort, ctx);

    const planPath = join(cwd, ".planning", effort, "task_plan.md");
    expect(existsSync(planPath)).toBe(true);
    const plan = readFileSync(planPath, "utf-8");
    // topo order: 01 before 02 (even though 02 was written first)
    expect(plan).toMatch(/### Phase 1 — \[01-alpha\] Alpha/);
    expect(plan).toMatch(/### Phase 2 — \[02-beta\] Beta/);
    expect(notifications.some((n) => n.includes("task_plan.md"))).toBe(true);
  });

  it("refuses to overwrite an existing task_plan.md (notifies, leaves file intact)", async () => {
    const { pi } = setup();
    const cwd = makeCwd();
    const effort = "demo";
    mkdirSync(join(cwd, ".planning", effort), { recursive: true });
    writeFileSync(join(cwd, ".planning", effort, "task_plan.md"), "EXISTING PLAN", "utf-8");
    const { ctx, notifications } = ctxWithCapturedNotify(cwd);

    await pi.commands.get("plan-seed")?.(effort, ctx);

    expect(readFileSync(join(cwd, ".planning", effort, "task_plan.md"), "utf-8")).toBe("EXISTING PLAN");
    expect(notifications.some((n) => /exist|refuse|not overwrite/i.test(n))).toBe(true);
  });
});

// ─── /to-spec + /to-tickets — chain synthesis commands ───────────────────────
describe("to-spec / to-tickets — chain synthesis commands", () => {
  it("both are registered", () => {
    const { pi } = setup();
    expect(pi.commands.has("to-spec")).toBe(true);
    expect(pi.commands.has("to-tickets")).toBe(true);
  });

  it("to-spec sends a priming steer that mentions the spec + the chain", async () => {
    const { pi } = setup();
    await run(pi, "to-spec", "orders");
    expect(pi.sent.length).toBe(1);
    expect(pi.sent[0].toLowerCase()).toContain("spec");
    expect(pi.sent[0]).toContain("/to-tickets");
  });

  it("to-tickets sends a priming steer naming the unified format + /plan-seed", async () => {
    const { pi } = setup();
    await run(pi, "to-tickets", "orders");
    expect(pi.sent.length).toBe(1);
    expect(pi.sent[0].toLowerCase()).toContain("ticket");
    expect(pi.sent[0]).toContain("/plan-seed");
  });
});
