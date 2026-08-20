/**
 * Source watch-list — the registry that makes coverage actionable against
 * silent convergence failure.
 *
 * The 83%-unconverged incident happened because nobody remembered to run ingest
 * with the right inputs. The watch-list lets ONE command (graph_health / zk-query
 * --coverage) check every configured source family without the operator naming
 * them. Resolution order: explicit override > `.pi/kcard-coverage.json` >
 * conventional per-family defaults.
 *
 * This module owns the SourceSpec shape + the loader. The companion helper
 * `resolveSpecsToRecords` (which turns a spec into parsed KnowledgeRecord[] via
 * the REAL ingest adapters) lives here too, so adapter reuse stays in one place
 * and callers (graph_health, the host-fn, the CLI) share a single faithful path.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import {
  parseKnowledgeJsonl,
  adaptAutoMemoryMarkdown,
  adaptHermesMarkdown,
  collectInputFiles,
} from "./adapters.js";
import type {
  SourceFamily,
  KnowledgeRecord,
  CoverageSourceSpec,
} from "./types.js";

export interface SourceSpec {
  family: SourceFamily;
  /** A directory whose files are all this family (recursive). */
  dir?: string;
  /** Explicit file list (mutually exclusive with dir, or combined). */
  files?: string[];
}

/** Conventional per-family default locations (zero-config for standard layouts). */
export const DEFAULT_WATCHLIST: SourceSpec[] = [
  { family: "hermes", dir: join(homedir(), ".pi", "agent", "pi-hermes-memory") },
  { family: "auto-memory", dir: join(homedir(), ".pi", "agent", "memory") },
  { family: "workflow-jsonl", dir: "output" },
];

function expandTilde(p: string): string {
  return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

/**
 * Load the source watch-list.
 *   override (non-empty)  → returned verbatim
 *   .pi/kcard-coverage.json (valid, non-empty sources) → used (dirs tilde-expanded)
 *   otherwise             → DEFAULT_WATCHLIST
 * Never throws — a malformed/empty config falls through to defaults.
 */
export function loadWatchlist(cwd: string, override?: SourceSpec[]): SourceSpec[] {
  if (override && override.length) return override;
  const cfg = join(cwd, ".pi", "kcard-coverage.json");
  if (existsSync(cfg)) {
    try {
      const raw = JSON.parse(readFileSync(cfg, "utf8")) as { sources?: SourceSpec[] };
      if (raw.sources && raw.sources.length) {
        return raw.sources.map((s) => ({
          ...s,
          dir: s.dir ? expandTilde(s.dir) : s.dir,
        }));
      }
    } catch {
      /* fall through to defaults */
    }
  }
  return DEFAULT_WATCHLIST;
}

/**
 * Resolve a watch-list into parsed records per family, via the REAL ingest
 * adapters (faithful — same parse path as zk_ingest). Missing dirs are SKIPPED
 * (not thrown): a family whose conventional dir does not exist on this machine
 * is simply absent from the coverage check, never a hard error. Returns the
 * CoverageSourceSpec[] that coverageReport consumes.
 */
export async function resolveSpecsToRecords(
  specs: SourceSpec[],
  cwd: string,
): Promise<CoverageSourceSpec[]> {
  const out: CoverageSourceSpec[] = [];
  for (const spec of specs) {
    const inputs: string[] = [];
    if (spec.dir) {
      const dirAbs = resolve(cwd, spec.dir);
      if (!existsSync(dirAbs)) continue; // missing dir → skip this family
      inputs.push(dirAbs);
    }
    if (spec.files?.length) inputs.push(...spec.files);
    if (!inputs.length) continue;

    const { files } = collectInputFiles(inputs, { source: spec.family, cwd });
    const records: KnowledgeRecord[] = [];
    for (const f of files) {
      const content = readFileSync(f, "utf8");
      if (spec.family === "workflow-jsonl") {
        const { records: recs } = parseKnowledgeJsonl(content);
        records.push(...recs);
      } else if (spec.family === "auto-memory") {
        const r = adaptAutoMemoryMarkdown(content);
        if (r) records.push(r);
      } else if (spec.family === "hermes") {
        records.push(...adaptHermesMarkdown(content));
      } else {
        // generic: try jsonl first (heuristic — matches collectInputFiles' sweep)
        try {
          const { records: recs } = parseKnowledgeJsonl(content);
          if (recs.length) records.push(...recs);
        } catch {
          /* skip unparseable */
        }
      }
    }
    if (records.length) out.push({ family: spec.family, records });
  }
  return out;
}
