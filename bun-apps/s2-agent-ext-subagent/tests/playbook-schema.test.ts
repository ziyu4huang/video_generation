import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Playbook schema locks (spwf-ab-closing lineage; selfimprove-playbook t02).
 * The playbook is the loop's curated strategy store — read at every arc open
 * (arc-plan.ts --include-playbook), curated at every close (itemized deltas).
 * These tests keep it trustworthy: schema conformance, evidence resolution,
 * hard caps, and supersede-not-delete.
 */

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const PLAYBOOK = join(REPO_ROOT, ".planning", "playbook.md");

const LINE_CAP = 150;
const ENTRY_CAP = 25;

interface Entry {
  id: string;
  title: string;
  scope: string;
  strategy: string;
  evidence: string;
  confidence: string;
  status: string;
}

function parsePlaybook(md: string): { frontmatter: Record<string, string>; entries: Entry[]; totalLines: number } {
  const lines = md.split(/\r?\n/);
  expect(lines[0]).toBe("---");
  const fmEnd = lines.indexOf("---", 1);
  const frontmatter: Record<string, string> = {};
  for (const l of lines.slice(1, fmEnd)) {
    const i = l.indexOf(":");
    if (i > 0) frontmatter[l.slice(0, i).trim()] = l.slice(i + 1).trim();
  }
  const entries: Entry[] = [];
  let cur: Entry | null = null;
  for (const l of lines.slice(fmEnd + 1)) {
    const h = l.match(/^### (PB-\d+) — (.+)$/);
    if (h) {
      if (cur) entries.push(cur);
      cur = { id: h[1], title: h[2], scope: "", strategy: "", evidence: "", confidence: "", status: "" };
      continue;
    }
    if (!cur) continue;
    const f = l.match(/^- \*\*(Scope|Strategy|Evidence|Confidence|Status):\*\* (.*)$/);
    if (f) {
      const key = f[1].toLowerCase();
      if (key === "scope") cur.scope = f[2];
      else if (key === "strategy") cur.strategy += f[2];
      else if (key === "evidence") cur.evidence += f[2];
      else if (key === "confidence") cur.confidence = f[2];
      else if (key === "status") cur.status = f[2];
    }
  }
  if (cur) entries.push(cur);
  return { frontmatter, entries, totalLines: lines.length };
}

function evidenceResolves(evidence: string): boolean {
  // path citations: every .planning/... or bun-apps/... path must exist
  const pathM = evidence.match(/(?:\.planning|bun-apps)\/[A-Za-z0-9_./-]+/g);
  if (pathM) {
    for (const raw of pathM) {
      const p = raw.replace(/[.,)]+$/, "");
      if (!existsSync(join(REPO_ROOT, p))) return false;
    }
  }
  // PR citations: #N must resolve as a merged commit via git log --grep
  for (const prM of evidence.matchAll(/#(\d{2,6})/g)) {
    const r = spawnSync(
      "git",
      ["-C", REPO_ROOT, "log", "origin/main", "--grep", `#${prM[1]}($|[^0-9])`, "-E", "--oneline", "-1"],
      {
        encoding: "utf8",
      },
    );
    if (r.status !== 0 || !r.stdout.trim()) return false;
  }
  return true;
}

describe("loop playbook schema (.planning/playbook.md)", () => {
  it("exists with the required frontmatter", () => {
    expect(existsSync(PLAYBOOK)).toBe(true);
    const { frontmatter } = parsePlaybook(readFileSync(PLAYBOOK, "utf8"));
    expect(frontmatter.version).toBe("1");
    expect(frontmatter.updated).toMatch(/^20\d{2}-\d{2}-\d{2}$/);
  });

  it("holds itemized PB-nn entries with all required fields", () => {
    const { entries } = parsePlaybook(readFileSync(PLAYBOOK, "utf8"));
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      expect(e.scope).not.toBe("");
      expect(e.strategy.length).toBeGreaterThan(20);
      expect(e.evidence).not.toBe("");
      expect(["high", "medium", "low"].some((c) => e.confidence.startsWith(c))).toBe(true);
      expect(e.status).toMatch(/^(active|superseded-by PB-\d+)/);
    }
  });

  it("respects the hard caps (25 entries, 150 lines)", () => {
    const { entries, totalLines } = parsePlaybook(readFileSync(PLAYBOOK, "utf8"));
    expect(entries.length).toBeLessThanOrEqual(ENTRY_CAP);
    expect(totalLines).toBeLessThanOrEqual(LINE_CAP);
  });

  it("every Evidence citation resolves on disk or as a merged PR", () => {
    const { entries } = parsePlaybook(readFileSync(PLAYBOOK, "utf8"));
    const unresolved: string[] = [];
    for (const e of entries) {
      if (e.status.startsWith("superseded")) continue; // dead entries may cite dead paths
      if (!evidenceResolves(e.evidence)) unresolved.push(`${e.id}: ${e.evidence.slice(0, 90)}`);
    }
    expect(unresolved).toEqual([]);
  });

  it("ids are unique and sequential from PB-01", () => {
    const { entries } = parsePlaybook(readFileSync(PLAYBOOK, "utf8"));
    const ids = entries.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (let i = 0; i < ids.length; i++) {
      expect(ids[i]).toBe(`PB-${String(i + 1).padStart(2, "0")}`);
    }
  });
});
