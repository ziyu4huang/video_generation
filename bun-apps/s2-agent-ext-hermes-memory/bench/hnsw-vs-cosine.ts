/**
 * bench/hnsw-vs-cosine.ts — SurrealDB HNSW vs in-memory brute-force-cosine
 * query-latency benchmark at scale (wayfinder ticket 16 / zk-spawn task).
 *
 * QUESTION (ticket 14 input): does SurrealDB's true HNSW index keep query
 * p95 bounded as the corpus grows to 100k vectors, or does the per-query HTTP
 * RTT floor (no RTT for the in-process cosine fallback) make the brute-force
 * cosine path the de-facto choice? Where is the crossover N?
 *
 * DESIGN (mirrors bench/backend-ab.ts — seeded RNG, isolated namespaces,
 * partial-data-safety = rewrite the results .md after every scale):
 *
 *   Vectors: N synthetic 768-dim unit vectors (Box–Muller Gaussian → L2
 *   normalize), SEEDED so the same N always yields the identical corpus for
 *   BOTH paths. K=200 hold-out query vectors (separate seed, distinct).
 *
 *   (a) SurrealDB HNSW — per scale, isolated ns/db `bench_hnsw_<pid>_<scale>`;
 *       table v{ id, vec }; `DEFINE INDEX vec_hnsw ON v FIELDS vec HNSW
 *       DIMENSION 768 DIST COSINE TYPE F32`. Bulk-insert N vectors in batches
 *       of 500 CREATE statements per single /sql body (prior single-insert
 *       throughput was ~44/s over HTTP). NOTE: SurrealDB's /sql endpoint caps
 *       the request body at exactly 1MiB (1,048,576B — empirically pinned), so
 *       at 768-dim the true max is ~143 CREATEs/body; we use BATCH=120 for a
 *       safe worst-case margin. Build time is graph-bound (HNSW construction),
 *       not RTT-bound, so the smaller batch costs ~negligible wall time.
 *       BUILD wall-ms recorded separately.
 *       Then K=200 KNN queries: `SELECT id FROM v WHERE vec <|10,EF|> $q`
 *       EF=100, via the REAL SurrealClient (HTTP RTT is in the measurement).
 *       Modes: single (sequential awaits) + concurrent (8 / 16 via Promise.all
 *       batches). Per-query wall-ms → p50/p95/p99. REMOVE NAMESPACE at end.
 *
 *   (b) In-memory cosine — load the SAME N vectors; per query run the EXACT
 *       brute-force cosine loop copied from knowledge-card/retrieve.ts:621
 *       (cosine() copied verbatim from semantic.ts:31). Same modes. NOTE: JS
 *       is single-threaded, so "concurrent" cosine loops serialize on the
 *       event loop — exactly how prod runs — and concurrent latency therefore
 *       reflects CPU contention (measured from batch dispatch, see below).
 *
 *   Scales: 1k, 10k, 100k.
 *
 *   Output: after EACH scale, rewrite bench/results/hnsw-vs-cosine-<stamp>.md
 *   and print the row to stdout (partial-data safety). Final stdout dump too.
 *
 * Concurrent-mode latency model: per-query wall-ms = (query_complete −
 * batch_dispatch). For HNSW this is the user-visible latency when N queries
 * arrive together and the server parallelizes them (each ≈ own RTT). For
 * cosine this is the latency when N sync CPU loops arrive together and the JS
 * event loop serializes them (a query that runs k-th in its batch pays ≈ k×
 * one-loop time) — the CPU-contention worst case, which is how prod behaves
 * when retrieve is CPU-bound. This asymmetry IS the finding.
 *
 * 100k build time-box: if the 100k HNSW insert+index build alone exceeds
 * BUILD_DEADLINE_100K ms wall, STOP it, record 1k+10k HNSW firmly, report the
 * cosine 100k numbers, and give an EXTRAPOLATED/NA note for HNSW@100k from the
 * achieved build rate. Never let the whole run die on 100k.
 *
 * Run:  ( cd bun-apps/s2-agent-ext-hermes-memory && bun run bench/hnsw-vs-cosine.ts )
 *
 * New file only — no existing file modified.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { SurrealClient } from "../src/store/surreal/surreal-client.ts";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SURREAL_ENDPOINT = "http://127.0.0.1:8000";
const DIM = 768;
const K_QUERIES = 200; // query vectors
const TOP_K = 10; // KNN k AND cosine top-k (apples-to-apples)
const EF = 100; // HNSW exploration factor (2-arg KNN second parameter)
// /sql body is capped at 1MiB (verified: 144×768-dim CREATEs = 1053728B → HTTP
// 413; 143× = 1046400B → OK). 120 gives a safe worst-case margin (~900KB even if
// every component renders as a 9-char "-0.XXXXXX"), and build time is HNSW-
// graph-bound not RTT-bound, so the smaller batch costs negligible wall time.
const BATCH = 120;
const WARMUP = 8; // priming queries discarded (server cache + JS JIT)
// Empirically pinned /sql body limit; 144×768-dim CREATEs → HTTP 413.
const SQL_BODY_LIMIT_B = 1_048_576;
const CONCURRENCIES = [8, 16] as const;

const SCALES = [1_000, 10_000, 100_000];
const BUILD_DEADLINE_MS: Record<number, number> = {
  // Per-scale build wall-ms cap. 1k is seconds; only 100k realistically binds.
  1_000: 5 * 60_000,
  10_000: 10 * 60_000,
  100_000: 15 * 60_000,
};

// ---------------------------------------------------------------------------
// Helpers (mirror backend-ab.ts / corpus.ts)
// ---------------------------------------------------------------------------

const ns = (): number => Bun.nanoseconds();

/** Nearest-rank percentile from ASC-sorted latencies (ms). Identical to
 *  backend-ab.ts so percentile methodology matches the prior A/B. */
