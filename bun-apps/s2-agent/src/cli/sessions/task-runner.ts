/**
 * Shared CLI task runners — stream a `session.prompt()` result either as
 * pretty terminal output or as an NDJSON event stream.
 *
 * Extracted so the zk-extract / zk-card / zk-ask commands stay thin
 * flow-control wrappers: they build the task string (from pi-knowledge-card)
 * and hand the session + task to these runners. Keeps the NDJSON event shape
 * and error handling identical across all three commands.
 *
 * ## Verbosity (`verbose` param, 0-2)
 *
 *   0 (default) — tool name only:  `[tool] name` / `[tool done] name (ok)`
 *   1           — append a compact one-line args summary on start.
 *   2  (debug)  — full args JSON on start + a result preview on end.
 *
 * The same levels shape JSON mode: at 0 the emitted tool events stay
 * backward-compatible (no args/result); at >=1 args are included on
 * `tool_execution_start` and result on `tool_execution_end` (truncated at 1,
 * fuller at 2) so log-dredging / replay tooling can see what happened.
 */

import { clip } from "../format.ts";

/** Minimal session surface these runners need. */
export interface TaskSession {
  subscribe: (fn: (event: any) => void) => () => void;
  prompt: (task: string) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Verbosity formatters
// ---------------------------------------------------------------------------

/** Hard cap on a single preview/summary line (chars). */
const LINE_CAP = 240;
/** Cap on the level-2 result preview (chars). */
const RESULT_CAP_LVL2 = 600;

/**
 * Pick the most meaningful arg keys for a compact one-line summary.
 * Ordered by how informative each tends to be for that tool.
 */
const PRIORITY_KEYS = [
  "query",
  "question",
  "search_query",
  "pattern",
  "note",
  "path",
  "file",
  "files",
  "command",
  "cmd",
  "action",
  "heading",
  "name",
  "newName",
  "tag",
  "tags",
  "from",
  "to",
  "folder",
  "content",
] as const;

// trunc → shared clip in ../format.ts (round-2 ticket 06): same cut semantics
// with trimTail left off — quoted/JSON values keep every char of their cut.

/** Render a single arg value compactly (strings quoted, objects JSON'd). */
function renderValue(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(clip(v, 80));
  if (v === null || v === undefined) return String(v);
  if (typeof v === "object") {
    try {
      return clip(JSON.stringify(v), 120);
    } catch {
      return String(v);
    }
  }
  return String(v);
}

/**
 * Level-1 summary: up to 3 of the most informative args as `key=value` pairs.
 * Falls back to a compact JSON dump if no priority key is present.
 */
function summarizeArgs(args: unknown): string {
  if (args === null || args === undefined) return "";
  if (typeof args !== "object") return clip(String(args), LINE_CAP);
  const obj = args as Record<string, unknown>;
  const picked: string[] = [];
  for (const key of PRIORITY_KEYS) {
    if (key in obj && obj[key] !== undefined) {
      picked.push(`${key}=${renderValue(obj[key])}`);
      if (picked.length >= 3) break;
    }
  }
  if (picked.length === 0) {
    // No recognized key — emit the whole thing compactly.
    try {
      return clip(JSON.stringify(obj), LINE_CAP);
    } catch {
      return "";
    }
  }
  return clip(picked.join("  "), LINE_CAP);
}

/** Level-2 full args: pretty-but-compact JSON, capped. */
function dumpArgs(args: unknown): string {
  if (args === null || args === undefined) return "";
  try {
    return clip(JSON.stringify(args), LINE_CAP);
  } catch {
    return String(args).slice(0, LINE_CAP);
  }
}

/**
 * Result preview for level 1 (terse) / level 2 (fuller).
 * Handles common shapes: string, array, object, scalar.
 */
function summarizeResult(result: unknown, cap: number): string {
  if (result === null || result === undefined) return "(no result)";
  if (typeof result === "string") return clip(result, cap);
  if (Array.isArray(result)) {
    const head = result[0];
    const headStr =
      head && typeof head === "object"
        ? clip(JSON.stringify(head), Math.min(120, cap))
        : clip(String(head ?? ""), Math.min(120, cap));
    return `${result.length} item(s): [${headStr}${result.length > 1 ? ", …" : ""}]`;
  }
  if (typeof result === "object") {
    // Many obsidian tools return { content?: string, ... } or structured text.
    const r = result as Record<string, unknown>;
    const textish = r.text ?? r.content ?? r.message ?? r.error;
    if (typeof textish === "string") return clip(textish, cap);
    try {
      return clip(JSON.stringify(r), cap);
    } catch {
      return String(result).slice(0, cap);
    }
  }
  return clip(String(result), cap);
}

/** Format the `[tool]` start line for the given verbosity. */
function fmtToolStart(toolName: string, args: unknown, verbose: number): string {
  if (verbose <= 0) return `\n[tool] ${toolName}`;
  if (verbose === 1) {
    const sum = summarizeArgs(args);
    return sum ? `\n[tool] ${toolName}  ${sum}` : `\n[tool] ${toolName}`;
  }
  const dump = dumpArgs(args);
  return dump ? `\n[tool] ${toolName}  ${dump}` : `\n[tool] ${toolName}`;
}

/** Format the `[tool done]` end line for the given verbosity. */
function fmtToolEnd(
  toolName: string,
  result: unknown,
  isError: boolean,
  verbose: number,
): string {
  const tag = isError ? "err" : "ok";
  if (verbose <= 1) return `[tool done] ${toolName} (${tag})`;
  // Level 2: append a result preview.
  const cap = verbose >= 2 ? RESULT_CAP_LVL2 : 120;
  const prev = summarizeResult(result, cap);
  return `[tool done] ${toolName} (${tag})  → ${prev}`;
}

// ---------------------------------------------------------------------------
// Runners
// ---------------------------------------------------------------------------

/** Nudge sent when a turn completes with tool calls but no final synthesis text.
 *  Reuses the in-session tool results — no re-retrieval. Traditional Chinese
 *  to match the RAG task's output language. */
const SYNTHESIS_NUDGE =
  "你上一輪完成了工具呼叫但沒有輸出最終內容。請根據已檢索的筆記，現在輸出組合後的上下文，並在結尾附上 **Reference notes:** 清單。不要再次呼叫工具。";

/** Detect whether a completed prompt produced any assistant text or tool
 *  activity. Local models (LM Studio) intermittently return a completely empty
 *  turn — no tool calls, no text — which the SDK treats as a normal completion.
 *  Without a retry the CLI prints the done footer over empty output and exits 0
 *  (silent failure); this is the dominant source of refs=0 in retrieval runs. */
interface TurnActivity {
  textChars: number;
  toolCalls: number;
}

function runPrettyTaskOnce(
  session: TaskSession,
  task: string,
  verbose: number,
  act: TurnActivity,
): () => void {
  return session.subscribe((event: any) => {
    if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
      const d = event.assistantMessageEvent.delta as string;
      act.textChars += d.length;
      process.stdout.write(d);
    } else if (event.type === "tool_execution_start") {
      act.toolCalls++;
      console.error(fmtToolStart(event.toolName, event.args, verbose));
    } else if (event.type === "tool_execution_end") {
      console.error(fmtToolEnd(event.toolName, event.result, !!event.isError, verbose));
    }
  });
}

