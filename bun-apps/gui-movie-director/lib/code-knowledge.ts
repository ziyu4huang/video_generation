// Code-health knowledge base — the self-improve workflow's producer side of the
// shared knowledge-base/ root. Where the generation KB (knowledge-db.ts) learns
// prompt-engineering insights from image results, this module learns CODE-HEALTH
// trends from gui-movie-director-self-improve runs: openIssues over time, most
// bug-prone files, recurring finding dimensions, fix rate.
//
// Lives under knowledge-base/code/ (own records.jsonl + index.json) so it never
// collides with the generation KB's records/ reports/ structured/ index.json.

import fs from "fs";
import path from "path";
import { REPO_DIR } from "./config";

// ── Paths ────────────────────────────────────────────────────────────────────
// Env-overridable so tests can point at a temp dir instead of the real KB.
// Derived from REPO_DIR (not a hardcoded username) so this is portable across
// machines/worktrees. Matches the sibling knowledge-db.ts DEFAULT_KB_ROOT pattern
// and resolves to ../video_generation/knowledge-base/code (a sibling repo).
const DEFAULT_KB_CODE_ROOT = path.resolve(REPO_DIR, "..", "video_generation", "knowledge-base", "code");
function codeRoot(): string {
  return process.env.KB_CODE_ROOT || DEFAULT_KB_CODE_ROOT;
}
function recordsPath(): string {
  return path.join(codeRoot(), "records.jsonl");
}
function indexPath(): string {
  return path.join(codeRoot(), "index.json");
}

const TREND_MAX = 50; // cap openIssues history stored in the index

// ── Types ────────────────────────────────────────────────────────────────────

export interface CodeFindings {
  verified: number;
  newFindings: number;
  bySeverity: Record<string, number>;
  byDimension: Record<string, number>;
}

export type CodeFixes =
  | { mode: "review-only" }
  | { applied: number; regressions: number; skipped?: number; failed?: number };

export interface CodeSchemaSummary {
  runtimeErrors: number;
  runtimeFindings: number;
  driftRemaining: number;
}

/** One record per self-improve run (append-only to records.jsonl). */
export interface CodeKnowledgeRecord {
  runId: string;
  workflow: string;
  lanes: string[];
  effort: string;
  fixApplied: boolean;
  /** Unified health scalar: review verified + schema runtime errors + drift remaining. Lower = healthier. */
  openIssues: number;
  findings: CodeFindings;
  fixes: CodeFixes;
  schema: CodeSchemaSummary;
  /** Files fixed this run — drives the "most bug-prone" trend across runs. */
  filesTouched: string[];
  timestamp: string;
}

export interface CodeKnowledgeIndex {
  version: number;
  lastUpdated: string;
  totalRuns: number;
  lastRunId: string | null;
  openIssuesTrend: number[];
}

export interface FileBugCount {
  file: string;
  count: number;
}
export interface DimensionCount {
  dimension: string;
  count: number;
}

/** Aggregated trend report — regenerated on read from all records. */
export interface CodeKnowledgeReport {
  generatedAt: string;
  totalRuns: number;
  openIssuesTrend: number[];
  mostBugProneFiles: FileBugCount[];
  recurringDimensions: DimensionCount[];
  /** applied / verified across history (percent, 1 decimal). 0 when no verified findings. */
  fixRate: number;
  latestRun: CodeKnowledgeRecord | null;
}

// ── Directory bootstrap ──────────────────────────────────────────────────────

export function ensureCodeKbDirs(): void {
  fs.mkdirSync(codeRoot(), { recursive: true });
}

// ── Records (append-only JSONL, single file — code runs are infrequent) ───────

export function appendCodeRecord(rec: CodeKnowledgeRecord): void {
  ensureCodeKbDirs();
  // Idempotent on runId. The gui self-improve Persist phase can reach this more
  // than once per run (agent retry / re-entry); before this guard that produced
  // 2–4× duplicate records + an inflated index (data was hand-deduped in PR #16,
  // but the persist path stayed unguarded). Skip silently if already recorded.
  if (readAllCodeRecords().some((r) => r.runId === rec.runId)) {
    return;
  }
  fs.appendFileSync(recordsPath(), JSON.stringify(rec) + "\n", "utf-8");

  const idx = readCodeIndex() ?? emptyIndex();
  idx.totalRuns += 1;
  idx.lastRunId = rec.runId;
  idx.openIssuesTrend = [...idx.openIssuesTrend, rec.openIssues].slice(-TREND_MAX);
  idx.lastUpdated = new Date().toISOString();
  writeCodeIndex(idx);
}

export function readAllCodeRecords(): CodeKnowledgeRecord[] {
  try {
    if (!fs.existsSync(recordsPath())) return [];
    const txt = fs.readFileSync(recordsPath(), "utf-8");
    const records: CodeKnowledgeRecord[] = [];
    for (const line of txt.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        records.push(JSON.parse(t) as CodeKnowledgeRecord);
      } catch {
        /* skip malformed line */
      }
    }
    return records;
  } catch {
    return [];
  }
}

// ── Index ────────────────────────────────────────────────────────────────────

export function readCodeIndex(): CodeKnowledgeIndex | null {
  try {
    if (!fs.existsSync(indexPath())) return null;
    return JSON.parse(fs.readFileSync(indexPath(), "utf-8")) as CodeKnowledgeIndex;
  } catch {
    return null;
  }
}

function writeCodeIndex(idx: CodeKnowledgeIndex): void {
  ensureCodeKbDirs();
  fs.writeFileSync(indexPath(), JSON.stringify(idx, null, 2), "utf-8");
}

function emptyIndex(): CodeKnowledgeIndex {
  return {
    version: 1,
    lastUpdated: new Date().toISOString(),
    totalRuns: 0,
    lastRunId: null,
    openIssuesTrend: [],
  };
}

// ── Report aggregation ───────────────────────────────────────────────────────

export function buildCodeReport(): CodeKnowledgeReport {
  const records = readAllCodeRecords();
  const fileCounts = new Map<string, number>();
  const dimCounts = new Map<string, number>();
  let applied = 0;
  let verified = 0;

  for (const r of records) {
    verified += r.findings?.verified ?? 0;
    if (!("mode" in r.fixes) || r.fixes.mode !== "review-only") {
      applied += (r.fixes as { applied: number }).applied ?? 0;
    }
    for (const f of r.filesTouched ?? []) {
      fileCounts.set(f, (fileCounts.get(f) ?? 0) + 1);
    }
    for (const [dim, n] of Object.entries(r.findings?.byDimension ?? {})) {
      dimCounts.set(dim, (dimCounts.get(dim) ?? 0) + (n || 0));
    }
  }

  const idx = readCodeIndex();
  return {
    generatedAt: new Date().toISOString(),
    totalRuns: records.length,
    // Prefer the maintained index trend; fall back to deriving from records.
    openIssuesTrend: idx?.openIssuesTrend ?? records.map((r) => r.openIssues),
    mostBugProneFiles: [...fileCounts.entries()]
      .map(([file, count]) => ({ file, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10),
    recurringDimensions: [...dimCounts.entries()]
      .map(([dimension, count]) => ({ dimension, count }))
      .sort((a, b) => b.count - a.count),
    fixRate: verified > 0 ? Math.round((applied / verified) * 1000) / 10 : 0,
    latestRun: records.length ? records[records.length - 1] : null,
  };
}

/** Thin alias for the API consumer — builds the report fresh on each call. */
export function loadLatestCodeReport(): CodeKnowledgeReport {
  return buildCodeReport();
}
