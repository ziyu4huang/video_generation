import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  _resetBootstrapCacheForTests,
  BOOTSTRAP_MARKER,
  getBootstrapContent,
  superpowersExtension,
} from "../src/index.js";

/**
 * Drives the Superpowers extension against a minimal in-memory mock of Pi's
 * ExtensionAPI. Verifies the three upstream behaviors survive the port:
 *   1. resources_discover returns the package's real skills/ dir.
 *   2. context handler injects the bootstrap exactly once per session/compaction,
 *      skips when already present, and goes inert after agent_end.
 *   3. the assembled bootstrap payload carries the marker + the real skill body.
 *
 * Deterministic: no LLM, no network, no real Pi.
 */

type Handler = (event: any, ctx?: any) => any;

function createMockPi(): ExtensionAPI & { handlers: Map<string, Handler>; fire: (e: string, ev?: any) => any } {
  const handlers = new Map<string, Handler>();
  const pi = {
    on: (event: string, handler: Handler) => {
      handlers.set(event, handler);
    },
    // Unused by this extension but required by the ExtensionAPI surface shape
    // for callers that probe it; kept permissive.
    sendUserMessage: () => {},
    registerCommand: () => {},
  } as unknown as ExtensionAPI;
  const fire = (event: string, ev: any = {}) => handlers.get(event)?.(ev);
  return { ...pi, handlers, fire } as any;
}

describe("superpowers extension wiring", () => {
  it("registers exactly the upstream event hooks", () => {
    const pi = createMockPi();
    superpowersExtension(pi);
    const events = (pi as any).handlers.keys();
    expect([...events].sort()).toEqual(
      ["agent_end", "context", "resources_discover", "session_compact", "session_start"].sort(),
    );
  });

  it("resources_discover returns the real package skills/ dir", async () => {
    _resetBootstrapCacheForTests();
    const pi = createMockPi();
    superpowersExtension(pi);
    const result = await pi.fire("resources_discover", { type: "resources_discover" });
    expect(result).toBeTruthy();
    expect(Array.isArray(result.skillPaths)).toBe(true);
    expect(result.skillPaths.length).toBe(1);
    const dir = result.skillPaths[0] as string;
    expect(existsSync(dir)).toBe(true);
    // 14 skill subdirs resolve here
    expect(existsSync(join(dir, "using-superpowers", "SKILL.md"))).toBe(true);
  });
});

describe("context bootstrap injection", () => {
  function setup() {
    _resetBootstrapCacheForTests();
    const pi = createMockPi();
    superpowersExtension(pi);
    return pi;
  }

  it("injects the bootstrap when inject is active and it is absent", async () => {
    const pi = setup();
    const base = [{ role: "user", content: "hello" }];
    const out = await pi.fire("context", { type: "context", messages: base });
    expect(out).toBeTruthy();
    expect(out.messages.length).toBe(2);
    // injected message carries the bootstrap marker
    const injected = out.messages[0];
    const text = typeof injected.content === "string" ? injected.content : injected.content[0].text;
    expect(text).toContain(BOOTSTRAP_MARKER);
    expect(text).toContain("You have superpowers.");
  });

  it("does NOT inject when the bootstrap is already present in messages", async () => {
    const pi = setup();
    const present = [{ role: "user", content: `prefix ${BOOTSTRAP_MARKER} suffix` }];
    const out = await pi.fire("context", { type: "context", messages: present });
    expect(out).toBeUndefined();
  });

  it("goes inert after agent_end (no further injection until session_start/compact)", async () => {
    const pi = setup();
    await pi.fire("agent_end", { type: "agent_end", messages: [] });
    const out = await pi.fire("context", { type: "context", messages: [{ role: "user", content: "x" }] });
    expect(out).toBeUndefined();

    // session_start re-arms injection
    await pi.fire("session_start", { type: "session_start" });
    const out2 = await pi.fire("context", { type: "context", messages: [{ role: "user", content: "x" }] });
    expect(out2).toBeTruthy();
  });

  it("session_compact also re-arms injection", async () => {
    const pi = setup();
    await pi.fire("agent_end", { type: "agent_end", messages: [] });
    await pi.fire("session_compact", { type: "session_compact" });
    const out = await pi.fire("context", { type: "context", messages: [{ role: "user", content: "x" }] });
    expect(out).toBeTruthy();
  });

  it("inserts AFTER leading compactionSummary messages, not before them", async () => {
    const pi = setup();
    const messages = [
      { role: "compactionSummary", content: "summary-1" },
      { role: "compactionSummary", content: "summary-2" },
      { role: "user", content: "real turn" },
    ];
    const out = await pi.fire("context", { type: "context", messages });
    expect(out.messages.length).toBe(4);
    // compaction summaries stay first; bootstrap lands right after them
    expect(out.messages[0].role).toBe("compactionSummary");
    expect(out.messages[1].role).toBe("compactionSummary");
    const injected = out.messages[2];
    const text = typeof injected.content === "string" ? injected.content : injected.content[0].text;
    expect(text).toContain(BOOTSTRAP_MARKER);
    expect(out.messages[3].content).toBe("real turn");
  });
});

describe("bootstrap payload assembly", () => {
  it("getBootstrapContent returns non-null with marker + real skill body + Pi tool mapping", () => {
    _resetBootstrapCacheForTests();
    const body = getBootstrapContent();
    expect(body).toBeTruthy();
    const payload = body ?? "";
    expect(payload).toContain(BOOTSTRAP_MARKER);
    expect(payload).toContain("You have superpowers.");
    expect(payload).toContain("## Pi tool mapping");
    expect(payload).toContain("pi-agent-ext-workflow");
  });

  it("Pi tool mapping names the workflow 'subagent' tool + its documented params", () => {
    _resetBootstrapCacheForTests();
    const payload = getBootstrapContent() ?? "";
    expect(payload).toContain("subagent");
    // the documented call signature the agent is told to use
    expect(payload).toContain("task");
    expect(payload).toMatch(/tools|excludeTools|cwd|model/);
  });
});
