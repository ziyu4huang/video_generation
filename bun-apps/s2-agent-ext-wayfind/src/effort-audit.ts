/**
 * `.planning/` finished-ness audit — the SOP's "is every effort properly
 * finished?" as a re-runnable check instead of a session tally (planning-audit
 * D8: two hand-sweeps of the same tree disagreed 75/10 vs 72/12). Spawn-free
 * (mirrors `sweep-zero-citation.ts`); section parsing reuses `parseMapBody`
 * and the front-matter split reuses `MAP_FM_RE` so extraction can never drift
 * from `readMap`. PR verification is INJECTED (`verifyPr`) so tests need no
 * git; the CLI twin supplies the `git log --grep` implementation.
 *
 * The audit is bidirectional (2026-09-09-planning-audit D4):
 *   red (a) map without a front-matter `status:` line
 *   red (b) non-terminal status, older than `staleDays`, no dated park note,
 *           not on the live-exempt list
 *   red (c) terminal status without a `## Shipped-as` / `## Resolution` section
 *   red (d) cited PR that does not resolve to a merged commit (verifyPr)
 *   red     `paused` without a dated park note; non-terminal without any date
 *   info    duplicate self-arc round numbers (by-design parallel sessions)
 *
 * Live-exempt = dirs owned by a concurrently-running session; recorded here
 * with the date so the list can be pruned when those efforts close.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseMapBody } from "./markdown.js";
import { MAP_FM_RE } from "./model.js";

/** Returns true when `pr` resolves to a merged commit in local git history. */
export type VerifyPr = (pr: number) => boolean;

export interface AuditFinding {
  code: string;
  severity: "red" | "info";
  message: string;
}

export interface EffortAuditRecord {
  /** Effort slug (the `.planning/<slug>/` folder name). */
  effort: string;
  /** Repo-relative map.md path. */
  mapPath: string;
  /** RAW front-matter status token, or null when the line is absent. */
  statusToken: string | null;
  /** Front-matter `last:` (fallback `created:`) date, YYYY-MM-DD, or null. */
  last: string | null;
  /** Terminal per the audit vocabulary (done|complete). */
  terminal: boolean;
  /** Token recognized in either vocabulary (terminal or non-terminal). */
  recognized: boolean;
  /** On the hardcoded live-exempt list (concurrent session's dir). */
  liveExempt: boolean;
  /** `## Shipped-as` or `## Resolution` section present and non-empty. */
  hasProvenance: boolean;
  /** PR numbers cited from Shipped-as/Resolution sections + body `PR #` lines. */
  citedPrs: number[];
  /** Subset of citedPrs verifyPr rejected (empty when verifyPr not supplied). */
  unverifiedPrs: number[];
  findings: AuditFinding[];
}

export interface AuditReport {
  generatedAt: string;
  /** Audit root (repo root whose .planning/ was walked). */
  root: string;
  staleDays: number;
  scanned: number;
  /** statusToken → count; "missing" counts maps with no status line. */
  census: Record<string, number>;
  records: EffortAuditRecord[];
  /** self-arc round numbers appearing under more than one dir prefix. */
  duplicateArcRounds: { round: number; efforts: string[] }[];
  /** Per-dir read failures (throw-free; a bad effort never fails the run). */
  errors: { dir: string; error: string }[];
  redCount: number;
}

/** Dated 2026-09-09: self-arc-17's closing docs PR was still unlanded and
 *  self-arc-18 arrives via open PR #2237 — both owned by a live parallel
 *  session. Prune when their close-outs merge. */
export const LIVE_EXEMPT = new Set(["2026-09-09-self-arc-17", "2026-09-09-self-arc-18"]);

const TERMINAL = new Set(["done", "complete"]);
const NON_TERMINAL = new Set([
  "active",
  "planning",
  "designing",
  "executing",
  "in-progress",
  "partial",
  "paused",
  "specified",
]);

const PARK_NOTE_RE = /(parked|paused|superseded|deferred)/i;
const DATE_RE = /20\d{2}-\d{2}-\d{2}/;
const ARC_ROUND_RE = /-(?:self-)?arc-(\d+)$/;

