/**
 * Generic agent/subagent-row display helpers — the shared visual language for
 * live agent rows across the bottom task panel, the /workflows navigator, and
 * the /subagents viewer. Extracted from pi-agent-ext-workflow/src/display.ts so
 * pi-agent-ext-subagent is self-contained for its TUI; workflow re-imports these
 * (it already depends on this package) for its own agent-row rendering.
 *
 * Self-contained: depends only on {@link ThemeLike} + primitives — NOT on any
 * workflow type. {@link ActivityStatus} is the canonical status union across
 * workflow agents, completed subagent runs, and in-flight subagents.
 */

import type { RunView } from "./run-view.js";

/** Statuses a live agent row can show (superset of workflow's WorkflowAgentStatus). */
export type ActivityStatus =
  | "queued"
  | "running"
  | "done"
  | "error"
  | "failed"
  | "skipped"
  | "timedout"
  | "budget"
  | "aborted";

/** Minimal theme surface so rendering works without a real Theme (tool output, tests). */
export interface ThemeLike {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

/** Identity passthrough for contexts where no theme is available (tool text output). */
export const NO_THEME: ThemeLike = { fg: (_c, t) => t, bold: (t) => t };

export interface ActivityRow {
  /** Covers the union of statuses across workflow agents, subagent runs, and in-flight subagents. */
  status: ActivityStatus;
  actor: string;
  model?: string;
  elapsedMs?: number;
  tokens?: number;
  cost?: number;
  toolCalls?: number;
  /** One-line "what is it doing right now" — present only while running and history exists. */
  latestAction?: string;
  /** Static description shown when latestAction is absent (e.g. a finished run's taskPreview). */
  detail?: string;
  badge?: string;
}

/** Single icon+color mapping for an agent-level status.
 *  Themed output is byte-identical to activityGlyph (which delegates here);
 *  `plain: true` yields plain-text glyphs for theme-free live tables. */
export function glyphFor(status: ActivityStatus | null | undefined, opts?: { plain?: boolean }): { icon: string; color: string } {
  // defensive: records constructed before the status field became required may omit it
  const s = status ?? "running";
  if (opts?.plain) {
    switch (s) {
      case "queued":
        return { icon: ".", color: "dim" };
      case "running":
        return { icon: "~", color: "warning" };
      case "done":
        return { icon: "+", color: "success" };
      case "error":
      case "failed":
        return { icon: "x", color: "error" };
      case "skipped":
        return { icon: "-", color: "dim" };
      case "timedout":
        return { icon: "t!", color: "warning" };
      case "budget":
        return { icon: "$", color: "warning" };
      case "aborted":
        return { icon: "/", color: "dim" };
    }
  }
  switch (s) {
    case "queued":
      return { icon: "○", color: "dim" };
    case "running":
      return { icon: "●", color: "warning" };
    case "done":
      return { icon: "✓", color: "success" };
    case "error":
    case "failed":
      return { icon: "✗", color: "error" };
    case "skipped":
      return { icon: "-", color: "dim" };
    case "timedout":
      return { icon: "⏱", color: "warning" };
    case "budget":
      return { icon: "⛔", color: "warning" };
    case "aborted":
      return { icon: "⊘", color: "dim" };
  }
}

/** Canonical icon+color for an agent-level status. Delegates to glyphFor (themed). */
export function activityGlyph(status: ActivityStatus): { icon: string; color: string } {
  return glyphFor(status);
}

export function fmtElapsed(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Shared one-line renderer for an agent/subagent's live status — used by the
 * bottom task panel, the /workflows navigator's agent list and detail
 * live-tail, and the /subagents viewer, so all three surfaces speak one
 * visual language. `latestAction` (dynamic) always wins over `detail` (static).
 */
export function renderActivityRow(row: ActivityRow, theme: ThemeLike, maxDetailWidth = 50): string {
  const { icon, color } = activityGlyph(row.status);
  const dim = (t: string) => theme.fg("dim", t);
  const badge = row.badge ? `${theme.fg("accent", row.badge)} ` : "";
  const head = `${badge}${theme.fg(color, icon)} ${theme.fg("muted", row.actor)}`;
  const meta = [
    row.model ?? undefined,
    row.tokens ? `${fmtTokensShort(row.tokens)} tok` : undefined,
    typeof row.cost === "number" && row.cost > 0 ? `$${fmtCost(row.cost)}` : undefined,
    typeof row.elapsedMs === "number" ? fmtElapsed(row.elapsedMs) : undefined,
    typeof row.toolCalls === "number" ? `${row.toolCalls} call${row.toolCalls === 1 ? "" : "s"}` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  const metaStr = meta ? dim(` ${meta}`) : "";
  const tail = row.latestAction ?? (row.detail ? shorten(row.detail, maxDetailWidth) : undefined);
  const tailStr = tail ? dim(` — ${tail}`) : "";
  return `${head}${metaStr}${tailStr}`;
}

/** Themed single-line row for a RunView — glyph icon (colored), actor, modelSeg,
 *  elapsed, toolCalls, latestAction (shortened). */
export function renderRunRow(v: RunView, theme: ThemeLike, maxDetailWidth = 50): string {
  const { icon, color } = glyphFor(v.status);
  const dim = (t: string) => theme.fg("dim", t);
  const badge = v.badgeText ? `${theme.fg("accent", v.badgeText)} ` : "";
  const head = `${badge}${theme.fg(color, icon)} ${theme.fg("muted", v.actor)}`;
  const meta = [v.modelSeg, fmtElapsed(v.elapsedMs), `${v.toolCallCount} call${v.toolCallCount === 1 ? "" : "s"}`]
    .filter(Boolean)
    .join(" · ");
  const tail = v.latestAction ? shorten(v.latestAction, maxDetailWidth) : undefined;
  return `${head}${dim(` ${meta}`)}${tail ? dim(` — ${tail}`) : ""}`;
}

/** Plain, theme-free header for live tables: `[id] glyph elapsed · latestAction`. */
export function runHeader(v: RunView): string {
  const { icon } = glyphFor(v.status, { plain: true });
  const tail = v.latestAction ? ` · ${shorten(v.latestAction, 60)}` : "";
  return `[${v.id}] ${icon} ${fmtElapsed(v.elapsedMs)}${tail}`;
}

/** Fixed-width themed badge — empty string when the view has no badgeText. */
export function renderBadge(v: RunView, theme: ThemeLike): string {
  if (!v.badgeText) return "";
  return theme.fg("accent", v.badgeText.padEnd(8));
}

/** Short, human-friendly model label: drop the provider prefix for display. */
export function shortModel(model: string | undefined): string | undefined {
  if (!model) return undefined;
  const slash = model.indexOf("/");
  return slash > 0 ? model.slice(slash + 1) : model;
}

/** Compact token count for space-constrained rows: 980, 12.4K, 1.3M. */
export function fmtTokensShort(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n < 1000) return `${Math.round(n)}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Shared cost formatting for agent/subagent rows: 2 decimals when ≥$0.01, else 4. */
export function fmtCost(cost: number): string {
  return cost >= 0.01 ? cost.toFixed(2) : cost.toFixed(4);
}

export function shorten(value: string, max: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function preview(value: unknown, max = 80): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
