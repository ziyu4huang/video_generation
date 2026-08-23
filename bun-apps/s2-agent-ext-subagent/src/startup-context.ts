/**
 * Startup-context block (cc-parity-2 ticket 04, map D5).
 *
 * Claude Code's spawned children start with a startup-context block: repo
 * context files + a git-status snapshot + the sibling-agent roster. Our
 * children ALREADY inherit the CLAUDE.md/AGENTS.md hierarchy through pi's
 * `DefaultResourceLoader` (measured — see `tests/startup-context.test.ts`'s
 * faux-transport spawn, which pins that claim before anything builds on it).
 * This module composes the two MISSING pieces as a task-prompt PREFIX block:
 *
 *   [fork transcript (02)] → [agentDef.prompt] → instructions
 *   task: [startup-context] → params.task → [env-hints] → [abort-safety]
 *
 * i.e. the block prefixes the SPAWNED task (persisted task stays raw, same
 * discipline as the abort-safety footer at subagent-tool-run.ts), sits BEFORE
 * env-hints and the abort-safety footer (which keeps the last word), and is a
 * SNAPSHOT — spawn-time state that may be stale by the time the child reads
 * it, which the header says out loud.
 *
 * Batch children share ONE git snapshot (computed once per
 * `list_subagents` call — a 10-task batch pays one pair of git subprocesses,
 * not ten) and get a tighter cap (map D5).
 */

import type { LiveAgentRegistry, RunView, SubagentInFlightRegistry } from "@repo/s2-agent-core-runtime";
import { isTerminalStatus } from "@repo/s2-agent-core-runtime";
import type { GitSnapshot } from "./git-scope.js";

/** Header of the injected block — "snapshot" is load-bearing: the child must re-check, not trust. */
export const STARTUP_CONTEXT_HEADER = "## Startup context (spawn-time snapshot — may be stale; re-check before acting)";

/** Default char cap of the singular-tool block (full mode). */
export const DEFAULT_STARTUP_CAP_CHARS = 2000;

/** Batch children get a tighter cap — they are read-only researchers, and the
 *  block is shared verbatim across N tasks (map D5's prompt-size risk). */
export const DEFAULT_BATCH_STARTUP_CAP_CHARS = 1000;

/** Sibling roster rows are capped first (a 50-run day-session must not eat the block). */
export const MAX_ROSTER_ROWS = 12;

/** How much startup context a child receives (spawn_subagent / list_subagents `context` param). */
export type StartupContextMode = "full" | "minimal" | "none";

/** One sibling row: a named live agent or a running one-shot child. */
export interface RosterRow {
  /** Handle the parent addresses (live-agent name, or the run's toolCallId). */
  name: string;
  /** "running" | "idle" for live agents; the ActivityStatus for one-shots. */
  status: string;
  /** One-line role: agentType binding for live agents, work intent for one-shots. */
  role: string;
}

/**
 * Build the sibling roster from the two process-side registries: named live
 * agents first (they are addressable — the row tells the child who its
 * siblings ARE), then non-terminal one-shot runs (what else is in flight).
 * Capped at {@link MAX_ROSTER_ROWS}. Pure — both registries are read, never
 * mutated. Either argument may be undefined (tests / hosts without them).
 */
export function buildSiblingRoster(live?: LiveAgentRegistry, inFlight?: SubagentInFlightRegistry): RosterRow[] {
  const rows: RosterRow[] = [];
  if (live) {
    for (const name of live.names()) {
      const e = live.get(name);
      if (!e) continue;
      rows.push({
        name: e.name,
        status: e.agent.status,
        role: e.agentType ? `agentType ${e.agentType}` : "named agent",
      });
      if (rows.length >= MAX_ROSTER_ROWS) return rows;
    }
  }
  if (inFlight) {
    for (const v of inFlight.views()) {
      if (isTerminalStatus(v.status)) continue;
      rows.push({
        name: v.id,
        status: v.status,
        role: oneShotRole(v),
      });
      if (rows.length >= MAX_ROSTER_ROWS) return rows;
    }
  }
  return rows;
}