/**
 * Heuristic (recorded as such per D3): a park note = a line mentioning
 * parked/paused/superseded/deferred with a YYYY-MM-DD date within ±2 lines.
 */
export function hasDatedParkNote(body: string): boolean {
  const lines = body.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!PARK_NOTE_RE.test(lines[i])) continue;
    for (let j = Math.max(0, i - 2); j <= Math.min(lines.length - 1, i + 2); j++) {
      if (DATE_RE.test(lines[j])) return true;
    }
  }
  return false;
}

function parseDate(s: string | null | undefined): string | null {
  return (s?.match(DATE_RE)?.[0] as string | undefined) ?? null;
}

function ageDays(date: string, now: Date): number {
  const then = new Date(`${date}T00:00:00Z`).getTime();
  if (Number.isNaN(then)) return Number.POSITIVE_INFINITY;
  return (now.getTime() - then) / 86_400_000;
}

/** Raw front-matter fields the model's closed vocabulary drops on the floor. */
function readRawFrontmatter(md: string): {
  status: string | null;
  last: string | null;
  created: string | null;
  body: string;
} {
  const m = md.match(MAP_FM_RE);
  if (!m) return { status: null, last: null, created: null, body: md };
  let status: string | null = null;
  let last: string | null = null;
  let created: string | null = null;
  for (const line of (m[1] ?? "").split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    if (key === "status") status = val || null;
    else if (key === "last") last = val || null;
    else if (key === "created") created = val || null;
  }
  return { status, last, created, body: (m[2] ?? md).replace(/^\r?\n+/, "") };
}

/** Provenance headings. The SOP requires terminal maps to CITE what shipped;
 *  sessions have used both `## Shipped-as` and `## Shipped` (baseline
 *  finding, 2026-09-09) — both count, so the audit checks the requirement,
 *  not one spelling. */
const PROVENANCE_SECTIONS = ["Shipped-as", "Shipped", "Resolution"];

/** PR citations: `#N` inside provenance sections + `PR #N` body lines. Bare
 *  `#N` elsewhere (fences, fog prose) is NOT a citation. */
