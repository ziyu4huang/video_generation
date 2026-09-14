import { afterEach, beforeEach, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AssistantMessage,
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
  type Model,
} from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  createAgentSession,
  createCodingTools,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

/**
 * t03 probe (self-arc-25): pi 0.85.x threads the SESSION cwd into every tool
 * execution as `ctx.cwd` (all seven built-ins read `ctx?.cwd || cwd`). The
 * runner context factory wraps BOTH built-in and SDK `customTools`
 * (wrapRegisteredTools(allCustomTools, runner) in the shipped dist) and its
 * cwd is the session's. CoreAgent.assembleSession therefore no longer needs
 * to re-bind createCodingTools(runCwd) for per-call cwds — a tool constructed
 * at the CoreAgent cwd resolves against the session cwd at call time.
 *
 * These tests drive a REAL agent-loop turn per assertion — but with a
 * scripted stream function (no LLM, no network): the fake stream emits one
 * forced tool call, the loop executes it through the session's own wrapped
 * tool registry, then a text-only second turn stops the loop. The session
 * cwd (B) differs from the tools' construction cwd (A), so any
 * construction-cwd resolution fails the test.
 */

let dirA: string;
let dirB: string;
let agentDir: string;

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "cwd-delegation-"));
  dirA = join(root, "a");
  dirB = join(root, "b");
  agentDir = join(root, "agent-dir");
  mkdirSync(dirA, { recursive: true });
  mkdirSync(dirB, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(dirB, "note.txt"), "FROM_B");
  writeFileSync(join(dirA, "other.txt"), "FROM_A");
});

afterEach(() => {
  rmSync(join(dirA, ".."), { recursive: true, force: true });
});

const FAKE_MODEL = {
  api: "openai-completions",
  id: "fake-model",
  provider: "fake-provider",
  name: "Fake Model",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4_096,
} as unknown as Model<never>;

function msgBase(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "fake",
    provider: "fake-provider",
    model: "fake-model",
    usage: {
      input: { tokens: 1, cost: { total: 0, amount: 0, currency: "usd" } },
      output: { tokens: 1, cost: { total: 0, amount: 0, currency: "usd" } },
      totalTokens: 2,
      cost: { total: 0, amount: 0, currency: "usd" },
    },
    stopReason: "toolUse",
    timestamp: Date.now(),
  } as unknown as AssistantMessage;
}

/** A scripted stream: first turn forces ONE tool call; second turn says done. */
function scriptedToolCallStream(toolName: string, args: object): () => AssistantMessageEventStream {
  let turn = 0;
  return () => {
    turn += 1;
    const stream = createAssistantMessageEventStream();
    if (turn === 1) {
      const toolCall = { type: "toolCall" as const, id: "call_1", name: toolName, arguments: args };
      const partial = msgBase([toolCall]);
      stream.push({ type: "start", partial });
      stream.push({ type: "toolcall_start", contentIndex: 0, partial });
      stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial });
      stream.push({ type: "done", reason: "toolUse", message: partial });
    } else {
      const partial = msgBase([{ type: "text" as const, text: "done" }]);
      const donePartial = { ...partial, stopReason: "stop" as const };
      stream.push({ type: "start", partial: donePartial });
      stream.push({ type: "text_start", contentIndex: 0, partial: donePartial });
      stream.push({ type: "text_end", contentIndex: 0, content: "done", partial: donePartial });
      stream.push({ type: "done", reason: "stop", message: donePartial });
    }
    stream.end();
    return stream;
  };
}

interface BuiltSession {
  session: Awaited<ReturnType<typeof createAgentSession>>["session"];
  /** ctx.cwd the loop's factory injected into the canary (set when it runs). */
  observedCwd: () => string | undefined;
}

async function buildSession(): Promise<BuiltSession> {
  let observed: string | undefined;
  const canary = {
    name: "cwd_canary",
    label: "cwd_canary",
    description: "records ctx.cwd",
    parameters: { type: "object" as const, properties: {}, required: [] as string[] },
    execute: async (_id: string, _params: object, _signal: AbortSignal, _onUpdate: unknown, ctx: unknown) => {
      observed = (ctx as { cwd?: string } | undefined)?.cwd;
      return { output: "ok", isError: false };
    },
  } as unknown as ToolDefinition;

  // Tools are CONSTRUCTED at A; the session will run at B.
  const { session } = await createAgentSession({
    cwd: dirB,
    agentDir,
    sessionManager: SessionManager.inMemory(),
    settingsManager: SettingsManager.create(dirA, agentDir),
    model: FAKE_MODEL,
    customTools: [...createCodingTools(dirA), canary],
  });
  return { session, observedCwd: () => observed };
}

async function runOneToolCall(
  toolName: string,
  args: object,
): Promise<{ resultText: string; observedCwd: () => string | undefined }> {
  const { session, observedCwd } = await buildSession();
  // Drive the RAW agent loop (session.agent.prompt) — it has no provider-auth
  // gate, and the scripted streamFunction replaces the provider entirely. The
  // tool registry it executes against is the session's own wrapped registry.
  session.agent.streamFunction = scriptedToolCallStream(toolName, args);
  await session.agent.prompt("run the tool");
  const toolResults = session.messages.filter((m) => m.role === "toolResult");
  assert.ok(toolResults.length >= 1, "loop produced a tool result");
  return { resultText: JSON.stringify(toolResults), observedCwd };
}

test("read tool constructed at A resolves a relative path against the SESSION cwd B", async () => {
  const { resultText } = await runOneToolCall("read", { path: "note.txt" });
  assert.ok(
    resultText.includes("FROM_B"),
    `expected session-cwd resolution (B/note.txt), got: ${resultText.slice(0, 400)}`,
  );
  assert.ok(!resultText.includes("other.txt"), "must not resolve against construction cwd A");
});

test("bash tool inherits the SESSION cwd (pwd equals B)", async () => {
  const { resultText } = await runOneToolCall("bash", { command: "pwd" });
  assert.ok(resultText.includes(dirB), `expected pwd=${dirB}, got: ${resultText.slice(0, 400)}`);
});

test("customTools get the factory-threaded ctx.cwd too (canary observes B)", async () => {
  const { observedCwd } = await runOneToolCall("cwd_canary", {});
  assert.equal(observedCwd(), dirB);
});