/**
 * Pretty-print a prompt() run to stdout/stderr, then emit a
 * `--- <doneLabel> done ---` footer. Used in the default (non-json) mode.
 *
 * Retries once on an empty model turn: if the first prompt produces neither
 * assistant text nor tool calls (a local-model hiccup), or produces tool calls
 * but no synthesis text, a single focused follow-up recovers it. Without this,
 * `zk-ask --retrieve-only -p` intermittently prints just the done footer over
 * empty output — the dominant refs=0 cause in retrieval measurement.
 *
 * @param verbose  tool-event verbosity (0 silent, 1 args summary, 2 debug).
 */
export async function runPrettyTask(
  session: TaskSession,
  task: string,
  doneLabel: string,
  verbose = 0,
): Promise<void> {
  const act: TurnActivity = { textChars: 0, toolCalls: 0 };
  const unsub = runPrettyTaskOnce(session, task, verbose, act);
  try {
    await session.prompt(task);
    if (act.textChars === 0) {
      // Empty synthesis: tools ran but no final text → nudge (reuses context);
      // nothing ran at all → retry the original task (the model hiccuped).
      const followUp = act.toolCalls > 0 ? SYNTHESIS_NUDGE : task;
      console.error(`[retry] empty ${act.toolCalls > 0 ? "synthesis" : "turn"} — issuing one follow-up`);
      await session.prompt(followUp);
    }
    console.log(`\n\n--- ${doneLabel} done ---`);
  } finally {
    unsub();
  }
}

