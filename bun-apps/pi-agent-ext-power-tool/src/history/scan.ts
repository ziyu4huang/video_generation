/**
 * Transcript scanner — the ONE reader of pi-agent session logs.
 *
 * Every pi-agent run appends a JSONL transcript under
 * `~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl`, recording:
 *   - `assistant` messages whose `content[]` holds `{type:"toolCall", id, name, arguments}`
 *   - `toolResult` messages carrying `{toolCallId, toolName, isError}` + an ISO `timestamp`
 *   - a `session` header with the authoritative `cwd`
 *
 * Relocated here from `pi-agent/src/cli/commands/tools-metrics.ts` so tool-health
 * metrics and pathology replay share one parser. A second parser would let the two
 * disagree about what a session contains, and the divergence would be invisible.
 *
 * `bashExecution` messages are deliberately IGNORED — a separate detail log whose
 * call/result/error signal already appears on the `bash` tool's own records.
 * Counting both would double-count bash.
 *
 * PURE: parseSessionLines takes already-read lines, so the parser is unit-testable
 * with zero filesystem access.
 */

/** Minimal shape of a JSONL event line — only the fields we read. */
interface AnyEvent {
  type: string;
  timestamp?: string;
  cwd?: string;
  provider?: string;
  modelId?: string;
  message?: {
    role?: string;
    content?: Array<{
      type: string;
      id?: string;
      name?: string;
      arguments?: unknown;
    }>;
    toolCallId?: string;
    toolName?: string;
    isError?: boolean;
    usage?: { totalTokens?: number };
  };
}

/** One toolCall block, flattened. */
export interface CallRec {
  callId: string;
  name: string;
  t0: number;
  /** Raw call arguments — fed to argsSig() by the replay, unused by tool metrics. */
  args?: unknown;
}

/** One toolResult message, flattened. */
export interface ResultRec {
  callId: string;
  name: string;
  t1: number;
  isError: boolean;
}

/** Parsed view of a single transcript file. */
export interface SessionScan {
  cwd?: string;
  startedAt?: number; // epoch ms of the `session` event (earliest event)
  calls: CallRec[];
  results: ResultRec[];
  /** Highest `usage.totalTokens` seen — the session's peak context fill, in tokens. */
  maxTotalTokens: number;
  /** Assistant message count — the turn-count proxy. Transcripts carry no turn_end
   *  event, so this is an APPROXIMATION of the accumulator's turnCount. */
  assistantMessages: number;
  /** From the last `model_change` event — used to resolve the context window. */
  provider?: string;
  modelId?: string;
}

/** Parse an event timestamp (ISO string or epoch-ms number) → epoch ms. */
function parseTs(ts: unknown): number | undefined {
  if (typeof ts === "number" && Number.isFinite(ts)) return ts;
  if (typeof ts === "string") {
    const n = Date.parse(ts);
    if (!Number.isNaN(n)) return n;
  }
  return undefined;
}

/** Parse one JSONL transcript (array of raw lines) into a SessionScan. */
export function parseSessionLines(lines: string[]): SessionScan {
  const scan: SessionScan = {
    calls: [],
    results: [],
    maxTotalTokens: 0,
    assistantMessages: 0,
  };
  let earliest: number | undefined;

  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    let ev: AnyEvent;
    try {
      ev = JSON.parse(trimmed) as AnyEvent;
    } catch {
      continue; // skip malformed lines silently
    }
    const t = parseTs(ev.timestamp);
    if (t !== undefined && (earliest === undefined || t < earliest)) earliest = t;

    if (ev.type === "session" && typeof ev.cwd === "string") {
      scan.cwd = ev.cwd;
      if (scan.startedAt === undefined && t !== undefined) scan.startedAt = t;
    }

    if (ev.type === "model_change") {
      if (typeof ev.provider === "string") scan.provider = ev.provider;
      if (typeof ev.modelId === "string") scan.modelId = ev.modelId;
    }

    if (ev.type !== "message" || !ev.message) continue;
    const m = ev.message;

    if (m.role === "assistant") {
      // Turn counting and usage must happen even when the message carries no
      // content array and even when its timestamp is unparseable, so the
      // `t !== undefined` guard applies only to the tool-call extraction.
      scan.assistantMessages++;
      const total = m.usage?.totalTokens;
      if (typeof total === "number" && total > scan.maxTotalTokens) scan.maxTotalTokens = total;
      if (Array.isArray(m.content) && t !== undefined) {
        for (const b of m.content) {
          if (b?.type === "toolCall" && b.id && b.name) {
            scan.calls.push({ callId: b.id, name: b.name, t0: t, args: b.arguments });
          }
        }
      }
    } else if (m.role === "toolResult" && t !== undefined) {
      const callId = m.toolCallId;
      const name = m.toolName ?? "(unknown)";
      if (callId) {
        scan.results.push({ callId, name, t1: t, isError: !!m.isError });
      } else {
        // toolResult without a callId still counts toward results/errors;
        // use a synthetic unique id so it can't accidentally pair.
        scan.results.push({
          callId: `__orphan__${name}__${scan.results.length}`,
          name,
          t1: t,
          isError: !!m.isError,
        });
      }
    }
  }

  if (scan.startedAt === undefined) scan.startedAt = earliest;
  return scan;
}
