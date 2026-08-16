import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { updateSticky, computeBannerSaved, matchIntent, matchesKeyword, gateFires, measureToolTokens, filterActive, buildEffectiveGates, injectBuiltinCore, BUILTIN_CORE } from "./tool-gate.ts";
import type { ToolGate, CoOccurrence } from "./tool-gate.ts";
import { CORE_NAMES, CORE_SET, CORE_TOOLS_ARRAY } from "./core-names.fixture.ts";
import { emitToolGateLog, isMissCandidate } from "./tool-gate.ts";
import toolGateExtension from "./tool-gate.ts";
import file2mdExtension from "@repo/pi-agent-ext-file2md/extensions/file2md.ts";
import flux2Extension from "@repo/pi-agent-ext-flux2/extensions/flux2.ts";
import krea2Extension from "@repo/pi-agent-ext-krea2/extensions/krea2.ts";
import ltxExtension from "@repo/pi-agent-ext-ltx/extensions/ltx.ts";
import movieExtension from "@repo/pi-agent-ext-movie-director/extensions/movie-director.ts";
import researchExtension from "@repo/pi-agent-ext-research-tool/extensions/research-tool.ts";
// tickets 10 + 11 (rolled out TOGETHER over their single shared combined
// workflow/subagent gating). Captured in workflow-FIRST order so "workflow"
// leads the family's gate order (the gate id qa + matchIntent key off of).
import workflowExtension from "@repo/pi-agent-ext-workflow/extensions/workflow.ts";
import subagentExtension from "@repo/pi-agent-ext-subagent/extensions/subagent.ts";

// CORE_NAMES / CORE_SET / CORE_TOOLS_ARRAY now imported from the shared
// ./core-names.fixture.ts (22 always-active names: 18 owner-declared in-repo
// core tools + 4 pi-coding-agent built-ins). Formerly duplicated verbatim here
// AND in self-promotion-interaction.test.ts; centralized to stop drift.

// file2md/vision_ask (ticket 04) + flux2/flux2_help (ticket 05) + krea2/
// krea2_help (ticket 06) + ltx/ltx_help (ticket 07) + movie/movie_help
// (ticket 08) + research-tool's collect_videos/organize_vault_notes/
// import_memory_to_vault + arxiv_search/arxiv_fetch2md/arxiv_paper (ticket 09)
// migrated to owner-declared gating — their gates no longer live
// in the hardcoded GATES, so
// the migration-touching integration tests below reconstruct the EFFECTIVE gate
// set the way production does (buildEffectiveGates over the owner-declared defs
// + fallback GATES), keeping the migrated tools firing + tracking exercised
// against real gating instead of re-hardcoding the gate definition here.
const ownerDeclaredDefs: { name: string; description?: string; gating?: unknown }[] = [];
const captureOwner = (ext: (pi: any) => void) =>
	ext({
		on: () => {},
		registerTool: (def: { name: string; description?: string; gating?: unknown }) => { ownerDeclaredDefs.push(def); },
		// research-tool registers 3 collect-videos slash commands; subagent
		// registers /subagents + /models-preset (registerCommand) — no-op them so
		// capture stays tool-only. Other migrated factories register tools only.
		registerCommand: () => {},
		// subagent registers ctrl+b (detach-foreground shortcut) — no-op it too.
		registerShortcut: () => {},
	} as never);
captureOwner(file2mdExtension);
captureOwner(flux2Extension);
captureOwner(krea2Extension);
captureOwner(ltxExtension);
captureOwner(movieExtension);
captureOwner(researchExtension);
// workflow BEFORE subagent (see import comment): the 5 tools share identical
// keywords-only gating, and buildEffectiveGates emits ONE SINGLE-NAME GATE PER
// DEF — so they become 5 single-name gates that co-fire, NOT one collapsed
// multi-name gate. Capture order therefore fixes EFF.gates order (and so
// matchIntent's result order), keeping "workflow" the family's canonical
// first-listed id. NOTE:
// the capture stub below (on/registerTool/registerCommand) tolerates BOTH
// registrars — workflow guards `if (pi.events)` (absent → skipped) and calls
// pi.on/registerTool; subagent's top-level pi.getActiveTools() is try/caught,
// registerModelsPresetCommand → pi.registerCommand (no-op'd), pi.registerTool
// (captured). subagent's companion subagent_runs carries NO gating →
// buildEffectiveGates skips it (not fail-open in EFF; it's simply absent from
// EFF.tracked, matching its ungated-by-design status). subagents (plural) now
// carries the workflow family's gating too, so it IS tracked — see the 5-name
// matchIntent assertion below.
captureOwner(workflowExtension);
captureOwner(subagentExtension);
// zai-mcp (ticket 12) is the odd one out: it registers tools DYNAMICALLY at
// session_start (tool names are discovered from each MCP server's listTools()),
// so — unlike the extensions above — captureOwner(zaiExtension) captures NOTHING
// (no top-level registerTool). Inject the owner-declared gating SYNTHETICALLY
// here, mirroring what production's registerServerTools attaches to every
// dynamically-registered zai tool: the reference form `gating: { gate: "zai" }`
// (wayfinder ticket 01) + the GATE_DEFS["zai"] family registration. buildEffectiveGates
// groups both names into one "zai" family gate; this keeps EFF/ownerByName
// reconstructing the zai gate exactly as production's buildEffectiveGates path does.
import { GATE_DEFS } from "@repo/pi-agent-core-interface";
GATE_DEFS["zai"] = {
  id: "zai",
  keywords: ["zai search", "zai reader", "zai web", "zai_mcp", "z.ai", "z.ai search", "z.ai reader"],
  requires: {
    nouns: ["online", "internet", "page", "site", "news", "網路", "網頁", "線上"],
    verbs: ["search", "find", "搜尋", "查", "找"],
  },
};
const ZAI_NAMES = ["zai_web_search_web_search_prime", "zai_web_reader_webReader"];
for (const name of ZAI_NAMES) {
  ownerDeclaredDefs.push({ name, description: "Z.ai MCP web tool", gating: { gate: "zai" } });
}
const EFF = buildEffectiveGates(ownerDeclaredDefs as never);
/** name → owner-declared def (incl. `gating`) for the migrated extensions. The
 *  setupPi integration harness threads this into its getAllToolDefinitions mock
 *  so the production buildEffectiveGates path reconstructs owner-declared gates
 *  (workflow/subagent etc.) instead of only the hardcoded-GATES fallback — the
 *  module GATES no longer holds workflow/subagent after tickets 10 + 11. */
const ownerByName = new Map(ownerDeclaredDefs.map((d: { name: string }) => [d.name, d] as const));

describe("updateSticky + filterActive", () => {
  test("a tool not in the core set or any gate is always active (fail-open)", () => {
    const allTools = [...CORE_NAMES, "some_future_tool_not_in_any_gate"];
    const sticky = new Set(CORE_SET);
    const active = filterActive(allTools, sticky);
    expect(active).toContain("some_future_tool_not_in_any_gate");
  });

  test("a gate stays active across turns even when a later prompt doesn't mention it", () => {
    const allTools = [...CORE_NAMES, "flux2", "flux2_help"];
    const sticky = new Set(CORE_SET);
    // flux2/flux2_help are owner-declared (ticket 05) → thread EFF so they're
    // tracked + gated (absent from module-level TRACKED_TOOLS/GATES now).
    updateSticky("generate an image of a cat", sticky, EFF.gates);
    expect(filterActive(allTools, sticky, EFF.tracked)).toContain("flux2");
    updateSticky("make it bigger", sticky, EFF.gates);
    const turn2 = filterActive(allTools, sticky, EFF.tracked);
    expect(turn2).toContain("flux2");
    expect(turn2).toContain("flux2_help");
  });

  test("a gate never mentioned by any prompt stays inactive", () => {
    const allTools = [...CORE_NAMES, "flux2", "flux2_help"];
    const sticky = new Set(CORE_SET);
    // Without EFF.tracked, flux2 would fail-open (absent from TRACKED_TOOLS) →
    // spuriously active. Thread EFF so flux2 stays gated when no keyword fires.
    updateSticky("what's the weather", sticky, EFF.gates);
    const active = filterActive(allTools, sticky, EFF.tracked);
    expect(active).not.toContain("flux2");
    expect(active).not.toContain("flux2_help");
  });

  test("core tools are always active regardless of prompt", () => {
    const allTools = [...CORE_NAMES];
    const sticky = new Set(CORE_SET);
    updateSticky("irrelevant prompt", sticky);
    const active = filterActive(allTools, sticky);
    for (const t of CORE_SET) expect(active).toContain(t);
  });
});

