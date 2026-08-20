/**
 * BTW — side conversation channel — transcript state machine.
 *
 * Adapted from pi-btw (MIT, Dan Bachelder). Manages an ordered transcript of
 * the BTW side conversation (user messages, thinking, tool calls/results,
 * assistant replies) that is rendered by the overlay component.
 */

import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  BtwDetails,
  BtwTranscript,
  BtwTranscriptEntry,
  BtwTranscriptState,
} from "./types";

// ─── Factory ─────────────────────────────────────────────────────────────────

export function createEmptyTranscriptState(): BtwTranscriptState {
  return {
    entries: [],
    nextEntryId: 1,
    nextTurnId: 1,
    currentTurnId: null,
    lastTurnId: null,
    toolCalls: new Map(),
  };
}

// ─── Internal helpers ────────────────────────────────────────────────────────

function appendTranscriptEntry<T extends BtwTranscriptEntry>(
  state: BtwTranscriptState,
  entry: Omit<T, "id">,
): T {
  const nextEntry = { ...entry, id: state.nextEntryId++ } as T;
  state.entries.push(nextEntry);
  return nextEntry;
}

function ensureTranscriptTurn(state: BtwTranscriptState): number {
  if (state.currentTurnId !== null) return state.currentTurnId;
  const turnId = state.nextTurnId++;
  state.currentTurnId = turnId;
  state.lastTurnId = turnId;
  appendTranscriptEntry(state, {
    type: "turn-boundary",
    turnId,
    phase: "start",
  } as Omit<Extract<BtwTranscriptEntry, { type: "turn-boundary" }>, "id">);
  return turnId;
}

function finishTranscriptTurn(state: BtwTranscriptState, turnId?: number | null): void {
  const resolvedTurnId = turnId ?? state.currentTurnId;
  if (resolvedTurnId == null) return;

  const hasEndBoundary = state.entries.some(
    (e) => e.turnId === resolvedTurnId && e.type === "turn-boundary" && e.phase === "end",
  );
  if (!hasEndBoundary) {
    appendTranscriptEntry(state, {
      type: "turn-boundary",
      turnId: resolvedTurnId,
      phase: "end",
    } as Omit<Extract<BtwTranscriptEntry, { type: "turn-boundary" }>, "id">);
  }

  for (const entry of state.entries) {
    if (entry.turnId !== resolvedTurnId) continue;
    if (entry.type === "thinking" || entry.type === "assistant-text" || entry.type === "tool-result") {
      (entry as { streaming: boolean }).streaming = false;
    }
  }

  state.lastTurnId = resolvedTurnId;
  if (state.currentTurnId === resolvedTurnId) state.currentTurnId = null;
}

export function findLatestTranscriptEntry<TType extends BtwTranscriptEntry["type"]>(
  state: BtwTranscriptState,
  turnId: number,
  type: TType,
): Extract<BtwTranscriptEntry, { type: TType }> | undefined {
  for (let i = state.entries.length - 1; i >= 0; i--) {
    const entry = state.entries[i];
    if (entry.turnId === turnId && entry.type === type) return entry as Extract<BtwTranscriptEntry, { type: TType }>;
  }
  return undefined;
}

function ensureTranscriptTurnForUserMessage(state: BtwTranscriptState): number {
  if (state.currentTurnId !== null) {
    const currentAssistant = findLatestTranscriptEntry(state, state.currentTurnId, "assistant-text");
    if (currentAssistant && !(currentAssistant as { streaming: boolean }).streaming) {
      finishTranscriptTurn(state, state.currentTurnId);
    }
  }
  return ensureTranscriptTurn(state);
}

function extractMessageText(message: { content?: string | unknown[] }): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((part): part is { type: "text"; text: string } => typeof part === "object" && part !== null && (part as Record<string, unknown>).type === "text" && typeof (part as Record<string, string>).text === "string")
    .map((part) => (part as { text: string }).text)
    .join("\n")
    .trim();
}