function pct(latenciesMsSortedAsc: number[], p: number): number {
  const n = latenciesMsSortedAsc.length;
  if (n === 0) return NaN;
  const idx = Math.min(n - 1, Math.floor((p / 100) * n));
  return latenciesMsSortedAsc[idx];
}

const fmt = (x: number): string => (Number.isFinite(x) ? x.toFixed(3) : "—");

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const thr = (x: number): string =>
  Number.isFinite(x) ? (Math.abs(x) >= 100 ? x.toFixed(0) : x.toFixed(1)) : "—";

/** mulberry32 PRNG — deterministic, no Math.random leakage (from corpus.ts). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box–Muller standard-normal sample from a uniform RNG. */
function gaussian(rng: () => number): number {
  const u1 = Math.max(rng(), 1e-12);
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

const CORPUS_SEED = 0xc0ffee;
const QUERY_SEED = 0x5eed1e;

/** N synthetic DIM-dim unit vectors (Gaussian → L2-normalize), seeded. */
function genUnitVectors(n: number, seed: number): number[][] {
  const rng = mulberry32(seed);
  const out: number[][] = new Array(n);
  for (let i = 0; i < n; i++) {
    const v = new Array<number>(DIM);
    let norm = 0;
    for (let d = 0; d < DIM; d++) {
      const g = gaussian(rng);
      v[d] = g;
      norm += g * g;
    }
    norm = Math.sqrt(norm) || 1;
    for (let d = 0; d < DIM; d++) v[d] /= norm;
    out[i] = v;
  }
  return out;
}

/** Compact SurrealQL array literal for a vector (6 decimals ≈ f32 precision). */
function vstr(v: number[]): string {
  let s = "[";
  for (let i = 0; i < v.length; i++) {
    if (i) s += ",";
    s += v[i].toFixed(6);
  }
  return s + "]";
}

// ---------------------------------------------------------------------------
// Cosine — VERBATIM copy of knowledge-card/src/semantic.ts:31 cosine()
// (and the retrieve.ts:621 brute-force loop). Not imported, to avoid pulling
// in the vault / LM-Studio coupling; synthetic vectors are fed directly.
// ---------------------------------------------------------------------------

/** Cosine similarity. Vectors need not be pre-normalised. (semantic.ts:31) */
function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let dotA = 0;
  let dotB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    dotA += a[i]! * a[i]!;
    dotB += b[i]! * b[i]!;
  }
  return dot / (Math.sqrt(dotA) * Math.sqrt(dotB));
}