describe("updateSticky (mutation half)", () => {
  test("fires matching gates and mutates sticky in place", () => {
    const sticky = new Set(CORE_SET);
    // flux2/flux2_help owner-declared (ticket 05) → EFF.gates (both fire, co-fire preserved).
    updateSticky("generate an image of a cat", sticky, EFF.gates);
    expect(sticky.has("flux2")).toBe(true);
    expect(sticky.has("flux2_help")).toBe(true);
  });

  test("accumulates across turns (sticky persistence)", () => {
    const sticky = new Set(CORE_SET);
    // flux2 (ticket 05) + ltx (ticket 07) owner-declared; EFF.gates carries
    // both → flux2 fires on "generate an image", ltx on "make a video".
    updateSticky("generate an image", sticky, EFF.gates);
    updateSticky("make a video", sticky, EFF.gates);
    // both flux2 and ltx should be in sticky after two prompts
    expect(sticky.has("flux2")).toBe(true);
    expect(sticky.has("ltx")).toBe(true);
  });

  test("empty prompt fires nothing", () => {
    const sticky = new Set(CORE_SET);
    const before = sticky.size;
    updateSticky("", sticky);
    expect(sticky.size).toBe(before);
  });
});

// Ticket 15 deleted the hardcoded GATES array (it was empty post-migration).
// The former `describe("GATES data (S1)")` block lived here; its GATES-asserting
// test (`expect(GATES).toHaveLength(0)`) was removed with the symbol. The movie
// CJK firing is covered via the matchIntent (S1) block below.

// The former "inspect_* precision/escape" block (gateFires/matchIntent coverage
// of the keyword-gated inspect family) was REMOVED in wayfinder ticket 06
// (HITL): the six inspect_* diagnostics are now owner-declared CORE (always-on)
// — there is no inspect gate to fire anymore. See power-tool src/gating.ts.

describe("matchIntent (S1)", () => {
  const sticky = () => new Set(CORE_SET);

  test("video intent → ltx family", () => {
    // ltx/ltx_help share ONE id-referenced gate family (wayfinder ticket 01) →
    // buildEffectiveGates groups them into a single multi-name gate; matchIntent
    // surfaces the family, and co-firing (both names active together) is
    // preserved by the grouped gate's names array.
    const matched = matchIntent("make a video", EFF.gates, sticky());
    expect(matched.map((g) => g.names[0])).toEqual(["ltx"]);
    expect(matched[0]!.names).toEqual(["ltx", "ltx_help"]);
  });
  test("image intent → flux2 family", () => {
    // flux2/flux2_help share the "flux2" gate family (ticket 01 reference form).
    const matched = matchIntent("generate an image of a cat", EFF.gates, sticky());
    expect(matched.map((g) => g.names[0])).toEqual(["flux2"]);
    expect(matched[0]!.names).toEqual(["flux2", "flux2_help"]);
  });
  test("describe intent → file2md family", () => {
    // file2md/vision_ask share the "file2md" gate family (ticket 01 reference form).
    const matched = matchIntent("describe this picture", EFF.gates, sticky());
    expect(matched.map((g) => g.names[0])).toEqual(["file2md"]);
    expect(matched[0]!.names).toEqual(["file2md", "vision_ask"]);
  });
  test("movie intent (CJK) → movie family", () => {
    // movie/movie_help share the "movie" gate family (ticket 01 reference form).
    const matched = matchIntent("做一個 movie 分鏡", EFF.gates, sticky());
    expect(matched.map((g) => g.names[0])).toEqual(["movie"]);
    expect(matched[0]!.names).toEqual(["movie", "movie_help"]);
  });
  test("workflow intent → the 5-tool workflow/subagent family", () => {
    // workflow/workflow_help/workflow_control/subagent/subagents all reference
    // the ONE "workflow" gate family (ticket 01, declared in the workflow
    // extension, referenced cross-package by subagent) → buildEffectiveGates
    // groups all 5 into a single multi-name gate. Intent-mode fires the whole
    // family; co-fire via updateSticky is preserved by the grouped names.
    const matched = matchIntent("orchestrate a parallel pipeline", EFF.gates, sticky());
    expect(matched.map((g) => g.names[0])).toEqual(["workflow"]);
    expect(matched[0]!.names).toEqual(["workflow", "workflow_help", "workflow_control", "subagent", "subagents"]);
  });
  test("S2 flip: 'docker image cleanup' → [] (image noun, no gen-verb)", () => {
    expect(matchIntent("docker image cleanup", EFF.gates, sticky()).map((g) => g.names[0])).toEqual([]);
  });
  test("no match → []", () => {
    expect(matchIntent("what's the weather", EFF.gates, sticky())).toEqual([]);
  });
  test("dormant-skip: already-active gate is not returned", () => {
    const s = sticky();
    s.add("ltx"); s.add("ltx_help");
    // ltx/ltx_help owner-declared (ticket 07) → EFF.gates; both already in
    // sticky → dormant-skip returns [].
    expect(matchIntent("make a video", EFF.gates, s)).toEqual([]);
  });
});

describe("telemetry helpers (S1)", () => {
  // Hermeticity (matches hermes config.test.ts PR #938): the live agent harness
  // exports TOOL_GATE_LOG_PATH, which makes emitToolGateLog write to a FILE
  // instead of stderr — breaking the stderr-capture assertions below and
  // polluting the real telemetry file as a side-effect. Snapshot/delete/restore
  // per test so emitToolGateLog's stderr path is deterministic.
  let savedLogPath: string | undefined;
  beforeEach(() => { savedLogPath = process.env.TOOL_GATE_LOG_PATH; delete process.env.TOOL_GATE_LOG_PATH; });
  afterEach(() => { if (savedLogPath === undefined) delete process.env.TOOL_GATE_LOG_PATH; else process.env.TOOL_GATE_LOG_PATH = savedLogPath; });
  test("isMissCandidate: non-empty prompt + no fire + dormant ≥1 → true", () => {
    expect(isMissCandidate("hello", [], ["ltx"])).toBe(true);
  });
  test("isMissCandidate: empty prompt → false", () => {
    expect(isMissCandidate("   ", [], ["ltx"])).toBe(false);
  });
  test("isMissCandidate: a gate fired → false", () => {
    expect(isMissCandidate("make a video", ["ltx"], ["movie"])).toBe(false);
  });
  test("isMissCandidate: no dormant gate → false", () => {
    expect(isMissCandidate("hello", [], [])).toBe(false);
  });

  test("emitToolGateLog writes one JSON line to stderr when TOOL_GATE_LOG=1 (opt-in)", () => {
    const origEnv = process.env.TOOL_GATE_LOG;
    process.env.TOOL_GATE_LOG = "1";
    const sink: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr as { write: (s: string) => boolean }).write = (s: string) => { sink.push(s); return true; };
    try {
      emitToolGateLog({ kind: "turn", ts: "x", promptLen: 5, gatesFired: [], dormantGates: ["ltx"], activeCount: 20, totalCount: 40 });
    } finally {
      (process.stderr as { write: (s: string) => boolean }).write = orig;
      process.env.TOOL_GATE_LOG = origEnv;
    }
    expect(sink.length).toBe(1);
    const parsed = JSON.parse(sink[0]);
    expect(parsed.kind).toBe("turn");
    expect(parsed.dormantGates).toEqual(["ltx"]);
  });

  test("emitToolGateLog is silent by default (F4: opt-in, not opt-out)", () => {
    const origEnv = process.env.TOOL_GATE_LOG;
    delete process.env.TOOL_GATE_LOG;
    const sink: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr as { write: (s: string) => boolean }).write = (s: string) => { sink.push(s); return true; };
    try {
      emitToolGateLog({ kind: "turn", ts: "x", promptLen: 5, gatesFired: [], dormantGates: ["ltx"], activeCount: 20, totalCount: 40 });
    } finally {
      (process.stderr as { write: (s: string) => boolean }).write = orig;
      process.env.TOOL_GATE_LOG = origEnv;
    }
    expect(sink.length).toBe(0);
  });

  test("emitToolGateLog is a no-op when TOOL_GATE_LOG=0", () => {
    const orig = process.env.TOOL_GATE_LOG;
    process.env.TOOL_GATE_LOG = "0";
    const sink: string[] = [];
    const w = process.stderr.write.bind(process.stderr);
    (process.stderr as { write: (s: string) => boolean }).write = (s: string) => { sink.push(s); return true; };
    try {
      emitToolGateLog({ kind: "turn", ts: "x", promptLen: 1, gatesFired: [], dormantGates: [], activeCount: 1, totalCount: 1 });
    } finally {
      (process.stderr as { write: (s: string) => boolean }).write = w;
      process.env.TOOL_GATE_LOG = orig;
    }
    expect(sink.length).toBe(0);
  });
});

