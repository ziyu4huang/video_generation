/**
 * Shared "what is the agent doing / did the agent do" label helper.
 *
 * Replaces machine-protocol tool-event strings (`read`, `read → done`, `▸ read`)
 * with human verb-led phrases (`Reading src/foo.ts`, `Read src/foo.ts`,
 * `Searching for "bar"`). ONE helper owns the PHRASE; each render surface keeps
 * its own glyph/marker (`→`, `✓`, `✗`, `↳`, …) and delegates the wording here.
 *
 * Entry kinds:
 *  - toolCall   → present-continuous + target, parsed from `entry.text` (JSON args).
 *  - toolResult → past tense; the target is recovered from the MATCHING preceding
 *                 toolCall's args via `matchedCallArgsFor` (results carry only
 *                 result prose, no args). Orphan result → verb-only past.
 *  - error      → `Failed to <verb> <target>` (+ optional `: <first line>`); a
 *                 whole-turn assistant error (no toolName) → `⚠ <first line>`.
 *  - text/idle  → first line (≤60), else `…thinking`.
 *
 * Parse tolerance: `entry.text` may be `{}`, valid JSON, non-JSON, or a payload
 * truncated by `compactAgentHistory` (`... [truncated]`, 2000-char cap). We
 * `JSON.parse` first, then regex-scrape known string keys, then fall back to the
 * toolName — and NEVER throw.
 */
import type { AgentHistoryEntry } from "./agent-history.js";
import { capWidth, ellipsizeMidToWidth, ellipsizeToWidth } from "./render-width.js";

export interface ToolActionContext {
  /**
   * Parsed args of the matching preceding toolCall — lets a toolResult/error
   * recover the target (results carry only result prose, no args). Obtained via
   * `matchedCallArgsFor`; absent for orphan results (→ verb-only).
   */
  matchedCallArgs?: Record<string, unknown>;
  /**
   * Terminal width (columns) available for the phrase's TARGET. Optional:
   * absent → the historical ~50-char cap semantics (ASCII byte-identical);
   * present → `capWidth(50, width)` only ever NARROWS it. Cuts are terminal-
   * COLUMN aware either way (CJK double-width counted via render-width).
   */
  width?: number;
}

/** Arg keys tried, in order, when a tool's own per-tool key is absent (generic fallback). */
const GENERIC_KEYS = ["path", "file", "note", "command", "query", "pattern", "url", "name", "task", "action", "id"];

interface VerbSpec {
  /** Priority arg keys for this tool's target (first hit wins). */
  keys: string[];
  /** Bare verb for the error form `Failed to <stem>`. */
  stem: string;
  /** When true, the target is the array `.length` (subagents/ask_user_question). */
  count?: boolean;
  /** Present-continuous phrase WITH a target. */
  present: (target: string) => string;
  /** Past phrase WITH a target (may ignore it — e.g. `Dispatched subagent`). */
  past: (target: string) => string;
  /** Verb-only present (no target recoverable). */
  presentBare: string;
  /** Verb-only past (no target recoverable). */
  pastBare: string;
}

const pluralize = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** Per-tool verb table keyed by toolName (REAL arg keys — see compactAgentHistory). */
const VERBS: Record<string, VerbSpec> = {
  read: {
    keys: ["path"],
    stem: "read",
    present: (t) => `Reading ${t}`,
    past: (t) => `Read ${t}`,
    presentBare: "Reading",
    pastBare: "Read",
  },
  write: {
    keys: ["path"],
    stem: "write",
    present: (t) => `Writing ${t}`,
    past: (t) => `Wrote ${t}`,
    presentBare: "Writing",
    pastBare: "Wrote",
  },
  edit: {
    keys: ["path"],
    stem: "edit",
    present: (t) => `Editing ${t}`,
    past: (t) => `Edited ${t}`,
    presentBare: "Editing",
    pastBare: "Edited",
  },
  bash: {
    keys: ["command"],
    stem: "run",
    present: (t) => `Running: ${t}`,
    past: (t) => `Ran: ${t}`,
    presentBare: "Running",
    pastBare: "Ran",
  },
  grep: {
    keys: ["pattern"],
    stem: "search",
    present: (t) => `Searching for "${t}"`,
    past: (t) => `Searched for "${t}"`,
    presentBare: "Searching",
    pastBare: "Searched",
  },
  find: {
    keys: ["pattern"],
    stem: "find",
    present: (t) => `Finding "${t}"`,
    past: (t) => `Found "${t}"`,
    presentBare: "Finding",
    pastBare: "Found",
  },
  ls: {
    keys: ["path"],
    stem: "list",
    present: (t) => `Listing ${t}`,
    past: (t) => `Listed ${t}`,
    presentBare: "Listing",
    pastBare: "Listed",
  },
  web_search: {
    keys: ["query", "queries"],
    stem: "search the web",
    present: (t) => `Searching web for "${t}"`,
    past: () => `Searched web`,
    presentBare: "Searching web",
    pastBare: "Searched web",
  },
  fetch_content: {
    keys: ["url", "urls"],
    stem: "fetch",
    present: (t) => `Fetching ${t}`,
    past: (t) => `Fetched ${t}`,
    presentBare: "Fetching",
    pastBare: "Fetched",
  },
  subagent: {
    keys: ["task"],
    stem: "dispatch subagent",
    present: (t) => `Dispatching subagent "${t}"`,
    past: () => `Dispatched subagent`,
    presentBare: "Dispatching subagent",
    pastBare: "Dispatched subagent",
  },
  subagents: {
    keys: ["tasks"],
    stem: "dispatch subagents",
    count: true,
    present: (t) => `Dispatching ${pluralize(Number(t) || 0, "subagent")}`,
    past: (t) => `Dispatched ${pluralize(Number(t) || 0, "subagent")}`,
    presentBare: "Dispatching subagents",
    pastBare: "Dispatched subagents",
  },
  ask_user_question: {
    keys: ["questions"],
    stem: "ask",
    count: true,
    present: (t) => `Asking ${pluralize(Number(t) || 0, "question")}`,
    past: (t) => `Asked ${pluralize(Number(t) || 0, "question")}`,
    presentBare: "Asking questions",
    pastBare: "Asked questions",
  },
};

