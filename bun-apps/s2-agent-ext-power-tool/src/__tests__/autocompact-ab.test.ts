/**
 * autocompact A/B harness — real AgentSession + ScriptedProvider (no network).
 * Spec: .planning/specs/2026-08-30-autocompact-ab-harness-design.md
 * Arms S1–S4 + validity gate live in Task 4; this file grows task by task.
 *
 * Reality fixes applied in Task 1 Step 2 (first run failed with
 * `apiKey.resolve is not a function`):
 *  - ProviderAuth is `{ apiKey: { name, resolve } }`, not
 *    `{ type: "apiKey", apiKey: "..." }`; resolve must return an AuthResult.
 *  - The session streams through `modelRuntime.streamSimple`, so the provider
 *    needs BOTH `stream` and `streamSimple`.
 *  - The terminal stream event is `{ type: "done", reason, message }` —
 *    there is no `message_end` AssistantMessageEvent — and `start` requires
 *    `partial`. `s.end(message)` stays last (it feeds `response.result()`).
 *  - AssistantMessage requires content BLOCKS, `api`/`provider`/`model`,
 *    `timestamp`, and a Usage with `totalTokens` + `cost`.
 *  - `model: SCRIPTED_MODEL` needed no setModel-in-factory workaround: the
 *    option is taken as-is and the factory-time registerProvider is flushed
 *    into the session's modelRuntime when the extension runner binds.
 *
 * Reality fixes applied in Task 2 (brief's sketch vs 0.84.4 dist):
 *  - AssistantMessage has NO `toolCalls` field — a tool call IS a content
 *    block `{ type: "toolCall", id, name, arguments }` (pi-ai types.d.ts:309),
 *    so ScriptedMessage carries `toolCall` and toAssistantMessage appends it
 *    to `content`.
 *  - Compaction summarizer calls are detected via `context.systemPrompt` —
 *    upstream builds `{ systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages:
 *    [user] }` (compaction.js:475-486), so `messages[0].role === "system"`
 *    from the brief can never fire. The default agent system prompt contains
 *    no "summar*" substring (core/system-prompt.js), so this cannot
 *    false-positive on normal turns.
 *  - `toAssistantMessage` sets totalTokens to input+output+cacheRead+cacheWrite
 *    (Task 1 used input+output): calculateContextTokens prefers totalTokens
 *    (compaction.js:86-87), and the usage curve puts live tokens in cacheWrite,
 *    so the old sum silently dropped 100 tokens off every curve point.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAssistantMessageEventStream,
  createProvider,
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
  type Provider,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { createAgentSession, DefaultResourceLoader, defineTool } from "@earendil-works/pi-coding-agent";
import type { AgentSession, InlineExtension, ToolDefinition } from "@earendil-works/pi-coding-agent";
import powerToolFactory from "../index.ts";

/** The scripted model every arm of the A/B harness runs on. */
export function makeScriptedModel(): Model<Api> {
  return {
    id: "scripted-1",
    name: "Scripted 1",
    provider: "scripted",
    api: "scripted",
    baseUrl: "scripted://local", // never fetched — the api object intercepts
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
  };
}

/** What each scripted turn says; the envelope (api/provider/model/timestamp/
 *  full usage) is filled in by toAssistantMessage. */
