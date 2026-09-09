import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditEfforts, hasDatedParkNote } from "../src/effort-audit.js";

const tempRoots: string[] = [];

function makeRoot(): string {
  const cwd = mkdtempSync(join(tmpdir(), "wf-effort-audit-"));
  tempRoots.push(cwd);
  return cwd;
}

afterEach(() => {
  while (tempRoots.length) {
    const r = tempRoots.pop();
    if (r) rmSync(r, { recursive: true, force: true });
  }
});

/**
 * Seed a RAW map (not via writeMap): the audit reads raw bytes, and the tree
 * carries status tokens outside writeMap's closed vocabulary — exactly what
 * these fixtures must exercise.
 */
function seedRaw(root: string, slug: string, frontmatter: string, body = "## Destination\n\nDest.\n"): void {
  const dir = join(root, ".planning", slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "map.md"), `---\n${frontmatter}\n---\n\n${body}`, "utf-8");
}

const NOW = new Date("2026-09-09T12:00:00Z");
const FRESH = "2026-09-08";
const ANCIENT = "2026-08-01";

function codes(rec: { findings: { code: string; severity: string }[] }, severity = "red"): string[] {
  return rec.findings.filter((f) => f.severity === severity).map((f) => f.code);
}

describe("hasDatedParkNote", () => {
  it("requires a keyword AND a date within ±2 lines", () => {
    expect(hasDatedParkNote("parked: awaiting 2026-07-01 upstream fix")).toBe(true);
    expect(hasDatedParkNote("Superseded by the 2026-08-15 effort below.")).toBe(true);
    expect(hasDatedParkNote("parked indefinitely")).toBe(false);
    expect(hasDatedParkNote("parked on 2026-07-01")).toBe(true);
    // date outside the ±2-line window does not count
    expect(hasDatedParkNote("parked\n\n\n\n2026-07-01")).toBe(false);
  });
});