function extractText(parts: AssistantMessage["content"], type: "text" | "thinking"): string {
  const chunks: string[] = [];
  for (const part of parts) {
    if (type === "text" && part.type === "text") chunks.push(part.text);
    else if (type === "thinking" && part.type === "thinking") chunks.push(part.thinking);
  }
  return chunks.join("\n").trim();
}

function extractThinking(message: AssistantMessage): string {
  return extractText(message.content, "thinking");
}

function formatToolPreview(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const path = (value as { path?: unknown }).path;
    if (typeof path === "string") return path;
  }
  try {
    const preview = JSON.stringify(value);
    if (!preview || preview === "{}") return "";
    return preview.length > 120 ? `${preview.slice(0, 117)}...` : preview;
  } catch {
    return "";
  }
}

function summarizeToolResult(value: unknown, maxLength = 400): { content: string; truncated: boolean } {
  let content = "";
  if (value && typeof value === "object") {
    const toolValue = value as { content?: Array<{ type?: string; text?: string }>; error?: unknown; message?: unknown };
    if (Array.isArray(toolValue.content)) {
      content = toolValue.content
        .filter((p): p is { type: string; text: string } => p.type === "text" && typeof p.text === "string")
        .map((p) => p.text)
        .join("\n")
        .trim();
    }
    if (!content && typeof toolValue.error === "string") content = toolValue.error;
    if (!content && typeof toolValue.message === "string") content = toolValue.message;
  }
  if (!content) {
    if (typeof value === "string") content = value;
    else if (value !== undefined) {
      try { content = JSON.stringify(value, null, 2); } catch { content = String(value); }
    }
  }
  if (!content) content = "(no tool output)";
  const truncated = content.length > maxLength;
  return {
    content: truncated ? `${content.slice(0, maxLength - 3)}...` : content,
    truncated,
  };
}

// ─── Turn tracking ──────────────────────────────────────────────────────────

// ─── Event-driven transcript construction ────────────────────────────────────

function applyAssistantMessageToTranscript(
  state: BtwTranscriptState,
  turnId: number,
  message: AssistantMessage,
  streaming: boolean,
): void {
  const thinking = extractThinking(message);
  const answer = extractMessageText(message);
  if (thinking) upsertTranscriptTextEntry(state, turnId, "thinking", thinking, streaming);
  if (answer) upsertTranscriptTextEntry(state, turnId, "assistant-text", answer, streaming);
}

function upsertUserMessageEntry(state: BtwTranscriptState, turnId: number, text: string): void {
  if (!text) return;
  const existing = findLatestTranscriptEntry(state, turnId, "user-message");
  if (existing) { (existing as { text: string }).text = text; return; }
  appendTranscriptEntry(state, { type: "user-message", turnId, text } as Omit<Extract<BtwTranscriptEntry, { type: "user-message" }>, "id">);
}

function upsertTranscriptTextEntry(
  state: BtwTranscriptState,
  turnId: number,
  type: "thinking" | "assistant-text",
  text: string,
  streaming: boolean,
): void {
  if (!text) return;
  const existing = findLatestTranscriptEntry(state, turnId, type);
  if (existing) {
    (existing as { text: string; streaming: boolean }).text = text;
    (existing as { text: string; streaming: boolean }).streaming = streaming;
    return;
  }
  appendTranscriptEntry(state, { type, turnId, text, streaming } as Omit<Extract<BtwTranscriptEntry, { type: "thinking" | "assistant-text" }>, "id">);
}

function ensureToolCallEntry(
  state: BtwTranscriptState,
  turnId: number,
  toolCallId: string,
  toolName: string,
  args: string,
): { turnId: number; callEntryId: number; resultEntryId?: number } {
  const existing = state.toolCalls.get(toolCallId);
  if (existing) return existing;
  const callEntry = appendTranscriptEntry(state, {
    type: "tool-call",
    turnId,
    toolCallId,
    toolName,
    args,
  } as Omit<Extract<BtwTranscriptEntry, { type: "tool-call" }>, "id">);
  const record = { turnId, callEntryId: callEntry.id };
  state.toolCalls.set(toolCallId, record);
  return record;
}

