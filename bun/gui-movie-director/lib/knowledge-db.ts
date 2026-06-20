import fs from "fs";
import path from "path";
import type {
  KnowledgeRecord,
  KnowledgeReport,
  KnowledgeIndex,
  StructuredKnowledge,
  PromptStrategy,
  ExampleRecord,
  LoraInsight,
  BestParams,
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

// ── Structured knowledge JSONL export (ACCUMULATE per category) ──────────────
// Each knowledge:learn call distills the current top-N records via DeepSeek, but
// it must NOT discard knowledge from prior runs (or hand-seeded entries). We
// merge incoming entries into the existing per-category JSONL, keyed by a stable
// field: incoming wins on collision (latest distillation for that key), while
// entries absent from the incoming set are preserved. Without this, every
// iteration destructively regenerates the files and the self-learning loop
// forgets everything it ever learned (observed 2026-06-20: iteration #5 wiped
// hand-seeded plasticky-skin-ceiling knowledge with a 1-record regeneration).

// Pure merge core (no FS) — unit-tested. incoming entries overwrite existing on
// key collision (latest wins); existing-only entries are preserved. Output order:
// incoming (new/refreshed) first, then preserved existing-only entries. Empty
// keys are dropped (malformed input).
export function mergeByKey<T>(existing: T[], incoming: T[], keyOf: (item: T) => string): T[] {
  const merged = new Map<string, T>();
  const incomingKeys: string[] = [];
  for (const item of existing) {
    const k = keyOf(item);
    if (k) merged.set(k, item);
  }
  for (const item of incoming) {
    const k = keyOf(item);
    if (!k) continue;
    if (!merged.has(k)) incomingKeys.push(k);
    merged.set(k, item);
  }
  const ordered: T[] = [];
  for (const k of incomingKeys) ordered.push(merged.get(k) as T);
  for (const [k, item] of merged) {
    if (!incomingKeys.includes(k)) ordered.push(item);
  }
  return ordered;
}

export function exportStructuredToDb(structured: StructuredKnowledge): void {
  ensureKbDirs();

  function readExisting<T>(filename: string): T[] {
    const p = path.join(KB_STRUCTURED_DIR, filename);
    if (!fs.existsSync(p)) return [];
    const out: T[] = [];
    for (const line of fs.readFileSync(p, "utf-8").split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try { out.push(JSON.parse(t) as T); } catch { /* skip malformed legacy line */ }
    }
    return out;
  }

  function writeMerged<T>(filename: string, incoming: T[], keyOf: (item: T) => string): void {
    const existing = readExisting<T>(filename);
    const ordered = mergeByKey(existing, incoming, keyOf);
    const content = ordered.map((item) => JSON.stringify(item)).join("\n") + (ordered.length ? "\n" : "");
    fs.writeFileSync(path.join(KB_STRUCTURED_DIR, filename), content, "utf-8");
  }

  const norm = (s: unknown): string =>
    typeof s === "string" ? s.trim().toLowerCase().replace(/\s+/g, " ") : "";

  writeMerged<PromptStrategy>("strategies.jsonl", structured.topStrategies,
    (s) => norm(s.template));
  writeMerged<ExampleRecord>("examples.jsonl", structured.topExamples,
    (e) => norm(e.prompt));
  writeMerged<LoraInsight>("lora-insights.jsonl", structured.loraInsights,
    (l) => norm(l.lora));
  writeMerged<BestParams>("params.jsonl", structured.bestParams,
    (p) => `${norm(p.pipeline)}|${p.steps ?? ""}|${p.cfgScale ?? ""}`);
  writeMerged<{ item: string }>("avoid.jsonl", structured.avoid.map((item) => ({ item })),
    (a) => norm(a.item));
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
