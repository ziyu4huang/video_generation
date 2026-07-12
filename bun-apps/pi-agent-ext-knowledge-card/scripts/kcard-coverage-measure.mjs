#!/usr/bin/env bun
/**
 * kcard-coverage-measure.mjs — performance benchmark + 83% recall repro for
 * the convergence-coverage dimension (kg-improvement-plan P9).
 *
 * Two modes:
 *
 *   --synthetic <N>   PERF BENCHMARK (run anywhere). Generates N cards in a temp
 *                     vault + (N + gap) records in a temp source, measures
 *                     coverageReport wall-clock. Validates the perf gate
 *                     (sub-second at vault scale).
 *
 *   (default)         REAL RECALL REPRO (run from the PRIMARY worktree where the
 *                     vault submodule is initialized). Uses loadWatchlist(cwd) +
 *                     the real vault, dumps missing[] — the 83%-unconverged
 *                     recall gate. Compare missing[] against /memory-health.
 *
 * Usage:
 *   bun scripts/kcard-coverage-measure.mjs --synthetic 500
 *   bun scripts/kcard-coverage-measure.mjs --vault /path/to/vault [--cwd <dir>]
 *
 * Output: output/kcard-coverage-measurements/measure-<ts>.json (gitignored).
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  ingestRecords,
  coverageReport,
} from "../src/ingest.ts";
import { loadWatchlist, resolveSpecsToRecords } from "../src/source-watchlist.ts";

const outDir = resolve(import.meta.dir, "..", "output", "kcard-coverage-measurements");
const ts = new Date().toISOString().replace(/[:.]/g, "-");

function stamp(o) {
  const path = join(outDir, `measure-${ts}.json`);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path, JSON.stringify(o, null, 2));
  console.log(`\nreceipt → ${path}`);
}

function rec(i) {
  return {
    id: `wf:bench-${i}`,
    type: "gotcha",
    title: `Bench ${i}`,
    detail: `Detail line for bench record ${i}.`,
    tags: ["bench", `g-${i % 8}`],
    dimension: "correctness",
    confidence: 0.8,
    status: "active",
    superseded_by: null,
  };
}

// ── synthetic perf benchmark ──────────────────────────────────────────────
async function synthetic(n) {
  const vault = mkdtempSync(join(tmpdir(), "kc-perf-vault-"));
  const srcDir = mkdtempSync(join(tmpdir(), "kc-perf-src-"));
  const gap = Math.max(10, Math.floor(n * 0.1)); // 10% expected-but-missing
  try {
    // Seed vault with N cards (faithful: via the real ingestRecords).
    const seed = Array.from({ length: n }, (_, i) => rec(i));
    await ingestRecords(seed, {
      vaultPath: vault,
      source: "workflow-jsonl",
      sourceLabel: "workflow-jsonl:bench",
      cwd: vault,
    });
    // Source has N + gap records (the gap is the expected-but-missing set).
    writeFileSync(
      join(srcDir, "bench.knowledge.jsonl"),
      Array.from({ length: n + gap }, (_, i) => JSON.stringify(rec(i))).join("\n") + "\n",
    );
    const sources = await resolveSpecsToRecords(
      [{ family: "workflow-jsonl", dir: srcDir }],
      vault,
    );
    // Warm + measure (median of 3).
    const samples = [];
    for (let k = 0; k < 3; k++) {
      const t0 = performance.now();
      const cov = await coverageReport({ vaultPath: vault, sources });
      samples.push(performance.now() - t0);
      if (k === 0) {
        console.log(`synthetic N=${n}: expected ${cov.expected}, vault ${cov.vault}, missing ${cov.missing.length}`);
      }
    }
    samples.sort((a, b) => a - b);
    const median = samples[1];
    const gate = median < 1000 ? "PASS (<1s)" : "FAIL";
    console.log(`wall-clock median (3 runs): ${median.toFixed(1)} ms  [gate: ${gate}]`);
    stamp({ mode: "synthetic", n, gap, wallClockMs: median, samples, gate });
  } finally {
    rmSync(vault, { recursive: true, force: true });
    rmSync(srcDir, { recursive: true, force: true });
  }
}

// ── real recall repro ─────────────────────────────────────────────────────
async function real(vaultPath, cwd) {
  if (!existsSync(vaultPath)) {
    console.error(`vault not found: ${vaultPath} (run from the primary worktree with the submodule initialized)`);
    process.exit(1);
  }
  const specs = loadWatchlist(cwd);
  console.error(`watch-list families: ${specs.map((s) => s.family).join(", ")}`);
  const sources = await resolveSpecsToRecords(specs, cwd);
  if (!sources.length) {
    console.error("no source families resolved — check .pi/kcard-coverage.json or the conventional dirs.");
    process.exit(1);
  }
  const t0 = performance.now();
  const cov = await coverageReport({ vaultPath: vaultPath, sources });
  const wall = performance.now() - t0;
  console.log(`coverage: ${cov.matched}/${cov.expected} converged, ${cov.missing.length} missing, ${cov.sourceOrphaned.length} source-orphaned (${wall.toFixed(1)} ms)`);
  for (const [fam, by] of Object.entries(cov.byFamily)) {
    console.log(`[${fam}] expected ${by.expected}, vault ${by.vault}, matched ${by.matched}, missing ${by.missing.length}`);
    if (by.missing.length) console.log(`  missing (first 20): ${by.missing.slice(0, 20).join(", ")}${by.missing.length > 20 ? ` … (+${by.missing.length - 20})` : ""}`);
  }
  console.log(`\nRECALL GATE: missing[] must include the unconverged entries /memory-health reports.`);
  stamp({ mode: "real", vaultPath, cwd, wallClockMs: wall, coverage: cov });
}

// ── arg parse ─────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
if (args.includes("--synthetic")) {
  const idx = args.indexOf("--synthetic");
  const n = parseInt(args[idx + 1] ?? "500", 10);
  await synthetic(n);
} else {
  const vIdx = args.indexOf("--vault");
  const cIdx = args.indexOf("--cwd");
  const vaultPath = vIdx >= 0 ? args[vIdx + 1] : process.env.OB_VAULT_PATH ?? join(process.cwd(), "vault");
  const cwd = cIdx >= 0 ? args[cIdx + 1] : process.cwd();
  await real(vaultPath, cwd);
}
