/**
 * Unit tests for the probe-harness PURE logic. These must pass regardless of
 * the runtime model (standalone script vs workflow tool) — they exercise no
 * live subagent dispatch, only the deterministic helpers + the pass/fail gate.
 */
import { describe, expect, it } from "bun:test";
import type { Probe, ProbeResult } from "./types.ts";
import { passed } from "./types.ts";
import {
  alignScores,
  buildJudgePrompt,
  formatRow,
  parseJudgeResult,
  runStructural,
  validateProbe,
} from "./runner-lib.ts";
import { probes as phase1 } from "./phase1-subagent.ts";

const result = (over: Partial<ProbeResult> = {}): ProbeResult => ({
  id: "p",
  rubricScores: [3, 3, 3],
  structuralPassed: true,
  judgeNotes: "",
  output: "",
  ...over,
});

describe("passed() — tolerance gate", () => {
  it("fails immediately when structural did not pass (regardless of rubric)", () => {
    expect(passed(result({ structuralPassed: false }), undefined)).toBe(false);
    expect(passed(result({ structuralPassed: false, rubricScores: [3, 3, 3] }), result({ rubricScores: [3, 3, 3] }))).toBe(
      false,
    );
  });

  it("passes with no baseline as long as structural passed (first run = the baseline)", () => {
    expect(passed(result({ structuralPassed: true, rubricScores: [0, 0, 0] }), undefined)).toBe(true);
  });

  it("passes when every score is within −1 of baseline (tolerance)", () => {
    const base = result({ rubricScores: [3, 2, 3] });
    expect(passed(result({ rubricScores: [2, 1, 3] }), base)).toBe(true); // each exactly −1 or better
    expect(passed(result({ rubricScores: [3, 2, 3] }), base)).toBe(true); // identical
  });

  it("fails when ANY score drops by 2+ from baseline", () => {
    const base = result({ rubricScores: [3, 2, 3] });
    expect(passed(result({ rubricScores: [1, 2, 3] }), base)).toBe(false); // item 0: 3→1 (−2)
    expect(passed(result({ rubricScores: [3, 0, 3] }), base)).toBe(false); // item 1: 2→0 (−2)
  });

  it("treats a missing baseline-score index as 0 (defensive)", () => {
    // baseline has fewer scores than result: the missing index is 0, so a
    // result score of 0 still satisfies >= 0 - 1.
    const base = result({ rubricScores: [3] });
    expect(passed(result({ rubricScores: [3, 0, 0] }), base)).toBe(true);
    expect(passed(result({ rubricScores: [3, 0] }), base)).toBe(true);
  });
});

describe("runStructural() — machine gate", () => {
  it("vacuously true when no structural regexes configured", () => {
    expect(runStructural(undefined, "anything")).toBe(true);
    expect(runStructural([], "anything")).toBe(true);
  });

  it("all regexes must match (AND)", () => {
    expect(runStructural([/\bsubagent\b/i, /dispatch/i], "I will dispatch a subagent")).toBe(true);
    expect(runStructural([/\bsubagent\b/i, /workflow/i], "I will dispatch a subagent")).toBe(false);
  });

  it("respects flags (case-insensitive declared in the regex)", () => {
    expect(runStructural([/SUBAGENT/i], "called subagent")).toBe(true);
    expect(runStructural([/SUBAGENT/], "called subagent")).toBe(false); // no 'i' flag
  });

  it("Phase-1 fixtures' structural regexes match their intended targets", () => {
    expect(phase1[0].structural?.[0].test("I'll use the subagent tool")).toBe(true);
    expect(phase1[0].structural?.[0].test("I'll use bash")).toBe(false);
    // recall probe: subagent_runs OR /subagents
    const recallRe = phase1[2].structural?.[0];
    expect(recallRe?.test("use the subagent_runs tool")).toBe(true);
    expect(recallRe?.test("run /subagents")).toBe(true);
    expect(recallRe?.test("use bash")).toBe(false);
  });
});