describe("computeBannerSaved (S3 — runtime measured tokens)", () => {
  test("sums measured tokens of loaded+gated gates only (no phantom, no static field)", () => {
    // Mock tools with real description+parameters so measureToolTokens is deterministic.
    // After ticket 12 the module GATES is EMPTY (every gate is owner-declared),
    // so computeBannerSaved is given a SYNTHETIC multi-name gate (mirroring a
    // former hardcoded entry) to prove its summing logic. The 4th arg is the
    // parameterized `gates` (defaults to the now-empty module GATES in prod).
    const mockTool = (name: string, desc: string) => ({ name, description: desc, parameters: { p: 1 } });
    const synthNames = ["synth_search", "synth_reader"];
    const loadedNames = [...CORE_NAMES, ...synthNames];
    const loadedTools = [
      ...CORE_TOOLS_ARRAY().map((n) => mockTool(n, "core")),
      mockTool("synth_search", "synth search"),
      mockTool("synth_reader", "synth reader"),
    ];
    const measured = new Map(loadedTools.map((t) => [t.name, measureToolTokens(t)]));
    const synthGate = { names: synthNames, keywords: ["synth"], description: "synthetic gate (ticket 12: GATES empty)" };
    // CORE-only active ⇒ synth gate is gated/dormant. filterActive needs the synth
    // names in `tracked` (they're absent from module TRACKED_TOOLS now) to stay
    // dormant instead of fail-opening.
    const active = filterActive(loadedNames, new Set(CORE_SET), new Set([...CORE_NAMES, ...synthNames]));
    const saved = computeBannerSaved(active, loadedNames, measured, [synthGate]);
    const expected = measured.get("synth_search")! + measured.get("synth_reader")!;
    expect(saved).toBe(expected);
  });

  test("a gate whose tools are absent from allToolNames contributes 0 (no phantom)", () => {
    const measured = new Map([["ghost_a", 999], ["ghost_b", 999]]);
    // ghost tools measured + gated, but NOT in allToolNames → excluded.
    const ghostGate = { names: ["ghost_a", "ghost_b"], keywords: ["ghost"], description: "gate whose tools are not loaded" };
    const saved = computeBannerSaved([...CORE_NAMES], [...CORE_NAMES], measured, [ghostGate]);
    expect(saved).toBe(0);
  });
});

