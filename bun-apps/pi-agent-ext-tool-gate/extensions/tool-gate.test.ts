import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { updateSticky, CORE_TOOLS, GATES, computeBannerSaved, matchIntent, matchesKeyword, gateFires, measureToolTokens, filterActive } from "./tool-gate.ts";
import type { ToolGate } from "./tool-gate.ts";
import { emitToolGateLog, isMissCandidate } from "./tool-gate.ts";
import toolGateExtension from "./tool-gate.ts";

/** Spread CORE_TOOLS into an array of names (CORE_TOOLS is a Set). */
const CORE_TOOLS_ARRAY = (): string[] => Array.from(CORE_TOOLS);

describe("updateSticky + filterActive", () => {
  test("a tool not listed in CORE_TOOLS or any gate is always active (fail-open)", () => {
    const allTools = [...CORE_TOOLS, "some_future_tool_not_in_any_gate"];
    const sticky = new Set(CORE_TOOLS);
    const active = filterActive(allTools, sticky);
    expect(active).toContain("some_future_tool_not_in_any_gate");
  });

  test("a gate stays active across turns even when a later prompt doesn't mention it", () => {
    const allTools = [...CORE_TOOLS, "flux2", "flux2_help"];
    const sticky = new Set(CORE_TOOLS);
    updateSticky("generate an image of a cat", sticky);
    expect(filterActive(allTools, sticky)).toContain("flux2");
    updateSticky("make it bigger", sticky);
    const turn2 = filterActive(allTools, sticky);
    expect(turn2).toContain("flux2");
    expect(turn2).toContain("flux2_help");
  });

  test("a gate never mentioned by any prompt stays inactive", () => {
    const allTools = [...CORE_TOOLS, "flux2", "flux2_help"];
    const sticky = new Set(CORE_TOOLS);
    updateSticky("what's the weather", sticky);
    const active = filterActive(allTools, sticky);
    expect(active).not.toContain("flux2");
    expect(active).not.toContain("flux2_help");
  });

  test("CORE_TOOLS are always active regardless of prompt", () => {
    const allTools = [...CORE_TOOLS];
    const sticky = new Set(CORE_TOOLS);
    updateSticky("irrelevant prompt", sticky);
    const active = filterActive(allTools, sticky);
    for (const t of CORE_TOOLS) expect(active).toContain(t);
  });
});

describe("updateSticky (mutation half)", () => {
  test("fires matching gates and mutates sticky in place", () => {
    const sticky = new Set(CORE_TOOLS);
    updateSticky("generate an image of a cat", sticky);
    expect(sticky.has("flux2")).toBe(true);
    expect(sticky.has("flux2_help")).toBe(true);
  });

  test("accumulates across turns (sticky persistence)", () => {
    const sticky = new Set(CORE_TOOLS);
    updateSticky("generate an image", sticky);
    updateSticky("make a video", sticky);
    // both flux2 and ltx should be in sticky after two prompts
    expect(sticky.has("flux2")).toBe(true);
    expect(sticky.has("ltx")).toBe(true);
  });

  test("empty prompt fires nothing", () => {
    const sticky = new Set(CORE_TOOLS);
    const before = sticky.size;
    updateSticky("", sticky);
    expect(sticky.size).toBe(before);
  });
});

describe("GATES data (S1)", () => {
  test("every gate has a non-empty description", () => {
    for (const g of GATES) {
      expect(g.description.length).toBeGreaterThan(0);
    }
  });

  test("movie gate exists and fires on 'movie' and '分鏡'", () => {
    const sticky = new Set(CORE_TOOLS);
    const all = [...CORE_TOOLS, "movie", "movie_help"];
    updateSticky("幫我用 movie 做一個分鏡", sticky);
    expect(filterActive(all, sticky)).toEqual(expect.arrayContaining(["movie", "movie_help"]));
  });

  test("inspect does NOT fire on generic 'debug the docker build' (narrowed)", () => {
    const sticky = new Set(CORE_TOOLS);
    const inspectTools = ["inspect_context", "inspect_agent", "inspect_extensions", "inspect_pathology"];
    const all = [...CORE_TOOLS, ...inspectTools];
    updateSticky("let's debug the docker build", sticky);
    const active = filterActive(all, sticky);
    for (const t of inspectTools) {
      expect(active).not.toContain(t);
    }
  });

  test("inspect fires on 'inspect extension health'", () => {
    const sticky = new Set(CORE_TOOLS);
    const all = [...CORE_TOOLS, "inspect_extensions"];
    updateSticky("inspect extension health", sticky);
    expect(filterActive(all, sticky)).toContain("inspect_extensions");
  });
});

