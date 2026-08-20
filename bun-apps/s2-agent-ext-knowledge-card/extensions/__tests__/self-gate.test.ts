import { afterEach, describe, expect, it } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import factory from "../knowledge-card.ts";

// Self-gate mirror of superpowers.test.ts: BUN_PI_KNOWLEDGE_CARD=0 must make
// the factory register nothing (no tools, no session hooks, no workflow
// host-fn bus emits). Direct default-import from the entry — the gate lives in
// the entry factory, so the test must call THAT.

const ENV_KEY = "BUN_PI_KNOWLEDGE_CARD";
const saved = process.env[ENV_KEY];

type Handler = (event: any, ctx?: any) => any;
function makeMockPi() {
  const handlers = new Map<string, Handler>();
  const tools: string[] = [];
  const emitted: string[] = [];
  const pi = {
    on: (event: string, handler: Handler) => {
      handlers.set(event, handler);
    },
    registerTool: (t: { name: string }) => {
      tools.push(t.name);
    },
    registerCommand: () => {},
    sendUserMessage: () => {},
    notify: () => {},
    setStatus: () => {},
    getAllTools: () => [],
    getCommands: () => [],
    getAllToolDefinitions: () => [],
    appendEntry: () => {},
    events: {
      on: () => () => {},
      emit: (ch: string) => {
        emitted.push(ch);
      },
    },
  } as unknown as ExtensionAPI;
  return { pi, handlers, tools, emitted };
}

afterEach(() => {
  if (saved === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = saved;
});

describe("BUN_PI_KNOWLEDGE_CARD=0 self-gate", () => {
  it("registers nothing when disabled", async () => {
    process.env[ENV_KEY] = "0";
    const { pi, handlers, tools, emitted } = makeMockPi();
    await factory(pi);
    expect(handlers.size).toBe(0);
    expect(tools).toHaveLength(0);
    // The workflow host-fn registration is a bus EMIT from the factory — gated too.
    expect(emitted).toHaveLength(0);
  });

  it("registers the zk tools + host-fn bus emits when enabled (default)", async () => {
    delete process.env[ENV_KEY];
    const { pi, tools, emitted } = makeMockPi();
    await factory(pi);
    expect(tools).toContain("zk_card");
    expect(tools).toContain("zk_ask");
    expect(tools).toContain("zk_ingest");
    expect(tools).toContain("knowledge_query");
    expect(emitted).toContain("workflow:hostfn:v1:register");
  });
});