/** EXACT retrieve.ts:621 brute-force: map every vec → cosine, sort desc, top-k. */
function bruteTopK(qv: number[], vectors: number[][], k: number): void {
  const scored = vectors
    .map((vec, i) => ({ i, cos: cosine(qv, vec) }))
    .sort((a, b) => b.cos - a.cos);
  scored.slice(0, k); // compute to completion (result discarded; latency only)
}

// ---------------------------------------------------------------------------
// SurrealDB admin (ns/db create + cleanup) — raw fetch, root-level ops
// ---------------------------------------------------------------------------

async function adminSql(sql: string, nsName?: string, dbName?: string): Promise<unknown> {
  const headers: Record<string, string> = {
    "Content-Type": "text/plain",
    Accept: "application/json",
    Authorization: "Basic " + btoa("root:root"),
  };
  if (nsName) headers["surreal-ns"] = nsName;
  if (dbName) headers["surreal-db"] = dbName;
  const res = await fetch(`${SURREAL_ENDPOINT}/sql`, {
    method: "POST",
    headers,
    body: sql,
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`adminSql HTTP ${res.status}: ${text}`);
  }
  return res.json();
}

function benchNs(scale: number): string {
  return `bench_hnsw_${process.pid}_${scale}`;
}
const BENCH_DB = "bench";

// ---------------------------------------------------------------------------
// (a) SurrealDB HNSW path
// ---------------------------------------------------------------------------

interface BuildResult {
  buildMs: number;
  inserted: number;
  capped: boolean; // true ⇒ hit the wall deadline before inserting all N
  rateVecPerS: number;
}

/** Build the HNSW index: DDL + bulk insert in BATCH-sized /sql bodies. Timed.
 *  Returns build wall-ms and whether it was capped by the deadline. */
async function buildHnsw(
  buildClient: SurrealClient,
  vectors: number[][],
  scale: number,
  deadlineMs: number | undefined,
): Promise<BuildResult> {
  // DDL (index-only; no FIELD type needed — verified by smoke test on v3.2.3).
  await buildClient.query(
    `REMOVE TABLE IF EXISTS v; DEFINE INDEX vec_hnsw ON v FIELDS vec HNSW DIMENSION ${DIM} DIST COSINE TYPE F32;`,
  );

  const t0 = ns();
  let inserted = 0;
  let capped = false;
  for (let i = 0; i < vectors.length; i += BATCH) {
    const chunk = vectors.slice(i, i + BATCH);
    const stmts: string[] = new Array(chunk.length);
    for (let j = 0; j < chunk.length; j++) {
      stmts[j] = `CREATE v SET vec = ${vstr(chunk[j]!)};`;
    }
    await buildClient.query(stmts.join("\n"));
    inserted += chunk.length;
    if (inserted % (BATCH * 10) === 0 || inserted === vectors.length) {
      const elapsedMs = (ns() - t0) / 1e6;
      console.log(
        `    [build] ${scale.toLocaleString()}: inserted ${inserted.toLocaleString()}/${vectors.length.toLocaleString()} in ${(elapsedMs / 1000).toFixed(1)}s (${thr(inserted / (elapsedMs / 1000))} v/s)`,
      );
    }
    if (deadlineMs && (ns() - t0) / 1e6 > deadlineMs) {
      capped = true;
      console.log(
        `    [build] ${scale.toLocaleString()}: DEADLINE ${deadlineMs / 1000}s hit at ${inserted.toLocaleString()}/${vectors.length.toLocaleString()} — capping.`,
      );
      break;
    }
  }
  const buildMs = (ns() - t0) / 1e6;
  return { buildMs, inserted, capped, rateVecPerS: inserted / (buildMs / 1000) };
}

/** KNN query SQL: 2-arg form, k=10, EF. Param $q bound by SurrealClient. */
const KNN_SQL = `SELECT id FROM v WHERE vec <|${TOP_K},${EF}|> $q;`;

async function queryHnswSingle(queryClient: SurrealClient, queries: number[][]): Promise<number[]> {
  const lat: number[] = [];
  for (let i = 0; i < queries.length; i++) {
    const t = ns();
    await queryClient.query(KNN_SQL, { q: queries[i] });
    lat.push((ns() - t) / 1e6);
  }
  return lat;
}

