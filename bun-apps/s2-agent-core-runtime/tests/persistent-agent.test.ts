import { describe, expect, test } from "bun:test";
import { createBudgetGuard } from "../src/agent-budget.js";
import { createTurnGuard } from "../src/agent-turns.js";
import { LiveAgentRegistry } from "../src/live-agent-registry.js";
import { LiveAgent, spawnLiveAgentFirstExchange } from "../src/persistent-agent.js";
import type { SpawnSubagentOptions } from "../src/spawn-subagent.js";

/**
 * Fake AgentSession exercising exactly the seams LiveAgent touches:
 * prompt/steer/isStreaming/abort/dispose/getSessionStats/subscribe/messages.
 * prompt() records the text, appends an assistant reply, and — when a
 * `blockUntilAbort` harness is armed — resolves only after abort() fires
 * (the timeout path: abort ends the loop; the session stays reusable).
 */
function fakeSession(init: { tokensTotal?: number; cost?: number } = {}) {
  const state = {
    prompts: [] as string[],
    steers: [] as string[],
    aborted: 0,
    disposed: 0,
    streaming: false,
    tokensTotal: init.tokensTotal ?? 0,
    cost: init.cost ?? 0,
    listeners: [] as Array<(event: unknown) => void>,
  };
  const assistantReply = (text: string) => {
    session.messages.push({ role: "assistant", content: [{ type: "text", text }] });
  };
  let blockUntilAbort = false;
  let midPrompt: (() => void) | undefined;
  const session = {
    messages: [] as unknown[],
    get isStreaming() {
      return state.streaming;
    },
    subscribe(fn: (event: unknown) => void) {
      state.listeners.push(fn);
      return () => {
        state.listeners = state.listeners.filter((l) => l !== fn);
      };
    },
    emit(event: unknown) {
      for (const l of [...state.listeners]) l(event);
    },
    async prompt(text: string) {
      state.prompts.push(text);
      if (blockUntilAbort || midPrompt) {
        const abortedBefore = state.aborted;
        midPrompt?.();
        await new Promise<void>((resolve) => {
          const iv = setInterval(() => {
            if (state.aborted > abortedBefore) {
              clearInterval(iv);
              resolve();
            }
          }, 5);
        });
        blockUntilAbort = false; // one blocked exchange — the next prompts normally
        midPrompt = undefined;
        return; // aborted loop — no assistant reply
      }
      assistantReply(`reply to: ${text}`);
    },
    async steer(text: string) {
      state.steers.push(text);
    },
    async abort() {
      state.aborted++;
    },
    dispose() {
      state.disposed++;
    },
    getSessionStats() {
      return {
        tokens: { input: state.tokensTotal, output: 0, cacheRead: 0, cacheWrite: 0, total: state.tokensTotal },
        cost: state.cost,
      };
    },
    armBlockUntilAbort() {
      blockUntilAbort = true;
    },
    armMidPrompt(fn: () => void) {
      midPrompt = fn;
    },
  };
  return { session, state };
}

type FakeSession = ReturnType<typeof fakeSession>;

/** A LiveAgent over the fake session with REAL guards (the aggregation seam under test). */
function liveAgent(fs: FakeSession, budget: { tokenBudget?: number; spendBudget?: number; maxTurns?: number } = {}) {
  const budgetGuard = createBudgetGuard(fs.session, budget);
  const turnGuard = createTurnGuard(fs.session, { maxTurns: budget.maxTurns });
  const unsubscribe = fs.session.subscribe((event) => {
    budgetGuard.onSessionEvent(event);
    turnGuard.onSessionEvent(event);
  });
  return new LiveAgent({
    session: fs.session as never,
    unsubscribe,
    budgetGuard,
    turnGuard,
    instructions: "You are a named test agent.",
  });
}

const usageObservation = () => ({ type: "message_end", message: { role: "assistant", usage: { total: 1 } } });

