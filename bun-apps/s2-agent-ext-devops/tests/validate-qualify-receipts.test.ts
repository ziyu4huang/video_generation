/**
 * validate-qualify-receipts tests — the independent grader for qualify sweep
 * receipts (self-arc-21).
 *
 * THE canary (permanent): the committed fixture
 * `tests/fixtures/qualify-wrong-self-grade/` holds four mini-sweeps whose
 * SELF-grade (`pass: true`) disagrees with primary evidence — flash model
 * line, missing required snap, snap-count mismatch, summary-row drift. The
 * grader must REJECT every one and record `agree: false`. An independent
 * grader never seen disagreeing with a wrong self-grade has never been seen
 * working (two-commit red-bar ritual receipted in the arc's evidence/).
 *
 * The green control builds a synthetic CLEAN sweep for all ten scenarios from
 * the SCENARIO_EVIDENCE table itself — a table typo fails here too.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LIVE_MARKER_RE, SCENARIO_EVIDENCE, validateQualifySweep } from "../src/validate-qualify-receipts.js";

const CANARY = join(import.meta.dir, "fixtures", "qualify-wrong-self-grade");

const tempRoots: string[] = [];
function makeSweep(): string {
  const dir = mkdtempSync(join(tmpdir(), "validate-qualify-"));
  tempRoots.push(dir);
  return dir;
}
afterEach(() => {
  while (tempRoots.length) {
    const r = tempRoots.pop();
    if (r) rmSync(r, { recursive: true, force: true });
  }
});

const OKLINE = "↑12k ↓447 R54k CH91.4% 3.4%/1.0M (auto) glm-5.3 • medium";
const IDLE = "idle · ready (settled screen, no live markers)";

function writeScenario(
  sweep: string,
  scenario: string,
  snaps: string[],
  opts: { snapsClaim?: number; modelLine?: string; pass?: boolean; omitPass?: boolean } = {},
): void {
  const dir = join(sweep, scenario);
  mkdirSync(dir, { recursive: true });
  for (const label of snaps)
    writeFileSync(
      join(dir, `snap-${String(snaps.indexOf(label) + 1).padStart(2, "0")}-${label}.txt`),
      label.match(/settled|completed|chain-done|finding|routed|agents-deleted|viewer-closed|wf-aborted/)
        ? IDLE
        : `${label} screen`,
      "utf8",
    );
  const receipt: Record<string, unknown> = {
    scenario,
    cwd: "/tmp/vanished",
    bytesSeen: 123456,
    startedAt: "2026-09-10T02:00:00.000Z",
    finishedAt: "2026-09-10T02:01:00.000Z",
    snaps: opts.snapsClaim ?? snaps.length,
    modelLine: opts.modelLine ?? OKLINE,
    checks: { booted: true },
    pass: opts.pass ?? true,
    launcher: { sh: "/dist/s2-agent.sh", deployedVersion: "0.10.3+g-test", tree: "deployed" },
  };
  if (opts.omitPass) delete receipt.pass; // the self-grade key itself is absent
  writeFileSync(join(dir, "receipt.json"), JSON.stringify(receipt, null, "\t") + "\n", "utf8");
}

function writeSummary(sweep: string, scenarios: string[]): void {
  writeFileSync(
    join(sweep, "summary.json"),
    JSON.stringify(
      { allGreen: true, redCount: 0, rows: scenarios.map((s) => ({ scenario: s, pass: true, rpcCrossCheck: null })) },
      null,
      "\t",
    ) + "\n",
    "utf8",
  );
}

/** A clean sweep for ALL ten scenarios, derived from the evidence table. */
function buildCleanSweep(): string {
  const sweep = makeSweep();
  const ids: string[] = [];
  for (const [scenario, ev] of Object.entries(SCENARIO_EVIDENCE)) {
    ids.push(scenario);
    const labels: string[] = [...ev.required];
    for (const group of ev.anyOf) labels.push(group[0]);
    writeScenario(sweep, scenario, labels);
  }
  writeSummary(sweep, ids);
  return sweep;
}