function upsertToolResultEntry(
  state: BtwTranscriptState,
  turnId: number,
  toolCallId: string,
  toolName: string,
  content: string,
  truncated: boolean,
  isError: boolean,
  streaming: boolean,
): void {
  const toolCall = ensureToolCallEntry(state, turnId, toolCallId, toolName, "");
  const existing = toolCall.resultEntryId !== undefined
    ? state.entries.find((e) => e.id === toolCall.resultEntryId && e.type === "tool-result")
    : undefined;
  if (existing && existing.type === "tool-result") {
    existing.content = content;
    existing.truncated = truncated;
    existing.isError = isError;
    existing.streaming = streaming;
    return;
  }
  const resultEntry = appendTranscriptEntry(state, {
    type: "tool-result",
    turnId,
    toolCallId,
    toolName,
    content,
    truncated,
    isError,
    streaming,
  } as Omit<Extract<BtwTranscriptEntry, { type: "tool-result" }>, "id">);
  toolCall.resultEntryId = resultEntry.id;
}

export function applyTranscriptEvent(state: BtwTranscriptState, event: AgentSessionEvent): void {
  switch (event.type) {
    case "turn_start":
      ensureTranscriptTurn(state);
      return;
    case "message_start":
      if (event.message.role === "user") {
        const turnId = ensureTranscriptTurnForUserMessage(state);
        upsertUserMessageEntry(state, turnId, extractMessageText(event.message));
        return;
      }
      if (event.message.role === "assistant") {
        const turnId = ensureTranscriptTurn(state);
        applyAssistantMessageToTranscript(state, turnId, event.message, true);
      }
      return;
    case "message_update":
      if (event.message.role !== "assistant") return;
      applyAssistantMessageToTranscript(state, ensureTranscriptTurn(state), event.message, true);
      return;
    case "message_end":
      if (event.message.role === "user") {
        upsertUserMessageEntry(state, ensureTranscriptTurnForUserMessage(state), extractMessageText(event.message));
        return;
      }
      if (event.message.role === "assistant") {
        applyAssistantMessageToTranscript(state, ensureTranscriptTurn(state), event.message, false);
      }
      return;
    case "tool_execution_start":
      ensureToolCallEntry(state, ensureTranscriptTurn(state), event.toolCallId, event.toolName, formatToolPreview(event.args));
      return;
    case "tool_execution_update": {
      const turnId = state.toolCalls.get(event.toolCallId)?.turnId ?? ensureTranscriptTurn(state);
      const result = summarizeToolResult(event.partialResult);
      upsertToolResultEntry(state, turnId, event.toolCallId, event.toolName, result.content, result.truncated, false, true);
      return;
    }
    case "tool_execution_end": {
      const turnId = state.toolCalls.get(event.toolCallId)?.turnId ?? ensureTranscriptTurn(state);
      const result = summarizeToolResult(event.result);
      upsertToolResultEntry(state, turnId, event.toolCallId, event.toolName, result.content, result.truncated, event.isError, false);
      return;
    }
    case "turn_end":
      finishTranscriptTurn(state);
      return;
    default:
      return;
  }
}

// ─── Persisted thread restore ────────────────────────────────────────────────

export function appendPersistedTranscriptTurn(state: BtwTranscriptState, details: BtwDetails): void {
  const turnId = ensureTranscriptTurn(state);
  upsertUserMessageEntry(state, turnId, details.question);
  if (details.thinking) upsertTranscriptTextEntry(state, turnId, "thinking", details.thinking, false);
  upsertTranscriptTextEntry(state, turnId, "assistant-text", details.answer, false);
  finishTranscriptTurn(state, turnId);
}

export function setTranscriptFailure(state: BtwTranscriptState, message: string): void {
  const turnId = state.currentTurnId ?? state.lastTurnId ?? ensureTranscriptTurn(state);
  upsertTranscriptTextEntry(state, turnId, "assistant-text", `❌ ${message}`, false);
  finishTranscriptTurn(state, turnId);
}

// ─── Transcript queries ─────────────────────────────────────────────────────
