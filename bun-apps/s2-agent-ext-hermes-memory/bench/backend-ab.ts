/**
 * bench/backend-ab.ts — SQLite vs SurrealDB backend A/B benchmark for
 * pi-hermes-memory (wayfinder ticket 06 / zk-spawn task).
 *
 * Loop order (per STEP 3): SCALE outer, BACKEND inner —
 *   sqlite@1k → surreal@1k → sqlite@10k → surreal@10k → sqlite@100k → surreal@100k
 *
 * Each backend×scale run is fully isolated (fresh bundle + fresh DB / surreal
 * namespace), bulk-inserts `scale` rows in 500-entry batches, then runs a fixed
 * warm workload (240 search / 30 add / 15 replace / 15 remove) recording
 * per-op latencies. Cold start is measured once per backend.
 *
 * Partial-data safety: the markdown results file is rewritten after EVERY
 * completed row, and each row is printed to stdout as it finishes — so a later
 * abort (timeout / Ctrl-C) still leaves usable partial data on disk.
 *
 * Run:  ( cd bun-apps/s2-agent-ext-hermes-memory && bun run bench/backend-ab.ts )
 *
 * New file only — no existing file modified.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createBackendBundle } from "../src/store/backend-factory.ts";
import type { MemoryConfig } from "../src/types.ts";
import { SurrealBackend } from "../src/store/surreal/surreal-backend.ts";
import { generateCorpus, randomQuery } from "./corpus.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** High-resolution time in nanoseconds (number). */
const ns = (): number => Bun.nanoseconds();

/** Percentile from ASC-sorted latencies (ms), nearest-rank per spec. */
function pct(latenciesMsSortedAsc: number[], p: number): number {
  const n = latenciesMsSortedAsc.length;
  if (n === 0) return NaN;
  const idx = Math.min(n - 1, Math.floor((p / 100) * n));
  return latenciesMsSortedAsc[idx];
}

/** Format a latency/value to 3 decimals. */
const fmt = (x: number): string => (Number.isFinite(x) ? x.toFixed(3) : "—");
/** Format a throughput (entries/s or ops/s): integers when large. */
const thr = (x: number): string =>
  Number.isFinite(x) ? (Math.abs(x) >= 100 ? x.toFixed(0) : x.toFixed(1)) : "—";

interface Row {
  backend: string;
  scale: number;
  insertMs: number;
  insertThr: number; // entries/s
  searchP50: number;
  searchP95: number;
  searchP99: number;
  addP95: number;
  replaceP95: number;
  removeP95: number;
  warmThr: number; // search ops/s = 240 / (sum search ms / 1000)
  coldMs: number;
  error?: string;
}

const SCALES = [1_000, 10_000];
const BACKENDS = ["sqlite", "surrealdb"] as const;
type BackendName = (typeof BACKENDS)[number];

const SURREAL_ENDPOINT = "http://127.0.0.1:8000";

// Stable results path (timestamp fixed at process start).
const stamp = (() => {
  const d = new Date();
  const p = (x: number, w = 2) => String(x).padStart(w, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
})();
const RESULTS_DIR = path.join(import.meta.dir, "results");
const RESULTS_FILE = path.join(RESULTS_DIR, `ab-${stamp}.md`);

const rows: Row[] = [];
const coldStart: Partial<Record<BackendName, number>> = {};

fs.mkdirSync(RESULTS_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Bundle config + cleanup per backend
// ---------------------------------------------------------------------------

function makeConfig(
  backend: BackendName,
  scale: number,
): { cfg: MemoryConfig; memoryDir: string; nsName: string } {
  const nsName = `bench_${process.pid}_${scale}_${Date.now().toString(36)}`;
  if (backend === "sqlite") {
    const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), "hb-sqlite-"));
    const cfg = { dbBackend: "sqlite" } as unknown as MemoryConfig;
    return { cfg, memoryDir, nsName };
  }
  const memoryDir = "/tmp/hb-surreal-unused";
  const cfg = {
    dbBackend: "surrealdb",
    surreal: {
      endpoint: SURREAL_ENDPOINT,
      namespace: nsName,
      database: "bench",
      username: "root",
      password: "root",
    },
  } as unknown as MemoryConfig;
  return { cfg, memoryDir, nsName };
}