describe("matchIntent (S1)", () => {
  const sticky = () => new Set(CORE_TOOLS);

  test("video intent → ltx", () => {
    expect(matchIntent("make a video", GATES, sticky()).map((g) => g.names[0])).toEqual(["ltx"]);
  });
  test("image intent → flux2", () => {
    expect(matchIntent("generate an image of a cat", GATES, sticky()).map((g) => g.names[0])).toEqual(["flux2"]);
  });
  test("describe intent → file2md", () => {
    expect(matchIntent("describe this picture", GATES, sticky()).map((g) => g.names[0])).toEqual(["file2md"]);
  });
  test("movie intent (CJK) → movie", () => {
    expect(matchIntent("做一個 movie 分鏡", GATES, sticky()).map((g) => g.names[0])).toEqual(["movie"]);
  });
  test("workflow intent → workflow", () => {
    expect(matchIntent("orchestrate a parallel pipeline", GATES, sticky()).map((g) => g.names[0])).toEqual(["workflow"]);
  });
  test("S2 flip: 'docker image cleanup' → [] (image noun, no gen-verb)", () => {
    expect(matchIntent("docker image cleanup", GATES, sticky()).map((g) => g.names[0])).toEqual([]);
  });
  test("no match → []", () => {
    expect(matchIntent("what's the weather", GATES, sticky())).toEqual([]);
  });
  test("dormant-skip: already-active gate is not returned", () => {
    const s = sticky();
    s.add("ltx"); s.add("ltx_help");
    expect(matchIntent("make a video", GATES, s)).toEqual([]);
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
    const mockTool = (name: string, desc: string) => ({ name, description: desc, parameters: { p: 1 } });
    const loadedNames = [...CORE_TOOLS, "ltx", "ltx_help", "flux2", "flux2_help"];
    const loadedTools = [
      ...CORE_TOOLS_ARRAY().map((n) => mockTool(n, "core")),
      mockTool("ltx", "video tool"),
      mockTool("ltx_help", "video help"),
      mockTool("flux2", "image tool"),
      mockTool("flux2_help", "image help"),
    ];
    const measured = new Map(loadedTools.map((t) => [t.name, measureToolTokens(t)]));
    // CORE-only active ⇒ ltx & flux2 are gated; movie is NOT loaded ⇒ excluded.
    const active = filterActive(loadedNames, new Set(CORE_TOOLS));
    const saved = computeBannerSaved(active, loadedNames, measured);
    const expected = measured.get("ltx")! + measured.get("ltx_help")!
      + measured.get("flux2")! + measured.get("flux2_help")!;
    expect(saved).toBe(expected);
  });

  test("a gate whose tools are absent from allToolNames contributes 0 (no phantom)", () => {
    const measured = new Map([["movie", 999], ["movie_help", 999]]);
    // movie not in allToolNames → excluded even though measured + gated
    const saved = computeBannerSaved([...CORE_TOOLS], [...CORE_TOOLS], measured);
    expect(saved).toBe(0);
  });
});