/**
 * Stream a prompt() run as NDJSON to stdout. Emits message_update /
 * tool_execution_start / tool_execution_end / message_end events, and a
 * `{ type: "error" }` line if prompt() throws — so json consumers always get a
 * well-formed termination signal instead of an uncaught throw.
 *
 * At `verbose >= 1`, tool events additionally carry `args` (on start) and
 * `result` (on end) so external log/replay tooling can inspect tool traffic.
 * At `verbose = 0` the shape is unchanged from earlier releases.
 *
 * @param verbose  tool-event verbosity (0 silent, 1 args, 2 args+result).
 */
export async function runJsonTask(
  session: TaskSession,
  task: string,
  verbose = 0,
): Promise<void> {
  let assistantText = "";
  let toolCalls = 0;
  const emit = (obj: unknown) => process.stdout.write(JSON.stringify(obj) + "\n");
  const unsub = session.subscribe((event: any) => {
    if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
      assistantText += event.assistantMessageEvent.delta;
      emit({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: event.assistantMessageEvent.delta },
      });
    } else if (event.type === "tool_execution_start") {
      toolCalls++;
      const base: Record<string, unknown> = {
        type: "tool_execution_start",
        toolName: event.toolName,
        toolCallId: event.toolCallId,
      };
      if (verbose >= 1) base.args = event.args;
      emit(base);
    } else if (event.type === "tool_execution_end") {
      const base: Record<string, unknown> = {
        type: "tool_execution_end",
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        isError: !!event.isError,
      };
      // Result only emitted from level 1+ (can be large); level 2 keeps it
      // fuller, level 1 caps to a preview.
      if (verbose >= 1) {
        base.result =
          verbose >= 2 ? event.result : summarizeResult(event.result, 200);
      }
      emit(base);
    }
  });
  try {
    await session.prompt(task);
    // Same empty-turn recovery as runPrettyTask: local models occasionally
    // return a turn with no text (and sometimes no tools). Retry once so json
    // consumers don't see a silent empty message_end.
    if (assistantText.length === 0) {
      const followUp = toolCalls > 0 ? SYNTHESIS_NUDGE : task;
      emit({ type: "retry", reason: toolCalls > 0 ? "empty_synthesis" : "empty_turn" });
      await session.prompt(followUp);
    }
    emit({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: assistantText }] },
    });
  } catch (err) {
    // Emit a well-formed terminal event for NDJSON consumers, then re-throw so
    // the process still exits non-zero (dispatch.ts's runCli catch). Swallowing
    // would silently turn a model failure into exit 0 — and the obsidian
    // subagent parser only reads `message_end`, so a swallowed error reaches
    // the parent as empty output + exit 0, i.e. a silent empty "success".
    emit({ type: "error", message: err instanceof Error ? err.message : String(err) });
    throw err;
  } finally {
    unsub();
  }
}
