/**
 * decision-log.ts — append-only (category, subject)-keyed record of
 * provider/model choices made mid-session (tool-design audit,
 * output/next-goal-20260712_142905.md, Item 2/P4; OpenMontage-style).
 *
 * Addresses the same root cause as Item 3's cost-estimate/tool-attribution
 * divergence (output/next-goal-20260712_135012.md): a provider substitution
 * at `generate`-time (e.g. tts's edge-tts-over-say opportunistic upgrade,
 * selector.ts's module doc) was previously invisible anywhere beyond the
 * cost log's `tool` field, which only carries the FINAL attribution, not the
 * fact that a substitution happened or why. This log records the decision
 * itself — resolved vs. actually-used, and why they differ — independent of
 * whether cost tracking (projectId) is even in play for the call.
 *
 * Never rewritten, never pruned — pure append. Read via `getDecisionLog`.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { decisionLogPath, projectDir } from "./paths.ts";

export interface DecisionEntry {
  category: string;
  subject: string;
  resolved: string;
  used: string;
  reason?: string;
  recorded_at: string;
}

export interface DecisionLog {
  entries: DecisionEntry[];
}

function load(projectId: string, env?: Record<string, string | undefined>): DecisionLog {
  const p = decisionLogPath(projectId, env);
  if (!existsSync(p)) return { entries: [] };
  try {
    return JSON.parse(readFileSync(p, "utf8")) as DecisionLog;
  } catch {
    return { entries: [] };
  }
}

/**
 * Record a decision only when `resolved !== used` (a real substitution) — a
 * call where the pre-resolved and actually-used choices match is not a
 * "decision" worth logging, it's the default path. No-op otherwise, so
 * callers can call this unconditionally after every generate() without
 * inflating the log on the common case.
 */
export function recordDecision(
  projectId: string,
  category: string,
  subject: string,
  resolved: string,
  used: string,
  reason?: string,
  env?: Record<string, string | undefined>,
): void {
  if (resolved === used) return;
  const log = load(projectId, env);
  log.entries.push({ category, subject, resolved, used, reason, recorded_at: new Date().toISOString() });
  mkdirSync(projectDir(projectId, env), { recursive: true });
  writeFileSync(decisionLogPath(projectId, env), JSON.stringify(log, null, 2));
}

export function getDecisionLog(projectId: string, env?: Record<string, string | undefined>): DecisionLog {
  return load(projectId, env);
}
