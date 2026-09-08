/**
 * Unit gates for the bench-base-tech library — NO LLM, no live spawns (spec
 * §11): pure-function coverage of the chunking/query-responder byte
 * contracts (mirroring the tui-drive pins), the case registry schema, and
 * the pre-registered scoring/recommendation rules (spec §8).
 */
import { describe, expect, test } from "bun:test";
import { CASE_CAPABILITY, CASES, caseById, type RpcCaseHelper } from "../scripts/lib/bench-base-tech/cases.js";
import { recommend, renderComparisonMd, scoreTech, type TechScore } from "../scripts/lib/bench-base-tech/compare.js";
import { chunkBytes, LIVE_MARKER_RE, makeQueryResponder } from "../scripts/lib/bench-base-tech/screen.js";

describe("screen byte contracts (tui-drive pins)", () => {
  test("chunkBytes slices payloads at 64 bytes", () => {
    const u8 = new TextEncoder().encode("x".repeat(200));
    const chunks = chunkBytes(u8);
    expect(chunks.length).toBe(4);
    expect(chunks[0].length).toBe(64);
    expect(chunks[3].length).toBe(8);
    expect(chunks.flatMap((c) => [...c])).toEqual([...u8]);
  });

  test("query responder answers primary DA exactly with the xterm reply", () => {
    const writes: string[] = [];
    const respond = makeQueryResponder((s) => writes.push(s));
    respond(new TextEncoder().encode("hello \x1b[c world"));
    expect(writes).toEqual(["\x1b[?1;2c"]);
  });

  test("query responder stays SILENT on the kitty protocol query", () => {
    const writes: string[] = [];
    const respond = makeQueryResponder((s) => writes.push(s));
    respond(new TextEncoder().encode("\x1b[?u"));
    expect(writes).toEqual([]);
  });

  test("live-marker regex catches spinners and misses idle text", () => {
    expect(LIVE_MARKER_RE.test("⠋ Working...")).toBe(true);
    expect(LIVE_MARKER_RE.test("BENCHPONG-s1 done")).toBe(false);
  });
});

describe("case registry", () => {
  test("six cases with unique ids, caps, stimuli, and predicates", () => {
    expect(CASES.length).toBe(6);
    for (const c of CASES) {
      expect(typeof c.capMs).toBe("number");
      expect(c.capMs).toBeGreaterThan(0);
      expect(typeof c.stimulus("n")).toBe("string");
      expect(typeof c.screenPred).toBe("function");
    }
    expect(new Set(CASES.map((c) => c.id)).size).toBe(6);
  });

  test("rpc is not capable of tui-gesture (D8 unreachable cell)", () => {
    expect(CASE_CAPABILITY["tui-gesture"]).not.toContain("rpc");
  });

  test("trivial-ask predicates: screen needs sentinel + quiet; rpc needs settled + marker", () => {
    const def = caseById("trivial-ask");
    const helper: RpcCaseHelper = { lastAssistantText: "BENCHPONG-n1" };
    expect(def.screenPred({ screen: "nope", structured: null }, "n1")).toBe(false);
    expect(def.screenPred({ screen: "BENCHPONG-n1 ⠋", structured: null }, "n1")).toBe(false);
    expect(def.screenPred({ screen: "answer BENCHPONG-n1 done", structured: null }, "n1")).toBe(true);
    expect(def.rpcPred?.({ screen: null, structured: { agentSettled: true } }, "n1", helper)).toBe(true);
    expect(def.rpcPred?.({ screen: null, structured: { agentSettled: false } }, "n1", helper)).toBe(false);
  });

  test("state-probe screen predicate excludes flash BY NAME", () => {
    const def = caseById("state-probe");
    expect(def.screenPred({ screen: "(zai) glm-5.3 • medium", structured: null }, "n")).toBe(true);
    expect(def.screenPred({ screen: "(zai) glm-5.3-flash", structured: null }, "n")).toBe(false);
  });
});

describe("scoring + recommendation (pre-registered rules)", () => {
  const base = {
    robustness: 3,
    bootStable: true,
    asyncQuality: 1,
    p50TrivialMs: 10_000,
    bootMs: 5_000,
    adapterLoc: 100,
    externalParts: 0,
  };

  test("eligibility: robustness < 3 disqualifies regardless of everything else", () => {
    const s = scoreTech({ ...base, tech: "bun-terminal", robustness: 2 }, 10_000);
    expect(s.eligible).toBe(false);
    expect(s.ineligibleReason).toBe("robustness 2/3");
  });

  test("tmux fidelity is partial (0.8); byte lanes full (1.0)", () => {
    const sTmux = scoreTech({ ...base, tech: "tmux", adapterLoc: 100, externalParts: 1 }, 10_000);
    const sBt = scoreTech({ ...base, tech: "bun-terminal" }, 10_000);
    expect(sTmux.scores.fidelity).toBe(0.8);
    expect(sBt.scores.fidelity).toBe(1);
  });

  test("simplicity penalizes external parts and adapter bulk", () => {
    const lean = scoreTech({ ...base, tech: "bun-terminal" }, 10_000);
    const bulky = scoreTech({ ...base, tech: "bun-pty", adapterLoc: 300, externalParts: 1 }, 10_000);
    expect(bulky.scores.simplicity).toBeLessThan(lean.scores.simplicity);
  });

  test("challenger needs >10% margin; ties keep the incumbent", () => {
    const incumbent: TechScore = scoreTech({ ...base, tech: "bun-terminal" }, 10_000);
    // Same inputs → same score → tie keeps bun-terminal.
    const tie = scoreTech({ ...base, tech: "bun-pty" }, 10_000);
    expect(recommend([incumbent, tie]).productionLane).toBe("bun-terminal");
    // RPC-eligible alone never wins the production seat (role rule).
    const rpc = scoreTech({ ...base, tech: "rpc" }, 10_000);
    expect(recommend([incumbent, rpc]).structuredComplement).toBe("rpc");
    expect(recommend([incumbent, rpc]).productionLane).toBe("bun-terminal");
  });

  test("comparison markdown renders outcomes, scores, matrix, recommendation", () => {
    const md = renderComparisonMd(
      [
        {
          tech: "bun-terminal",
          renderedTruth: true,
          dialogs: "keystroke",
          asyncEvents: "screen",
          deps: "none",
          loc: 90,
        },
        { tech: "rpc", renderedTruth: false, dialogs: "protocol", asyncEvents: "stream", deps: "none", loc: 120 },
      ],
      [scoreTech({ ...base, tech: "bun-terminal" }, 10_000), scoreTech({ ...base, tech: "rpc" }, 10_000)],
      [
        { tech: "bun-terminal", case: "boot-to-ready", pass: true, ms: 8_000 },
        { tech: "rpc", case: "tui-gesture", pass: null },
      ],
      recommend([scoreTech({ ...base, tech: "bun-terminal" }, 10_000), scoreTech({ ...base, tech: "rpc" }, 10_000)]),
    );
    expect(md).toContain("## Per-case outcomes");
    expect(md).toContain("N/A"); // D8 unreachable renders as N/A, not ❌
    expect(md).toContain("## Recommendation");
    expect(md).toContain("bun-terminal");
  });
});