describe("enable_tool (S1 A escape hatch)", () => {
  function setupPi(loadedTools: string[]) {
    const calls: { setActiveTools: string[] }[] = [];
    const registered: { name: string; execute: (a: string, p: any) => Promise<any> }[] = [];
    const handlers: Record<string, (e?: any, ctx?: any) => Promise<void> | void> = {};
    const pi: any = {
      // Thread owner-declared gating (ownerByName) so migrated gates reconstruct
      // via the production buildEffectiveGates path — the module GATES fallback
      // is now EMPTY (tickets 03–12 migrated every gate, incl. zai-mcp in ticket
      // 12). Names without an owner declaration fall back to {name} (ungated).
      getAllToolDefinitions: () => loadedTools.map((name) => (ownerByName as Map<string, any>).get(name) ?? { name }),
      setActiveTools: (names: string[]) => { calls.push({ setActiveTools: names }); },
      registerTool: (def: any) => { registered.push(def); },
      on: (ev: string, h: any) => { handlers[ev] = h; },
    };
    toolGateExtension(pi);
    // fire session_start so the closure populates allToolNames + sticky (as a real session does)
    if (handlers.session_start) {
      handlers.session_start({}, {
        ui: { theme: { fg: (_k: string, s: string) => s }, setWidget: () => {} },
      });
    }
    const enableTool = registered.find((r) => r.name === "enable_tool")!;
    return { pi, calls, registered, enableTool, handlers };
  }

  test("enable_tool is registered and is owner-declared core (always active)", () => {
    expect(CORE_SET.has("enable_tool")).toBe(true);
    const { enableTool } = setupPi([...CORE_NAMES, "ltx", "ltx_help", "flux2", "flux2_help", "workflow", "workflow_help"]);
    expect(enableTool).toBeTruthy();
  });

  test("list:true returns only dormant gates", async () => {
    // setupPi threads owner-declared gating (ownerByName), so workflow/workflow_help
    // (owner-declared, tickets 10 + 11) AND zai-mcp (owner-declared, ticket 12,
    // synthesized into ownerByName above) all reconstruct as gates. All are
    // dormant (CORE-only active) → every one appears in the list.
    const { enableTool } = setupPi([...CORE_NAMES, "workflow", "workflow_help", "zai_web_search_web_search_prime", "zai_web_reader_webReader"]);
    const res = await enableTool.execute("id", { list: true });
    const text = res.content[0].text;
    expect(text).toContain("workflow");
    expect(text).toContain("zai_web_search_web_search_prime");
  });

  test("intent 'orchestrate a parallel pipeline' activates workflow (sticky) and calls setActiveTools", async () => {
    const { enableTool, calls } = setupPi([...CORE_NAMES, "workflow", "workflow_help"]);
    const res = await enableTool.execute("id", { intent: "orchestrate a parallel pipeline" });
    expect(res.content[0].text).toContain("workflow");
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[calls.length - 1].setActiveTools).toEqual(expect.arrayContaining(["workflow", "workflow_help"]));
  });

  test("name 'workflow' co-activates its sibling gates (identical gating)", async () => {
    // workflow/workflow_help owner-declared (tickets 10 + 11) → buildEffectiveGates
    // splits each into its own single-name gate, but the two share IDENTICAL
    // owner-declared gating (same keywords). They co-fire as a family under
    // intent mode (matchIntent returns both) and auto-gating (updateSticky);
    // enable_tool NAME mode now mirrors that — requesting one sibling activates
    // ALL siblings with an identical gating fingerprint, so the escape hatch is
    // consistent regardless of whether a tool is requested by name or by intent.
    const { enableTool, calls } = setupPi([...CORE_NAMES, "workflow", "workflow_help"]);
    const res = await enableTool.execute("id", { name: "workflow" });
    expect(res.content[0].text).toContain("workflow");
    const lastActive = calls[calls.length - 1].setActiveTools;
    expect(lastActive).toEqual(expect.arrayContaining(["workflow", "workflow_help"]));
  });

  test("no-match intent returns a non-error result pointing to list", async () => {
    const { enableTool } = setupPi([...CORE_NAMES, "workflow", "workflow_help"]);
    const res = await enableTool.execute("id", { intent: "what's the weather" });
    expect(res.content[0].text).toMatch(/no dormant tool matched/i);
    expect(res.content[0].text).toMatch(/list:true/i);
  });

  test("F1 regression: enable_tool uses filterActive, not updateSticky (no re-firing of gates)", async () => {
    // Verify that enable_tool.execute uses filterActive (not updateSticky)
    // to build the active list. updateSticky re-evaluates every gate
    // against lastPrompt, which is unnecessary work and couples enable_tool to
    // the prompt-matching logic. filterActive computes the active list from
    // sticky alone — no gate re-evaluation, no risk of lastPrompt side effects.
    const loaded = [...CORE_NAMES, "workflow", "workflow_help", "zai_web_search_web_search_prime", "zai_web_reader_webReader"];
    const { enableTool, calls } = setupPi(loaded);
    const res = await enableTool.execute("id", { name: "workflow" });
    expect(res.content[0].text).toContain("workflow");
    const lastActive = calls[calls.length - 1].setActiveTools;
    // workflow + its sibling workflow_help co-activate (identical gating
    // fingerprint — NAME mode now mirrors intent mode's sibling co-firing).
    expect(lastActive).toEqual(expect.arrayContaining(["workflow", "workflow_help"]));
    // zai-mcp must NOT be active: it has DIFFERENT gating from workflow, so it
    // is not a sibling and must not co-activate. This proves co-activation is
    // gated by identical gating, not "everything". filterActive also doesn't
    // re-fire gates against lastPrompt — only the requested sibling group fires.
    expect(lastActive).not.toContain("zai_web_search_web_search_prime");
    expect(lastActive).not.toContain("zai_web_reader_webReader");
  });

  test("F3 regression: enable_tool with already-active gate returns 'already active' (not 'Activated')", async () => {
    // When a gate is already fully active, enable_tool({name}) must not claim
    // it was "Activated" — it should say "already active".
    const loaded = [...CORE_NAMES, "workflow", "workflow_help"];
    const { enableTool, handlers } = setupPi(loaded);
    // Activate workflow first via before_agent_start
    if (handlers.before_agent_start) {
      await handlers.before_agent_start({ prompt: "orchestrate a parallel pipeline" });
    }
    // Now request workflow again — it's already active
    const res = await enableTool.execute("id", { name: "workflow" });
    expect(res.content[0].text).toMatch(/already active/i);
    expect(res.content[0].text).not.toMatch(/Activated/i);
  });

  test("mutation guard: execute never throws even if setActiveTools fails", async () => {
    // setActiveTools throwing inside execute must be caught → error result, not a throw.
    // enable_tool's effectiveGates starts as the (now-empty) module GATES and is
    // rebuilt only at session_start/before_agent_start from getAllToolDefinitions.
    // So we MUST fire session_start to populate effectiveGates with the zai gate
    // (owner-declared via registerServerTools in ticket 12; mirrored here via
    // ZAI_GATING on the mocked def) — then make setActiveTools throw ONLY inside
    // execute (not during session_start, which also calls it) so the throw lands
    // in execute's try/catch. The guard under test: execute swallows the throw
    // and returns an /error/ result instead of rejecting.
    const handlers: Record<string, any> = {};
    let throwOnSetActive = false;
    const pi: any = {
      getAllToolDefinitions: () => [...CORE_NAMES, ...ZAI_NAMES].map((name) => ({ name, ...(name.startsWith("zai_") ? { gating: { gate: "zai" } } : {}) })),
      setActiveTools: () => { if (throwOnSetActive) throw new Error("setActiveTools boom"); },
      registerTool: (def: any) => { (pi as any)._t = def; },
      on: (ev: string, h: any) => { handlers[ev] = h; },
    };
    toolGateExtension(pi);
    const enableTool = (pi as any)._t;
    // session_start builds effectiveGates from getAllToolDefinitions (zai gate
    // present) WITHOUT throwing → the zai gate is live for the intent match below.
    await handlers.session_start({}, { ui: { theme: { fg: (_k: string, s: string) => s }, setWidget: () => {} } });
    throwOnSetActive = true;
    const res = await enableTool.execute("id", { intent: "use zai search to find results" });
    expect(res.content[0].text).toMatch(/error/i);
  });
});

describe("filterActive (F1 fix)", () => {
  test("tools not in the tracked set are always active (fail-open)", () => {
    const sticky = new Set(CORE_SET);
    const active = filterActive([...CORE_NAMES, "some_new_tool"], sticky);
    expect(active).toContain("some_new_tool");
  });

  test("gated tool is active only when in sticky", () => {
    // flux2 (ticket 05) + ltx (ticket 07) + movie (ticket 08) + workflow
    // (tickets 10 + 11) migrated → absent from module TRACKED_TOOLS, so
    // filterActive would fail-open them. Thread EFF.tracked so they stay gated.
    const all = [...CORE_NAMES, "zai_web_search_web_search_prime", "zai_web_reader_webReader", "workflow", "workflow_help"];
    const sticky = new Set([...CORE_NAMES, "zai_web_search_web_search_prime", "zai_web_reader_webReader"]);
    const active = filterActive(all, sticky, EFF.tracked);
    expect(active).toContain("zai_web_search_web_search_prime");
    expect(active).toContain("zai_web_reader_webReader");
    expect(active).not.toContain("workflow");
    expect(active).not.toContain("workflow_help");
  });

  test("does NOT mutate sticky", () => {
    const sticky = new Set(CORE_SET);
    const before = sticky.size;
    filterActive([...CORE_NAMES, "workflow", "workflow_help"], sticky);
    expect(sticky.size).toBe(before);
    expect(sticky.has("workflow")).toBe(false);
  });
});

describe("matchesKeyword (S2)", () => {
  test("word-boundary: 'flux' does NOT match inside 'conflux'", () => {
    expect(matchesKeyword("flux", "use the conflux library")).toBe(false);
  });
  test("word-boundary: 'flux' matches as a whole word", () => {
    expect(matchesKeyword("flux", "use the flux model")).toBe(true);
  });
  test("phrase substring: 'generate image' is NOT a substring of 'generate an image' (the gap co-occurrence closes)", () => {
    // This is the brittleness that motivates the requires:{nouns,verbs} design in Task 2/3.
    expect(matchesKeyword("generate image", "generate an image of a cat")).toBe(false);
  });
  test("phrase substring: 'generate image' matches 'generate image now'", () => {
    expect(matchesKeyword("generate image", "generate image now")).toBe(true);
  });
  test("CJK substring: '做動畫' matches a CJK prompt", () => {
    expect(matchesKeyword("做動畫", "幫我做動畫")).toBe(true);
  });
  test("M8: repeated calls are consistent (word-boundary regex cache is transparent)", () => {
    // The regex is now cached by lowercased keyword; verify correctness is
    // unchanged across many calls and that cached entries still respect word
    // boundaries (no cross-contamination between cached keywords).
    for (let i = 0; i < 50; i++) {
      expect(matchesKeyword("flux", "use the flux model")).toBe(true);
      expect(matchesKeyword("flux", "use the conflux library")).toBe(false);
      expect(matchesKeyword("image", "docker image pull")).toBe(true);
    }
  });
});

describe("gateFires (S2 co-occurrence)", () => {
  const coreNounGate: ToolGate = {
    names: ["fake"],
    keywords: ["outpaint"],
    description: "x",
    requires: { nouns: ["image", "picture"], verbs: ["generate", "make"] },
  };

  test("keyword match fires regardless of requires", () => {
    expect(gateFires(coreNounGate, "please outpaint this")).toBe(true);
  });
  test("noun + verb co-occurrence fires", () => {
    expect(gateFires(coreNounGate, "generate an image of a cat")).toBe(true);
  });
  test("noun without a gen-verb does NOT fire (the docker-image case)", () => {
    expect(gateFires(coreNounGate, "docker image cleanup")).toBe(false);
  });
  test("verb without a noun does NOT fire", () => {
    expect(gateFires(coreNounGate, "generate a report")).toBe(false);
  });
  test("gate without requires fires only on keywords", () => {
    const plain: ToolGate = { names: ["p"], keywords: ["montage"], description: "x" };
    expect(gateFires(plain, "orchestrate a montage")).toBe(true);
    expect(gateFires(plain, "generate an image")).toBe(false);
  });
});