describe("the canary: wrong self-grades are REJECTED (permanent)", () => {
  const variants: Array<{ dir: string; problem: string; scenarioLevel: boolean }> = [
    { dir: "flash-model-line", problem: "modelLine does not prove glm-5.3-not-flash", scenarioLevel: true },
    { dir: "missing-settled-snap", problem: 'required snap label "settled" absent', scenarioLevel: true },
    { dir: "snap-count-mismatch", problem: "snap count mismatch: receipt claims 7, 3 on disk", scenarioLevel: true },
    // summary drift is a SWEEP-level problem — there is no touched scenario;
    // the rejection itself is the assertion.
    {
      dir: "summary-row-drift",
      problem: 'summary.json row "ghost-scenario" has no scenario dir',
      scenarioLevel: false,
    },
  ];

  for (const v of variants) {
    it(`rejects ${v.dir} despite pass:true`, () => {
      const res = validateQualifySweep(join(CANARY, v.dir));
      expect(res.ok).toBe(false);
      const allProblems = [...res.problems, ...res.scenarios.flatMap((s) => s.problems)];
      expect(allProblems.some((p) => p.includes(v.problem))).toBe(true);
      if (!v.scenarioLevel) return;
      const touched = res.scenarios.find((s) => s.problems.some((p) => p.includes(v.problem)));
      expect(touched?.selfPass).toBe(true); // the self-grade SAID green
      expect(touched?.agree).toBe(false); // the grader must DISAGREE
    });
  }
});

describe("green control (table-derived clean sweep)", () => {
  it("accepts a fully clean ten-scenario sweep, all agreeing", () => {
    const res = validateQualifySweep(buildCleanSweep());
    expect(res.problems).toEqual([]);
    for (const s of res.scenarios) expect(s.problems).toEqual([]);
    expect(res.ok).toBe(true);
    expect(res.allAgree).toBe(true);
  });

  it("content-checks settled snaps for live markers (learning #5)", () => {
    const sweep = buildCleanSweep();
    const settledPath = join(sweep, "dispatch", "snap-03-settled.txt");
    writeFileSync(settledPath, "⠋ Working... still spinning", "utf8");
    const res = validateQualifySweep(sweep);
    expect(res.ok).toBe(false);
    expect(LIVE_MARKER_RE.test("⠋ Working...")).toBe(true);
    const dispatch = res.scenarios.find((s) => s.scenario === "dispatch");
    expect(dispatch?.problems.some((p) => p.includes("still shows live markers"))).toBe(true);
  });
});

describe("independence mechanics (D4)", () => {
  it("an absent self-grade still grades from evidence (undefined selfPass, no crash)", () => {
    const sweep = makeSweep();
    writeScenario(sweep, "parallel", ["boot", "submitted", "settled"], { omitPass: true });
    writeSummary(sweep, ["parallel"]);
    const res = validateQualifySweep(sweep);
    expect(res.ok).toBe(true);
    const s = res.scenarios.find((s2) => s2.scenario === "parallel");
    expect(s?.selfPass).toBeUndefined();
    expect(s?.agree).toBeUndefined();
    expect(s?.derivedPass).toBe(true); // derived, not echoed
  });

  it("a self-graded RED with green evidence still grades GREEN (evidence wins both ways)", () => {
    const sweep = makeSweep();
    writeScenario(sweep, "parallel", ["boot", "submitted", "settled"], { pass: false });
    writeSummary(sweep, ["parallel"]);
    const res = validateQualifySweep(sweep);
    const s = res.scenarios.find((s2) => s2.scenario === "parallel");
    expect(s?.derivedPass).toBe(true);
    expect(s?.agree).toBe(false);
    expect(res.allAgree).toBe(false);
  });

  it("an unknown scenario dir is rejected, not skipped", () => {
    const sweep = makeSweep();
    writeScenario(sweep, "mystery-scenario", ["anything"]);
    writeSummary(sweep, ["mystery-scenario"]);
    const res = validateQualifySweep(sweep);
    expect(res.ok).toBe(false);
    expect(res.scenarios[0]?.problems[0]).toContain("unknown scenario");
  });

  it("unparseable receipt and missing summary are red", () => {
    const sweep = makeSweep();
    mkdirSync(join(sweep, "parallel"), { recursive: true });
    writeFileSync(join(sweep, "parallel", "receipt.json"), "{nope", "utf8");
    const res = validateQualifySweep(sweep);
    expect(res.ok).toBe(false);
    expect(res.problems.some((p) => p.includes("missing summary.json"))).toBe(true);
  });
});

describe("drift guard (review nit, self-arc-21)", () => {
  it("LIVE_MARKER_RE stays byte-identical to the bench harness's class (screen.ts)", () => {
    // Deliberate copy per D4 (no import of the graded code) — but a silent
    // copy drifts: if screen.ts gains spinner frames, the validator would
    // pass live screens as settled. Pin the sources equal.
    const here = join(import.meta.dir, "..");
    const src = readFileSync(join(here, "src", "validate-qualify-receipts.ts"), "utf8");
    const bench = readFileSync(
      join(here, "..", "s2-agent-ext-subagent", "scripts", "lib", "bench-base-tech", "screen.ts"),
      "utf8",
    );
    const mine = /export const LIVE_MARKER_RE = (.+);/.exec(src)?.[1];
    const theirs = /export const LIVE_MARKER_RE = (.+);/.exec(bench)?.[1];
    expect(mine).toBeDefined();
    expect(mine).toBe(theirs);
  });
});
