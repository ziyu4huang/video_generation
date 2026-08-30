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
} from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import type { AgentSession, InlineExtension } from "@earendil-works/pi-coding-agent";
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
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

function toAssistantMessage(scripted: ScriptedMessage): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: scripted.content }],
    api: "scripted",
    provider: "scripted",
    model: "scripted-1",
    usage: {
      ...scripted.usage,
      totalTokens: scripted.usage.input + scripted.usage.output,
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

export interface SmokeSessionOptions {
  /** Extra extensions loaded alongside the scripted provider (Task 3's
   *  recorder, the real power-tool factory, ...). */
  extensions?: InlineExtension[];
  /** The scripted responses; defaults to one plain "smoke" turn. */
  respond?: (context: Context) => ScriptedMessage;
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
 *  so auto-compaction bookkeeping (Task 4) lands on the real session file. */
export async function smokeSession(options: SmokeSessionOptions = {}): Promise<SmokeSession> {
  const agentDir = await mkdtemp(join(tmpdir(), "ac-ab-"));
  const scriptedProviderExt: InlineExtension = {
    name: "scripted-provider",
    factory: (pi) => {
      pi.registerProvider(makeScriptedProvider(options.respond ?? (() => ({
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
  });
  return {
    session,
    agentDir,
    extensionErrors: loader.getExtensions().errors.map((e) => `${e.path}: ${e.error}`),
    dispose: async () => {
      session.dispose();
      await rm(agentDir, { recursive: true, force: true });
    },
  };
}

describe("autocompact A/B harness", () => {
  test("smoke: scripted provider drives a real tool-loop turn", async () => {
    // power-tool's session_start handler writes its env sidecar under
    // homedir() — point HOME at the tmp agentDir so the run stays hermetic.
    const prevHome = process.env.HOME;
    const homeDir = await mkdtemp(join(tmpdir(), "ac-ab-home-"));
    process.env.HOME = homeDir;
    try {
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
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      await rm(homeDir, { recursive: true, force: true });
    }
  });
});
