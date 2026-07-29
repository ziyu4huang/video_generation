// src/watchdog/watchdog.ts

import { runLspDiagnostics } from "./lsp-diagnostics.js";
import { runModelReview } from "./model-review.js";
import { changedTsJsPaths, computeBaseline, diffTextForReview, type RepoBaseline } from "./repo-diff.js";
import type { WatchdogOptions, WatchdogResult } from "./types.js";

let reviewDepth = 0; // module-level recursion guard (defense-in-depth)

export interface RunWatchdogInput {
  cwd: string;
  before: RepoBaseline;
  opts: WatchdogOptions;
  taskLabel: string;
  signal?: AbortSignal;
  /** Test seam: defaults to computeBaseline(cwd). */
  computeAfter?: () => RepoBaseline | undefined;
  /** Test seam: defaults to runLspDiagnostics. */
  lsp?: typeof runLspDiagnostics;
}

function summarize(l1: WatchdogResult["l1"], l2: WatchdogResult["l2"]): string {
  const blockers = [...l1.findings, ...l2.findings].filter((f) => f.severity === "blocker").length;
  const concerns = [...l1.findings, ...l2.findings].filter((f) => f.severity === "concern").length;
  if (blockers === 0 && concerns === 0) return "watchdog: clean";
  return `watchdog: ${blockers} blocker(s), ${concerns} concern(s)`;
}

export async function runWatchdog(input: RunWatchdogInput): Promise<WatchdogResult> {
  const t0 = Date.now();
  const after = (input.computeAfter ?? computeBaseline)(input.cwd);
  if (!after || after.key === input.before.key) {
    return {
      ran: false,
      editGated: true,
      l1: { ran: false, findings: [] },
      l2: { ran: false, findings: [] },
      summary: "watchdog: no changes (edit-gated)",
      elapsedMs: Date.now() - t0,
    };
  }
  if (reviewDepth > 0) {
    return {
      ran: false,
      editGated: false,
      l1: { ran: false, findings: [] },
      l2: { ran: false, findings: [] },
      summary: "watchdog: skipped (review-in-progress)",
      elapsedMs: Date.now() - t0,
    };
  }
  const tsJs = changedTsJsPaths(input.before, after);
  let l1: WatchdogResult["l1"];
  try {
    l1 = input.opts.l1
      ? await (input.lsp ?? runLspDiagnostics)({ root: after.root, changedPaths: tsJs, signal: input.signal })
      : { ran: false, findings: [] };
  } catch (e) {
    l1 = { ran: false, findings: [], note: `watchdog-error: ${(e as Error).message}` };
  }
  let l2: WatchdogResult["l2"] = { ran: false, findings: [] };
  if (input.opts.l2) {
    reviewDepth++;
    try {
      const diffText = diffTextForReview(input.cwd, tsJs.length ? tsJs : after.changedPaths);
      l2 = await runModelReview({ cwd: input.cwd, diffText, taskLabel: input.taskLabel, signal: input.signal });
    } catch (e) {
      l2 = { ran: false, findings: [], note: `watchdog-error: ${(e as Error).message}` };
    } finally {
      reviewDepth--;
    }
  }
  return { ran: true, editGated: false, l1, l2, summary: summarize(l1, l2), elapsedMs: Date.now() - t0 };
}