function firstLine(text: string | undefined): string {
  return (text ?? "").split("\n")[0] ?? "";
}

function truncateEnd(s: string, max: number): string {
  return ellipsizeToWidth(s, max);
}

function truncateMid(s: string, max: number): string {
  return ellipsizeMidToWidth(s, max);
}

/** Shape a raw arg value into a display target: commands → first line; else mid-ellipsis (~50). */
function shapeTarget(key: string, raw: string, cap = 50): string {
  if (key === "command") return truncateEnd(firstLine(raw) || raw, cap);
  return truncateMid(raw, cap);
}

/** Extract this tool's own target from parsed args (first matching key wins). */
function extractTargetValue(
  spec: VerbSpec,
  args: Record<string, unknown> | undefined,
  cap: number,
): string | undefined {
  if (!args) return undefined;
  for (const k of spec.keys) {
    const v = args[k];
    if (v == null) continue;
    if (Array.isArray(v)) {
      if (spec.count) return String(v.length);
      if (v.length === 0) continue;
      const first = v[0];
      return typeof first === "object" ? undefined : shapeTarget(k, String(first), cap);
    }
    if (typeof v === "object") continue;
    return shapeTarget(k, String(v), cap);
  }
  return undefined;
}

/** Generic-key fallback: first present of GENERIC_KEYS → shaped value. */
function extractGeneric(args: Record<string, unknown> | undefined, cap: number): string | undefined {
  if (!args) return undefined;
  for (const k of GENERIC_KEYS) {
    const v = args[k];
    if (v == null || Array.isArray(v) || typeof v === "object") continue;
    return shapeTarget(k, String(v), cap);
  }
  return undefined;
}

/**
 * Regex-scrape known string keys from a (possibly truncated / non-JSON) payload.
 * Used when `JSON.parse` fails — e.g. `{"path":"a.ts","offset":0,"text":"abc... [truncated]`
 * still yields `path="a.ts"`. Only catches string values (quoted) — by design.
 */
function scrapeJsonStrings(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const re = /"(path|file|note|command|query|pattern|url|name|task|action|id)"\s*:\s*"([^"]*)"/g;
  for (let m: RegExpExecArray | null = re.exec(text); m !== null; m = re.exec(text)) {
    const key = m[1];
    if (key !== undefined) out[key] = m[2];
  }
  return out;
}

/**
 * Parse a toolCall's args text into an object, tolerating `{}`, valid JSON,
 * non-JSON, and truncated payloads. Returns `undefined` only when nothing could
 * be recovered; returns `{}` for a valid-but-empty object (so a paired result
 * still knows it was matched, just arg-less).
 */
function parseArgs(text: string | undefined): Record<string, unknown> | undefined {
  if (!text) return undefined;
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    const obj: unknown = JSON.parse(trimmed);
    if (obj && typeof obj === "object" && !Array.isArray(obj)) return obj as Record<string, unknown>;
    return undefined;
  } catch {
    // not valid JSON — fall through to regex scrape (handles truncated payloads)
  }
  const scraped = scrapeJsonStrings(text);
  return Object.keys(scraped).length > 0 ? scraped : undefined;
}

/** toolCall (present-continuous) phrase. */
function presentPhrase(
  toolName: string | undefined,
  args: Record<string, unknown> | undefined,
  width?: number,
): string {
  const spec = toolName ? VERBS[toolName] : undefined;
  const a = args ?? {};
  const cap = capWidth(50, width);
  if (spec) {
    const t = extractTargetValue(spec, a, cap);
    if (t != null) return spec.present(t);
  }
  const g = extractGeneric(a, cap);
  if (g != null) return `Using ${g}`;
  return `Using ${toolName ?? "tool"}`;
}

