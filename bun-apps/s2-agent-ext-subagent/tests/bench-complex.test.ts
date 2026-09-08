/**
 * Unit gates for the complex suite (self-arc-15 t01) — no LLM, no spawns:
 * registry schema, step-predicate honesty (echo cannot satisfy recall),
 * cumulative-latch accounting, and the comparison-v2 renderer golden.
 */
import { describe, expect, test } from "bun:test";
import { COMPLEX_CASES, complexCaseById } from "../scripts/lib/bench-base-tech/cases-complex.js";
import { dimensionRows, renderComparisonV2 } from "../scripts/lib/bench-base-tech/compare-v2.js";
import type { CaseReceipt, StepHelper } from "../scripts/lib/bench-base-tech/types.js";

function helper(over: Partial<StepHelper> = {}): StepHelper {
  return { entries: null, stepFlags: {}, lastText: "", cumulative: new Set<string>(), ...over };
}

describe("complex case registry", () => {
  test("four scored cases with step scripts and caps", () => {
    expect(COMPLEX_CASES.map((c) => c.id)).toEqual([
      "cx-multi-turn",
      "cx-midturn-abort",
      "cx-long-output",
      "cx-error-path",
    ]);
    for (const c of COMPLEX_CASES) {
      expect(c.steps.length).toBeGreaterThan(0);
      expect(c.capMs).toBeGreaterThan(0);
      expect(typeof c.metric).toBe("string");
    }
    expect(() => complexCaseById("cx-multi-turn")).not.toThrow();
    expect(() => complexCaseById("nope")).toThrow();
  });

  test("cx-multi-turn: the filler and turn-3 echo never satisfy recall — only memory does", () => {
    const [, filler, recall] = complexCaseById("cx-multi-turn").steps;
    if (filler.kind !== "submit" || recall.kind !== "submit") throw new Error("shape");
    // Filler pred demands FILLER-DONE, not the code.
    expect(filler.pred?.({ screen: "CXK-n1", structured: null }, "n1", helper({ lastText: "CXK-n1" }))).toBe(false);
    // Turn 3: the dictated PLACEHOLDER (without the value) must NOT pass…
    expect(
      recall.pred?.(
        { screen: "The code is <code>.", structured: null },
        "n1",
        helper({ lastText: "The code is <code>." }),
      ),
    ).toBe(false);
    // …and turn 1's code on screen alone (no "The code is" phrase) must not pass either.
    expect(recall.pred?.({ screen: "CXK-n1", structured: null }, "n1", helper())).toBe(false);
    // The recalled value WITH the phrase passes.
    expect(recall.pred?.({ screen: "", structured: null }, "n1", helper({ lastText: "The code is CXK-n1" }))).toBe(
      true,
    );
  });

  test("cx-long-output: rpc counts full text; screen counts the cumulative union", () => {
    const [step] = complexCaseById("cx-long-output").steps;
    if (step.kind !== "submit") throw new Error("shape");
    const full = Array.from({ length: 20 }, (_, k) => `BENCLONG-${k + 1}-n1`).join("\n");
    expect(step.pred?.({ screen: null, structured: null }, "n1", helper({ lastText: full }))).toBe(true);
    expect(step.pred?.({ screen: null, structured: null }, "n1", helper({ lastText: full.slice(0, 100) }))).toBe(false);
    const cum = new Set(Array.from({ length: 19 }, (_, k) => `BENCLONG-${k + 1}-`));
    expect(step.pred?.({ screen: "idle", structured: null }, "n1", helper({ cumulative: cum }))).toBe(true);
    expect(step.pred?.({ screen: "⠋", structured: null }, "n1", helper({ cumulative: cum }))).toBe(false);
  });

  test("cx-midturn-abort: recovery pred requires the RECOVERED marker post-abort", () => {
    const steps = complexCaseById("cx-midturn-abort").steps;
    const recovery = steps[steps.length - 1];
    if (recovery.kind !== "submit") throw new Error("shape");
    expect(recovery.pred?.({ screen: "RECOVERED-n1", structured: null }, "n1", helper())).toBe(true);
    expect(recovery.pred?.({ screen: "RECOVERED-", structured: null }, "n1", helper())).toBe(false);
  });

  test("cx-error-path: needs ERRDONE + the pinned bash error needle", () => {
    const [step] = complexCaseById("cx-error-path").steps;
    if (step.kind !== "submit") throw new Error("shape");
    expect(
      step.pred?.(
        { screen: "", structured: null },
        "n1",
        helper({ lastText: "ERRDONE ls: /nonexistent: No such file or directory" }),
      ),
    ).toBe(true);
    expect(step.pred?.({ screen: "", structured: null }, "n1", helper({ lastText: "ERRDONE all fine" }))).toBe(false);
  });
});

describe("comparison-v2 renderer", () => {
  const mk = (tech: string, c: string, pass: boolean, extra: Record<string, unknown> = {}): CaseReceipt =>
    ({
      tech,
      case: c,
      nonce: "n",
      pass,
      verdict: pass ? "pass" : "fail",
      timingsMs: { "step0-submit": 1234 },
      evidence: { linesSeen: 20, bytesReceived: 500, stepFlags: {}, ...extra },
      env: {},
      notes: [],
    }) as CaseReceipt;

  test("dimension table carries all four dimensions with per-lane cells", () => {
    const rows = dimensionRows([
      mk("bun-terminal", "cx-multi-turn", true),
      mk("rpc", "cx-multi-turn", true),
      mk("bun-terminal", "cx-midturn-abort", true),
      mk("rpc", "cx-midturn-abort", true),
      mk("bun-terminal", "cx-long-output", true),
      mk("rpc", "cx-long-output", false),
      mk("rpc", "cx-error-path", true),
    ]);
    expect(rows.length).toBe(4);
    expect(rows.find((r) => r.case === "cx-long-output")?.rpc).toContain("❌");
    expect(rows.find((r) => r.case === "cx-long-output")?.rpc).toContain("20/20");
  });

  test("markdown golden: headers, verdict list, base-suite reference", () => {
    const md = renderComparisonV2([
      mk("bun-terminal", "cx-multi-turn", true),
      mk("rpc", "cx-multi-turn", false, { stepFlags: {} }),
    ]);
    expect(md).toContain("# Base-tech benchmark v2");
    expect(md).toContain("## Dimension table");
    expect(md).toContain("## Base-suite reference (arc-13, committed)");
    expect(md).toContain("bun-terminal 0.834");
    expect(md).toContain("1/2 green");
  });
});