async function queryHnswConcurrent(
  queryClient: SurrealClient,
  queries: number[][],
  concurrency: number,
): Promise<number[]> {
  const lat: number[] = [];
  for (let i = 0; i < queries.length; i += concurrency) {
    const batch = queries.slice(i, i + concurrency);
    const batchStart = ns();
    const durs = await Promise.all(
      batch.map(async (q) => {
        await queryClient.query(KNN_SQL, { q });
        return (ns() - batchStart) / 1e6;
      }),
    );
    lat.push(...durs);
  }
  return lat;
}

// ---------------------------------------------------------------------------
// (b) In-memory cosine path
// ---------------------------------------------------------------------------

function queryCosineSingle(vectors: number[][], queries: number[][]): number[] {
  const lat: number[] = [];
  for (let i = 0; i < queries.length; i++) {
    const t = ns();
    bruteTopK(queries[i], vectors, TOP_K);
    lat.push((ns() - t) / 1e6);
  }
  return lat;
}

async function queryCosineConcurrent(
  vectors: number[][],
  queries: number[][],
  concurrency: number,
): Promise<number[]> {
  const lat: number[] = [];
  for (let i = 0; i < queries.length; i += concurrency) {
    const batch = queries.slice(i, i + concurrency);
    const batchStart = ns();
    const durs = await Promise.all(
      batch.map((q) => {
        bruteTopK(q, vectors, TOP_K); // synchronous — serializes on the event loop
        return (ns() - batchStart) / 1e6;
      }),
    );
    lat.push(...durs);
  }
  return lat;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

type Mode = "single" | "c8" | "c16";
type Path = "hnsw" | "cosine";

interface Row {
  scale: number;
  path: Path;
  mode: Mode;
  buildMs: number; // only set on the (hnsw, single) row per scale; NaN otherwise
  p50: number;
  p95: number;
  p99: number;
  notes: string;
}

const stamp = (() => {
  const d = new Date();
  const p = (x: number, w = 2) => String(x).padStart(w, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
})();
const RESULTS_DIR = path.join(import.meta.dir, "results");
const RESULTS_FILE = path.join(RESULTS_DIR, `hnsw-vs-cosine-${stamp}.md`);

const rows: Row[] = [];
// Per-scale HNSW build metadata (for the crossover/verdict section).
const buildMeta: Record<number, BuildResult & { scale: number }> = {};

fs.mkdirSync(RESULTS_DIR, { recursive: true });

function recordRow(
  scale: number,
  path: Path,
  mode: Mode,
  lat: number[],
  buildMs = NaN,
  notes = "",
): void {
  lat.sort((a, b) => a - b);
  rows.push({
    scale,
    path,
    mode,
    buildMs,
    p50: pct(lat, 50),
    p95: pct(lat, 95),
    p99: pct(lat, 99),
    notes,
  });
  flushResults();
  printLastRow();
}

function printLastRow(): void {
  const r = rows[rows.length - 1]!;
  const bm = Number.isFinite(r.buildMs) ? `build=${fmt(r.buildMs)}ms` : "";
  console.log(
    `  [done] ${r.path}@${r.scale.toLocaleString()}/${r.mode} | ${bm} p50/p95/p99=${fmt(r.p50)}/${fmt(r.p95)}/${fmt(r.p99)}ms` +
      (r.notes ? ` | ${r.notes}` : ""),
  );
}

function buildMarkdown(): string {
  const L: string[] = [];
  L.push(`# HNSW vs In-Memory Cosine — Query-Latency Benchmark`);
  L.push(``);
  L.push(`- Ticket 16 (zk-spawn) / input to ticket 14 (full-HNSW vs lazy-backfill decision).`);
  L.push(`- Date: ${new Date().toISOString()}`);
  L.push(`- SurrealDB: \`${SURREAL_ENDPOINT}\` v3.2.3 (root/root), HNSW index COSINE/F32 DIM ${DIM}.`);
  L.push(`- Vectors: synthetic ${DIM}-dim unit (Gaussian → L2-normalize), seeded. K=${K_QUERIES} queries, TOP_K=${TOP_K}, EF=${EF}.`);
  L.push(`- Client: the REAL \`SurrealClient\` (HTTP POST /sql, 10s timeout, 3 retries) — RTT is in the measurement.`);
  L.push(`- Build: bulk insert in ${BATCH}-CREATE batches (SurrealDB /sql body capped at 1MiB ⇒ max ~143 768-dim CREATEs/body; 500/batch impossible); wall-ms recorded separately from query latency.`);
  L.push(`- Concurrent latency = per-query wall-ms from **batch dispatch** (see file header): HNSW parallelizes server-side; cosine serializes on the JS event loop.`);
L.push(`- HNSW queries are measured at WARM steady-state: a cold-start probe (first query post-build) is recorded in notes, then a 3s settle + scale-dependent warmup (8/10/100 queries for 1k/10k/100k) precede measurement — the fair comparison to the always-warm in-process cosine.`);
  L.push(``);

  L.push(`## Results`);
  L.push(``);
  L.push(`| scale | path | mode | build-ms | p50 (ms) | p95 (ms) | p99 (ms) | notes |`);
  L.push(`|---:|---|---|---:|---:|---:|---:|---|`);
  for (const r of rows) {
    L.push(
      `| ${r.scale.toLocaleString()} | ${r.path} | ${r.mode} | ${Number.isFinite(r.buildMs) ? fmt(r.buildMs) : "—"} | ${fmt(r.p50)} | ${fmt(r.p95)} | ${fmt(r.p99)} | ${r.notes} |`,
    );
  }
  L.push(``);

  // --- Crossover (single-mode p95, the cleanest per-query latency) ---
  L.push(`## Crossover analysis (single-mode p95)`);
  L.push(``);
  L.push(`ratio = cosine_p95 / hnsw_p95 (>1 ⇒ HNSW faster at that scale).`);
  L.push(``);
  L.push(`| scale | hnsw_p95 (ms) | cosine_p95 (ms) | ratio | faster |`);
  L.push(`|---:|---:|---:|---:|---|`);
  let crossoverN: number | null = null;
  for (const scale of SCALES) {
    const h = rows.find((r) => r.scale === scale && r.path === "hnsw" && r.mode === "single");
    const c = rows.find((r) => r.scale === scale && r.path === "cosine" && r.mode === "single");
    if (!h || !c || !Number.isFinite(h.p95) || !Number.isFinite(c.p95)) {
      L.push(`| ${scale.toLocaleString()} | ${h ? fmt(h.p95) : "pending"} | ${c ? fmt(c.p95) : "pending"} | — | (insufficient data) |`);
      continue;
    }
    const ratio = c.p95 / h.p95;
    const hnswFaster = ratio > 1;
    if (hnswFaster && crossoverN === null) crossoverN = scale;
    L.push(
      `| ${scale.toLocaleString()} | ${fmt(h.p95)} | ${fmt(c.p95)} | ${fmt(ratio)} | ${hnswFaster ? `✅ HNSW (${fmt(ratio)}×)` : `❌ cosine (${fmt(1 / ratio)}×)`} |`,
    );
  }
  L.push(``);
  if (crossoverN !== null) {
    L.push(`- **Crossover:** HNSW becomes faster than in-memory cosine at **${crossoverN.toLocaleString()}** vectors (single-mode p95).`);
  } else {
    L.push(`- **Crossover:** HNSW did NOT become faster at any completed scale — in-memory cosine wins throughout.`);
  }
  // Concurrent crossover note (c16 single-vs-hnsw at largest completed HNSW scale).
  const largestHnsw = SCALES.filter((s) => rows.some((r) => r.scale === s && r.path === "hnsw" && r.mode === "c16" && Number.isFinite(r.p95)));
  if (largestHnsw.length) {
    const s = largestHnsw[largestHnsw.length - 1]!;
    const h16 = rows.find((r) => r.scale === s && r.path === "hnsw" && r.mode === "c16")!;
    const c16 = rows.find((r) => r.scale === s && r.path === "cosine" && r.mode === "c16");
    if (c16 && Number.isFinite(c16.p95)) {
      L.push(`- At **${s.toLocaleString()} / 16-concurrent**: HNSW p95=${fmt(h16.p95)}ms vs cosine p95=${fmt(c16.p95)}ms — HNSW **${fmt(c16.p95 / h16.p95)}×** faster (server parallelism vs JS serialization).`);
    }
  }
  L.push(``);

  // --- Build cost
  L.push(`## Build cost (HNSW)`);
  L.push(``);
  for (const scale of SCALES) {
    const m = buildMeta[scale];
    if (!m) continue;
    const msPerVec = m.inserted ? m.buildMs / m.inserted : NaN;
    L.push(
      `- **${scale.toLocaleString()}**: inserted ${m.inserted.toLocaleString()} in ${fmt(m.buildMs)}ms (${thr(m.rateVecPerS)} v/s, ${fmt(msPerVec)} ms/vec)${m.capped ? ` — **CAPPED** at deadline; full-${scale.toLocaleString()} not built` : ``}.`,
    );
  }
  L.push(``);

  // --- Verdict
  L.push(`## Verdict`);
  L.push(``);
  const verdict = computeVerdict(crossoverN);
  L.push(...verdict.lines);
  L.push(``);

  return L.join("\n");
}

function computeVerdict(crossoverN: number | null): { tag: string; lines: string[] } {
  const lines: string[] = [];
  const h100k = rows.find((r) => r.scale === 100_000 && r.path === "hnsw" && r.mode === "single");
  const c100k = rows.find((r) => r.scale === 100_000 && r.path === "cosine" && r.mode === "single");
  const m100k = buildMeta[100_000];
  const capped100k = m100k?.capped;
  const h1k = rows.find((r) => r.scale === 1_000 && r.path === "hnsw" && r.mode === "single");

  let tag: string;
  let ticket14: string;

  const hnswFasterAt100k = !!h100k && !!c100k && Number.isFinite(h100k.p95) && Number.isFinite(c100k.p95) && h100k.p95 < c100k.p95;
  const hnswNeverFaster = crossoverN === null;

  if (capped100k || hnswNeverFaster) {
    tag = "degrades → fallback de-facto";
    ticket14 =
      capped100k
        ? `100k HNSW build could not complete in the time-box (build rate ${thr(m100k!.rateVecPerS)} v/s ⇒ projected ${fmt((m100k!.buildMs / m100k!.inserted) * 100_000 / 1000)}s for a full 100k). Build cost alone makes a full eager HNSW impractical → **descope ticket 14 to lazy-backfill + JSON-cache**, revisit HNSW only if query volume justifies it.`
        : `In-memory cosine beat HNSW at every completed scale (no crossover) — the HTTP RTT floor dominates HNSW at this corpus size, so the no-RTT in-process cosine is the de-facto path. **Ticket 14: keep the cosine fallback as primary; do not invest in full HNSW.**`;
  } else if (hnswFasterAt100k) {
    tag = "HNSW holds at scale";
    const holdRatio = h100k!.p95 / (h1k?.p95 || h100k!.p95);
    ticket14 = `HNSW p95 stays bounded from 1k→100k (${fmt(h1k?.p95 ?? NaN)}ms → ${fmt(h100k!.p95)}ms, ${fmt(holdRatio)}×) while cosine p95 climbs past it at ${crossoverN?.toLocaleString()}. Under concurrency the gap widens (server parallelism vs JS serialization). **Ticket 14: build the full HNSW** — it is the scalable path; cosine remains the warm cache / fallback.`;
  } else {
    tag = "mixed (specify)";
    ticket14 = `Results are mixed across scales (crossover at ${crossoverN?.toLocaleString() ?? "n/a"} but HNSW not decisively ahead at 100k). **Ticket 14: decide via follow-up grilling** — weigh eager-build cost (${m100k ? `${fmt(m100k.buildMs / 1000)}s for 100k` : "?"}) vs the latency headroom before committing to full HNSW or lazy-backfill+JSON-cache.`;
  }

  lines.push(`**Conclusion: ${tag}**`);
  lines.push(``);
  const parts: string[] = [];
  if (h1k && Number.isFinite(h1k.p95)) parts.push(`HNSW single p95 @1k = ${fmt(h1k.p95)}ms`);
  if (h100k && Number.isFinite(h100k.p95)) parts.push(`@100k = ${fmt(h100k.p95)}ms`);
  if (c1kSingle()) parts.push(`; cosine single p95 @1k = ${fmt(c1kSingle()!.p95)}ms`);
  if (c100k && Number.isFinite(c100k.p95)) parts.push(`@100k = ${fmt(c100k.p95)}ms`);
  lines.push(parts.join(" ") + ".");
  if (crossoverN !== null) {
    lines.push(`Crossover (HNSW overtakes cosine on single p95) at **${crossoverN.toLocaleString()}** vectors.`);
  } else {
    lines.push(`No crossover within completed scales — cosine wins on single p95 throughout.`);
  }
  lines.push(``);
  lines.push(`**Implication for ticket 14:** ${ticket14}`);
  return { tag, lines };
}

function c1kSingle(): Row | undefined {
  return rows.find((r) => r.scale === 1_000 && r.path === "cosine" && r.mode === "single");
}

function flushResults(): void {
  fs.writeFileSync(RESULTS_FILE, buildMarkdown());
}

// ---------------------------------------------------------------------------
// One scale
// ---------------------------------------------------------------------------

async function runScale(scale: number, queries: number[][]): Promise<void> {
  console.log(`\n=== scale ${scale.toLocaleString()} ===`);
  const nsName = benchNs(scale);

  // Shared corpus (same vectors for BOTH paths — fair A/B).
  const vectors = genUnitVectors(scale, CORPUS_SEED);

  // --- (a) SurrealDB HNSW ---
  try {
    await adminSql(
      `DEFINE NAMESPACE IF NOT EXISTS ${nsName}; USE NS ${nsName}; DEFINE DATABASE IF NOT EXISTS ${BENCH_DB};`,
      nsName,
      BENCH_DB,
    );
    const buildClient = new SurrealClient({
      endpoint: SURREAL_ENDPOINT,
      namespace: nsName,
      database: BENCH_DB,
      username: "root",
      password: "root",
      requestTimeoutMs: 120_000, // build batches may be slow; allow 120s/req
    });
    const queryClient = new SurrealClient({
      endpoint: SURREAL_ENDPOINT,
      namespace: nsName,
      database: BENCH_DB,
      username: "root",
      password: "root",
      // default 10s timeout = production-realistic for the measured query path
    });

    const deadline = BUILD_DEADLINE_MS[scale];
    const build = await buildHnsw(buildClient, vectors, scale, deadline);
    buildMeta[scale] = { ...build, scale };

    if (build.capped) {
      // Index incomplete → no valid latency measurement. Record extrapolation.
      const projectedFullMs = (build.buildMs / build.inserted) * scale;
      rows.push({
        scale,
        path: "hnsw",
        mode: "single",
        buildMs: NaN,
        p50: NaN,
        p95: NaN,
        p99: NaN,
        notes: `BUILD CAPPED @ ${build.inserted.toLocaleString()}; projected full build ${fmt(projectedFullMs / 1000)}s — queries skipped (index incomplete)`,
      });
      flushResults();
      printLastRow();
    } else {
      // Cold-start probe: the VERY FIRST query right after build, before any
      // warmup/settle. Captures the rebuild→first-query UX (post-write RocksDB
      // compaction + cold HNSW graph faulting). Operationally important for
      // ticket 14 (a freshly built index's first query can stall for seconds).
      let coldFirstMs = NaN;
      try {
        const tc = ns();
        await queryClient.query(KNN_SQL, { q: queries[0] });
        coldFirstMs = (ns() - tc) / 1e6;
      } catch {
        coldFirstMs = NaN;
      }
      console.log(`    [cold-first] ${scale.toLocaleString()}: ${fmt(coldFirstMs)}ms`);

      // Settle: let post-write compaction/flush quiesce before steady-state measure.
      await sleep(3000);

      // Scale-dependent warmup (discarded) — primes the HNSW graph + page cache
      // so the measured p50/p95/p99 reflect WARM steady-state (the fair
      // comparison to the always-warm in-process cosine), not cold faulting.
      const warmupN = Math.min(120, Math.max(8, Math.round(scale / 1000)));
      console.log(`    [warmup] ${scale.toLocaleString()}: ${warmupN} queries (+3s settle)`);
      for (let i = 0; i < warmupN; i++) {
        try {
          await queryClient.query(KNN_SQL, { q: queries[i % queries.length] });
        } catch {
          /* swallow — warmup only */
        }
      }

      const latSingle = await queryHnswSingle(queryClient, queries);
      const warmNote =
        `cold-first=${fmt(coldFirstMs)}ms; warmup=${warmupN}q (+3s settle)` +
        (coldFirstMs > 1000 ? ` — ⚠️ cold-start stall` : "");
      recordRow(scale, "hnsw", "single", latSingle, build.buildMs, warmNote);
      const latC8 = await queryHnswConcurrent(queryClient, queries, CONCURRENCIES[0]!);
      recordRow(scale, "hnsw", "c8", latC8);
      const latC16 = await queryHnswConcurrent(queryClient, queries, CONCURRENCIES[1]!);
      recordRow(scale, "hnsw", "c16", latC16);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  [HNSW @ ${scale.toLocaleString()} FAILED: ${msg}]`);
    rows.push({
      scale,
      path: "hnsw",
      mode: "single",
      buildMs: NaN,
      p50: NaN,
      p95: NaN,
      p99: NaN,
      notes: `ERROR: ${msg}`,
    });
    flushResults();
  } finally {
    // Always try to remove the isolated namespace (no live-DB pollution).
    try {
      await adminSql(`REMOVE NAMESPACE IF EXISTS ${nsName};`, nsName, BENCH_DB);
      console.log(`  [cleanup] removed namespace ${nsName}`);
    } catch (e) {
      console.log(`  [cleanup] FAILED to remove ${nsName}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // --- (b) In-memory cosine (always run, even if HNSW was capped) ---
  try {
    // JIT warmup (discarded).
    for (let i = 0; i < WARMUP; i++) bruteTopK(queries[i % queries.length], vectors, TOP_K);
    const latSingle = queryCosineSingle(vectors, queries);
    recordRow(scale, "cosine", "single", latSingle, NaN);
    const latC8 = await queryCosineConcurrent(vectors, queries, CONCURRENCIES[0]!);
    recordRow(scale, "cosine", "c8", latC8);
    const latC16 = await queryCosineConcurrent(vectors, queries, CONCURRENCIES[1]!);
    recordRow(scale, "cosine", "c16", latC16);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  [cosine @ ${scale.toLocaleString()} FAILED: ${msg}]`);
    rows.push({
      scale,
      path: "cosine",
      mode: "single",
      buildMs: NaN,
      p50: NaN,
      p95: NaN,
      p99: NaN,
      notes: `ERROR: ${msg}`,
    });
    flushResults();
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`=== HNSW vs in-memory cosine — query-latency benchmark (ticket 16) ===`);
  console.log(`results file: ${RESULTS_FILE}`);
  console.log(`scales: ${SCALES.map((s) => s.toLocaleString()).join(", ")} | K=${K_QUERIES} queries | DIM=${DIM} | TOP_K=${TOP_K} | EF=${EF} | BATCH=${BATCH}`);
  console.log(`concurrency: ${CONCURRENCIES.join(", ")} | build deadlines(ms): ${SCALES.map((s) => `${s.toLocaleString()}=${BUILD_DEADLINE_MS[s]}`).join(", ")}`);
  console.log(``);

  const queries = genUnitVectors(K_QUERIES, QUERY_SEED);
  console.log(`generated ${K_QUERIES} query vectors (seed 0x${QUERY_SEED.toString(16)}).`);

  for (const scale of SCALES) {
    await runScale(scale, queries);
  }

  flushResults();
  console.log(`\n=== FULL RESULTS ===\n`);
  console.log(buildMarkdown());

  // Verify no live-DB pollution: list any leftover bench_hnsw_* namespaces.
  console.log(`\n=== namespace-pollution check ===`);
  try {
    const j = (await adminSql(`INFO FOR ROOT;`)) as Array<{
      result?: { namespaces?: Record<string, unknown> };
      status: string;
    }>;
    const rootInfo = j.find((s) => s.status === "OK" && s.result?.namespaces)?.result;
    const nsList = rootInfo ? Object.keys(rootInfo.namespaces!) : [];
    const leftover = nsList.filter((n) => n.startsWith("bench_hnsw_"));
    if (leftover.length === 0) {
      console.log(`OK — no bench_hnsw_* namespaces remain (clean). All ${nsList.length} root namespaces: ${nsList.join(", ") || "(none)"}`);
    } else {
      console.log(`WARN — leftover namespaces: ${leftover.join(", ")}`);
    }
  } catch (e) {
    console.log(`(could not run INFO FOR ROOT: ${e instanceof Error ? e.message : String(e)})`);
  }

  console.log(`\nresults written to: ${RESULTS_FILE}`);
}

main().catch((err) => {
  console.error(`FATAL:`, err);
  flushResults();
  process.exit(1);
});
