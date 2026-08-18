/**
 * report-persist.ts — cross-restart persistence for report frames.
 * The session store is in-memory: a pi restart wiped every published report
 * (bitten in practice 2026-08-17). This module mirrors report frames to a
 * per-port JSONL file (~/.pi/webui/reports/reports-<port>.jsonl) and reloads
 * the most recent ones at wiring time, so the Report tab — the durable
 * archive surface — survives restarts.
 *
 * Contract: BEST-EFFORT. Persistence must NEVER break a broadcast — every
 * filesystem error is swallowed. Restore is store-append only (append does
 * not broadcast): no bell, no live push — restored frames surface via the
 * connect-time snapshot like any replayed history.
 * Env override WEBUI_REPORT_DIR (tests, sandboxes).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { WebFrame } from "./protocol.js";

export type ReportFrame = Extract<WebFrame, { type: "report" }>;

/** v1 cap: the newest N report frames reloaded at boot. */
export const REPORT_RESTORE_CAP = 25;

function reportDir(): string {
  const base = process.env["WEBUI_REPORT_DIR"];
  return base && base.trim() !== "" ? base : join(homedir(), ".pi", "webui", "reports");
}

export function reportPersistPath(port: number): string {
  return join(reportDir(), "reports-" + port + ".jsonl");
}

function isReportFrame(v: unknown): v is ReportFrame {
  if (typeof v !== "object" || v === null) return false;
  const f = v as Record<string, unknown>;
  return (
    f["type"] === "report" &&
    typeof f["id"] === "string" &&
    typeof f["title"] === "string" &&
    (typeof f["markdown"] === "string" || typeof f["html"] === "string")
  );
}

/** Best-effort mirror write — one JSON line; failures are silent by contract. */
export function appendReport(path: string, frame: ReportFrame): void {
  try {
    mkdirSync(join(path, ".."), { recursive: true });
    appendFileSync(path, JSON.stringify(frame) + "\n", "utf8");
  } catch {
    /* best-effort by contract */
  }
}

/** Load the newest persisted report frames; corrupt or non-report lines
 * skipped; missing file -> []. Never throws. */
export function loadReports(path: string): ReportFrame[] {
  try {
    if (!existsSync(path)) return [];
    const lines = readFileSync(path, "utf8").split("\n");
    const out: ReportFrame[] = [];
    for (const line of lines) {
      const s = line.trim();
      if (s === "") continue;
      try {
        const v: unknown = JSON.parse(s);
        if (isReportFrame(v)) out.push(v);
      } catch {
        /* corrupt line — skip */
      }
    }
    return out.slice(-REPORT_RESTORE_CAP);
  } catch {
    return [];
  }
}

/** report-cleanup: best-effort compaction — rewrite the mirror WITHOUT the
 * removed ids. Reads the UNCAPPED file (the archive may exceed the restore
 * cap); only the named ids go, order preserved, corrupt lines kept as-is.
 * Failures are silent by the same contract as append. */
export function compactReports(path: string, removeIds: Set<string>): void {
  try {
    if (!existsSync(path) || removeIds.size === 0) return;
    const lines = readFileSync(path, "utf8").split("\n");
    const kept: string[] = [];
    for (const line of lines) {
      const s = line.trim();
      if (s === "") continue;
      try {
        const v: unknown = JSON.parse(s);
        if (typeof v === "object" && v !== null && removeIds.has((v as { id?: unknown }).id as string)) continue;
      } catch {
        /* corrupt line — keep as-is (load skips it anyway) */
      }
      kept.push(s);
    }
    writeFileSync(path, kept.join("\n") + (kept.length > 0 ? "\n" : ""), "utf8");
  } catch {
    /* best-effort by contract */
  }
}

/** report-cleanup: truncate the mirror entirely (clear-all). Best-effort. */
export function clearReportsFile(path: string): void {
  try {
    writeFileSync(path, "", "utf8");
  } catch {
    /* best-effort by contract */
  }
}
