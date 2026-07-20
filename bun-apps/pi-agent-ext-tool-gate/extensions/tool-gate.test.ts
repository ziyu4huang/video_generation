import { describe, expect, test } from "bun:test";
import { computeActiveTools, CORE_TOOLS, GATES, computeBannerSaved, matchIntent, matchesKeyword, gateFires, measureToolTokens } from "./tool-gate.ts";
import type { ToolGate } from "./tool-gate.ts";
import { emitToolGateLog, isMissCandidate } from "./tool-gate.ts";
import toolGateExtension from "./tool-gate.ts";

/** Spread CORE_TOOLS into an array of names (CORE_TOOLS is a Set). */
const CORE_TOOLS_ARRAY = (): string[] => Array.from(CORE_TOOLS);

describe("computeActiveTools", () => {
  test("a tool not listed in CORE_TOOLS or any gate is always active (fail-open)", () => {
    const allTools = [...CORE_TOOLS, "some_future_tool_not_in_any_gate"];
    const sticky = new Set(CORE_TOOLS);
    const active = computeActiveTools("", allTools, sticky);
    expect(active).toContain("some_future_tool_not_in_any_gate");
  });

  test("a gate stays active across turns even when a later prompt doesn't mention it", () => {
    const allTools = [...CORE_TOOLS, "flux2", "flux2_help"];
    const sticky = new Set(CORE_TOOLS);
    const turn1 = computeActiveTools("generate an image of a cat", allTools, sticky);
    expect(turn1).toContain("flux2");
    const turn2 = computeActiveTools("make it bigger", allTools, sticky);
    expect(turn2).toContain("flux2");
    expect(turn2).toContain("flux2_help");
  });

  test("a gate never mentioned by any prompt stays inactive", () => {
    const allTools = [...CORE_TOOLS, "flux2", "flux2_help"];
    const sticky = new Set(CORE_TOOLS);
    const active = computeActiveTools("what's the weather", allTools, sticky);
    expect(active).not.toContain("flux2");
    expect(active).not.toContain("flux2_help");
  });

  test("CORE_TOOLS are always active regardless of prompt", () => {
    const allTools = [...CORE_TOOLS];
    const sticky = new Set(CORE_TOOLS);
    const active = computeActiveTools("irrelevant prompt", allTools, sticky);
    for (const t of CORE_TOOLS) expect(active).toContain(t);
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
    const active = computeActiveTools("幫我用 movie 做一個分鏡", all, sticky);
    expect(active).toEqual(expect.arrayContaining(["movie", "movie_help"]));
  });

  test("inspect does NOT fire on generic 'debug the docker build' (narrowed)", () => {
    const sticky = new Set(CORE_TOOLS);
    const inspectTools = ["inspect_context", "inspect_agent", "inspect_extensions", "inspect_pathology"];
    const all = [...CORE_TOOLS, ...inspectTools];
    const active = computeActiveTools("let's debug the docker build", all, sticky);
    for (const t of inspectTools) {
      expect(active).not.toContain(t);
    }
  });

  test("inspect fires on 'inspect extension health'", () => {
    const sticky = new Set(CORE_TOOLS);
    const all = [...CORE_TOOLS, "inspect_extensions"];
    expect(computeActiveTools("inspect extension health", all, sticky)).toContain("inspect_extensions");
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

  test("emitToolGateLog writes one JSON line to stderr by default", () => {
    const sink: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr as { write: (s: string) => boolean }).write = (s: string) => { sink.push(s); return true; };
    try {
      emitToolGateLog({ kind: "turn", ts: "x", promptLen: 5, gatesFired: [], dormantGates: ["ltx"], activeCount: 20, totalCount: 40 });
    } finally {
      (process.stderr as { write: (s: string) => boolean }).write = orig;
    }
    expect(sink.length).toBe(1);
    const parsed = JSON.parse(sink[0]);
    expect(parsed.kind).toBe("turn");
    expect(parsed.dormantGates).toEqual(["ltx"]);
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
    const active = computeActiveTools("", loadedNames, new Set(CORE_TOOLS));
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
      getAllTools: () => loadedTools.map((name) => ({ name })),
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

  test("mutation guard: execute never throws even if setActiveTools fails", async () => {
    // setActiveTools throwing inside execute must be caught → error result, not a throw.
    const handlers: Record<string, any> = {};
    const pi: any = {
      getAllTools: () => [...CORE_TOOLS, "ltx", "ltx_help"].map((name) => ({ name })),
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

describe("S2 keyword audit (computeActiveTools Effect table)", () => {
  const all = [...CORE_TOOLS, "flux2", "flux2_help", "krea2", "krea2_help", "ltx", "ltx_help",
    "file2md", "vision_ask", "inspect_extensions", "workflow", "workflow_help",
    "collect_videos", "movie", "movie_help"];
  const act = (prompt: string) => computeActiveTools(prompt, all, new Set(CORE_TOOLS));

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
  const act = (prompt: string) => computeActiveTools(prompt, all, new Set(CORE_TOOLS));

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