describe("S2 keyword audit (updateSticky + filterActive Effect table)", () => {
  // inspect_extensions dropped (Task-3 review Minor C): it's owner-declared now,
  // absent from hardcoded TRACKED_TOOLS → fail-open → always-active dead data.
  const all = [...CORE_NAMES, "flux2", "flux2_help", "krea2", "krea2_help", "ltx", "ltx_help",
    "file2md", "vision_ask", "workflow", "workflow_help",
    "collect_videos", "movie", "movie_help"];
  // flux2 (ticket 05) + file2md/vision_ask (ticket 04) + krea2/krea2_help
  // (ticket 06) + ltx/ltx_help (ticket 07) + movie/movie_help (ticket 08) +
  // collect_videos (ticket 09, research-tool) are
  // owner-declared → thread the effective gates + tracked set (production
  // session_start path) so they stay tracked + gated instead of falling open
  // (absent from module-level TRACKED_TOOLS).
  const act = (prompt: string) => {
    const sticky = new Set(EFF.core);
    updateSticky(prompt, sticky, EFF.gates);
    return filterActive(all, sticky, EFF.tracked);
  };

  test("docker image cleanup → []", () => {
    expect(act("docker image cleanup")).toEqual(expect.arrayContaining([...CORE_NAMES]));
    expect(act("docker image cleanup")).not.toContain("flux2");
  });
  test("generate an image of a cat → flux2 (generate+image)", () => {
    expect(act("generate an image of a cat")).toContain("flux2");
  });
  test("coding style → []", () => {
    expect(act("coding style")).not.toContain("flux2");
  });
  test("video call → []", () => {
    expect(act("video call")).not.toContain("ltx");
  });
  test("make a video → ltx (make+video)", () => {
    expect(act("make a video")).toContain("ltx");
  });
  test("做動畫 → ltx (做+動畫)", () => {
    expect(act("做動畫")).toContain("ltx");
  });
  test("下載影片 → [] (影片 noun, no gen-verb)", () => {
    expect(act("下載影片")).not.toContain("ltx");
  });
  test("draft an email → []", () => {
    expect(act("draft an email")).not.toContain("krea2");
  });
  test("describe the problem → []", () => {
    expect(act("describe the problem")).not.toContain("file2md");
  });
  test("read this pdf → file2md (read+pdf)", () => {
    expect(act("read this pdf")).toContain("file2md");
  });
  test("supply chain → []", () => {
    expect(act("supply chain")).not.toContain("workflow");
  });
  test("collect the data → []", () => {
    expect(act("collect the data")).not.toContain("collect_videos");
  });
  test("orchestrate a montage → movie (montage keyword)", () => {
    expect(act("orchestrate a montage")).toContain("movie");
  });
});

describe("S2 cross-gate invariant — shared noun, disjoint verbs ⇒ only one fires", () => {
  const all = [...CORE_NAMES, "flux2", "flux2_help", "ltx", "ltx_help",
    "file2md", "vision_ask"];
  // flux2 (ticket 05) + file2md/vision_ask (ticket 04) → effective gates/tracked.
  const act = (prompt: string) => {
    const sticky = new Set(EFF.core);
    updateSticky(prompt, sticky, EFF.gates);
    return filterActive(all, sticky, EFF.tracked);
  };

  test("'generate an image' fires flux2 but NOT file2md (generate ∉ file2md verbs)", () => {
    const a = act("generate an image");
    expect(a).toContain("flux2");
    expect(a).not.toContain("file2md");
  });
  test("'describe this picture' fires file2md but NOT flux2 (describe ∉ flux2 verbs)", () => {
    const a = act("describe this picture");
    expect(a).toContain("file2md");
    expect(a).not.toContain("flux2");
  });
});

describe("S2 matchIntent false-fire cases", () => {
  const sticky = () => new Set(CORE_SET);
  const first = (prompt: string) => matchIntent(prompt, EFF.gates, sticky()).map((g) => g.names[0]);

  test("describe the architecture → []", () => {
    expect(first("describe the architecture")).toEqual([]);
  });
  test("make an image → the flux2 family [flux2, flux2_help] (make+image via requires)", () => {
    // flux2/flux2_help share the ONE "flux2" gate family (ticket 01 reference
    // form) → EFF groups them into a single multi-name gate; matchIntent
    // surfaces the family with both names (co-fire preserved by construction).
    const matched = matchIntent("make an image", EFF.gates, sticky());
    expect(matched.map((g) => g.names[0])).toEqual(["flux2"]);
    expect(matched[0]!.names).toEqual(["flux2", "flux2_help"]);
  });
  test("conflux library → [] (flux word-boundary, not inside conflux)", () => {
    expect(first("use the conflux library")).toEqual([]);
  });
});

describe("previously-leaked tools regression (2026-07-21)", () => {
  // These 5 tools were untracked (fail-open → always active) before the fix.
  // Each must now be explicitly tracked — either owner-declared core or a GATE.

  test("grill_decision is in the core set (always active, not fail-open)", () => {
    expect(CORE_SET.has("grill_decision")).toBe(true);
  });

  test("subagent + workflow_control are gated (tracked, not fail-open)", () => {
    // Originally the combined {workflow,workflow_help,subagent,workflow_control}
    // gate; tickets 10 + 11 migrated each to owner-declared gating → each is its
    // OWN single-name gate in EFF (buildEffectiveGates splits them). The
    // regression invariant these tests guard — the previously-leaked tools are
    // TRACKED (gated), NOT fail-open — is preserved: all 4 names are in EFF.tracked.
    expect(EFF.tracked.has("workflow")).toBe(true);
    expect(EFF.tracked.has("workflow_help")).toBe(true);
    expect(EFF.tracked.has("subagent")).toBe(true);
    expect(EFF.tracked.has("workflow_control")).toBe(true);
  });

  test("zai-mcp proxy tools are gated (tracked, not fail-open)", () => {
    // zai-mcp owner-declared (ticket 12) → absent from module GATES/TRACKED_TOOLS;
    // buildEffectiveGates splits each name into its OWN single-name gate in EFF
    // (identical predicates → intent-mode co-fire preserved). Both names are gated.
    const searchGate = EFF.gates.find((g) => g.names.includes("zai_web_search_web_search_prime"));
    const readerGate = EFF.gates.find((g) => g.names.includes("zai_web_reader_webReader"));
    expect(searchGate).toBeDefined();
    expect(readerGate).toBeDefined();
  });

  test("none of the 5 previously-leaked tools are untracked (fail-open)", () => {
    // Full tracked set = core ∪ all gate names (what buildEffectiveGates emits as
    // `.tracked` when given the complete def list). EFF here is built from the
    // migrated GATED extensions only (its `.core` is empty — no core registrar
    // captured), so union the core names back in to mirror the runtime full
    // tracked set. Before ticket 04 the CORE_TOOLS fallback did this implicitly;
    // now core + gates are explicit. So the 5 previously-leaked tools are all
    // tracked regardless of which gate/set owns them.
    const tracked = new Set<string>([...CORE_NAMES, ...EFF.tracked]);
    const leaked = [
      "grill_decision",
      "subagent",
      "workflow_control",
      "zai_web_search_web_search_prime",
      "zai_web_reader_webReader",
    ];
    for (const name of leaked) {
      expect(tracked.has(name)).toBe(true);
    }
  });

  test("subagent + workflow_control gate behind 'workflow' keyword", () => {
    // workflow/workflow_help/subagent/workflow_control owner-declared (tickets
    // 10 + 11) → absent from module GATES/TRACKED_TOOLS. Thread EFF.gates +
    // EFF.tracked so the gates fire on the keyword AND stay tracked (else they
    // fail-open, hiding whether the keyword actually fired).
    const sticky = new Set(EFF.core);
    const allTools = [...CORE_NAMES, "workflow", "workflow_help", "subagent", "workflow_control"];
    updateSticky("run a multi-step workflow", sticky, EFF.gates);
    const active = filterActive(allTools, sticky, EFF.tracked);
    expect(active).toContain("subagent");
    expect(active).toContain("workflow_control");
  });

  test("zai-mcp gate fires on 'zai search' keyword", () => {
    const sticky = new Set(CORE_SET);
    const allTools = [...CORE_NAMES, "zai_web_search_web_search_prime", "zai_web_reader_webReader"];
    // zai-mcp owner-declared (ticket 12) → thread EFF so the gates fire + stay
    // tracked (absent from module GATES/TRACKED_TOOLS now).
    updateSticky("use zai search to find results", sticky, EFF.gates);
    const active = filterActive(allTools, sticky, EFF.tracked);
    expect(active).toContain("zai_web_search_web_search_prime");
    expect(active).toContain("zai_web_reader_webReader");
  });

  test("zai-mcp tools stay dormant without keyword (the savings)", () => {
    const sticky = new Set(CORE_SET);
    const allTools = [...CORE_NAMES, "zai_web_search_web_search_prime", "zai_web_reader_webReader"];
    updateSticky("search the web for cats", sticky, EFF.gates);
    const active = filterActive(allTools, sticky, EFF.tracked);
    // 'search' alone doesn't fire the zai gate — only 'zai search' does
    expect(active).not.toContain("zai_web_search_web_search_prime");
    expect(active).not.toContain("zai_web_reader_webReader");
  });

  test("obsidian_help is in the core set (always active, not fail-open)", () => {
    expect(CORE_SET.has("obsidian_help")).toBe(true);
  });

  test("inspect_tui is owner-declared CORE (ticket 06 un-gate, not fail-open)", () => {
    // ticket 06 (HITL): the inspect_* diagnostics are always-on core, NOT
    // keyword-gated. buildEffectiveGates must route core:true into eff.core.
    const eff = buildEffectiveGates([
      { name: "inspect_tui", description: "d", gating: { core: true } },
    ]);
    expect(eff.core.has("inspect_tui")).toBe(true); // core → always active
    expect(eff.gates.find((g) => g.names.includes("inspect_tui"))).toBeUndefined();
  });
});

