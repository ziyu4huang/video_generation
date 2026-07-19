import { describe, expect, test } from "bun:test";
import { computeActiveTools, CORE_TOOLS, GATES, matchIntent } from "./tool-gate.ts";
import { emitToolGateLog, isMissCandidate } from "./tool-gate.ts";

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
  test("S1 over-broad pin: 'docker image cleanup' → flux2 (image keyword); S2 narrows", () => {
    expect(matchIntent("docker image cleanup", GATES, sticky()).map((g) => g.names[0])).toEqual(["flux2"]);
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
