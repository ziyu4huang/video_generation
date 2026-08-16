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
    // Suppress the Phase-3 default exclude so this wiring test asserts pure dir
    // resolution (the whole skills/ dir), decoupled from the exclude policy.
    process.env.PI_SUPERPOWERS_SKILL_EXCLUDE_DEFAULTS = "0";
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
    // the subagent tool is owned by pi-agent-ext-subagent (extracted from workflow)
    expect(payload).toContain("pi-agent-ext-subagent");
    expect(payload).not.toContain("pi-agent-ext-workflow");
  });

  it("Pi tool mapping names the subagent ext's 'subagent' tool + its documented params", () => {
    _resetBootstrapCacheForTests();
    const payload = getBootstrapContent() ?? "";
    expect(payload).toContain("subagent");
    // the documented call signature the agent is told to use
    expect(payload).toContain("task");
    expect(payload).toMatch(/tier|tools|excludeTools|cwd|model/);
    // prefer tier over raw model id (portable, user-tunable via /workflows-models)
    expect(payload).toContain("tier");
    // capability: model-capability axis (e.g. 'vision') from the merged model-role resolver (#827)
    expect(payload).toContain("capability?");
    // commitScope: the SDD commit-hygiene guardrail (catches the git add -A sweep)
    expect(payload).toContain("commitScope");
    // tokenBudget/spendBudget: per-agent spend cap (soft guidance — bounds runaway dispatches)
    expect(payload).toContain("tokenBudget");
    expect(payload).toContain("spendBudget");
    // deferral: the terse bootstrap points at the canonical full doc
    expect(payload).toContain("references/pi-tools.md");
    // concurrent fan-out goes through the workflow tool's parallel(), not ad-hoc multi-dispatch
    expect(payload).toContain("parallel()");
    // watchdog:{l2:true} advisory adversarial-review guardrail (D2 MED-risk mitigation pin)
    expect(payload).toContain("watchdog");
  });

  it("carries the Pipeline routing (2-rule boundary convergence, ADR-0004-safe)", () => {
    _resetBootstrapCacheForTests();
    const payload = getBootstrapContent() ?? "";
    // new header (renamed from "Path & routing overrides")
    expect(payload).toContain("## Pipeline routing (this repo)");
    expect(payload).not.toContain("## Path & routing overrides");
    // rule 1: one canonical home — the convergence specifics stay actionable
    expect(payload).toContain("One canonical home");
    expect(payload).toContain(".planning/<effort>/spec.md");
    expect(payload).toContain(".planning/<effort>/plan.md");
    expect(payload).toContain(".planning/<effort>/sdd/<plan-basename>/");
    expect(payload).toContain(".planning/<effort>/sdd/<plan-basename>/progress.md");
    expect(payload).toContain(".planning/<effort>/brainstorm/");
    expect(payload).toContain("PI_PLANNING_EFFORT");
    expect(payload).toContain("sdd-workspace PLAN_FILE");
    // rule 2: stage table discriminator keyed on disk state
    expect(payload).toContain("check what's on disk");
    expect(payload).toContain("DECIDE");
    expect(payload).toContain("SYNTHESIZE");
    expect(payload).toContain("DESIGN");
    expect(payload).toContain("PLAN");
    expect(payload).toContain("EXECUTE");
    // the SYNTHESIZE/DESIGN partition: to-spec vs brainstorming no longer compete
    expect(payload).toContain("to-spec");
    expect(payload).toContain("brainstorming");
    // retired old structure must be gone
    expect(payload).not.toContain("Four runtime rules");
    expect(payload).not.toContain("can I write a plan right now");
    expect(payload).not.toContain("Artifact-home override");
    expect(payload).not.toContain("Entry-path routing");
    expect(payload).not.toContain("Visual-companion convergence");
    // note: "SDD workspace" the bare topic word legitimately remains in rule 1;
    // only the retired header phrase "SDD workspace override" must be gone
    expect(payload).not.toContain("SDD workspace override");
    // ADR-0007 → ADR-0009: no-effort specs route to the flat .planning/specs/;
    // the former alias symlinks under the retired upstream docs namespace are
    // gone — .planning is the sole artifact home and the payload never names
    // the dead namespace (asserted via joined segments, not a literal, so this
    // file does not re-introduce the retired path string)
    expect(payload).toContain(".planning/specs/");
    expect(payload).not.toContain("symlink");
    expect(payload).not.toContain(["docs", "superpowers"].join("/"));
    expect(payload).not.toContain("when an effort is active");
  });

  it("routing section is meaningfully shorter than the old 3039 chars", () => {
    _resetBootstrapCacheForTests();
    const payload = getBootstrapContent() ?? "";
    const i = payload.indexOf("## Pipeline routing");
    const section = i >= 0 ? payload.slice(i) : "";
    expect(section.length).toBeLessThan(2000);
    expect(section.length).toBeGreaterThan(800); // sanity: not accidentally empty
  });
});