describe("measureToolTokens (S3)", () => {
  test("replicates schema-cost.ts:20 — round((desc + params) / 4)", () => {
    const tool = { description: "abcd", parameters: { a: 1 } }; // desc=4, params=JSON.stringify({a:1})='{"a":1}'=7
    const expected = Math.round((4 + 7) / 4); // = round(2.75) = 3
    expect(measureToolTokens(tool)).toBe(expected);
  });
  test("missing description + parameters → treats as empty (0 + '{}')", () => {
    // desc="" (0), params=JSON.stringify({})='{}' (2) → round(2/4)=1
    expect(measureToolTokens({})).toBe(1);
  });
  test("long description scales linearly", () => {
    const short = measureToolTokens({ description: "x", parameters: {} });
    const long = measureToolTokens({ description: "x".repeat(400), parameters: {} });
    expect(long).toBeGreaterThan(short * 50);
  });
});

describe("buildEffectiveGates", () => {
  test("owner-declared core:true → core set, removed from fallback need", () => {
    const defs = [{ name: "enable_tool", gating: { core: true } }] as Array<{
      name: string; description?: string; gating?: { core?: boolean; gate?: string };
    }>;
    const eff = buildEffectiveGates(defs);
    expect(eff.core.has("enable_tool")).toBe(true);
    expect(eff.gates.find((g) => g.names.includes("enable_tool"))).toBeUndefined();
  });

  test("owner-declared non-core gating (reference form) resolves keywords/requires from the registry", () => {
    // 01c: the ONLY non-core form is `gating: { gate: "<id>" }` — keywords/
    // requires come from the registry spec, grouped by id.
    const defs = [{
      name: "flux2", description: "d",
      gating: { gate: "flux2" },
    }] as Array<{ name: string; description?: string; gating?: any }>;
    const eff = buildEffectiveGates(defs, {
      flux2: { id: "flux2", keywords: ["flux"], requires: { nouns: ["image"], verbs: ["generate"] } },
    });
    const g = eff.gates.find((x) => x.names.includes("flux2"));
    expect(g).toBeDefined();
    expect(g!.keywords).toEqual(["flux"]);
    expect(g!.requires).toEqual({ nouns: ["image"], verbs: ["generate"] });
    expect(g!.gateId).toBe("flux2");
  });

  test("undeclared names are simply ungated (no hardcoded fallback — ticket 04 deleted CORE_TOOLS)", () => {
    // Ticket 15 deleted the hardcoded GATES array + the `fallbackGates` param;
    // ticket 04 deleted the `fallbackCore` (= CORE_TOOLS) always-active set.
    // Now NOTHING falls back: a name with no owner declaration is simply
    // ungated (absent from eff.core + eff.tracked). read/write/edit/bash only
    // land in core when injectBuiltinCore attaches gating:{core:true} (ticket 03).
    const eff = buildEffectiveGates([]); // no owner declarations
    expect(eff.core.has("read")).toBe(false); // no fallback — read is ungated here
    expect(eff.gates).toHaveLength(0); // no fallback gates exist
  });

  test("01c: a def with neither core:true nor a gate reference is invalid → ungated (fail-open)", () => {
    // The inline keywords/requires form was DELETED in 01c — such a def carries
    // no valid gating, so it is simply untracked (fail-open); the drift-guard
    // flags the declaration at CI time.
    const eff = buildEffectiveGates([{ name: "legacy", gating: { keywords: ["kw"] } }] as never);
    expect(eff.gates).toHaveLength(0);
    expect(eff.tracked.has("legacy")).toBe(false);
  });

  // Ticket 15 deleted the hardcoded GATES array, the buildEffectiveGates
  // `fallbackGates` param, and the FOLLOWUPS #4 per-name fallback partition.
  // The two tests that lived here ("owner-declared tool supersedes a same-named
  // fallback gate" + "FOLLOWUPS #4 — partial migration… per-name resolution")
  // asserted exactly that removed fallback mechanism, so they were deleted with
  // it. Ticket 04 then deleted the `fallbackCore` always-active set (the former
  // CORE_TOOLS) — buildEffectiveGates now has ONLY owner-declared `gating`, no
  // fallback of any kind (core or gate).
});

