import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  _resetBootstrapCacheForTests,
  BOOTSTRAP_MARKER,
  getBootstrapContent,
  superpowersExtension,
} from "../src/index.js";
import { createMockPi } from "./helpers/mock-pi.js";

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

describe("superpowers extension wiring", () => {
  it("registers exactly the upstream event hooks", () => {
    const pi = createMockPi();
    superpowersExtension(pi, import.meta.url);
    const events = (pi as any).handlers.keys();
    expect([...events].sort()).toEqual(
      ["agent_end", "context", "resources_discover", "session_compact", "session_start"].sort(),
    );
  });

  it("resources_discover returns the real package skills/ dir", async () => {
    _resetBootstrapCacheForTests();
    // Suppress the Phase-3 default exclude so this wiring test asserts pure dir
    // resolution (the whole skills/ dir), decoupled from the exclude policy.
    process.env.PI_SUPERPOWERS_SKILL_EXCLUDE_DEFAULTS = "0";
    const pi = createMockPi();
    superpowersExtension(pi, import.meta.url);
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
    superpowersExtension(pi, import.meta.url);
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
    const body = getBootstrapContent(import.meta.url);
    expect(body).toBeTruthy();
    const payload = body ?? "";
    expect(payload).toContain(BOOTSTRAP_MARKER);
    expect(payload).toContain("You have superpowers.");
    expect(payload).toContain("## Pi tool mapping");
    // the subagent tool is owned by s2-agent-ext-subagent (extracted from workflow)
    expect(payload).toContain("s2-agent-ext-subagent");
    expect(payload).not.toContain("s2-agent-ext-ultracode");
  });

  it("Pi tool mapping is TERSE: essentials + deferral pointers, params live in the reference (ADR-0010)", () => {
    _resetBootstrapCacheForTests();
    const payload = getBootstrapContent(import.meta.url) ?? "";
    // the load-bearing tool directives stay inline (the agent must not need a
    // read to avoid the known dispatch footguns)
    expect(payload).toContain("spawn_subagent");
    expect(payload).toContain("task");
    expect(payload).toContain("tier");
    expect(payload).toContain("commitScope");
    expect(payload).toContain("watchdog");
    expect(payload).toContain("parallel()");
    // deferral: the terse bootstrap points at the canonical full docs
    expect(payload).toContain("references/pi-tools.md");
    expect(payload).toContain("BEFORE any SDD/subagent dispatch");
    // full param signatures MOVED to the reference (progressive disclosure) —
    // their presence is asserted in tests/references.test.ts, and their absence
    // here is the token diet itself
    expect(payload).not.toContain("capability?");
    expect(payload).not.toContain("tokenBudget");
    expect(payload).not.toContain("spendBudget");
  });

  it("carries the Pipeline routing (terse stage prose + deferral pointer, ADR-0010)", () => {
    _resetBootstrapCacheForTests();
    const payload = getBootstrapContent(import.meta.url) ?? "";
    // new header (renamed from "Path & routing overrides")
    expect(payload).toContain("## Pipeline routing (this repo)");
    expect(payload).not.toContain("## Path & routing overrides");
    // stage discriminator stays inline (disk-check prose, all five stage words)
    expect(payload).toContain("what's on disk");
    expect(payload).toContain("DECIDE");
    expect(payload).toContain("SYNTHESIZE");
    expect(payload).toContain("DESIGN");
    expect(payload).toContain("PLAN");
    expect(payload).toContain("EXECUTE");
    // the SYNTHESIZE/DESIGN partition: to-spec vs brainstorming no longer compete
    // (also the routing-contract seam: wayfind greps src/superpowers.ts for these)
    expect(payload).toContain("to-spec");
    expect(payload).toContain("grilling");
    expect(payload).toContain("brainstorming");
    expect(payload).toContain("writing-plans");
    // artifact-home essence stays inline; the full path table moved to the reference
    expect(payload).toContain(".planning/<effort>/");
    expect(payload).toContain("references/pi-routing.md");
    expect(payload).not.toContain("PI_PLANNING_EFFORT");
    expect(payload).not.toContain("sdd-workspace PLAN_FILE");
    // retired old structure must be gone
    expect(payload).not.toContain("Four runtime rules");
    expect(payload).not.toContain("can I write a plan right now");
    expect(payload).not.toContain("Artifact-home override");
    expect(payload).not.toContain("Entry-path routing");
    expect(payload).not.toContain("Visual-companion convergence");
    expect(payload).not.toContain("SDD workspace override");
    expect(payload).not.toContain("symlink");
    expect(payload).not.toContain(["docs", "superpowers"].join("/"));
    expect(payload).not.toContain("when an effort is active");
  });

  it("TOKEN BUDGET RATCHET (ADR-0010): repo-owned sections ≤ 1,100 chars; total ≤ 5,900 chars", () => {
    _resetBootstrapCacheForTests();
    const payload = getBootstrapContent(import.meta.url) ?? "";
    const i = payload.indexOf("## Pi tool mapping");
    const r = payload.indexOf("## Pipeline routing");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(r).toBeGreaterThan(i);
    const sections = payload.slice(i);
    expect(sections.length, "piToolMapping + piBoundaryOverrides combined").toBeLessThan(1100);
    expect(sections.length).toBeGreaterThan(300); // sanity: not accidentally gutted
    expect(payload.length, "whole bootstrap (skill body is byte-pinned ~2.9k chars)").toBeLessThan(5900);
  });
});