describe("auditEfforts", () => {
  it("terminal done + Shipped-as with verifiable PRs is green", () => {
    const root = makeRoot();
    seedRaw(
      root,
      "2026-01-01-green",
      `effort: 2026-01-01-green\ncreated: 2026-01-01\nlast: 2026-01-02\nstatus: done`,
      "## Destination\n\nD.\n\n## Shipped-as\n\nPR #1234 merged it.\n",
    );
    const r = auditEfforts(root, { now: NOW, verifyPr: () => true });
    expect(r.scanned).toBe(1);
    expect(r.redCount).toBe(0);
    expect(r.records[0].citedPrs).toEqual([1234]);
    expect(codes(r.records[0])).toEqual([]);
  });

  it("flags a map with no front-matter status line", () => {
    const root = makeRoot();
    seedRaw(root, "2026-01-02-legacy", `effort: 2026-01-02-legacy\ncreated: ${ANCIENT}`);
    const r = auditEfforts(root, { now: NOW });
    expect(codes(r.records[0])).toEqual(["missing-status"]);
    expect(r.census.missing).toBe(1);
  });

  it("flags a status token outside the vocabulary", () => {
    const root = makeRoot();
    seedRaw(root, "2026-01-03-weird", `effort: x\nstatus: banana`, "## Destination\n\nD.\n");
    const r = auditEfforts(root, { now: NOW });
    expect(codes(r.records[0])).toEqual(["unknown-status-token"]);
  });

  it("flags terminal without Shipped-as/Resolution", () => {
    const root = makeRoot();
    seedRaw(root, "2026-01-04-bare", `effort: x\nlast: ${FRESH}\nstatus: done`);
    const r = auditEfforts(root, { now: NOW });
    expect(codes(r.records[0])).toEqual(["terminal-no-provenance"]);
  });

  it("flags stale non-terminal without a dated park note", () => {
    const root = makeRoot();
    seedRaw(root, "2026-01-05-stale", `effort: x\nlast: ${ANCIENT}\nstatus: active`);
    const r = auditEfforts(root, { now: NOW, staleDays: 14 });
    expect(codes(r.records[0])).toEqual(["stale-non-terminal"]);
  });

  it("fresh non-terminal is green", () => {
    const root = makeRoot();
    seedRaw(root, "2026-01-06-fresh", `effort: x\nlast: ${FRESH}\nstatus: active`);
    const r = auditEfforts(root, { now: NOW, staleDays: 14 });
    expect(codes(r.records[0])).toEqual([]);
  });

  it("dated park note suppresses the stale red", () => {
    const root = makeRoot();
    seedRaw(
      root,
      "2026-01-07-parked",
      `effort: x\nlast: ${ANCIENT}\nstatus: active`,
      "## Destination\n\nD.\n\nParked awaiting upstream (2026-08-02).\n",
    );
    const r = auditEfforts(root, { now: NOW, staleDays: 14 });
    expect(codes(r.records[0])).toEqual([]);
  });

  it("paused without a dated note is red even when fresh", () => {
    const root = makeRoot();
    seedRaw(root, "2026-01-08-paused", `effort: x\nlast: ${FRESH}\nstatus: paused`);
    const r = auditEfforts(root, { now: NOW });
    expect(codes(r.records[0])).toEqual(["paused-without-note"]);
  });

  it("non-terminal with no parseable date is red", () => {
    const root = makeRoot();
    seedRaw(root, "2026-01-09-nodate", `effort: x\nstatus: planning`);
    const r = auditEfforts(root, { now: NOW });
    expect(codes(r.records[0])).toEqual(["no-date"]);
  });

  it("live-exempt stale non-terminal gets info, not red", () => {
    const root = makeRoot();
    seedRaw(root, "2026-09-09-self-arc-17", `effort: x\nlast: ${ANCIENT}\nstatus: active`);
    const r = auditEfforts(root, { now: NOW, staleDays: 14 });
    expect(r.records[0].liveExempt).toBe(true);
    expect(codes(r.records[0])).toEqual([]);
    expect(codes(r.records[0], "info")).toContain("live-exempt");
  });

  it("flags cited PRs that do not resolve as merged", () => {
    const root = makeRoot();
    seedRaw(
      root,
      "2026-01-10-bogus",
      `effort: x\nlast: ${FRESH}\nstatus: done`,
      "## Shipped-as\n\nPR #9999 merged it (citation), also #1234.\n",
    );
    const r = auditEfforts(root, { now: NOW, verifyPr: (n) => n === 1234 });
    expect(r.records[0].citedPrs).toEqual([1234, 9999]);
    expect(r.records[0].unverifiedPrs).toEqual([9999]);
    expect(codes(r.records[0])).toEqual(["unmerged-citation"]);
  });

  it("without verifyPr, citations are counted but only noted as skipped", () => {
    const root = makeRoot();
    seedRaw(root, "2026-01-11-skip", `effort: x\nlast: ${FRESH}\nstatus: done`, "## Shipped-as\n\nPR #42.\n");
    const r = auditEfforts(root, { now: NOW, verifyPr: null });
    expect(r.records[0].citedPrs).toEqual([42]);
    expect(codes(r.records[0])).toEqual([]);
    expect(codes(r.records[0], "info")).toContain("pr-verification-skipped");
  });

  it("counts citations from Shipped-as/Shipped/Resolution sections and body `PR #` lines only", () => {
    const root = makeRoot();
    seedRaw(
      root,
      "2026-01-12-cites",
      `effort: x\nlast: ${FRESH}\nstatus: complete`,
      "## Destination\n\nSee #777 in fog prose.\n\n## Shipped-as\n\n#100 landed.\n\n## Resolution\n\nClosed via PR #200.\n\n## Shipped\n\n#300 also counts (baseline drift finding).\n",
    );
    const r = auditEfforts(root, { now: NOW, verifyPr: () => true });
    expect(r.records[0].citedPrs).toEqual([100, 200, 300]); // #777 (bare, non-PR line) NOT a citation
  });

  it("a `## Shipped` section alone satisfies provenance (sibling sessions' spelling)", () => {
    const root = makeRoot();
    seedRaw(root, "2026-01-13-shipped", `effort: x\nlast: ${FRESH}\nstatus: done`, "## Shipped\n\n- the thing (#42)\n");
    const r = auditEfforts(root, { now: NOW, verifyPr: () => true });
    expect(r.records[0].hasProvenance).toBe(true);
    expect(codes(r.records[0])).toEqual([]);
  });

  it("duplicate self-arc round numbers are info, never red", () => {
    const root = makeRoot();
    seedRaw(root, "2026-09-06-self-arc-13", `effort: x\nlast: ${FRESH}\nstatus: done`, "## Shipped-as\n\nPR #1.\n");
    seedRaw(root, "2026-09-08-self-arc-13", `effort: x\nlast: ${FRESH}\nstatus: done`, "## Shipped-as\n\nPR #2.\n");
    const r = auditEfforts(root, { now: NOW, verifyPr: () => true });
    expect(r.duplicateArcRounds).toEqual([
      { round: 13, efforts: ["2026-09-06-self-arc-13", "2026-09-08-self-arc-13"] },
    ]);
    expect(r.redCount).toBe(0);
    expect(r.records.every((rec) => codes(rec, "info").includes("duplicate-arc-round"))).toBe(true);
  });

  it("scans only date-prefixed dirs and is throw-free on a bad map", () => {
    const root = makeRoot();
    mkdirSync(join(root, ".planning", "knowledge"), { recursive: true });
    mkdirSync(join(root, ".planning", "2026-99-99-broken"), { recursive: true });
    writeFileSync(join(root, ".planning", "2026-99-99-broken", "map.md"), "---\nstatus: [unclosed\n", "utf-8");
    const r = auditEfforts(root, { now: NOW });
    expect(r.scanned).toBe(1);
    expect(r.errors.length).toBe(0); // malformed fences parse as body, not errors
    expect(codes(r.records[0])).toContain("missing-status");
  });
});
