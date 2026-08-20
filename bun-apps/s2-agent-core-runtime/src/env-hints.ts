/**
 * Environment-hints dispatch footer (2026-08-18): recurring host/repo
 * environment facts (macOS has no GNU `timeout`; never `git add -A`; no
 * top-level `cd`; English artifacts) were hand-written into every dispatch
 * prompt by the orchestrator — variance when forgotten costs children turns
 * (empirics: dying children rediscover "no timeout" mid-run). This module
 * formalizes them as an auto-appended footer sourced from a user-owned hints
 * file, mirroring the abort-safety footer's marker style.
 *
 * ON/OFF SWITCH: the hints file's PRESENCE is the switch — no extra env flag.
 * `~/.pi/subagents/hints.md` (override: PI_SUBAGENT_HINTS_FILE) exists with
 * non-blank content → footer appended to every spawned task; absent, unreadable,
 * or blank → no footer (undefined). Read failure is SILENT-undefined: a broken
 * hints file must never break dispatches.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Env override for the hints file location (same per-call read pattern as budget-defaults). */
const HINTS_ENV = "PI_SUBAGENT_HINTS_FILE";

/** Hard cap on hints content: a footer is ambient context, not a second prompt. */
const HINTS_CAP = 2000;

/** Marker mirrors the abort-safety footer style ("appended by the dispatch layer — obey; don't restate"). */
export const ENV_HINTS_MARKER = "--- environment hints (auto-appended by the dispatch layer — obey; don't restate) ---";

/** Resolved hints path: PI_SUBAGENT_HINTS_FILE override, else ~/.pi/subagents/hints.md. */
export function envHintsPath(): string {
  return process.env[HINTS_ENV] ?? join(homedir(), ".pi", "subagents", "hints.md");
}

/**
 * The environment-hints footer block, or undefined when the feature is off.
 *
 * - Missing/unreadable/blank file → undefined (presence = on; silence on failure).
 * - Content is the raw file trimmed; capped at 2000 chars (slice + "\n[hints truncated]").
 * - Block shape mirrors abortSafetyFooter: leading newline + marker + content.
 */
export function envHintsFooter(): string | undefined {
  let raw: string;
  try {
    raw = readFileSync(envHintsPath(), "utf8");
  } catch {
    return undefined;
  }
  const content = raw.trim();
  if (!content) return undefined;
  const capped = content.length > HINTS_CAP ? `${content.slice(0, HINTS_CAP)}\n[hints truncated]` : content;
  return `\n${ENV_HINTS_MARKER}\n${capped}`;
}

/** Append the hints block to a task (undefined → task unchanged). Order: task → env hints → abort-safety. */
export function appendEnvHints(task: string): string {
  const hints = envHintsFooter();
  return hints ? `${task}${hints}` : task;
}
