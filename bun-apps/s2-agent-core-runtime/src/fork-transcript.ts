/**
 * Fork transcript projection (cc-parity-2 ticket 02, map D2/D3).
 *
 * A fork child cannot literally continue the parent session — pi's
 * `createAgentSession` has no `initialMessages` — so it receives the parent
 * transcript as an instructions-prefix BLOCK instead (prompt-borne
 * inheritance, the deliberate CC divergence recorded in the effort's spec §3).
 * This module owns that projection: compaction-aware (via pi's exported
 * `buildContextEntries`), text-only (user/assistant turns + the latest
 * compaction summary; tool calls / results / custom entries are noise), and
 * hard-capped in chars with OLDEST-first truncation — ticket 01 measured that
 * session objects are noise and TRANSCRIPT size is the real cost lever, so the
 * cap is the point of the whole design.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { buildContextEntries, type SessionEntry, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";

/** Header of the injected block — "context only" is load-bearing: the child must
 *  answer its own task, never continue the parent conversation. */
export const FORK_TRANSCRIPT_HEADER = "## Parent conversation (context only, do not continue it)";

/** Default char cap of the rendered block (~24k chars ≈ 6k tokens — cheap enough
 *  for a one-shot child, generous enough for a long day-session's tail). */
export const DEFAULT_FORK_TRANSCRIPT_CAP = 24_000;

/** Marker replacing the turns dropped to fit the cap. */
const TRUNCATION_MARKER = "[... earlier turns truncated ...]";

/**
 * Effective char cap: `SUBAGENT_FORK_TRANSCRIPT_CAP` env override (integer > 0),
 * else {@link DEFAULT_FORK_TRANSCRIPT_CAP}. Read at call time so tests and
 * operators can tune without rebuilding.
 */
export function forkTranscriptCap(): number {
  const raw = Number(process.env.SUBAGENT_FORK_TRANSCRIPT_CAP);
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_FORK_TRANSCRIPT_CAP;
}

/** One projected turn: role + rendered text. */
interface TranscriptTurn {
  role: "user" | "assistant" | "compactionSummary";
  text: string;
}

/** Extract the TEXT of a message's content: a bare string passes through; an
 *  array yields its text items only (toolCall / image / thinking content is
 *  exactly the noise the projection exists to drop). Returns undefined when
 *  nothing textual remains. */
function textOf(content: unknown): string | undefined {
  if (typeof content === "string") return content.trim() ? content : undefined;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const c of content) {
    if (c && typeof c === "object" && (c as { type?: string }).type === "text") {
      const t = (c as { text?: string }).text;
      if (typeof t === "string" && t.trim()) parts.push(t);
    }
  }
  return parts.length ? parts.join("\n") : undefined;
}

/** Project compaction-aware entries into text turns. Exported for tests. */
export function projectTranscriptTurns(entries: SessionEntry[], leafId: string | null | undefined): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  for (const entry of buildContextEntries(entries, leafId ?? null)) {
    for (const msg of sessionEntryToContextMessages(entry)) {
      const m = msg as { role?: string; content?: unknown; summary?: unknown };
      if (m.role === "user" || m.role === "assistant") {
        const text = textOf(m.content);
        if (text) turns.push({ role: m.role, text });
      } else if (m.role === "compactionSummary" && typeof m.summary === "string" && m.summary.trim()) {
        // The compaction summary IS the parent's own memory of the turns the
        // projection otherwise omits — dropping it would fork a parent that
        // "forgot" everything before its last compaction.
        turns.push({ role: "compactionSummary", text: `Summary of earlier turns:\n${m.summary}` });
      }
    }
  }
  return turns;
}

/**
 * Render the fork context block. Pure — no session, no IO — so the whole
 * contract (compaction, cap, truncation) is unit-testable. Returns undefined
 * when the conversation holds no projectable text (a fork of an empty session
 * inherits nothing — the dispatch still runs, without the block).
 *
 * Truncation is OLDEST-first over whole turns; the marker names what was
 * dropped. Blocks are sliced against the effective limit (the cap minus the
 * marker + separator length when turns were dropped), so the body never
 * exceeds the cap (the cap is a hard bound, never advisory — with one floor:
 * a cap smaller than marker + separator keeps the intact marker over literal
 * compliance).
 */
export function buildForkTranscript(
  entries: SessionEntry[],
  leafId: string | null | undefined,
  capChars: number = forkTranscriptCap(),
): string | undefined {
  const turns = projectTranscriptTurns(entries, leafId);
  if (turns.length === 0) return undefined;
  const render = (t: TranscriptTurn): string => `${t.role}: ${t.text}`;
  const blocks = turns.map(render);
  let body = blocks.join("\n\n");
  if (body.length > capChars) {
    const kept = [...blocks];
    while (kept.length > 1 && `${TRUNCATION_MARKER}\n\n${kept.join("\n\n")}`.length > capChars) {
      kept.shift();
    }
    const dropped = kept.length < blocks.length;
    // A block that alone exceeds the cap is sliced — the cap is a hard bound,
    // never advisory. When turns were dropped the marker prefixes the body, so
    // its length (+ separator) is reserved BEFORE slicing: every block is
    // sliced against the EFFECTIVE limit (cap minus marker slack), so the final
    // body never exceeds the cap. No marker when nothing was dropped (a slice
    // is not a truncation of TURNS).
    const markerSlack = dropped ? TRUNCATION_MARKER.length + 2 : 0;
    const limit = capChars - markerSlack;
    const sliced = kept.map((b) => (b.length > limit ? b.slice(0, Math.max(0, limit)) : b));
    body = dropped ? `${TRUNCATION_MARKER}\n\n${sliced.join("\n\n")}` : sliced.join("\n\n");
  }
  return `${FORK_TRANSCRIPT_HEADER}\n\n${body}`;
}

// ---- fork-child ambient scope (no-fork-recursion guard, map D3) ----
//
// A fork child receives the PARENT's spawn_subagent definition through the
// extensionTools bridge — the same ToolDefinition closure, executed inside the
// fork child's async subtree. There is no per-child options object that
// closure could read, so "am I a fork child?" travels as an ambient async
// scope: the fork dispatch wraps its spawn call in runAsForkChild(), and every
// descendant tool execution (any depth — a named grandchild inherits the scope
// too) observes isForkChild(). AsyncLocalStorage propagates through awaits, so
// the whole in-process child lifetime is covered without touching pi.

const forkChildScope = new AsyncLocalStorage<{ depth: number }>();

/** Run `fn` (a fork child's entire spawn) inside the fork-child scope. */
export function runAsForkChild<T>(fn: () => T): T {
  return forkChildScope.run({ depth: 1 }, fn);
}

/** True when the caller executes inside a fork child (at any depth). */
export function isForkChild(): boolean {
  return forkChildScope.getStore() !== undefined;
}