async function cleanup(
  backend: BackendName,
  bundle: { backend: { close(): Promise<void> } } | null,
  memoryDir: string,
  nsName: string,
): Promise<void> {
  if (!bundle) return;
  if (backend === "surrealdb") {
    // Remove the isolated namespace before close (surreal close is a no-op,
    // HTTP stateless, so the client is still usable here).
    try {
      await (bundle.backend as unknown as SurrealBackend).client.query(
        `REMOVE NAMESPACE IF EXISTS ${nsName};`,
      );
    } catch {
      /* best-effort; unique ns name means a leftover is harmless */
    }
  }
  try {
    await bundle.backend.close();
  } catch {
    /* ignore */
  }
  if (backend === "sqlite") {
    try {
      fs.rmSync(memoryDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// One backend×scale run
// ---------------------------------------------------------------------------

async function runScale(
  backend: BackendName,
  scale: number,
  coldMs: number,
): Promise<Row> {
  const { cfg, memoryDir, nsName } = makeConfig(backend, scale);
  const row: Row = {
    backend,
    scale,
    insertMs: NaN,
    insertThr: NaN,
    searchP50: NaN,
    searchP95: NaN,
    searchP99: NaN,
    addP95: NaN,
    replaceP95: NaN,
    removeP95: NaN,
    warmThr: NaN,
    coldMs,
  };

  let bundle: Awaited<ReturnType<typeof createBackendBundle>> | null = null;
  try {
    bundle = await createBackendBundle(cfg, memoryDir);
    // Cheat-sheet: call init() before using repos (idempotent — createBackendBundle
    // also inits, this is harmless).
    await bundle.backend.init();

    // --- BULK INSERT (chunk 500) ---
    const corpus = generateCorpus(scale);
    const t0 = ns();
    for (let i = 0; i < corpus.length; i += 1) {
      const chunk = corpus.slice(i, i + 1).map((e) => ({
        content: e.content,
        target: e.target,
      }));
      await bundle.memoryRepo.syncMemoryEntriesBatch(chunk);
    }
    row.insertMs = (ns() - t0) / 1e6;
    row.insertThr = scale / (row.insertMs / 1000);

    // Keep ~60 entry contents as replace/remove targets.
    const sample = corpus.slice(0, 60).map((e) => e.content);

    // --- WARM WORKLOAD (fixed op counts; record per-op ms) ---
    const lat = { search: [] as number[], add: [] as number[], replace: [] as number[], remove: [] as number[] };

    for (let i = 0; i < 240; i++) {
      const t = ns();
      await bundle.memoryRepo.searchMemories(randomQuery(), { limit: 10 });
      lat.search.push((ns() - t) / 1e6);
    }
    for (let i = 0; i < 30; i++) {
      const t = ns();
      await bundle.memoryRepo.addMemory({
        content: `extra note ${backend}-${scale}-${i}: ${randomQuery()}`,
        target: "memory",
      });
      lat.add.push((ns() - t) / 1e6);
    }
    for (let i = 0; i < 15; i++) {
      const old = sample[(i * 2) % sample.length].slice(0, 50);
      const t = ns();
      try {
        await bundle.memoryRepo.replaceSyncedMemories(old, {
          content: old + " [updated]",
          target: "memory",
        });
      } catch {
        /* match ambiguity / no-op — swallow, still record latency */
      }
      lat.replace.push((ns() - t) / 1e6);
    }
    for (let i = 0; i < 15; i++) {
      const old = sample[(i * 2 + 1) % sample.length].slice(0, 50);
      const t = ns();
      try {
        await bundle.memoryRepo.removeSyncedMemories(old, { target: "memory" });
      } catch {
        /* match ambiguity / no-op — swallow, still record latency */
      }
      lat.remove.push((ns() - t) / 1e6);
    }

    lat.search.sort((a, b) => a - b);
    lat.add.sort((a, b) => a - b);
    lat.replace.sort((a, b) => a - b);
    lat.remove.sort((a, b) => a - b);

    row.searchP50 = pct(lat.search, 50);
    row.searchP95 = pct(lat.search, 95);
    row.searchP99 = pct(lat.search, 99);
    row.addP95 = pct(lat.add, 95);
    row.replaceP95 = pct(lat.replace, 95);
    row.removeP95 = pct(lat.remove, 95);
    const searchSumMs = lat.search.reduce((a, b) => a + b, 0);
    row.warmThr = 240 / (searchSumMs / 1000);
  } catch (err) {
    row.error = err instanceof Error ? err.message : String(err);
  } finally {
    await cleanup(backend, bundle, memoryDir, nsName);
  }
  return row;
}

// ---------------------------------------------------------------------------
// Cold start (once per backend)
// ---------------------------------------------------------------------------

async function measureColdStart(backend: BackendName): Promise<number> {
  const { cfg, memoryDir, nsName } = makeConfig(backend, 0);
  let bundle: Awaited<ReturnType<typeof createBackendBundle>> | null = null;
  try {
    const t0 = ns();
    bundle = await createBackendBundle(cfg, memoryDir);
    await bundle.backend.init(); // idempotent; honors cheat-sheet
    await bundle.memoryRepo.searchMemories(randomQuery(), { limit: 10 });
    return (ns() - t0) / 1e6;
  } finally {
    await cleanup(backend, bundle, memoryDir, nsName);
  }
}

// ---------------------------------------------------------------------------
// Markdown emit
// ---------------------------------------------------------------------------

function buildMarkdown(): string {
  const lines: string[] = [];
  lines.push(`# Hermes-Memory Backend A/B Benchmark`);
  lines.push("");
  lines.push(`- Date: ${new Date().toISOString()}`);
  lines.push(`- SurrealDB endpoint: \`${SURREAL_ENDPOINT}\` (root/root)`);
  lines.push(`- Corpus: deterministic (seeded) — same rows per scale for both backends.`);
  lines.push(`- Warm workload: 240 search / 30 add / 15 replace / 15 remove ops.`);
  lines.push("");

  lines.push(`## Results`);
  lines.push("");
  lines.push(
    `| backend | scale | insert_thr (entries/s) | search p50 (ms) | search p95 (ms) | search p99 (ms) | add p95 (ms) | replace p95 (ms) | remove p95 (ms) | warm_thr (search ops/s) | cold_start (ms) |`,
  );
  lines.push(
    `|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|`,
  );
  for (const r of rows) {
    lines.push(
      `| ${r.backend} | ${r.scale.toLocaleString()} | ${r.error ? "—" : thr(r.insertThr)} | ${r.error ? "—" : fmt(r.searchP50)} | ${r.error ? "ERR" : fmt(r.searchP95)} | ${r.error ? "—" : fmt(r.searchP99)} | ${r.error ? "—" : fmt(r.addP95)} | ${r.error ? "—" : fmt(r.replaceP95)} | ${r.error ? "—" : fmt(r.removeP95)} | ${r.error ? "—" : thr(r.warmThr)} | ${fmt(r.coldMs)} |`,
    );
  }
  lines.push("");

  // Errors
  const errored = rows.filter((r) => r.error);
  if (errored.length) {
    lines.push(`## Errors`);
    lines.push("");
    for (const r of errored) {
      lines.push(`- \`${r.backend}@${r.scale.toLocaleString()}\`: ${r.error}`);
    }
    lines.push("");
  }

  // Crossover analysis
  lines.push(`## Crossover analysis`);
  lines.push("");
  lines.push(`Crossover ratio = surreal_search_p95 / sqlite_search_p95 (<1 ⇒ surreal faster).`);
  lines.push("");
  lines.push(`| scale | sqlite_search_p95 (ms) | surreal_search_p95 (ms) | ratio (surreal/sqlite) | surreal faster? |`);
  lines.push(`|---:|---:|---:|---:|---|`);
  let barMetScale: number | null = null;
  let firstFasterScale: number | null = null;
  for (const scale of SCALES) {
    const s = rows.find((r) => r.backend === "sqlite" && r.scale === scale && !r.error);
    const u = rows.find((r) => r.backend === "surrealdb" && r.scale === scale && !r.error);
    if (!s || !u || !Number.isFinite(s.searchP95) || !Number.isFinite(u.searchP95)) {
      lines.push(`| ${scale.toLocaleString()} | ${s ? fmt(s.searchP95) : "pending"} | ${u ? fmt(u.searchP95) : "pending"} | — | (insufficient data) |`);
      continue;
    }
    const ratio = u.searchP95 / s.searchP95;
    const faster = ratio < 1;
    if (faster && firstFasterScale === null) firstFasterScale = scale;
    // Provisional adoption bar: surreal p95-search <= 0.667× sqlite at scale>=10000.
    if (scale >= 10_000 && ratio <= 0.667) barMetScale = scale;
    lines.push(
      `| ${scale.toLocaleString()} | ${fmt(s.searchP95)} | ${fmt(u.searchP95)} | ${fmt(ratio)} | ${faster ? `✅ surreal faster (${fmt(1 / ratio)}×)` : `❌ sqlite faster (${fmt(1 / ratio)}×)`} |`,
    );
  }
  lines.push("");

  // Verdict
  lines.push(`## Verdict`);
  lines.push("");
  if (firstFasterScale !== null) {
    lines.push(`- SurrealDB first beats SQLite on p95 search at scale **${firstFasterScale.toLocaleString()}**.`);
  } else {
    lines.push(`- SurrealDB did NOT beat SQLite on p95 search at any completed scale (in this run).`);
  }
  if (barMetScale !== null) {
    lines.push(
      `- **Provisional adoption bar MET** (surreal p95-search ≤ 0.667× sqlite, i.e. ≥1.5× faster, at scale ≥10k): yes, at **${barMetScale.toLocaleString()}**.`,
    );
  } else {
    lines.push(
      `- **Provisional adoption bar NOT met** at any completed scale ≥10k (surreal p95-search was not ≤0.667× sqlite).`,
    );
  }
  const pending = SCALES.filter(
    (sc) =>
      !rows.find((r) => r.backend === "surrealdb" && r.scale === sc && !r.error) ||
      !rows.find((r) => r.backend === "sqlite" && r.scale === sc && !r.error),
  );
  if (pending.length) {
    lines.push(`- ⚠️ Pending/incomplete scales: ${pending.map((s) => s.toLocaleString()).join(", ")} (see status above).`);
  }
  lines.push("");

  return lines.join("\n");
}

function flushResults(): void {
  const md = buildMarkdown();
  fs.writeFileSync(RESULTS_FILE, md);
}

function printRow(row: Row): void {
  if (row.error) {
    console.log(
      `[done] ${row.backend}@${row.scale.toLocaleString()} — ERROR after ${fmt(row.insertMs)}ms insert: ${row.error}`,
    );
    return;
  }
  console.log(
    `[done] ${row.backend}@${row.scale.toLocaleString()} | insert_thr=${thr(row.insertThr)} e/s (insert ${fmt(row.insertMs)}ms) | ` +
      `search p50/p95/p99=${fmt(row.searchP50)}/${fmt(row.searchP95)}/${fmt(row.searchP99)}ms | ` +
      `add p95=${fmt(row.addP95)} replace p95=${fmt(row.replaceP95)} remove p95=${fmt(row.removeP95)}ms | ` +
      `warm_thr=${thr(row.warmThr)} ops/s | cold=${fmt(row.coldMs)}ms`,
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`=== hermes-memory backend A/B benchmark ===`);
  console.log(`results file: ${RESULTS_FILE}`);
  console.log(`scales: ${SCALES.map((s) => s.toLocaleString()).join(", ")} × backends: ${BACKENDS.join(", ")}`);
  console.log(`(scale-outer / backend-inner order; each row printed as it completes)`);
  console.log("");

  // --- COLD START (once per backend; scale-independent) ---
  for (const backend of BACKENDS) {
    try {
      const cold = await measureColdStart(backend);
      coldStart[backend] = cold;
      console.log(`[cold] ${backend} cold_start=${fmt(cold)}ms`);
    } catch (err) {
      coldStart[backend] = NaN;
      console.log(`[cold] ${backend} FAILED: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log("");

  // --- SCALE-OUTER / BACKEND-INNER loop ---
  for (const scale of SCALES) {
    for (const backend of BACKENDS) {
      const startedAt = Date.now();
      console.log(`[start] ${backend}@${scale.toLocaleString()} …`);
      const row = await runScale(backend, scale, coldStart[backend] ?? NaN);
      rows.push(row);
      printRow(row);
      flushResults(); // rewrite results file after every completed row (partial-data safety)
      console.log(`[elapsed] ${backend}@${scale.toLocaleString()} took ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
      console.log("");
    }
  }

  // Final emit.
  flushResults();
  console.log(`=== FULL RESULTS ===`);
  console.log("");
  console.log(buildMarkdown());
  console.log("");
  console.log(`results written to: ${RESULTS_FILE}`);
}

main().catch((err) => {
  console.error(`FATAL:`, err);
  flushResults();
  process.exit(1);
});
