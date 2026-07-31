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
  /** Test seam: defaults to diffTextForReview (hermetic L2-path testing). */
  diffForReview?: typeof diffTextForReview;
  /** Test seam: defaults to runModelReview (hermetic L2-path testing). */
  modelReview?: typeof runModelReview;
}

function summarize(l1: WatchdogResult["l1"], l2: WatchdogResult["l2"]): string {
  const blockers = [...l1.findings, ...l2.findings].filter((f) => f.severity === "blocker").length;
  const concerns = [...l1.findings, ...l2.findings].filter((f) => f.severity === "concern").length;
  const degraded: string[] = [];
  if (!l1.ran && l1.note) degraded.push("L1");
  if (!l2.ran && l2.note) degraded.push("L2");
  const truncated = l2.truncated === true;
  if (blockers === 0 && concerns === 0 && degraded.length === 0 && !truncated) return "watchdog: clean";
  const parts: string[] = [];
  if (blockers || concerns) parts.push(`${blockers} blocker(s), ${concerns} concern(s)`);
  if (degraded.length) parts.push(`${degraded.join("+")} degraded`);
  if (truncated) parts.push("L2 reviewed a truncated diff");
  return `watchdog: ${parts.join("; ")}`;
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
      const dr = (input.diffForReview ?? diffTextForReview)(input.cwd, after.changedPaths);
      const reviewed = await (input.modelReview ?? runModelReview)({
        cwd: input.cwd,
        diffText: dr.text,
        taskLabel: input.taskLabel,
        signal: input.signal,
      });
      l2 = { ...reviewed, ...(dr.truncated ? { truncated: true } : {}) };
    } catch (e) {
      l2 = { ran: false, findings: [], note: `watchdog-error: ${(e as Error).message}` };
    } finally {
      reviewDepth--;
    }
  }
  return { ran: true, editGated: false, l1, l2, summary: summarize(l1, l2), elapsedMs: Date.now() - t0 };
}