/** One-line role for an in-flight one-shot: its work intent if known, else the task preview. */
function oneShotRole(v: RunView): string {
  const role = v.workIntent ?? v.taskPreview ?? "one-shot subagent";
  return `one-shot: ${role}`;
}

/** Render the porcelain status under a hard line budget. */
function renderStatusLines(lines: readonly string[], maxLines: number): string {
  const shown = lines.slice(0, maxLines);
  const rest = lines.length - shown.length;
  return rest > 0
    ? `${shown.join("\n")}\n[... ${rest} more entr${rest === 1 ? "y" : "ies"} truncated ...]`
    : shown.join("\n");
}

/**
 * Render the startup-context block. Pure — git snapshot and roster are passed
 * in pre-captured (injectable ops in the callers). Returns undefined when
 * there is nothing to say (no git section AND no roster): an empty block is
 * noise, and omitting it entirely keeps the persisted-vs-spawned task delta
 * zero for non-repo dispatches (the common unit-test cwd).
 *
 * Modes (map D5 / ticket 04):
 * - "none"    → no block, ever.
 * - "minimal" → branch + head line only — no porcelain body, no roster. The
 *               batch default: read-only children need to know WHERE they
 *               stand, not the full dirty-tree inventory.
 * - "full"    → branch + head + porcelain (capped) + sibling roster. The
 *               singular default.
 *
 * The cap is a hard bound on the whole block; budget is spent in this order:
 * branch/head (never dropped), roster rows (dropped last-added first), then
 * porcelain lines (the truncation marker names what was dropped).
 */
export function buildStartupContextBlock(opts: {
  /** The child's spawn cwd (rendered so the child knows what the snapshot is OF). */
  spawnCwd: string;
  gitStatus?: GitSnapshot;
  roster?: RosterRow[];
  mode: StartupContextMode;
  capChars?: number;
}): string | undefined {
  const { spawnCwd, gitStatus, mode } = opts;
  if (mode === "none") return undefined;
  const cap = opts.capChars ?? DEFAULT_STARTUP_CAP_CHARS;

  const gitSection: string[] = [];
  if (gitStatus && (gitStatus.branch || gitStatus.head || gitStatus.statusLines.length > 0)) {
    gitSection.push("### Git (snapshot at spawn)");
    if (gitStatus.branch) gitSection.push(gitStatus.branch);
    if (gitStatus.head) gitSection.push(`HEAD: ${gitStatus.head}`);
    if (mode === "full" && gitStatus.statusLines.length > 0) {
      gitSection.push(renderStatusLines(gitStatus.statusLines, 20));
    }
  }

  const rosterSection: string[] = [];
  if (mode === "full" && opts.roster && opts.roster.length > 0) {
    rosterSection.push("### Siblings (live agents and in-flight runs — snapshot)");
    for (const r of opts.roster) rosterSection.push(`- ${r.name} [${r.status}] — ${r.role}`);
  }

  if (gitSection.length === 0 && rosterSection.length === 0) return undefined;

  let body = [`(${spawnCwd})`, ...gitSection, ...rosterSection].join("\n");
  if (body.length > cap) {
    // Drop roster rows last-added first, then hard-slice — the cap is never advisory.
    const lines = body.split("\n");
    while (lines.length > 2 && lines.join("\n").length > cap) {
      // Prefer dropping a roster/sibling line; else drop from the porcelain tail.
      const lastSibling = findLastIndex(lines, (l) => l.startsWith("- ") || l.startsWith("### Siblings"));
      const idx = lastSibling >= 2 ? lastSibling : lines.length - 1;
      lines.splice(idx, 1);
    }
    body = lines.join("\n").slice(0, cap);
  }
  return `${STARTUP_CONTEXT_HEADER}\n${body}`;
}

/** findLastIndex (ES2023) polyfill-in-place: Bun has it, but the tsconfig
 *  target keeps us honest — a tiny local beats a lib downgrade. */
function findLastIndex<T>(arr: readonly T[], pred: (t: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) {
    const item = arr[i];
    if (item !== undefined && pred(item)) return i;
  }
  return -1;
}