describe("enable_tool (S1 A escape hatch)", () => {
  function setupPi(loadedTools: string[]) {
    const calls: { setActiveTools: string[] }[] = [];
    const registered: { name: string; execute: (a: string, p: any) => Promise<any> }[] = [];
    const handlers: Record<string, (e?: any, ctx?: any) => Promise<void> | void> = {};
    const pi: any = {
      getAllToolDefinitions: () => loadedTools.map((name) => ({ name })),
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

  test("enable_tool is registered and is in CORE_TOOLS (always active)", () => {
    expect(CORE_TOOLS.has("enable_tool")).toBe(true);
    const { enableTool } = setupPi([...CORE_TOOLS, "ltx", "ltx_help", "flux2", "flux2_help", "movie", "movie_help"]);
    expect(enableTool).toBeTruthy();
  });

  test("list:true returns only dormant gates", async () => {
    const { enableTool } = setupPi([...CORE_TOOLS, "ltx", "ltx_help", "flux2", "flux2_help"]);
    const res = await enableTool.execute("id", { list: true });
    const text = res.content[0].text;
    expect(text).toContain("ltx");
    expect(text).toContain("flux2");
  });

  test("intent 'make a video' activates ltx (sticky) and calls setActiveTools", async () => {
    const { enableTool, calls } = setupPi([...CORE_TOOLS, "ltx", "ltx_help"]);
    const res = await enableTool.execute("id", { intent: "make a video" });
    expect(res.content[0].text).toContain("ltx");
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[calls.length - 1].setActiveTools).toEqual(expect.arrayContaining(["ltx", "ltx_help"]));
  });

  test("name 'movie' activates the movie gate", async () => {
    const { enableTool, calls } = setupPi([...CORE_TOOLS, "movie", "movie_help"]);
    const res = await enableTool.execute("id", { name: "movie" });
    expect(res.content[0].text).toContain("movie");
    expect(calls[calls.length - 1].setActiveTools).toEqual(expect.arrayContaining(["movie", "movie_help"]));
  });

  test("no-match intent returns a non-error result pointing to list", async () => {
    const { enableTool } = setupPi([...CORE_TOOLS, "ltx", "ltx_help"]);
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
    const loaded = [...CORE_TOOLS, "ltx", "ltx_help", "movie", "movie_help"];
    const { enableTool, calls } = setupPi(loaded);
    const res = await enableTool.execute("id", { name: "ltx" });
    expect(res.content[0].text).toContain("ltx");
    const lastActive = calls[calls.length - 1].setActiveTools;
    // ltx must be active
    expect(lastActive).toEqual(expect.arrayContaining(["ltx", "ltx_help"]));
    // movie must NOT be active (was not requested, and filterActive doesn't
    // re-fire gates against lastPrompt — only the named gate is activated)
    expect(lastActive).not.toContain("movie");
    expect(lastActive).not.toContain("movie_help");
  });

  test("F3 regression: enable_tool with already-active gate returns 'already active' (not 'Activated')", async () => {
    // When a gate is already fully active, enable_tool({name}) must not claim
    // it was "Activated" — it should say "already active".
    const loaded = [...CORE_TOOLS, "ltx", "ltx_help"];
    const { enableTool, handlers } = setupPi(loaded);
    // Activate ltx first via before_agent_start
    if (handlers.before_agent_start) {
      await handlers.before_agent_start({ prompt: "make a video" });
    }
    // Now request ltx again — it's already active
    const res = await enableTool.execute("id", { name: "ltx" });
    expect(res.content[0].text).toMatch(/already active/i);
    expect(res.content[0].text).not.toMatch(/Activated/i);
  });

  test("mutation guard: execute never throws even if setActiveTools fails", async () => {
    // setActiveTools throwing inside execute must be caught → error result, not a throw.
    const handlers: Record<string, any> = {};
    const pi: any = {
      getAllToolDefinitions: () => [...CORE_TOOLS, "ltx", "ltx_help"].map((name) => ({ name })),
      setActiveTools: () => { throw new Error("setActiveTools boom"); },
      registerTool: (def: any) => { (pi as any)._t = def; },
      on: (ev: string, h: any) => { handlers[ev] = h; },
    };
    toolGateExtension(pi);
    const enableTool = (pi as any)._t;
    const res = await enableTool.execute("id", { intent: "make a video" });
    expect(res.content[0].text).toMatch(/error/i);
  });
});

describe("filterActive (F1 fix)", () => {
  test("tools not in TRACKED_TOOLS are always active (fail-open)", () => {
    const sticky = new Set(CORE_TOOLS);
    const active = filterActive([...CORE_TOOLS, "some_new_tool"], sticky);
    expect(active).toContain("some_new_tool");
  });

  test("gated tool is active only when in sticky", () => {
    const all = [...CORE_TOOLS, "ltx", "ltx_help", "flux2", "flux2_help"];
    const sticky = new Set([...CORE_TOOLS, "ltx", "ltx_help"]);
    const active = filterActive(all, sticky);
    expect(active).toContain("ltx");
    expect(active).toContain("ltx_help");
    expect(active).not.toContain("flux2");
    expect(active).not.toContain("flux2_help");
  });

  test("does NOT mutate sticky", () => {
    const sticky = new Set(CORE_TOOLS);
    const before = sticky.size;
    filterActive([...CORE_TOOLS, "ltx", "ltx_help"], sticky);
    expect(sticky.size).toBe(before);
    expect(sticky.has("ltx")).toBe(false);
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
  const all = [...CORE_TOOLS, "flux2", "flux2_help", "krea2", "krea2_help", "ltx", "ltx_help",
    "file2md", "vision_ask", "inspect_extensions", "workflow", "workflow_help",
    "collect_videos", "movie", "movie_help"];
  const act = (prompt: string) => {
    const sticky = new Set(CORE_TOOLS);
    updateSticky(prompt, sticky);
    return filterActive(all, sticky);
  };

  test("docker image cleanup → []", () => {
    expect(act("docker image cleanup")).toEqual(expect.arrayContaining([...CORE_TOOLS]));
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
  const all = [...CORE_TOOLS, "flux2", "flux2_help", "ltx", "ltx_help",
    "file2md", "vision_ask"];
  const act = (prompt: string) => {
    const sticky = new Set(CORE_TOOLS);
    updateSticky(prompt, sticky);
    return filterActive(all, sticky);
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
  const sticky = () => new Set(CORE_TOOLS);
  const first = (prompt: string) => matchIntent(prompt, GATES, sticky()).map((g) => g.names[0]);

  test("describe the architecture → []", () => {
    expect(first("describe the architecture")).toEqual([]);
  });
  test("make an image → [flux2] (make+image via requires)", () => {
    expect(first("make an image")).toEqual(["flux2"]);
  });
  test("conflux library → [] (flux word-boundary, not inside conflux)", () => {
    expect(first("use the conflux library")).toEqual([]);
  });
});

describe("previously-leaked tools regression (2026-07-21)", () => {
  // These 5 tools were untracked (fail-open → always active) before the fix.
  // Each must now be explicitly tracked — either in CORE_TOOLS or a GATE.

  test("grill_decision is in CORE_TOOLS (always active, not fail-open)", () => {
    expect(CORE_TOOLS.has("grill_decision")).toBe(true);
  });

  test("subagent + workflow_control are in the workflow gate (gated, not fail-open)", () => {
    const wfGate = GATES.find((g) => g.names.includes("workflow"));
    expect(wfGate).toBeDefined();
    expect(wfGate!.names).toContain("subagent");
    expect(wfGate!.names).toContain("workflow_control");
  });

  test("zai-mcp proxy tools are in a dedicated gate (gated, not fail-open)", () => {
    const zaiGate = GATES.find((g) =>
      g.names.includes("zai_web_search_web_search_prime"));
    expect(zaiGate).toBeDefined();
    expect(zaiGate!.names).toContain("zai_web_reader_webReader");
  });

  test("none of the 5 previously-leaked tools are untracked (fail-open)", () => {
    // Build the full tracked set from CORE_TOOLS + all gate names
    const tracked = new Set([
      ...CORE_TOOLS,
      ...GATES.flatMap((g) => g.names),
    ]);
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
    const sticky = new Set(CORE_TOOLS);
    const allTools = [...CORE_TOOLS, "workflow", "workflow_help", "subagent", "workflow_control"];
    updateSticky("run a multi-step workflow", sticky);
    const active = filterActive(allTools, sticky);
    expect(active).toContain("subagent");
    expect(active).toContain("workflow_control");
  });

  test("zai-mcp gate fires on 'zai search' keyword", () => {
    const sticky = new Set(CORE_TOOLS);
    const allTools = [...CORE_TOOLS, "zai_web_search_web_search_prime", "zai_web_reader_webReader"];
    updateSticky("use zai search to find results", sticky);
    const active = filterActive(allTools, sticky);
    expect(active).toContain("zai_web_search_web_search_prime");
    expect(active).toContain("zai_web_reader_webReader");
  });

  test("zai-mcp tools stay dormant without keyword (the savings)", () => {
    const sticky = new Set(CORE_TOOLS);
    const allTools = [...CORE_TOOLS, "zai_web_search_web_search_prime", "zai_web_reader_webReader"];
    updateSticky("search the web for cats", sticky);
    const active = filterActive(allTools, sticky);
    // 'search' alone doesn't fire the zai gate — only 'zai search' does
    expect(active).not.toContain("zai_web_search_web_search_prime");
    expect(active).not.toContain("zai_web_reader_webReader");
  });

  test("obsidian_help is in CORE_TOOLS (always active, not fail-open)", () => {
    expect(CORE_TOOLS.has("obsidian_help")).toBe(true);
  });

  test("inspect_tui is in the inspect gate (gated, not fail-open)", () => {
    const inspectGate = GATES.find((g) => g.names.includes("inspect_context"));
    expect(inspectGate).toBeDefined();
    expect(inspectGate!.names).toContain("inspect_tui");
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

import { buildEffectiveGates } from "./tool-gate.ts";

describe("buildEffectiveGates", () => {
  test("owner-declared core:true → core set, removed from fallback need", () => {
    const defs = [{ name: "enable_tool", gating: { core: true } }] as Array<{
      name: string; description?: string; gating?: { keywords: string[]; requires?: { nouns: string[]; verbs: string[] }; core?: boolean };
    }>;
    const eff = buildEffectiveGates(defs);
    expect(eff.core.has("enable_tool")).toBe(true);
    expect(eff.gates.find((g) => g.names.includes("enable_tool"))).toBeUndefined();
  });

  test("owner-declared non-core gating becomes a single-name gate", () => {
    const defs = [{
      name: "inspect_hooks", description: "d",
      gating: { keywords: ["schema cost"], requires: { nouns: ["agent"], verbs: ["inspect"] } },
    }] as Array<{ name: string; description?: string; gating?: any }>;
    const eff = buildEffectiveGates(defs);
    const g = eff.gates.find((x) => x.names.includes("inspect_hooks"));
    expect(g).toBeDefined();
    expect(g!.keywords).toEqual(["schema cost"]);
    expect(g!.requires).toEqual({ nouns: ["agent"], verbs: ["inspect"] });
  });

  test("hybrid fallback: tools without gating keep their hardcoded gate", () => {
    const eff = buildEffectiveGates([]); // no owner declarations
    const flux = eff.gates.find((g) => g.names.includes("flux2"));
    expect(flux).toBeDefined(); // hardcoded GATES fallback intact
    expect(eff.core.has("read")).toBe(true); // CORE_TOOLS fallback intact
  });

  test("owner-declared tool supersedes a same-named hardcoded gate", () => {
    const defs = [{
      name: "flux2", description: "owner",
      gating: { keywords: ["owner-kw"] },
    }] as Array<{ name: string; description?: string; gating?: any }>;
    const eff = buildEffectiveGates(defs);
    const g = eff.gates.find((x) => x.names.includes("flux2"));
    expect(g!.keywords).toEqual(["owner-kw"]); // owner wins, not the hardcoded flux2 entry
  });
});

describe("tool-gate runtime reads owner-declared gating", () => {
  test("a tool whose owner declared gating is gated; a core-declared tool is active", async () => {
    const activeCalls: string[][] = [];
    let sessionStartHandler: ((e: unknown, ctx: unknown) => Promise<void>) | null = null;
    const pi = {
      getAllToolDefinitions: () => [
        { name: "read", description: "r", gating: { core: true } },
        { name: "inspect_hooks", description: "d", gating: { keywords: ["schema cost"], requires: { nouns: ["agent"], verbs: ["inspect"] } } },
        { name: "flux2", description: "f" }, // no gating → hardcoded fallback (flux2 is in GATES)
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
    expect(active).not.toContain("inspect_hooks"); // owner-gated, no keyword in "" prompt → dormant
    expect(active).not.toContain("flux2");        // hardcoded fallback gate, dormant
  });
});