describe("buildJudgePrompt() — deterministic prompt shape", () => {
  it("numbers the rubric 0..n-1 and requests JSON only", () => {
    const p = buildJudgePrompt(["first check", "second check"], "the agent output");
    expect(p).toContain("0: first check");
    expect(p).toContain("1: second check");
    expect(p).toContain('Return JSON: {"scores":[...], "notes":"..."}. Only the JSON.');
    expect(p).toContain('"""\nthe agent output\n"""');
  });

  it("truncates the output to the cap to bound judge token cost", () => {
    const big = "x".repeat(10_000);
    const p = buildJudgePrompt(["r"], big, 100);
    // the cap applies to the embedded output only
    const segment = p.slice(p.indexOf('"""'), p.lastIndexOf('"""'));
    expect(segment.length).toBeLessThan(200);
  });

  it("keeps full output when under the cap", () => {
    const p = buildJudgePrompt(["r"], "short", 4000);
    expect(p).toContain("short");
  });
});

describe("parseJudgeResult() — robust JSON extraction", () => {
  it("parses a bare JSON object", () => {
    expect(parseJudgeResult('{"scores":[3,2,1],"notes":"good"}')).toEqual({ scores: [3, 2, 1], notes: "good" });
  });

  it("parses a ```json fenced block with surrounding prose", () => {
    const raw = 'Here you go:\n```json\n{"scores":[0,1],"notes":"meh"}\n```\nthanks';
    expect(parseJudgeResult(raw)).toEqual({ scores: [0, 1], notes: "meh" });
  });

  it("extracts the first balanced object from prose", () => {
    const raw = 'The grade is {"scores":[2,2],"notes":"ok"} as requested.';
    expect(parseJudgeResult(raw)).toEqual({ scores: [2, 2], notes: "ok" });
  });

  it("coerces numeric strings and drops non-finite values to 0", () => {
    const raw = '{"scores":["3", 2, null, "NaN"], "notes": 5}';
    expect(parseJudgeResult(raw)).toEqual({ scores: [3, 2, 0, 0], notes: "5" });
  });

  it("returns empty scores + diagnostic note on total failure", () => {
    const out = parseJudgeResult("no json here at all");
    expect(out.scores).toEqual([]);
    expect(out.notes).toContain("unparseable");
  });
});

describe("validateProbe() + alignScores() + formatRow() — shape guards", () => {
  const valid: Probe = { id: "x", phase: 1, prompt: "do", rubric: ["a"] };

  it("accepts a well-formed probe", () => {
    expect(validateProbe(valid)).toEqual([]);
  });

  it("rejects bad phase, empty rubric, empty prompt, non-RegExp structural", () => {
    // expect(validateProbe(...)) returns an Assertion wrapper — index the array FIRST.
    expect(validateProbe({ ...valid, phase: 4 as Probe["phase"] })[0]).toMatch(/phase/);
    expect(validateProbe({ ...valid, rubric: [] })[0]).toMatch(/rubric/);
    expect(validateProbe({ ...valid, prompt: "   " })[0]).toMatch(/prompt/);
    expect(validateProbe({ ...valid, structural: ["not-a-regex"] as unknown as RegExp[] })[0]).toMatch(/structural\[0\]/);
  });

  it("alignScores pads short arrays and truncates long ones", () => {
    expect(alignScores([3, 1], 4)).toEqual([3, 1, 0, 0]);
    expect(alignScores([3, 1, 9, 9], 2)).toEqual([3, 1]);
  });

  it("formatRow renders a stable single-line summary with PASS/FAIL", () => {
    const row = formatRow(result({ id: "p1", rubricScores: [3, 2, 3] }), result({ rubricScores: [3, 2, 3] }), 3);
    expect(row).toContain("p1");
    expect(row).toContain("struct:ok");
    expect(row).toContain("[3,2,3]");
    expect(row).toContain("PASS");
  });

  it("every Phase-1 fixture is a valid probe", () => {
    for (const p of phase1) {
      expect(validateProbe(p)).toEqual([]);
    }
  });
});
