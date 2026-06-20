import fs from "fs";
import path from "path";
import type {
  KnowledgeRecord,
  KnowledgeReport,
  KnowledgeIndex,
  StructuredKnowledge,
} from "./knowledge-types";
import { REPO_DIR } from "./config";

// Resolve relative to the repo root so this is portable across machines and
// worktrees (consistent with OUTPUT_DIRS resolution in lib/config.ts). The
// KB sits in the sibling video_generation/knowledge-base dir. Env-overridable
// for parity with KB_CODE_ROOT in code-knowledge.ts, so tests can point at a
// temp dir instead of the real KB.
const DEFAULT_KB_ROOT = path.resolve(REPO_DIR, "..", "video_generation", "knowledge-base");
export const KB_ROOT = process.env.KB_ROOT || DEFAULT_KB_ROOT;
const KB_RECORDS_DIR   = path.join(KB_ROOT, "records");
const KB_REPORTS_DIR   = path.join(KB_ROOT, "reports");
const KB_STRUCTURED_DIR = path.join(KB_ROOT, "structured");
const KB_INDEX_PATH    = path.join(KB_ROOT, "index.json");
const SHARD_MAX_BYTES  = 1 * 1024 * 1024; // 1MB

// ── Directory bootstrap ───────────────────────────────────────────────────────

export function ensureKbDirs(): void {
  for (const dir of [KB_ROOT, KB_RECORDS_DIR, KB_REPORTS_DIR, KB_STRUCTURED_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ── Shard helpers ─────────────────────────────────────────────────────────────

function shardName(n: number): string {
  return `records-${String(n).padStart(4, "0")}.jsonl`;
}

function listShards(): string[] {
  try {
    return fs.readdirSync(KB_RECORDS_DIR).filter((f) => f.endsWith(".jsonl")).sort();
  } catch { return []; }
}

function countLines(shards: string[]): number {
  let n = 0;
  for (const s of shards) {
    try {
      const txt = fs.readFileSync(path.join(KB_RECORDS_DIR, s), "utf-8");
      n += txt.split("\n").filter((l) => l.trim()).length;
    } catch { /* skip */ }
  }
  return n;
}

// ── Records JSONL append with 1MB sharding ────────────────────────────────────

export function appendRecordsToDb(records: KnowledgeRecord[]): void {
  if (records.length === 0) return;
  ensureKbDirs();

  const shards = listShards();
  let activeName = shards.length > 0 ? shards[shards.length - 1] : shardName(0);
  let activePath = path.join(KB_RECORDS_DIR, activeName);

  // Roll to a new shard if the current one is already at the limit
  try {
    if (fs.statSync(activePath).size >= SHARD_MAX_BYTES) {
      activeName = shardName(shards.length);
      activePath = path.join(KB_RECORDS_DIR, activeName);
    }
  } catch { /* file doesn't exist yet — will be created on first append */ }

  for (const record of records) {
    fs.appendFileSync(activePath, JSON.stringify(record) + "\n", "utf-8");
    // Roll shard if it just crossed the limit
    try {
      if (fs.statSync(activePath).size >= SHARD_MAX_BYTES) {
        const next = listShards();
        activeName = shardName(next.length);
        activePath = path.join(KB_RECORDS_DIR, activeName);
      }
    } catch { /* ignore */ }
  }

  // Refresh index shard list
  const idx = readKbIndex() ?? emptyIndex();
  const updated = listShards();
  idx.recordShards = updated.map((s) => `records/${s}`);
  idx.totalRecords = countLines(updated);
  idx.lastUpdated = new Date().toISOString();
  writeKbIndex(idx);
}

// ── Report save: timestamped + latest.json + structured JSONL + index ─────────

function timestampStr(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function saveReportToDb(report: KnowledgeReport): void {
  ensureKbDirs();

  const filename = `${timestampStr()}.json`;
  const reportPath = path.join(KB_REPORTS_DIR, filename);
  const latestPath = path.join(KB_REPORTS_DIR, "latest.json");
  const payload = JSON.stringify(report, null, 2);

  fs.writeFileSync(reportPath, payload, "utf-8");
  fs.writeFileSync(latestPath, payload, "utf-8");

  exportStructuredToDb(report.structured);

  const idx = readKbIndex() ?? emptyIndex();
  const rel = `reports/${filename}`;
  if (!idx.reports.includes(rel)) idx.reports.push(rel);
  idx.latestReport = rel;
  idx.lastUpdated = new Date().toISOString();
  idx.stats = computeStats(report);

  const shards = listShards();
  idx.recordShards = shards.map((s) => `records/${s}`);
  idx.totalRecords = countLines(shards);

  writeKbIndex(idx);
}

// ── Structured knowledge JSONL export (full overwrite per category) ───────────

export function exportStructuredToDb(structured: StructuredKnowledge): void {
  ensureKbDirs();

  function writeJsonl(filename: string, items: unknown[]): void {
    const content = items.map((item) => JSON.stringify(item)).join("\n") + (items.length ? "\n" : "");
    fs.writeFileSync(path.join(KB_STRUCTURED_DIR, filename), content, "utf-8");
  }

  writeJsonl("strategies.jsonl",    structured.topStrategies);
  writeJsonl("examples.jsonl",      structured.topExamples);
  writeJsonl("lora-insights.jsonl", structured.loraInsights);
  writeJsonl("params.jsonl",        structured.bestParams);
  writeJsonl("avoid.jsonl",         structured.avoid.map((item) => ({ item })));
}

// ── Load helpers ──────────────────────────────────────────────────────────────

export function loadLatestReportFromDb(): KnowledgeReport | null {
  try {
    const p = path.join(KB_REPORTS_DIR, "latest.json");
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf-8")) as KnowledgeReport;
  } catch { return null; }
}

export function readAllRecordsFromDb(): KnowledgeRecord[] {
  const records: KnowledgeRecord[] = [];
  for (const shard of listShards()) {
    try {
      const txt = fs.readFileSync(path.join(KB_RECORDS_DIR, shard), "utf-8");
      for (const line of txt.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try { records.push(JSON.parse(t) as KnowledgeRecord); } catch { /* skip malformed */ }
      }
    } catch { /* skip inaccessible shards */ }
  }
  return records;
}

export function readKbIndex(): KnowledgeIndex | null {
  try {
    if (!fs.existsSync(KB_INDEX_PATH)) return null;
    return JSON.parse(fs.readFileSync(KB_INDEX_PATH, "utf-8")) as KnowledgeIndex;
  } catch { return null; }
}

// ── Private helpers ───────────────────────────────────────────────────────────

function writeKbIndex(idx: KnowledgeIndex): void {
  fs.writeFileSync(KB_INDEX_PATH, JSON.stringify(idx, null, 2), "utf-8");
}

function emptyIndex(): KnowledgeIndex {
  return {
    version: 1,
    lastUpdated: new Date().toISOString(),
    recordShards: [],
    totalRecords: 0,
    reports: [],
    latestReport: null,
    stats: { avgQualityScore: 0, withCaption: 0, pipelines: {} },
  };
}

function computeStats(report: KnowledgeReport): KnowledgeIndex["stats"] {
  const pipelines: Record<string, number> = {};
  for (const ex of report.structured.topExamples) {
    if (ex.pipeline) pipelines[ex.pipeline] = (pipelines[ex.pipeline] ?? 0) + 1;
  }
  return {
    avgQualityScore: report.avgQualityScore,
    withCaption: report.recordCount,
    pipelines,
  };
}