function extractCitations(sections: Record<string, string>, body: string): number[] {
  const prs = new Set<number>();
  for (const key of PROVENANCE_SECTIONS) {
    for (const m of (sections[key] ?? "").matchAll(/#(\d{2,6})/g)) prs.add(Number(m[1]));
  }
  for (const m of body.matchAll(/\bPR #(\d{2,6})/g)) prs.add(Number(m[1]));
  return [...prs].sort((a, b) => a - b);
}

function classifyOne(
  effort: string,
  md: string,
  staleDays: number,
  now: Date,
  verifyPr: VerifyPr | null,
): EffortAuditRecord {
  const findings: AuditFinding[] = [];
  const { status, last, created, body } = readRawFrontmatter(md);
  const sections = parseMapBody(body);
  const terminal = status !== null && TERMINAL.has(status);
  const recognized = status !== null && (TERMINAL.has(status) || NON_TERMINAL.has(status));
  const provenanceSections = PROVENANCE_SECTIONS.filter((k) => (sections[k] ?? "").trim().length > 0);
  const hasProvenance = provenanceSections.length > 0;
  const citedPrs = extractCitations(sections, body);
  const liveExempt = LIVE_EXEMPT.has(effort);

  if (status === null) {
    findings.push({ code: "missing-status", severity: "red", message: "map has no front-matter `status:` line" });
  } else if (!recognized) {
    findings.push({
      code: "unknown-status-token",
      severity: "red",
      message: `status token \`${status}\` is outside the audit vocabulary`,
    });
  }

  if (terminal && !hasProvenance) {
    findings.push({
      code: "terminal-no-provenance",
      severity: "red",
      message: "terminal status without a Shipped-as/Resolution section",
    });
  }

  if (status !== null && recognized && !terminal) {
    const parkNote = hasDatedParkNote(body);
    if (status === "paused" && !parkNote) {
      findings.push({ code: "paused-without-note", severity: "red", message: "paused without a dated park note" });
    }
    const date = parseDate(last) ?? parseDate(created);
    if (!date) {
      findings.push({
        code: "no-date",
        severity: "red",
        message: "non-terminal without a parseable last:/created: date",
      });
    } else if (ageDays(date, now) > staleDays && !parkNote && !liveExempt) {
      findings.push({
        code: "stale-non-terminal",
        severity: "red",
        message: `non-terminal for ${Math.floor(ageDays(date, now))}d (> ${staleDays}d) with no dated park note`,
      });
    } else if (liveExempt && ageDays(date, now) > staleDays) {
      findings.push({
        code: "live-exempt",
        severity: "info",
        message: "stale non-terminal exempted: owned by a live parallel session (2026-09-09)",
      });
    }
  }

  const unverifiedPrs: number[] = [];
  if (verifyPr) {
    for (const pr of citedPrs) {
      if (!verifyPr(pr)) unverifiedPrs.push(pr);
    }
    if (unverifiedPrs.length > 0) {
      findings.push({
        code: "unmerged-citation",
        severity: "red",
        message: `cited PR(s) not resolvable as merged: ${unverifiedPrs.map((p) => `#${p}`).join(", ")}`,
      });
    }
  } else if (citedPrs.length > 0) {
    findings.push({
      code: "pr-verification-skipped",
      severity: "info",
      message: `${citedPrs.length} citation(s) not verified (no verifyPr)`,
    });
  }

  return {
    effort,
    mapPath: join(".planning", effort, "map.md"),
    statusToken: status,
    last: parseDate(last) ?? parseDate(created),
    terminal,
    recognized,
    liveExempt,
    hasProvenance,
    citedPrs,
    unverifiedPrs,
    findings,
  };
}

/** Walk `.planning/<YYYY-MM-DD-*>` effort dirs and audit every map.md. Throw-free. */
export function auditEfforts(
  cwd: string,
  opts?: { staleDays?: number; now?: Date; verifyPr?: VerifyPr | null },
): AuditReport {
  const staleDays = opts?.staleDays ?? 14;
  const now = opts?.now ?? new Date();
  const verifyPr = opts?.verifyPr ?? null;
  const planningRoot = join(cwd, ".planning");
  const report: AuditReport = {
    generatedAt: now.toISOString(),
    root: cwd,
    staleDays,
    scanned: 0,
    census: {},
    records: [],
    duplicateArcRounds: [],
    errors: [],
    redCount: 0,
  };
  if (!existsSync(planningRoot)) return report;

  const dirs = readdirSync(planningRoot)
    .filter((n) => /^20\d{2}-\d{2}-\d{2}-/.test(n))
    .filter((n) => {
      try {
        return statSync(join(planningRoot, n)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();

  for (const effort of dirs) {
    report.scanned += 1;
    const absMap = join(planningRoot, effort, "map.md");
    try {
      if (!existsSync(absMap)) {
        report.errors.push({ dir: effort, error: "no map.md" });
        continue;
      }
      report.records.push(classifyOne(effort, readFileSync(absMap, "utf-8"), staleDays, now, verifyPr));
    } catch (err) {
      report.errors.push({ dir: effort, error: err instanceof Error ? err.message : String(err) });
    }
  }

  for (const rec of report.records) {
    const key = rec.statusToken ?? "missing";
    report.census[key] = (report.census[key] ?? 0) + 1;
    report.redCount += rec.findings.filter((f) => f.severity === "red").length;
  }

  // Duplicate self-arc round numbers across distinct dir prefixes: by-design
  // parallel-session artifacts — info, never a red (planning-audit Frontier).
  const byRound = new Map<number, string[]>();
  for (const rec of report.records) {
    const m = rec.effort.match(ARC_ROUND_RE);
    if (!m) continue;
    const round = Number(m[1]);
    byRound.set(round, [...(byRound.get(round) ?? []), rec.effort]);
  }
  for (const [round, efforts] of [...byRound.entries()].sort((a, b) => a[0] - b[0])) {
    if (efforts.length > 1) {
      report.duplicateArcRounds.push({ round, efforts });
      for (const rec of report.records) {
        if (efforts.includes(rec.effort)) {
          rec.findings.push({
            code: "duplicate-arc-round",
            severity: "info",
            message: `self-arc round ${round} also exists as ${efforts.filter((e) => e !== rec.effort).join(", ")}`,
          });
        }
      }
    }
  }

  return report;
}