/** toolResult (past) phrase — requires the matched call's args for a target. */
function pastPhrase(toolName: string | undefined, args: Record<string, unknown> | undefined, width?: number): string {
  const spec = toolName ? VERBS[toolName] : undefined;
  const a = args ?? {};
  const cap = capWidth(50, width);
  if (spec) {
    const t = extractTargetValue(spec, a, cap);
    if (t != null) return spec.past(t);
  }
  const g = extractGeneric(a, cap);
  if (g != null) return `Used ${g}`;
  return `Used ${toolName ?? "tool"}`;
}

/** toolResult past phrase when no matchedCallArgs is available (orphan) — verb-only. */
function pastVerbOnly(toolName: string | undefined): string {
  const spec = toolName ? VERBS[toolName] : undefined;
  return spec ? spec.pastBare : `Used ${toolName ?? "tool"}`;
}

/** error phrase — `Failed to <verb> <target>` (+ optional `: <detail>`); whole-turn → `⚠ <line>`. */
function errorPhrase(
  entry: AgentHistoryEntry,
  matchedCallArgs: Record<string, unknown> | undefined,
  width?: number,
): string {
  // Whole-turn model error (assistant, no toolName): surface the raw message.
  if (entry.role === "assistant" && !entry.toolName) {
    return `⚠ ${truncateEnd(firstLine(entry.text), 200)}`;
  }
  const toolName = entry.toolName;
  const spec = toolName ? VERBS[toolName] : undefined;
  const cap = capWidth(50, width);
  let target: string | undefined;
  if (matchedCallArgs) {
    target = spec ? extractTargetValue(spec, matchedCallArgs, cap) : undefined;
    if (target == null) target = extractGeneric(matchedCallArgs, cap);
  }
  const stem = spec?.stem ?? toolName ?? "tool";
  const detail = truncateEnd(firstLine(entry.text), 120);
  if (target != null) return detail ? `Failed to ${stem} ${target}: ${detail}` : `Failed to ${stem} ${target}`;
  // No recoverable target: known tool → bare stem; unknown tool → parenthesized fallback.
  const base = spec ? `Failed to ${stem}` : `Failed (${toolName ?? "tool"})`;
  return detail ? `${base}: ${detail}` : base;
}

function idlePhrase(text: string | undefined): string {
  const line = firstLine(text);
  return line ? truncateEnd(line, 60) : "…thinking";
}

/**
 * Render one history entry as a human verb-led phrase (NO surface glyph —
 * callers add `→`/`✓`/`✗`/`↳` themselves). The single source of truth for
 * "what is/was the agent doing" wording across all subagent surfaces.
 */
export function formatToolAction(entry: AgentHistoryEntry, ctx?: ToolActionContext): string {
  switch (entry.kind) {
    case "toolCall":
      return presentPhrase(entry.toolName, parseArgs(entry.text), ctx?.width);
    case "toolResult":
      return ctx?.matchedCallArgs
        ? pastPhrase(entry.toolName, ctx.matchedCallArgs, ctx?.width)
        : pastVerbOnly(entry.toolName);
    case "error":
      return errorPhrase(entry, ctx?.matchedCallArgs, ctx?.width);
    case "text":
      return idlePhrase(entry.text);
    default:
      return idlePhrase(entry.text);
  }
}

/**
 * For a toolResult/error at `index`, recover the args of the call it answers so
 * the result can recover the target it acted on. Returns `undefined` for orphans,
 * for non-result/error entries, or when the matched call had no recoverable args.
 *
 * Pairing strategy (id-first, name-fallback — trace fidelity under batching):
 *  1. If the entry carries a `toolCallId`, scan BACKWARD for the nearest
 *     preceding toolCall whose `toolCallId` MATCHES. Under batching (one turn
 *     emits N same-tool calls, then N matching results) this is the only signal
 *     that disambiguates which result answers which call. Returns `undefined`
 *     only if no call shares the id (truncated window / mismatched upstream).
 *  2. Otherwise (no id, or id with no matching call) scan BACKWARD to the
 *     nearest preceding toolCall with the SAME toolName — the legacy path that
 *     handles older/id-less transcripts unchanged.
 */
export function matchedCallArgsFor(
  history: readonly AgentHistoryEntry[],
  index: number,
): Record<string, unknown> | undefined {
  const entry = history[index];
  if (!entry) return undefined;
  if (entry.kind !== "toolResult" && entry.kind !== "error") return undefined;
  // 1. id-first: find the call whose toolCallId matches this result's id.
  if (entry.toolCallId) {
    for (let i = index - 1; i >= 0; i--) {
      const prev = history[i];
      if (!prev) continue; // invariant: i >= 0 and < history.length (loop bound)
      if (prev.kind === "toolCall" && prev.toolCallId === entry.toolCallId) {
        return parseArgs(prev.text);
      }
    }
  }
  // 2. name fallback (legacy / id-less / unmatched-id): nearest preceding
  //    same-name call.
  const name = entry.toolName;
  for (let i = index - 1; i >= 0; i--) {
    const prev = history[i];
    if (!prev) continue; // invariant: i >= 0 and < history.length (loop bound)
    if (prev.kind === "toolCall" && prev.toolName === name) {
      return parseArgs(prev.text);
    }
  }
  return undefined;
}