export interface ScriptedMessage {
  content: string;
  stopReason: "stop" | "toolUse";
  /** Optional tool call, appended as a `toolCall` content block —
   *  AssistantMessage has no separate toolCalls field (see header). */
  toolCall?: { id: string; name: string; arguments: Record<string, unknown> };
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

function toAssistantMessage(scripted: ScriptedMessage): AssistantMessage {
  const u = scripted.usage;
  return {
    role: "assistant",
    content: [
      { type: "text", text: scripted.content },
      ...(scripted.toolCall
        ? [{
            type: "toolCall" as const,
            id: scripted.toolCall.id,
            name: scripted.toolCall.name,
            arguments: scripted.toolCall.arguments,
          }]
        : []),
    ],
    api: "scripted",
    provider: "scripted",
    model: "scripted-1",
    usage: {
      ...u,
      // calculateContextTokens prefers totalTokens (compaction.js:86-87), so
      // this MUST be the same four-field sum its fallback would compute —
      // otherwise the scripted curve and the compaction decision diverge.
      totalTokens: u.input + u.output + u.cacheRead + u.cacheWrite,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: scripted.stopReason,
    timestamp: Date.now(),
  };
}

function emitScripted(message: AssistantMessage) {
  const s = createAssistantMessageEventStream();
  queueMicrotask(() => {
    s.push({ type: "start", partial: message });
    s.push({
      type: "done",
      reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
      message,
    });
    s.end(message); // feeds response.result() in the agent loop
  });
  return s;
}

function makeScriptedProvider(respond: (context: Context) => ScriptedMessage) {
  return createProvider({
    id: "scripted",
    name: "scripted",
    auth: {
      apiKey: {
        name: "Scripted (test)",
        resolve: async () => ({ auth: { apiKey: "scripted" }, source: "scripted-test" }),
      },
    },
    models: [makeScriptedModel()],
    api: {
      stream: (_model, context) => emitScripted(toAssistantMessage(respond(context))),
      streamSimple: (_model, context) => emitScripted(toAssistantMessage(respond(context))),
    },
  });
}

// ─── Task 2: usage-curve script, emit_blob tool, summarizer lane ─────────────

/** One scripted turn; stopReason is derived (toolCall present → "toolUse"). */
interface ScriptStep {
  content: string;
  toolCall?: { args: { size: number } };
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

/** Context tokens after each scripted assistant response. input is
 *  `contextTokens - 500` and cacheWrite is 100, so the four-field usage sum
 *  (what calculateContextTokens reads — see toAssistantMessage) lands exactly
 *  on each value below: the compaction decision curve is scripted to the token. */
const USAGE_CURVE = [5_000, 12_000, 20_000, 30_000, 42_000, 55_000, 63_000, 70_000] as const;
const BLOB_SIZE = 4_000; // large tool result = #6879 trigger condition

/** All 8 curve points carry a tool call — "8 tool loops ... then a final
 *  text-only step" per the brief. (The brief's literal `i < length - 1` leaves
 *  FINAL_STEP unreachable: the 8th step would already end the turn with
 *  stopReason "stop" — verified by the first GREEN run, which stopped at 8
 *  assistant messages and never consumed FINAL_STEP.) */
const PROVOCATION_SCRIPT: ScriptStep[] = USAGE_CURVE.map((contextTokens, i) => ({
  content: `step ${i}`,
  toolCall: { args: { size: BLOB_SIZE } },
  usage: { input: contextTokens - 500, output: 400, cacheRead: 0, cacheWrite: 100 },
}));

/** The final turn after the loop: still 70k context so a boundary compaction
 *  check (agent-session.js:895) sees the peak, but no tool call. */
const FINAL_STEP: ScriptStep = {
  content: "done",
  usage: { input: 70_000, output: 100, cacheRead: 0, cacheWrite: 0 },
};

/** Compaction summarizer detection — see header for why this discriminates on
 *  systemPrompt, not messages[0].role. */
function isSummarizerCall(context: Context): boolean {
  return (context.systemPrompt ?? "").toLowerCase().includes("summar");
}

/** Fixed response for summarizer calls: small usage so a post-compaction
 *  context reads far below every threshold in every arm. */
const SUMMARIZER_RESPONSE: ScriptedMessage = {
  content: "[A/B summary] compacted",
  stopReason: "stop",
  usage: { input: 1_500, output: 100, cacheRead: 0, cacheWrite: 0 },
};

/** Cursor-based provider over a fixed script. Normal turns pop steps —
 *  running past the end throws loudly instead of silently repeating. */
function makeScriptedProviderFromScript(script: ScriptStep[]): Provider<Api> {
  let cursor = 0;
  return makeScriptedProvider((context) => {
    if (isSummarizerCall(context)) return SUMMARIZER_RESPONSE;
    const step = script[cursor];
    if (step === undefined) {
      throw new Error(`script exhausted: request ${cursor} of ${script.length} steps`);
    }
    cursor += 1;
    return {
      content: step.content,
      stopReason: step.toolCall ? "toolUse" : "stop",
      toolCall: step.toolCall
        ? { id: `call-${cursor - 1}`, name: "emit_blob", arguments: step.toolCall.args }
        : undefined,
      usage: step.usage,
    };
  });
}

const EMIT_BLOB_TOOL = defineTool({
  name: "emit_blob",
  label: "Emit Blob",
  description: "Returns a blob of the requested size (A/B harness).",
  parameters: Type.Object({
    size: Type.Number({ description: "blob length in chars" }),
  }),
  execute: async (_toolCallId, params) => ({
    content: [{ type: "text" as const, text: "x".repeat(params.size) }],
    details: null,
  }),
});

export interface SmokeSessionOptions {
  /** Extra extensions loaded alongside the scripted provider (Task 3's
   *  recorder, the real power-tool factory, ...). */
  extensions?: InlineExtension[];
  /** The scripted responses; defaults to one plain "smoke" turn. */
  respond?: (context: Context) => ScriptedMessage;
  /** A complete scripted provider (Task 2+); overrides `respond` when given. */
  provider?: Provider<Api>;
  /** Custom tools registered in addition to the built-ins (emit_blob, ...). */
  customTools?: ToolDefinition[];
}

export interface SmokeSession {
  session: AgentSession;
  agentDir: string;
  /** Extension-load failures — the loader records these instead of
   *  throwing, so a factory that dies mid-load would otherwise be silent. */
  extensionErrors: string[];
  dispose: () => Promise<void>;
}

/** One hermetic real AgentSession on the scripted provider — the seed every
 *  later task's test grows from. File-backed sessions under a tmp agentDir,
 *  so auto-compaction bookkeeping (Task 4) lands on the real session file.
 *
 *  HOME is redirected to a tmp dir for the session's lifetime and restored by
 *  dispose(): extensions that touch homedir() (power-tool's session_start env
 *  sidecar under ~/.pi/agent/power-tool) stay hermetic for every caller. */
export async function smokeSession(options: SmokeSessionOptions = {}): Promise<SmokeSession> {
  const agentDir = await mkdtemp(join(tmpdir(), "ac-ab-"));
  const homeDir = await mkdtemp(join(tmpdir(), "ac-ab-home-"));
  const prevHome = process.env.HOME;
  process.env.HOME = homeDir;
  const restoreHome = () => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
  };
  try {
    const scriptedProviderExt: InlineExtension = {
      name: "scripted-provider",
      factory: (pi) => {
        pi.registerProvider(options.provider ?? makeScriptedProvider(options.respond ?? (() => ({
          content: "smoke",
          stopReason: "stop",
          usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 },
        }))));
      },
    };
    const loader = new DefaultResourceLoader({
      cwd: agentDir,
      agentDir,
      extensionFactories: [scriptedProviderExt, ...(options.extensions ?? [])],
    });
    await loader.reload();
    const { session } = await createAgentSession({
      resourceLoader: loader,
      model: makeScriptedModel(),
      sessionManager: undefined, // in-file sessions under agentDir
      customTools: options.customTools,
    });
    return {
      session,
      agentDir,
      extensionErrors: loader.getExtensions().errors.map((e) => `${e.path}: ${e.error}`),
      dispose: async () => {
        session.dispose();
        restoreHome();
        await Promise.all([
          rm(agentDir, { recursive: true, force: true }),
          rm(homeDir, { recursive: true, force: true }),
        ]);
      },
    };
  } catch (error) {
    restoreHome();
    await Promise.all([
      rm(agentDir, { recursive: true, force: true }),
      rm(homeDir, { recursive: true, force: true }),
    ]);
    throw error;
  }
}

describe("autocompact A/B harness", () => {
  test("smoke: scripted provider drives a real tool-loop turn", async () => {
    const smoke = await smokeSession({
      extensions: [{ name: "power-tool", factory: powerToolFactory }],
    });
    try {
      await smoke.session.prompt("smoke");
      expect(smoke.extensionErrors).toEqual([]); // both factories loaded
      const assistants = smoke.session.messages.filter((m) => m.role === "assistant");
      // Honesty gate: an assistant entry alone would also pass on a
      // provider error (the loop appends a failure message), so pin the
      // scripted payload AND the absence of an error envelope.
      expect(assistants.length).toBeGreaterThan(0);
      expect(assistants.some((m) => m.errorMessage !== undefined)).toBe(false);
      expect(JSON.stringify(assistants.map((m) => m.content))).toContain("smoke");
    } finally {
      await smoke.dispose();
    }
  });

  test("provocation: usage-curve script drives a deep emit_blob tool loop", async () => {
    const smoke = await smokeSession({
      extensions: [{ name: "power-tool", factory: powerToolFactory }],
      provider: makeScriptedProviderFromScript([...PROVOCATION_SCRIPT, FINAL_STEP]),
      customTools: [EMIT_BLOB_TOOL],
    });
    try {
      await smoke.session.prompt("run the loop");
      expect(smoke.extensionErrors).toEqual([]);
      const assistants = smoke.session.messages.filter((m) => m.role === "assistant");
      expect(assistants.some((m) => m.errorMessage !== undefined)).toBe(false);
      // The loop actually ran deep: 7 scripted emit_blob calls, each executed
      // by the real tool executor with a full-size blob result.
      const toolResults = smoke.session.messages.filter((m) => m.role === "toolResult");
      expect(toolResults.length).toBeGreaterThanOrEqual(6);
      for (const result of toolResults) {
        expect(result.toolName).toBe("emit_blob");
        expect(result.content[0]).toEqual({ type: "text", text: "x".repeat(BLOB_SIZE) });
      }
      // Exact curve: each assistant response reports the scripted context
      // tokens (totalTokens = the four-field usage sum — see toAssistantMessage).
      expect(assistants.map((m) => m.usage.totalTokens)).toEqual([...USAGE_CURVE, 70_100]);
    } finally {
      await smoke.dispose();
    }
  });

  test("isSummarizerCall: matches upstream's summarization context, not normal turns", () => {
    // Shape from compaction.js buildSummarizationContext: system prompt carries
    // SUMMARIZATION_SYSTEM_PROMPT, messages[0] is a USER message.
    expect(isSummarizerCall({
      systemPrompt: "You are a context summarization assistant. Your task is to ...",
      messages: [{ role: "user", content: [{ type: "text", text: "<conversation/>..." }] } as never],
    })).toBe(true);
    // Normal agent turn: default system prompt (no "summar*" substring) with a
    // user message — must NOT be classified as a summarizer.
    expect(isSummarizerCall({
      systemPrompt: "You are pi, a coding agent running in an interactive CLI.",
      messages: [{ role: "user", content: [{ type: "text", text: "run the loop" }] } as never],
    })).toBe(false);
    expect(isSummarizerCall({ messages: [] })).toBe(false); // no systemPrompt at all
  });
});