describe("injectBuiltinCore (ticket 03 — Path B injected-core for the 4 built-ins)", () => {
  test("injects gating:{core:true} so buildEffectiveGates routes the 4 built-ins to core via owner-declaration", () => {
    // Bare built-in defs exactly as getAllToolDefinitions surfaces them: name
    // only, NO gating. (pi-coding-agent is immutable + `gating` is extension-
    // only — see injectBuiltinCore docs — so the live defs arrive bare.)
    const raw = ["read", "write", "edit", "bash"].map((name) => ({ name }));
    const injected = injectBuiltinCore(raw);
    // Every built-in now carries gating.core === true.
    for (const d of injected) expect((d as { gating?: { core?: boolean } }).gating?.core).toBe(true);
    // PROOF the built-ins are routed via owner-declared gating:{core:true}, NOT
    // any fallback: buildEffectiveGates now takes a SINGLE arg (no fallbackCore),
    // and the injected gating is the only thing putting the built-ins in eff.core.
    const eff = buildEffectiveGates(injected as never);
    for (const name of BUILTIN_CORE) expect(eff.core.has(name)).toBe(true);
  });

  test("does NOT mutate the upstream def (shallow-clone: built-in defs may be frozen)", () => {
    const raw = [{ name: "read" }];
    Object.freeze(raw[0]);
    const injected = injectBuiltinCore(raw);
    // upstream untouched (still no gating) …
    expect((raw[0] as { gating?: unknown }).gating).toBeUndefined();
    // … injected clone carries core:true WITHOUT a frozen-object throw …
    expect((injected[0] as { gating?: { core?: boolean } }).gating?.core).toBe(true);
    // … and is a different object (the clone, not the same reference).
    expect(injected[0]).not.toBe(raw[0]);
  });

  test("non-built-in defs pass through untouched (same reference, no gating added)", () => {
    const flux = { name: "flux2", gating: { gate: "flux2" } }; // reference form (01c)
    const injected = injectBuiltinCore([flux]);
    expect(injected[0]).toBe(flux); // same reference — untouched
  });

  test("a built-in that already declares gating.core===true is left as-is (idempotent)", () => {
    const read = { name: "read", gating: { core: true } };
    const injected = injectBuiltinCore([read]);
    expect(injected[0]).toBe(read); // already core:true → no re-clone needed
  });
});

describe("tool-gate runtime reads owner-declared gating", () => {
  test("a core-declared tool is active; a gated tool is dormant", async () => {
    const activeCalls: string[][] = [];
    let sessionStartHandler: ((e: unknown, ctx: unknown) => Promise<void>) | null = null;
    const pi = {
      getAllToolDefinitions: () => [
        { name: "read", description: "r", gating: { core: true } },
        // inspect_hooks is owner-declared CORE since ticket 06 (un-gate) → active.
        { name: "inspect_hooks", description: "d", gating: { core: true } },
        { name: "zai_web_search_web_search_prime", description: "f", gating: { gate: "zai" } }, // reference form (ticket 01) → gated; no keyword in "" prompt → dormant
      ],
      on: (_chan: string, h: (e: unknown, ctx: unknown) => Promise<void>) => { if (_chan === "session_start") sessionStartHandler = h; return () => {}; },
      setActiveTools: (names: string[]) => { activeCalls.push(names); },
      registerTool: () => {},
      // ctx passed to the handler:
    } as unknown as Parameters<typeof toolGateExtension>[0];
    toolGateExtension(pi);
    await sessionStartHandler!({}, { ui: { theme: { fg: (_k: string, s: string) => s }, setWidget: () => {} } });
    const active = activeCalls[0];
    expect(active).toContain("read");            // core-declared → active
    expect(active).toContain("inspect_hooks");     // core (ticket 06 un-gate) → active
    expect(active).not.toContain("zai_web_search_web_search_prime");          // owner-declared (ticket 12), no keyword → dormant
  });

  test("enable_tool recompute must NOT spuriously activate an owner-gated tool absent from TRACKED_TOOLS", async () => {
    // Regression for the enable_tool F1-fix block: its filterActive call used
    // the DEFAULT tracked set (module TRACKED_TOOLS — now an EMPTY placeholder
    // post-ticket-04; formerly CORE_TOOLS ∪ GATES-names) instead of
    // effectiveTracked. Any owner-declared gated tool whose name is NOT in the
    // session-built effective tracked set is therefore absent from TRACKED_TOOLS
    // → filterActive treats it as fail-open → it is spuriously active during an
    // enable_tool recompute. Fix: pass effectiveTracked.
    // Local family registration (scoped to this test; cleaned up after) so the
    // reference-form `gating: { gate: "unobtanium" }` resolves to a REAL gate —
    // the fixture needs it tracked+gated, not fail-open.
    GATE_DEFS["unobtanium"] = { id: "unobtanium", keywords: ["unobtanium-trigger"] };
    try {
    const activeCalls: string[][] = [];
    let sessionStartHandler: ((e: unknown, ctx: unknown) => Promise<void>) | null = null;
    let enableToolExecute: ((toolCallId: string, params: any) => Promise<any>) | null = null;
    const pi = {
      getAllToolDefinitions: () => [
        { name: "read", gating: { core: true } },
        // owner-declared NON-CORE gated tool; "unobtanium_tool" is NOT in any
        // owner-declared core set or gate → absent from the effective tracked
        // set (and from the now-empty module TRACKED_TOOLS).
        // (reference form, 01c — family registered below)
        { name: "unobtanium_tool", gating: { gate: "unobtanium" } },
        // a separate gated tool (zai-mcp, owner-declared in ticket 12 via
        // registerServerTools; we mirror ZAI_GATING here so it reconstructs as a
        // gate and enable_tool name-mode can resolve + activate it on request).
        { name: "zai_web_search_web_search_prime", gating: { gate: "zai" } },
      ],
      on: (_chan: string, h: (e: unknown, ctx: unknown) => Promise<void>) => {
        if (_chan === "session_start") sessionStartHandler = h;
        return () => {};
      },
      setActiveTools: (names: string[]) => { activeCalls.push(names); },
      registerTool: (def: { name: string; execute: (toolCallId: string, params: any) => Promise<any> }) => {
        if (def.name === "enable_tool") enableToolExecute = def.execute;
      },
    } as unknown as Parameters<typeof toolGateExtension>[0];
    toolGateExtension(pi);
    // drive session_start so effective gates are built; X must be dormant here.
    await sessionStartHandler!({}, { ui: { theme: { fg: (_k: string, s: string) => s }, setWidget: () => {} } });
    const sessionActive = activeCalls[0];
    expect(sessionActive).not.toContain("unobtanium_tool"); // owner-gated, no keyword → dormant

    // request a DIFFERENT tool (zai-mcp) — X was never asked for.
    await enableToolExecute!("id", { name: "zai_web_search_web_search_prime" });
    const recomputeActive = activeCalls[activeCalls.length - 1];
    expect(recomputeActive).toContain("zai_web_search_web_search_prime");               // zai explicitly requested → active
    expect(recomputeActive).not.toContain("unobtanium_tool"); // X must stay dormant during the recompute
    } finally {
      delete GATE_DEFS["unobtanium"]; // scoped cleanup — don't leak into other test files
    }
  });

  test("#2 before_agent_start self-seeds sticky when session_start was skipped (in-process subagent child)", async () => {
    // A child spawned via WorkflowAgent.run never fires session_start, so tool-gate's
    // sticky starts empty. before_agent_start must seed it from effectiveCore so core
    // tools stay active. See .planning/2026-08-08-fix-subagent-spawn-seam.../ ticket 02.
    const activeCalls: string[][] = [];
    let beforeAgentStart: ((e: any, ctx?: any) => Promise<void>) | null = null;
    const pi = {
      getAllToolDefinitions: () => [
        { name: "read", gating: { core: true } },
        { name: "bash", gating: { core: true } },
        { name: "flux2", gating: { gate: "flux2" } }, // reference form (01c)
      ],
      on: (chan: string, h: any) => { if (chan === "before_agent_start") beforeAgentStart = h; return () => {}; },
      setActiveTools: (names: string[]) => { activeCalls.push(names); },
      registerTool: () => {},
    } as unknown as Parameters<typeof toolGateExtension>[0];
    toolGateExtension(pi);
    // do NOT fire session_start — simulate the in-process subagent child
    await beforeAgentStart!({ prompt: "a benign prompt containing no gate keyword" });
    const active = activeCalls[activeCalls.length - 1];
    expect(active).toEqual(expect.arrayContaining(["read", "bash"])); // core seeded from effectiveCore
    expect(active).not.toContain("flux2");                            // gated, no keyword → dormant
  });

  test("ticket 05: parent + child sessions have INDEPENDENT gate state (keyed by session id)", async () => {
    // Parent fires session_start; a child (distinct session id) skips it and
    // seeds its own state on first before_agent_start. Firing a gate in the
    // PARENT must NOT leak into the CHILD's sticky, and vice versa.
    const setActiveCalls: string[][] = [];
    const handlers: Record<string, (e?: any, ctx?: any) => Promise<void> | void> = {};
    let toolCount = 0;
    const pi = {
      getAllToolDefinitions: () => [
        { name: "read", gating: { core: true } },
        { name: "flux2", gating: { gate: "flux2" } },
      ],
      on: (chan: string, h: any) => { handlers[chan] = h; },
      setActiveTools: (names: string[]) => { setActiveCalls.push(names); },
      registerTool: () => {},
    } as unknown as Parameters<typeof toolGateExtension>[0];
    toolGateExtension(pi);

    const parentCtx = { sessionManager: { getSessionId: () => "parent-session" } };
    const childCtx = { sessionManager: { getSessionId: () => "child-session" } };

    // parent session_start → parent state seeded with core only
    await handlers.session_start!({}, { ui: { theme: { fg: (_k: string, s: string) => s }, setWidget: () => {} }, ...parentCtx } as any);
    expect(setActiveCalls[0]).toEqual(expect.arrayContaining(["read"]));
    expect(setActiveCalls[0]).not.toContain("flux2");

    // parent turn fires flux2 → parent sticky gains it
    await handlers.before_agent_start!({ prompt: "generate an image" }, parentCtx);
    expect(setActiveCalls[1]).toContain("flux2"); // parent active

    // child's FIRST turn (no session_start) — child seeds its OWN state: core
    // only, flux2 still dormant despite the parent having fired it.
    await handlers.before_agent_start!({ prompt: "a benign child prompt" }, childCtx);
    const childActive = setActiveCalls[setActiveCalls.length - 1];
    expect(childActive).toContain("read");        // child core seeded
    expect(childActive).not.toContain("flux2");   // parent's fire did NOT leak into child
  });

  test("ticket 05: per-turn path does NOT rebuild the gate set (session_start is the one rebuild)", async () => {
    // F6: before_agent_start must fire + filter only. getDiscovered is called
    // at session_start (1) and at most once more to seed a missing session — a
    // session that already fired session_start sees NO further discovery calls
    // on its per-turn path.
    let discoveryCalls = 0;
    const handlers: Record<string, (e?: any, ctx?: any) => Promise<void> | void> = {};
    const pi = {
      getAllToolDefinitions: () => { discoveryCalls++; return [{ name: "read", gating: { core: true } }]; },
      on: (chan: string, h: any) => { handlers[chan] = h; },
      setActiveTools: () => {},
      registerTool: () => {},
    } as unknown as Parameters<typeof toolGateExtension>[0];
    toolGateExtension(pi);
    const ctx = { sessionManager: { getSessionId: () => "s" } };
    await handlers.session_start!({}, { ui: { theme: { fg: (_k: string, s: string) => s }, setWidget: () => {} }, ...ctx } as any);
    expect(discoveryCalls).toBe(1); // the ONE session_start rebuild
    await handlers.before_agent_start!({ prompt: "hi" }, ctx);
    await handlers.before_agent_start!({ prompt: "hi again" }, ctx);
    expect(discoveryCalls).toBe(1); // per-turn path performed NO rebuild
  });

  test("ticket 05: session_shutdown drops the session's gate state (no cross-session leak)", async () => {
    const setActiveCalls: string[][] = [];
    const handlers: Record<string, (e?: any, ctx?: any) => Promise<void> | void> = {};
    const pi = {
      getAllToolDefinitions: () => [
        { name: "read", gating: { core: true } },
        { name: "flux2", gating: { gate: "flux2" } },
      ],
      on: (chan: string, h: any) => { handlers[chan] = h; },
      setActiveTools: (names: string[]) => { setActiveCalls.push(names); },
      registerTool: () => {},
    } as unknown as Parameters<typeof toolGateExtension>[0];
    toolGateExtension(pi);
    const ctx = { sessionManager: { getSessionId: () => "s" } };
    await handlers.session_start!({}, { ui: { theme: { fg: (_k: string, s: string) => s }, setWidget: () => {} }, ...ctx } as any);
    await handlers.before_agent_start!({ prompt: "generate an image" }, ctx);
    expect(setActiveCalls[1]).toContain("flux2"); // fired in session s

    // shutdown s → state dropped
    await handlers.session_shutdown!({}, ctx);
    // a NEW session with the SAME id must start fresh (flux2 dormant again)
    await handlers.session_start!({}, { ui: { theme: { fg: (_k: string, s: string) => s }, setWidget: () => {} }, ...ctx } as any);
    expect(setActiveCalls[2]).not.toContain("flux2"); // fresh session, flux2 dormant
  });
});