describe("LiveAgent.send — routing", () => {
  test("idle → prompt; instructions prepend; output extracted; usage is the delta", async () => {
    const fs = fakeSession();
    const agent = liveAgent(fs, { spendBudget: 10 });
    fs.state.tokensTotal = 100;
    const r1 = await agent.send("first task");
    expect(r1.output).toBe("reply to: You are a named test agent.\n\nfirst task");
    expect(r1.failure).toBeUndefined();
    expect(r1.steered).toBeUndefined();
    fs.state.tokensTotal = 150;
    const r2 = await agent.send("second task");
    expect(r2.usage?.total).toBe(50); // delta, not cumulative
    expect(fs.state.prompts).toHaveLength(2);
  });

  test("running → steer, no prompt, steered flag set", async () => {
    const fs = fakeSession();
    const agent = liveAgent(fs);
    fs.state.streaming = true;
    const r = await agent.send("mid-flight nudge");
    expect(r.steered).toBe(true);
    expect(r.output).toBe("");
    expect(fs.state.steers).toEqual(["mid-flight nudge"]);
    expect(fs.state.prompts).toHaveLength(0);
  });

  test("timeout aborts the exchange; the session stays reusable for the next one", async () => {
    const fs = fakeSession();
    const agent = liveAgent(fs);
    fs.session.armBlockUntilAbort();
    const r = await agent.send("slow task", { timeoutMs: 30 });
    expect(r.failure?.kind).toBe("timedout");
    expect(fs.state.aborted).toBeGreaterThan(0);
    // Session reusable: a follow-up exchange prompts normally.
    const r2 = await agent.send("follow-up");
    expect(r2.failure).toBeUndefined();
    expect(r2.output).toContain("follow-up");
  });

  test("disposed agent refuses further sends without touching the session", async () => {
    const fs = fakeSession();
    const agent = liveAgent(fs);
    agent.dispose();
    const r = await agent.send("anything");
    expect(r.failure?.kind).toBe("failed");
    expect(fs.state.prompts).toHaveLength(0);
    expect(agent.disposed).toBe(true);
  });
});

describe("LiveAgent — lifetime ceiling aggregation", () => {
  test("a spend crossing on exchange 2 terminalizes the agent; exchange 3 refuses without prompting", async () => {
    const fs = fakeSession();
    const agent = liveAgent(fs, { spendBudget: 1 });
    // Exchange 1: under budget.
    const r1 = await agent.send("one");
    expect(r1.failure).toBeUndefined();
    // Exchange 2: cumulative cost crosses the spend ceiling mid-turn. The guard
    // hard-aborts (spend never earns grace) → abort ends the loop → send's
    // post-check surfaces the lifetime budget failure.
    fs.state.cost = 2;
    fs.session.emit(usageObservation());
    const r2 = await agent.send("two");
    expect(r2.failure?.kind).toBe("budget");
    const promptsAfter2 = fs.state.prompts.length;
    // Exchange 3: same failure, no new prompt — aggregate enforcement.
    const r3 = await agent.send("three");
    expect(r3.failure?.kind).toBe("budget");
    expect(fs.state.prompts.length).toBe(promptsAfter2);
  });
});

describe("openLiveAgent / spawnLiveAgentFirstExchange", () => {
  test("first exchange registers the agent; result mirrors SpawnSubagentResult", async () => {
    const fs = fakeSession();
    const registry = new LiveAgentRegistry(4);
    const openAgent = async () => liveAgent(fs);
    const { result, agent, entry } = await spawnLiveAgentFirstExchange(
      { task: "initial task", timeoutMs: 1000 } as SpawnSubagentOptions,
      { name: "researcher", agentId: "call-1", registry, openAgent },
    );
    expect(result.failure).toBeUndefined();
    expect(result.output).toContain("initial task");
    expect(agent).toBeDefined();
    expect(entry?.name).toBe("researcher");
    expect(registry.get("researcher")?.agentId).toBe("call-1");
  });

  test("a lifetime-terminal first exchange disposes the agent and registers nothing", async () => {
    const fs = fakeSession();
    const registry = new LiveAgentRegistry(4);
    const openAgent = async () => liveAgent(fs, { spendBudget: 1 });
    // The spend crossing fires MID-prompt: the guard hard-aborts (spend never
    // earns grace) → abort ends the loop → send's post-check terminalizes.
    fs.session.armMidPrompt(() => {
      fs.state.cost = 5;
      fs.session.emit(usageObservation());
    });
    const { result, agent, entry } = await spawnLiveAgentFirstExchange({ task: "doomed" } as SpawnSubagentOptions, {
      name: "doomed",
      agentId: "call-2",
      registry,
      openAgent,
    });
    expect(result.failure?.kind).toBe("budget");
    expect(agent).toBeUndefined();
    expect(entry).toBeUndefined();
    expect(registry.size).toBe(0);
    expect(fs.state.disposed).toBe(1);
  });

  test("name collision / reserved name fail BEFORE any session is opened", async () => {
    const fs = fakeSession();
    const registry = new LiveAgentRegistry(4);
    const openAgent = async () => liveAgent(fs);
    const opts = { task: "t" } as SpawnSubagentOptions;
    const reserved = await spawnLiveAgentFirstExchange(opts, { name: "main", agentId: "a", registry, openAgent });
    expect(reserved.result.failure?.kind).toBe("failed");
    expect(fs.state.prompts).toHaveLength(0); // no session work happened
    await spawnLiveAgentFirstExchange(opts, { name: "dup", agentId: "b", registry, openAgent });
    const dup = await spawnLiveAgentFirstExchange(opts, { name: "dup", agentId: "c", registry, openAgent });
    expect(dup.result.failure?.kind).toBe("failed");
    expect(dup.agent).toBeUndefined();
  });
});
