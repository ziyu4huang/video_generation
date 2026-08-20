/**
 * BTW — side conversation channel — shared types.
 *
 * Adapted from pi-btw (MIT, Dan Bachelder). These types describe the BTW
 * sub-session thread model, transcript entries, overlay state, and handoff
 * structures.
 */
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Message, ThinkingLevel as AiThinkingLevel, UserMessage } from "@earendil-works/pi-ai";

// ─── Session types ───────────────────────────────────────────────────────────

export type SessionThinkingLevel = "off" | AiThinkingLevel;
export type BtwThreadMode = "contextual" | "tangent";
export type SessionModel = NonNullable<ExtensionCommandContext["model"]>;

/** Loose model reference parsed from `/btw:model <provider> <id> <api>`. */
export type BtwModelRef = Pick<SessionModel, "provider" | "id" | "api">;

/** Persisted payload for one BTW exchange. */
export type BtwDetails = {
  question: string;
  thinking: string;
  answer: string;
  provider: string;
  model: string;
  api: string;
  thinkingLevel: SessionThinkingLevel;
  timestamp: number;
  usage?: AssistantMessage["usage"];
};

export type SaveState = "not-saved" | "saved" | "queued";

export type BtwResetDetails = {
  timestamp: number;
  mode?: BtwThreadMode;
};

export type BtwModelOverrideDetails =
  | ({ timestamp: number; action: "set" } & Pick<SessionModel, "provider" | "id" | "api">)
  | { timestamp: number; action: "clear" };

export type BtwThinkingOverrideDetails =
  | { timestamp: number; action: "set"; thinkingLevel: SessionThinkingLevel }
  | { timestamp: number; action: "clear" };

// ─── Resolved model/settings ─────────────────────────────────────────────────

export type ResolvedBtwModel = {
  model: SessionModel | null;
  source: "override" | "main" | "none";
  configuredOverride: SessionModel | null;
  fallbackReason?: string;
};

export type ResolvedBtwSettings = {
  model: SessionModel | null;
  modelSource: "override" | "main" | "none";
  configuredModelOverride: SessionModel | null;
  thinkingLevel: SessionThinkingLevel;
  thinkingSource: "override" | "main";
  fallbackReason?: string;
};

// ─── Transcript types (for overlay rendering) ────────────────────────────────

export type BtwTranscriptEntry =
  | { id: number; turnId: number; type: "turn-boundary"; phase: "start" | "end" }
  | { id: number; turnId: number; type: "user-message"; text: string }
  | { id: number; turnId: number; type: "thinking"; text: string; streaming: boolean }
  | { id: number; turnId: number; type: "assistant-text"; text: string; streaming: boolean }
  | { id: number; turnId: number; type: "tool-call"; toolCallId: string; toolName: string; args: string }
  | {
      id: number;
      turnId: number;
      type: "tool-result";
      toolCallId: string;
      toolName: string;
      content: string;
      truncated: boolean;
      isError: boolean;
      streaming: boolean;
    };

export type BtwTranscript = BtwTranscriptEntry[];

export type BtwTranscriptState = {
  entries: BtwTranscript;
  nextEntryId: number;
  nextTurnId: number;
  currentTurnId: number | null;
  lastTurnId: number | null;
  toolCalls: Map<string, { turnId: number; callEntryId: number; resultEntryId?: number }>;
};

// ─── Handoff types ───────────────────────────────────────────────────────────

export type BtwHandoffExchange = {
  user: string;
  assistant: string;
};

// ─── Overlay runtime ─────────────────────────────────────────────────────────

export type OverlayRuntime = {
  handle?: { setHidden: (h: boolean) => void; isFocused: () => boolean; focus: () => void; unfocus: () => void; hide: () => void };
  refresh?: () => void;
  close?: () => void;
  finish?: () => void;
  setDraft?: (value: string) => void;
  closed?: boolean;
};

// ─── Parsed args ─────────────────────────────────────────────────────────────

export type ParsedBtwArgs = {
  question: string;
  save: boolean;
};