// Ticket 14 — telemetry undercount fix.
//
// computeBannerSaved was parameterized in ticket 13a to accept a `gates` arg
// (default = module GATES, which is EMPTY since every gate migrated to
// owner-declared gating in tickets 03–12). The two prod call sites (session_start
// banner + before_agent_start telemetry `savedTok`) still passed only 3 args,
// so they hit the empty default → reported savings as 0 (an undercount of the
// real per-request savings). Fix: thread `effectiveGates` (the closure rebuilt
// from owner-declared gating at each session_start / before_agent_start) into
// both call sites. This regression fires a REAL session_start and asserts the
// rendered banner's N > 0 — pre-fix it was 0.
describe("session_start banner reflects runtime effectiveGates (ticket 14 undercount fix)", () => {
  test("banner 'saves ~N tok/req' > 0 when an owner-gated tool is loaded (pre-fix N was 0)", async () => {
    // TOOL_GATE_DEBUG_BANNER=1 → opts {immediate:true} → SHOW_DELAY_MS=0 (the
    // banner still lands via setTimeout, so we await one macrotask tick below).
    process.env.TOOL_GATE_DEBUG_BANNER = "1";
    try {
      // One core tool (active) + one owner-declared gated tool (dormant). The
      // gate reconstructs from the `gating` field via buildEffectiveGates, NOT
      // from module GATES (empty). measureToolTokens is importable (see imports
      // atop this file) → assert the EXACT banner value, not just > 0.
      const FLUX_DESC = "Generate an image with the flux2 diffusion model. ".repeat(10);
      const fluxTool = { name: "flux2", description: FLUX_DESC, parameters: {}, gating: { gate: "flux2" } }; // reference form (01c)
      let captured: string[] | undefined;
      let sessionStartHandler: ((e: unknown, ctx: unknown) => Promise<void>) | null = null;
      const pi = {
        getAllToolDefinitions: () => [
          { name: "read", description: "core read", parameters: {}, gating: { core: true } },
          fluxTool,
        ],
        on: (_chan: string, h: (e: unknown, ctx: unknown) => Promise<void>) => { if (_chan === "session_start") sessionStartHandler = h; return () => {}; },
        setActiveTools: () => {},
        registerTool: () => {},
      } as unknown as Parameters<typeof toolGateExtension>[0];
      toolGateExtension(pi);
      await sessionStartHandler!({}, {
        ui: {
          theme: { fg: (_k: string, s: string) => s },
          setWidget: (_key: string, lines: string[] | undefined) => { captured = lines; },
        },
      });
      // SHOW_DELAY_MS=0 is still a setTimeout(0) → yield to the macrotask queue.
      await new Promise((r) => setTimeout(r, 10));

      expect(captured).toBeTruthy();
      const line = captured!.find((l) => l.includes("saves ~"));
      expect(line).toBeTruthy();
      const m = line!.match(/saves ~(\d+) tok\/req/);
      expect(m).not.toBeNull();
      const n = Number(m![1]);

      // MINIMUM PROOF: pre-fix this was 0 (default GATES empty → no gate summed).
      expect(n).toBeGreaterThan(0);
      // EXACT-MATCH PROOF: flux2 is the only loaded+gated gate → its measured
      // tokens are the entire savings figure.
      expect(n).toBe(measureToolTokens({ description: FLUX_DESC, parameters: {} }));
    } finally {
      delete process.env.TOOL_GATE_DEBUG_BANNER;
    }
  });
});
