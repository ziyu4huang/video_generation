/**
 * BTW — side conversation channel — session management.
 *
 * Adapted from pi-btw (MIT, Dan Bachelder). Manages the BTW sub-session
 * lifecycle: creation, model/thinking override resolution, thread persistence,
 * handoff inject/summarize, and overlay orchestration.
 */

import {
  buildSessionContext,
  createAgentSession,
  createExtensionRuntime,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Message, UserMessage } from "@earendil-works/pi-ai";
import type {
  BtwDetails,
  BtwHandoffExchange,
  BtwThreadMode,
  OverlayRuntime,
  ParsedBtwArgs,
  ResolvedBtwSettings,
  SaveState,
  SessionModel,
  SessionThinkingLevel,
} from "./types";
import {
  BTW_ENTRY_TYPE,
  BTW_MESSAGE_TYPE,
  BTW_MODEL_OVERRIDE_TYPE,
  BTW_RESET_TYPE,
  BTW_THINKING_OVERRIDE_TYPE,
} from "./constants";
import {
  BTW_EVENT_CHANNEL,
  type BtwEvent,
  type BtwThreadState,
} from "./webui-events";
import {
  snapshotsFromDetails,
  snapshotsFromMessages,
  statusFromEvent,
  type BtwStatusUpdate,
} from "./snapshot";
import {
  applyTranscriptEvent,
  appendPersistedTranscriptTurn,
  createEmptyTranscriptState,
  findLatestTranscriptEntry,
  setTranscriptFailure,
} from "./transcript";
import type { BtwTranscriptState } from "./types";
import { BtwOverlayComponent, matchesBtwFocusShortcut } from "./overlay";

// ─── System prompts ──────────────────────────────────────────────────────────

const BTW_SYSTEM_PROMPT = [
  "You are having an aside conversation with the user, separate from their main working session.",
  "If main session messages are provided, they are for context only — that work is being handled by another agent.",
  "If no main session messages are provided, treat this as a fully contextless tangent thread and rely only on the user's words plus your general instructions.",
  "Focus on answering the user's side questions, helping them think through ideas, or planning next steps.",
  "Do not act as if you need to continue unfinished work from the main session unless the user explicitly asks you to prepare something for injection back to it.",
].join(" ");

const BTW_SUMMARIZE_SYSTEM_PROMPT =
  "Summarize the side conversation concisely. Preserve key decisions, plans, insights, risks, and action items. Output only the summary.";

const BTW_CONTINUE_THREAD_USER_TEXT = "[The following is a separate side conversation. Continue this thread.]";
const BTW_CONTINUE_THREAD_ASSISTANT_TEXT = "Understood, continuing our side conversation.";

// ─── Resource loader ─────────────────────────────────────────────────────────

function stripDynamicSystemPromptFooter(systemPrompt: string): string {
  return systemPrompt
    .replace(/\nCurrent date and time:[^\n]*(?:\nCurrent working directory:[^\n]*)?$/u, "")
    .replace(/\nCurrent working directory:[^\n]*$/u, "")
    .trim();
}

function createBtwResourceLoader(
  ctx: ExtensionCommandContext,
  appendSystemPrompt: string[] = [BTW_SYSTEM_PROMPT],
): ResourceLoader {
  const extensionsResult = { extensions: [], errors: [] as { path: string; error: string }[], runtime: createExtensionRuntime() };
  return {
    getExtensions: () => extensionsResult,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => stripDynamicSystemPromptFooter(ctx.getSystemPrompt()),
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => appendSystemPrompt,
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function extractMessageText(message: { content?: string | AssistantMessage["content"] | UserMessage["content"] }): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
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

function extractAnswer(message: AssistantMessage): string {
  return extractText(message.content, "text") || "(No text response)";
}

function extractThinking(message: AssistantMessage): string {
  return extractText(message.content, "thinking");
}

function isVisibleBtwMessage(message: { role: string; customType?: string }): boolean {
  return message.role === "custom" && message.customType === BTW_MESSAGE_TYPE;
}

function isCustomEntry(entry: unknown, customType: string): boolean {
  return (
    !!entry &&
    typeof entry === "object" &&
    (entry as Record<string, unknown>).type === "custom" &&
    (entry as Record<string, unknown>).customType === customType
  );
}

function getLastAssistantMessage(session: AgentSession): AssistantMessage | null {
  for (let i = session.state.messages.length - 1; i >= 0; i--) {
    const msg = session.state.messages[i];
    if (msg.role === "assistant") return msg as AssistantMessage;
  }
  return null;
}

function buildBtwMessageContent(question: string, answer: string): string {
  return `Q: ${question}\n\nA: ${answer}`;
}

function formatThread(thread: BtwHandoffExchange[]): string {
  return thread.map((e) => `User: ${e.user.trim()}\nAssistant: ${e.assistant.trim()}`).join("\n\n---\n\n");
}

function isThreadContinuationMarker(messages: Message[], index: number): boolean {
  const userMsg = messages[index];
  const assistantMsg = messages[index + 1];
  return (
    userMsg?.role === "user" &&
    extractMessageText(userMsg) === BTW_CONTINUE_THREAD_USER_TEXT &&
    assistantMsg?.role === "assistant" &&
    extractMessageText(assistantMsg) === BTW_CONTINUE_THREAD_ASSISTANT_TEXT
  );
}

function extractBtwHandoffThread(
  sessionRuntime: BtwSessionRuntime,
  pendingThread: BtwDetails[],
): BtwHandoffExchange[] {
  const handoffMessages = sessionRuntime.session.state.messages.slice(sessionRuntime.sideThreadStartIndex);
  const threadMessages = isThreadContinuationMarker(handoffMessages as Message[], 0)
    ? handoffMessages.slice(2)
    : handoffMessages;
  const exchanges: BtwHandoffExchange[] = [];
  let currentUser = "";
  let currentAssistant = "";

  const pushCurrent = () => {
    if (!currentUser && !currentAssistant) return;
    exchanges.push({
      user: currentUser.trim() || "(No user prompt)",
      assistant: currentAssistant.trim() || "(No assistant response)",
    });
    currentUser = ""; currentAssistant = "";
  };

  for (const msg of threadMessages) {
    if (msg.role !== "user" && msg.role !== "assistant") continue;
    const text = extractMessageText(msg).trim();
    if (!text) continue;
    if (msg.role === "user") { pushCurrent(); currentUser = text; continue; }
    currentAssistant = currentAssistant ? `${currentAssistant}\n\n${text}` : text;
  }
  pushCurrent();
  return exchanges;
}

function formatModelRef(model: Pick<SessionModel, "provider" | "id" | "api">): string {
  return `${model.provider}/${model.id} (${model.api})`;
}

function notify(ctx: ExtensionContext | ExtensionCommandContext, message: string, level: "info" | "warning" | "error"): void {
  if (ctx.hasUI) ctx.ui.notify(message, level);
}

function parseBtwArgs(args: string): ParsedBtwArgs {
  const save = /(?:^|\s)(?:--save|-s)(?=\s|$)/.test(args);
  const question = args.replace(/(?:^|\s)(?:--save|-s)(?=\s|$)/g, " ").trim();
  return { question, save };
}

function parseBtwModelArgs(args: string):
  | { action: "show" }
  | { action: "clear" }
  | { action: "set"; model: { provider: string; id: string; api: string } }
  | { action: "invalid"; message: string } {
  const trimmed = args.trim();
  if (!trimmed) return { action: "show" };
  if (trimmed === "clear") return { action: "clear" };
  const parts = trimmed.split(/\s+/);
  if (parts.length !== 3) return { action: "invalid", message: "Usage: /btw:model <provider> <model> <api> | clear" };
  return { action: "set", model: { provider: parts[0], id: parts[1], api: parts[2] } };
}

function parseBtwThinkingArgs(args: string):
  | { action: "show" }
  | { action: "clear" }
  | { action: "set"; thinkingLevel: SessionThinkingLevel } {
  const trimmed = args.trim();
  if (!trimmed) return { action: "show" };
  if (trimmed === "clear") return { action: "clear" };
  return { action: "set", thinkingLevel: trimmed as SessionThinkingLevel };
}

// ─── BtwSessionRuntime ───────────────────────────────────────────────────────

export type BtwSessionRuntime = {
  session: AgentSession;
  mode: BtwThreadMode;
  subscriptions: Set<() => void>;
  sideThreadStartIndex: number;
};

// ─── BtwEngine: the stateful engine for one BTW lifecycle ─────────────────────

export class BtwEngine {
  // ── State ────────────────────────────────────────────────────────────────
  pendingThread: BtwDetails[] = [];
  pendingMode: BtwThreadMode = "contextual";
  btwModelOverride: SessionModel | null = null;
  btwThinkingOverride: SessionThinkingLevel | null = null;
  transcriptState = createEmptyTranscriptState();
  overlayStatus: string | null = null;
  overlayDraft = "";
  overlayRuntime: OverlayRuntime | null = null;
  lastUiContext: ExtensionContext | ExtensionCommandContext | null = null;
  activeBtwSession: BtwSessionRuntime | null = null;
  /** Latest ExtensionCommandContext seen at session_start/session_tree; the webui command channel carries no ctx. */
  private latestCtx: ExtensionCommandContext | null = null;
  /** Status override for the last live message, derived from sub-session events. */
  private webuiStatus: BtwStatusUpdate | null = null;
  /** The BtwSessionRuntime currently bridged to the webui event channel. */
  private webuiBridgedFor: BtwSessionRuntime | null = null;
  /**
   * Disposer for the active webui bridge subscription. Deliberately NOT stored in
   * sr.subscriptions: the overlay attach guard in subscribeOverlayToActiveBtwSession
   * treats a non-empty set as "overlay already attached", which would silently kill
   * TUI live updates for every sub-session created after the bridge (Task 3 fix).
   */
  private webuiBridgeUnsub: (() => void) | null = null;

  constructor(private readonly pi: ExtensionAPI) {}

  // ── Sync UI ──────────────────────────────────────────────────────────────

  syncUi(ctx?: ExtensionContext | ExtensionCommandContext): void {
    const activeCtx = ctx ?? this.lastUiContext;
    if (activeCtx?.hasUI) {
      activeCtx.ui.setWidget("btw", undefined);
      this.overlayRuntime?.refresh?.();
    }
  }

  setOverlayStatus(status: string | null, ctx?: ExtensionContext | ExtensionCommandContext): void {
    this.overlayStatus = status;
    this.syncUi(ctx);
  }

  setOverlayDraft(value: string): void {
    this.overlayDraft = value;
    this.overlayRuntime?.setDraft?.(value);
  }

  dismissOverlay(): void {
    this.overlayRuntime?.close?.();
    this.overlayRuntime = null;
  }

  toggleOverlayFocus(): void {
    const handle = this.overlayRuntime?.handle;
    if (!handle) return;
    handle.setHidden(false);
    if (handle.isFocused()) handle.unfocus(); else handle.focus();
    this.overlayRuntime?.refresh?.();
  }

  focusOverlay(): void {
    const handle = this.overlayRuntime?.handle;
    if (!handle) return;
    handle.setHidden(false);
    handle.focus();
    this.overlayRuntime?.refresh?.();
  }

  // ── Session lifecycle ────────────────────────────────────────────────────

  private removeBtwSessionSubscription(sessionRuntime: BtwSessionRuntime, unsubscribe: () => void): void {
    if (!sessionRuntime.subscriptions.delete(unsubscribe)) return;
    try { unsubscribe(); } catch { /* ignore */ }
  }

  clearBtwSessionSubscriptions(sessionRuntime: BtwSessionRuntime): void {
    for (const unsub of [...sessionRuntime.subscriptions]) this.removeBtwSessionSubscription(sessionRuntime, unsub);
  }

  private handleBtwSessionEvent(
    sessionRuntime: BtwSessionRuntime,
    event: AgentSessionEvent,
    ctx?: ExtensionContext | ExtensionCommandContext,
  ): void {
    if (this.activeBtwSession?.session !== sessionRuntime.session || !this.overlayRuntime) return;
    applyTranscriptEvent(this.transcriptState, event);
    if (event.type === "tool_execution_start") { this.setOverlayStatus(`⏳ running tool: ${event.toolName}`, ctx); return; }
    if (event.type === "tool_execution_end") { this.setOverlayStatus(sessionRuntime.session.isStreaming ? `⏳ running tool: ${event.toolName}` : "⏳ streaming...", ctx); return; }
    if (event.type === "turn_end") { this.setOverlayStatus("⏳ streaming...", ctx); return; }
    if (event.type === "message_start" || event.type === "message_update" || event.type === "message_end" || event.type === "turn_start") this.syncUi(ctx);
  }

  subscribeOverlayToActiveBtwSession(ctx?: ExtensionContext | ExtensionCommandContext): void {
    const sr = this.activeBtwSession;
    if (!sr || sr.subscriptions.size > 0) return;
    const unsub = sr.session.subscribe((event: AgentSessionEvent) => this.handleBtwSessionEvent(sr, event, ctx));
    sr.subscriptions.add(unsub);
  }

  // ── Webui bridge (event-bus seam; independent of the TUI overlay path) ───

  /** Record the ctx the webui command handler should use (set from session_start/session_tree). */
  setLatestCtx(ctx: ExtensionCommandContext): void {
    this.latestCtx = ctx;
  }

  /**
   * Webui bridge: an ADDITIONAL session subscription (separate from the overlay's)
   * that pre-reduces each sub-session event into a thread snapshot and emits it on
   * BTW_EVENT_CHANNEL. Never touches applyTranscriptEvent / setOverlayStatus / syncUi.
   */
  subscribeWebuiBridge(sr: BtwSessionRuntime): void {
    if (this.webuiBridgedFor === sr) return;
    this.webuiBridgeUnsub?.();
    this.webuiBridgedFor = sr;
    this.webuiStatus = null;
    const dispose = sr.session.subscribe((event: AgentSessionEvent) => {
      const update = statusFromEvent(event);
      if (update) this.webuiStatus = update;
      this.emitThreadEvent();
    });
    // Tracked in a dedicated field (not sr.subscriptions) so the overlay attach
    // guard in subscribeOverlayToActiveBtwSession still sees an empty set.
    this.webuiBridgeUnsub = () => {
      if (this.webuiBridgedFor === sr) this.webuiBridgedFor = null;
      dispose();
    };
  }

  /** Current thread state, pre-reduced for the webui panel (D5). */
  buildThreadState(): BtwThreadState {
    const messages = this.activeBtwSession
      ? snapshotsFromMessages(
          this.activeBtwSession.session.agent.state.messages.slice(
            this.activeBtwSession.sideThreadStartIndex,
          ),
          this.webuiStatus,
        )
      : snapshotsFromDetails(this.pendingThread);
    return {
      messages,
      mode: this.pendingMode,
      model: this.btwModelOverride
        ? {
            provider: this.btwModelOverride.provider,
            id: this.btwModelOverride.id,
            api: this.btwModelOverride.api,
          }
        : null,
      thinking: this.btwThinkingOverride,
    };
  }

  /** Emit the current thread snapshot on the webui event channel. */
  emitThreadEvent(): void {
    const event: BtwEvent = { type: "thread", state: this.buildThreadState() };
    this.pi.events?.emit(BTW_EVENT_CHANNEL, event);
  }

  /** Emit a one-line notice (inject confirmation, summarize output, errors). */
  emitNotice(text: string): void {
    const event: BtwEvent = { type: "notice", text };
    this.pi.events?.emit(BTW_EVENT_CHANNEL, event);
  }

  async disposeBtwSession(): Promise<void> {
    const current = this.activeBtwSession;
    this.activeBtwSession = null;
    this.webuiStatus = null;
    this.webuiBridgeUnsub?.();
    this.webuiBridgeUnsub = null;
    if (!current) return;
    this.clearBtwSessionSubscriptions(current);
    try { await current.session.abort(); } catch { /* ignore */ }
    current.session.dispose();
    this.emitThreadEvent();
  }

  async dismissOverlaySession(): Promise<void> {
    this.dismissOverlay();
    await this.disposeBtwSession();
  }

  // ── Model resolution ─────────────────────────────────────────────────────

  async resolveBtwSettings(ctx: ExtensionCommandContext, notifyOnFallback = false): Promise<ResolvedBtwSettings> {
    const modelResult = await this.resolveBtwModel(ctx, notifyOnFallback);
    const thinkingLevel = this.btwThinkingOverride ?? (this.pi.getThinkingLevel() as SessionThinkingLevel);
    return {
      model: modelResult.model,
      modelSource: modelResult.source,
      configuredModelOverride: modelResult.configuredOverride,
      thinkingLevel,
      thinkingSource: this.btwThinkingOverride ? "override" : "main",
      fallbackReason: modelResult.fallbackReason,
    };
  }

  private async resolveBtwModel(ctx: ExtensionCommandContext, notifyOnFallback = false) {
    if (this.btwModelOverride) {
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(this.btwModelOverride);
      if (auth.ok && auth.apiKey) {
        return { model: this.btwModelOverride, source: "override" as const, configuredOverride: this.btwModelOverride };
      }
      const reason = ctx.model
        ? `Configured BTW model ${formatModelRef(this.btwModelOverride)} has no credentials. Falling back to main model ${formatModelRef(ctx.model)}.`
        : `Configured BTW model ${formatModelRef(this.btwModelOverride)} has no credentials, and no main model is active.`;
      if (notifyOnFallback) notify(ctx, reason, "warning");
      if (ctx.model) return { model: ctx.model, source: "main" as const, configuredOverride: this.btwModelOverride, fallbackReason: reason };
      return { model: null, source: "none" as const, configuredOverride: this.btwModelOverride, fallbackReason: reason };
    }
    if (ctx.model) return { model: ctx.model, source: "main" as const, configuredOverride: null };
    return { model: null, source: "none" as const, configuredOverride: null };
  }

  describeResolvedModel(settings: ResolvedBtwSettings): string {
    if (!settings.model) {
      if (settings.configuredModelOverride && settings.fallbackReason) return `BTW model unavailable. ${settings.fallbackReason}`;
      return "BTW model unavailable. No active model selected.";
    }
    const source = settings.modelSource === "override" ? "override" : settings.configuredModelOverride ? "inherited fallback" : "inherits main thread";
    return `BTW model: ${formatModelRef(settings.model)} (${source}).${settings.fallbackReason ? ` ${settings.fallbackReason}` : ""}`;
  }

  describeResolvedThinking(settings: ResolvedBtwSettings): string {
    return `BTW thinking: ${settings.thinkingLevel} (${settings.thinkingSource === "override" ? "override" : "inherits main thread"}).`;
  }

  // ── Sub-session creation ─────────────────────────────────────────────────

  private buildBtwSeedState(ctx: ExtensionCommandContext): { messages: Message[]; sideThreadStartIndex: number } {
    const messages: Message[] = [];

    if (this.pendingMode === "contextual") {
      try {
        messages.push(
          ...(buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId()).messages as Message[]).filter(
            (m) => !isVisibleBtwMessage(m),
          ),
        );
      } catch {
        messages.push(
          ...ctx.sessionManager.getEntries().flatMap((entry) => {
            if (!entry || typeof entry !== "object") return [];
            const msg = entry as unknown as Partial<Message> & { role?: string; customType?: string; content?: unknown };
            if (typeof msg.role !== "string" || !Array.isArray(msg.content)) return [];
            return isVisibleBtwMessage({ role: msg.role, customType: msg.customType }) ? [] : [msg as Message];
          }),
        );
      }
    }

    const sideThreadStartIndex = messages.length;

    if (this.pendingThread.length > 0) {
      messages.push(
        { role: "user", content: [{ type: "text", text: BTW_CONTINUE_THREAD_USER_TEXT }], timestamp: Date.now() } as Message,
        {
          role: "assistant",
          content: [{ type: "text", text: BTW_CONTINUE_THREAD_ASSISTANT_TEXT }],
          provider: "unknown",
          model: "unknown",
          api: "openai-responses",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "stop",
          timestamp: Date.now(),
        } as AssistantMessage,
      );

      for (const entry of this.pendingThread) {
        messages.push(
          { role: "user", content: [{ type: "text", text: entry.question }], timestamp: entry.timestamp } as Message,
          {
            role: "assistant",
            content: [{ type: "text", text: entry.answer }],
            provider: entry.provider,
            model: entry.model,
            api: entry.api || "openai-responses",
            usage: entry.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: "stop",
            timestamp: entry.timestamp,
          } as AssistantMessage,
        );
      }
    }

    return { messages, sideThreadStartIndex };
  }

  async createBtwSubSession(ctx: ExtensionCommandContext): Promise<BtwSessionRuntime> {
    const settings = await this.resolveBtwSettings(ctx, true);
    if (!settings.model) throw new Error(settings.fallbackReason || "No active model selected.");

    const { session } = await createAgentSession({
      sessionManager: SessionManager.inMemory(),
      model: settings.model,
      thinkingLevel: settings.thinkingLevel,
      tools: ["read", "bash", "edit", "write"],
      resourceLoader: createBtwResourceLoader(ctx),
    });

    const { messages: seedMessages, sideThreadStartIndex } = this.buildBtwSeedState(ctx);
    if (seedMessages.length > 0) {
      session.agent.state.messages = seedMessages as typeof session.state.messages;
    }

    const sr: BtwSessionRuntime = { session, mode: this.pendingMode, subscriptions: new Set(), sideThreadStartIndex };
    this.subscribeWebuiBridge(sr);
    return sr;
  }

  async ensureBtwSession(ctx: ExtensionCommandContext): Promise<BtwSessionRuntime | null> {
    const settings = await this.resolveBtwSettings(ctx);
    if (!settings.model) return null;
    if (this.activeBtwSession?.mode === this.pendingMode) return this.activeBtwSession;
    await this.disposeBtwSession();
    this.activeBtwSession = await this.createBtwSubSession(ctx);
    return this.activeBtwSession;
  }

  // ── Overlay ──────────────────────────────────────────────────────────────

  async ensureOverlay(ctx: ExtensionCommandContext | ExtensionContext): Promise<void> {
    if (!ctx.hasUI) return;
    this.lastUiContext = ctx;
    if (this.overlayRuntime?.handle) { this.subscribeOverlayToActiveBtwSession(ctx); this.focusOverlay(); return; }

    const engine = this;
    const runtime: OverlayRuntime = {};
    const closeRuntime = () => {
      if (runtime.closed) return;
      runtime.closed = true;
      if (engine.activeBtwSession) engine.clearBtwSessionSubscriptions(engine.activeBtwSession);
      runtime.handle?.hide();
      if (engine.overlayRuntime === runtime) engine.overlayRuntime = null;
      runtime.finish?.();
    };
    runtime.close = closeRuntime;
    engine.overlayRuntime = runtime;

    void ctx.ui
      .custom<void>(
        (tui, theme, keybindings, done) => {
          runtime.finish = done;

          const overlay = new BtwOverlayComponent(
            tui,
            theme,
            keybindings,
            () => engine.transcriptState.entries,
            () => engine.overlayStatus,
            () => engine.pendingMode,
            (value) => { void engine.submitFromOverlay(ctx, value); },
            () => { void engine.dismissOverlaySession(); },
            () => { engine.overlayRuntime?.handle?.unfocus(); engine.overlayRuntime?.refresh?.(); },
          );

          overlay.focused = runtime.handle?.isFocused() ?? true;
          overlay.setDraft(engine.overlayDraft);
          runtime.setDraft = (v: string) => overlay.setDraft(v);
          runtime.refresh = () => { overlay.focused = runtime.handle?.isFocused() ?? false; overlay.refresh(); };
          runtime.close = () => { engine.overlayDraft = overlay.getDraft(); overlay.dispose(); closeRuntime(); };

          engine.subscribeOverlayToActiveBtwSession(ctx);
          if (runtime.closed) done();
          return overlay;
        },
        {
          overlay: true,
          overlayOptions: {
            width: "78%",
            minWidth: 72,
            maxHeight: "78%",
            anchor: "top-center",
            margin: { top: 1, left: 2, right: 2 },
            nonCapturing: true,
          },
          onHandle: (handle) => {
            runtime.handle = {
              setHidden: (h: boolean) => { if (h) handle.hide(); else handle.setHidden(false); },
              isFocused: () => handle.isFocused(),
              focus: () => handle.focus(),
              unfocus: () => handle.unfocus(),
              hide: () => handle.hide(),
            };
            handle.focus();
            if (runtime.closed) closeRuntime();
          },
        },
      )
      .catch((error: unknown) => {
        if (engine.overlayRuntime === runtime) engine.overlayRuntime = null;
        notify(ctx, error instanceof Error ? error.message : String(error), "error");
      });
  }

  // ── Overlay submit ───────────────────────────────────────────────────────

  parseOverlayBtwCommand(value: string): { name: string; args: string } | null {
    const trimmed = value.trim();
    const m = trimmed.match(/^\/(btw:(?:new|tangent|clear|inject|summarize|model|thinking))(?:\s+(.*))?$/);
    if (!m) return null;
    return { name: m[1], args: m[2]?.trim() ?? "" };
  }

  async submitFromOverlay(ctx: ExtensionCommandContext | ExtensionContext, value: string): Promise<void> {
    const question = value.trim();
    if (!question) { this.setOverlayStatus("Enter a BTW prompt before submitting.", ctx); return; }
    if (!("getSystemPrompt" in ctx)) { this.setOverlayStatus("BTW overlay submit requires a command context.", ctx); return; }

    const cmdCtx = ctx as ExtensionCommandContext;
    const btwCmd = this.parseOverlayBtwCommand(question);
    if (btwCmd) { this.setOverlayDraft(""); await this.dispatchBtwCommand(btwCmd.name, btwCmd.args, cmdCtx); return; }

    this.setOverlayDraft("");
    this.setOverlayStatus("⏳ streaming...", ctx);
    this.syncUi(ctx);
    await this.runBtw(cmdCtx, question, false);
  }

  // ── Thread management ────────────────────────────────────────────────────

  async resetThread(ctx: ExtensionContext | ExtensionCommandContext, persist = true): Promise<void> {
    await this.disposeBtwSession();
    this.pendingThread = [];
    this.transcriptState = createEmptyTranscriptState();
    this.setOverlayDraft("");
    this.setOverlayStatus(null, ctx);
    if (persist) this.pi.appendEntry(BTW_RESET_TYPE, { timestamp: Date.now(), mode: this.pendingMode });
    this.syncUi(ctx);
  }

  async restoreThread(ctx: ExtensionContext): Promise<void> {
    await this.disposeBtwSession();
    this.pendingThread = [];
    this.pendingMode = "contextual";
    this.btwModelOverride = null;
    this.btwThinkingOverride = null;
    this.transcriptState = createEmptyTranscriptState();
    this.overlayDraft = "";
    this.lastUiContext = ctx;
    this.overlayStatus = null;

    const branch = ctx.sessionManager.getBranch();
    let lastResetIndex = -1;

    for (let i = 0; i < branch.length; i++) {
      const entry = branch[i];
      if (isCustomEntry(entry, BTW_MODEL_OVERRIDE_TYPE)) {
        const details = (entry as { data?: unknown }).data as { action?: string; provider?: string; id?: string; api?: string } | undefined;
        if (details?.action === "set" && details.provider && details.id) {
          const resolved = ctx.modelRegistry.find(details.provider, details.id);
          if (resolved) this.btwModelOverride = resolved; else this.btwModelOverride = null;
        } else if (details?.action === "clear") this.btwModelOverride = null;
      }
      if (isCustomEntry(entry, BTW_THINKING_OVERRIDE_TYPE)) {
        const details = (entry as { data?: unknown }).data as { action?: string; thinkingLevel?: SessionThinkingLevel } | undefined;
        this.btwThinkingOverride = details?.action === "set" ? (details.thinkingLevel ?? this.btwThinkingOverride) : details?.action === "clear" ? null : this.btwThinkingOverride;
      }
      if (isCustomEntry(entry, BTW_RESET_TYPE)) {
        lastResetIndex = i;
        const details = (entry as { data?: unknown }).data as { mode?: BtwThreadMode } | undefined;
        this.pendingMode = details?.mode ?? "contextual";
      }
    }

    for (const entry of branch.slice(lastResetIndex + 1)) {
      if (!isCustomEntry(entry, BTW_ENTRY_TYPE)) continue;
      const details = (entry as { data?: BtwDetails }).data;
      if (!details?.question || !details.answer) continue;
      const normalized: BtwDetails = { ...details, api: details.api || "openai-responses" };
      this.pendingThread.push(normalized);
      appendPersistedTranscriptTurn(this.transcriptState, normalized);
    }

    this.syncUi(ctx);
  }

  // ── Run BTW ──────────────────────────────────────────────────────────────

  private getPendingThreadForHandoff(): BtwHandoffExchange[] {
    return this.pendingThread.map((e) => ({ user: e.question, assistant: e.answer }));
  }

  async getBtwHandoffThread(ctx: ExtensionCommandContext): Promise<{ sessionRuntime: BtwSessionRuntime | null; thread: BtwHandoffExchange[] }> {
    const sessionRuntime = this.activeBtwSession ?? (await this.ensureBtwSession(ctx));
    const thread = sessionRuntime ? extractBtwHandoffThread(sessionRuntime, this.pendingThread) : [];
    const resolvedThread = thread.length > 0 ? thread : this.getPendingThreadForHandoff();
    if (resolvedThread.length === 0) throw new Error("No BTW thread available for handoff.");
    return { sessionRuntime, thread: resolvedThread };
  }

  async summarizeThread(ctx: ExtensionCommandContext, thread: BtwHandoffExchange[]): Promise<string> {
    const settings = await this.resolveBtwSettings(ctx, true);
    const model = settings.model;
    if (!model) throw new Error(settings.fallbackReason || "No active model selected.");
    // Only check credentials for override models — inherited models already work.
    if (settings.modelSource === "override") {
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok || !auth.apiKey) throw new Error(auth.ok ? `No credentials available for ${model.provider}/${model.id}.` : auth.error);
    }

    const { session } = await createAgentSession({
      sessionManager: SessionManager.inMemory(),
      model,
      thinkingLevel: "off",
      tools: [],
      resourceLoader: createBtwResourceLoader(ctx, [BTW_SUMMARIZE_SYSTEM_PROMPT]),
    });

    try {
      await session.prompt(formatThread(thread), { source: "extension" });
      const response = getLastAssistantMessage(session);
      if (!response) throw new Error("BTW summarize finished without a response.");
      if (response.stopReason === "error") throw new Error(response.errorMessage || "Failed to summarize BTW thread.");
      if (response.stopReason === "aborted") throw new Error("BTW summarize aborted.");
      return extractAnswer(response);
    } finally {
      try { await session.abort(); } catch { /* ignore */ }
      session.dispose();
    }
  }

  sendThreadToMain(ctx: ExtensionCommandContext, content: string): void {
    if (ctx.isIdle()) this.pi.sendUserMessage(content);
    else this.pi.sendUserMessage(content, { deliverAs: "followUp" });
  }

  // ── Model override management ────────────────────────────────────────────

  async setBtwModelOverride(ctx: ExtensionCommandContext, nextModel: SessionModel | null): Promise<void> {
    this.btwModelOverride = nextModel;
    const details = nextModel
      ? { action: "set" as const, timestamp: Date.now(), provider: nextModel.provider, id: nextModel.id, api: nextModel.api }
      : { action: "clear" as const, timestamp: Date.now() };
    this.pi.appendEntry(BTW_MODEL_OVERRIDE_TYPE, details);
    await this.disposeBtwSession();
    const s = await this.resolveBtwSettings(ctx);
    const msg = nextModel ? `BTW model override set to ${formatModelRef(nextModel)}.` : "BTW model override cleared.";
    this.setOverlayStatus(msg, ctx);
    notify(ctx, `${msg} ${this.describeResolvedModel(s)}`, "info");
  }

  async setBtwThinkingOverride(ctx: ExtensionCommandContext, nextLevel: SessionThinkingLevel | null): Promise<void> {
    this.btwThinkingOverride = nextLevel;
    const details = nextLevel
      ? { action: "set" as const, timestamp: Date.now(), thinkingLevel: nextLevel }
      : { action: "clear" as const, timestamp: Date.now() };
    this.pi.appendEntry(BTW_THINKING_OVERRIDE_TYPE, details);
    await this.disposeBtwSession();
    const s = await this.resolveBtwSettings(ctx);
    const msg = nextLevel ? `BTW thinking override set to ${nextLevel}.` : "BTW thinking override cleared.";
    this.setOverlayStatus(msg, ctx);
    notify(ctx, `${msg} ${this.describeResolvedThinking(s)}`, "info");
  }

  // ── Command dispatch ─────────────────────────────────────────────────────

  async dispatchBtwCommand(name: string, args: string, ctx: ExtensionCommandContext): Promise<boolean> {
    const trimmedArgs = args.trim();

    if (name === "btw") {
      const { question, save } = parseBtwArgs(trimmedArgs);
      if (!question) { await this.ensureBtwSession(ctx); await this.ensureOverlay(ctx); return true; }
      if (this.pendingMode !== "contextual") { await this.resetThread(ctx, true); }
      await this.runBtw(ctx, question, save);
      return true;
    }

    if (name === "btw:tangent") {
      const { question, save } = parseBtwArgs(trimmedArgs);
      if (this.pendingMode !== "tangent") { this.pendingMode = "tangent"; await this.resetThread(ctx, true); }
      if (!question) { await this.ensureBtwSession(ctx); await this.ensureOverlay(ctx); return true; }
      await this.runBtw(ctx, question, save);
      return true;
    }

    if (name === "btw:new") {
      await this.resetThread(ctx, true);
      const { question, save } = parseBtwArgs(trimmedArgs);
      if (question) { await this.runBtw(ctx, question, save); } else {
        await this.ensureBtwSession(ctx); this.setOverlayStatus("Started a fresh BTW thread.", ctx);
        await this.ensureOverlay(ctx); notify(ctx, "Started a fresh BTW thread.", "info");
      }
      return true;
    }

    if (name === "btw:clear") { await this.resetThread(ctx); this.dismissOverlay(); notify(ctx, "Cleared BTW thread.", "info"); return true; }

    if (name === "btw:model") {
      const parsed = parseBtwModelArgs(trimmedArgs);
      if (parsed.action === "invalid") { this.setOverlayStatus(parsed.message, ctx); notify(ctx, parsed.message, "error"); return true; }
      if (parsed.action === "show") {
        const s = await this.resolveBtwSettings(ctx);
        const msg = this.describeResolvedModel(s);
        this.setOverlayStatus(msg, ctx); notify(ctx, msg, s.model ? "info" : "warning");
        return true;
      }
      if (parsed.action === "clear") { await this.setBtwModelOverride(ctx, null); return true; }
      const resolved = ctx.modelRegistry.find(parsed.model.provider, parsed.model.id);
      if (!resolved) {
        const msg = `Unknown model ${parsed.model.provider}/${parsed.model.id}. Use /login or /models to add it first.`;
        this.setOverlayStatus(msg, ctx); notify(ctx, msg, "error"); return true;
      }
      await this.setBtwModelOverride(ctx, resolved);
      return true;
    }

    if (name === "btw:thinking") {
      const parsed = parseBtwThinkingArgs(trimmedArgs);
      if (parsed.action === "show") {
        const s = await this.resolveBtwSettings(ctx);
        const msg = this.describeResolvedThinking(s);
        this.setOverlayStatus(msg, ctx); notify(ctx, msg, "info");
        return true;
      }
      await this.setBtwThinkingOverride(ctx, parsed.action === "clear" ? null : parsed.thinkingLevel);
      return true;
    }

    if (name === "btw:inject") {
      if (this.pendingThread.length === 0) { notify(ctx, "No BTW thread to inject.", "warning"); return true; }
      this.setOverlayStatus("⏳ injecting into the main session...", ctx);
      await this.ensureOverlay(ctx);
      try {
        const { thread } = await this.getBtwHandoffThread(ctx);
        const instructions = trimmedArgs;
        const content = instructions
          ? `Here is a side conversation I had. ${instructions}\n\n${formatThread(thread)}`
          : `Here is a side conversation I had for additional context:\n\n${formatThread(thread)}`;
        this.sendThreadToMain(ctx, content);
        const count = thread.length;
        await this.resetThread(ctx);
        this.dismissOverlay();
        notify(ctx, `Injected BTW thread (${count} exchange${count === 1 ? "" : "s"}).`, "info");
      } catch (error) {
        this.setOverlayStatus("Inject failed. Thread preserved for retry or summarize.", ctx);
        notify(ctx, error instanceof Error ? error.message : String(error), "error");
      }
      return true;
    }

    if (name === "btw:summarize") {
      if (this.pendingThread.length === 0) { notify(ctx, "No BTW thread to summarize.", "warning"); return true; }
      this.setOverlayStatus("⏳ summarizing...", ctx);
      await this.ensureOverlay(ctx);
      try {
        const { thread } = await this.getBtwHandoffThread(ctx);
        const summary = await this.summarizeThread(ctx, thread);
        const instructions = trimmedArgs;
        const content = instructions
          ? `Here is a summary of a side conversation I had. ${instructions}\n\n${summary}`
          : `Here is a summary of a side conversation I had:\n\n${summary}`;
        this.sendThreadToMain(ctx, content);
        const count = thread.length;
        await this.resetThread(ctx);
        this.dismissOverlay();
        notify(ctx, `Injected BTW summary (${count} exchange${count === 1 ? "" : "s"}).`, "info");
      } catch (error) {
        this.setOverlayStatus("Summarize failed. Thread preserved for retry or injection.", ctx);
        notify(ctx, error instanceof Error ? error.message : String(error), "error");
      }
      return true;
    }

    return false;
  }

  // ── Save visible note ────────────────────────────────────────────────────

  private saveVisibleBtwNote(details: BtwDetails, saveRequested: boolean, wasBusy: boolean): SaveState {
    if (!saveRequested) return "not-saved";
    const message = { customType: BTW_MESSAGE_TYPE, content: buildBtwMessageContent(details.question, details.answer), display: true, details };
    if (wasBusy) { this.pi.sendMessage(message, { deliverAs: "followUp" }); return "queued"; }
    this.pi.sendMessage(message);
    return "saved";
  }

  // ── Run BTW conversation ─────────────────────────────────────────────────

  async runBtw(ctx: ExtensionCommandContext, question: string, saveRequested: boolean = false): Promise<void> {
    this.lastUiContext = ctx;
    const settings = await this.resolveBtwSettings(ctx);
    const model = settings.model;
    if (!model) {
      const msg = settings.fallbackReason || "No active model selected.";
      this.setOverlayStatus(msg, ctx); notify(ctx, msg, "error"); return;
    }

    // Only check credentials for override models — the main session's model already
    // has working credentials (the main session is running with it). Inheriting a
    // model from ctx.model means pi already authenticated it.
    if (settings.modelSource === "override") {
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok || !auth.apiKey) {
        const msg = auth.ok ? `No credentials available for ${model.provider}/${model.id}.` : auth.error;
        this.setOverlayStatus(msg, ctx); notify(ctx, msg, "error");
        await this.ensureOverlay(ctx); return;
      }
    }

    const sessionRuntime = await this.ensureBtwSession(ctx);
    if (!sessionRuntime) {
      this.setOverlayStatus("No active model selected.", ctx); notify(ctx, "No active model selected.", "error"); return;
    }

    const session = sessionRuntime.session;
    const wasBusy = !ctx.isIdle();

    this.setOverlayStatus("⏳ streaming...", ctx);
    await this.ensureOverlay(ctx);

    try {
      await session.prompt(question, { source: "extension" });
      const response = getLastAssistantMessage(session);
      if (!response) throw new Error("BTW request finished without a response.");
      if (response.stopReason === "aborted") {
        // Remove incomplete turn from transcript
        const tid = this.transcriptState.lastTurnId ?? this.transcriptState.currentTurnId;
        if (tid !== null) {
          this.transcriptState.entries = this.transcriptState.entries.filter((e) => e.turnId !== tid);
        }
        this.setOverlayStatus("Request aborted.", ctx); return;
      }
      if (response.stopReason === "error") throw new Error(response.errorMessage || "BTW request failed.");

      const completedTurnId = this.transcriptState.lastTurnId ?? this.transcriptState.currentTurnId;
      const streamedThinking = completedTurnId !== null
        ? findLatestTranscriptEntry(this.transcriptState, completedTurnId, "thinking")?.text
        : "";
      const answer = extractAnswer(response);
      const thinking = extractThinking(response) || streamedThinking || "";

      const details: BtwDetails = {
        question,
        thinking,
        answer,
        provider: model.provider,
        model: model.id,
        api: model.api,
        thinkingLevel: settings.thinkingLevel,
        timestamp: Date.now(),
        usage: response.usage,
      };

      this.pendingThread.push(details);
      this.pi.appendEntry(BTW_ENTRY_TYPE, details);

      const saveState = this.saveVisibleBtwNote(details, saveRequested, wasBusy);
      if (saveState === "saved") {
        notify(ctx, "Saved BTW note to the session.", "info");
        this.setOverlayStatus("Saved BTW note to the session.", ctx);
      } else if (saveState === "queued") {
        notify(ctx, "BTW note queued to save after the current turn finishes.", "info");
        this.setOverlayStatus("BTW note queued to save after the current turn finishes.", ctx);
      } else {
        this.setOverlayStatus("Ready for a follow-up. Hidden BTW thread updated.", ctx);
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      setTranscriptFailure(this.transcriptState, errorMsg);
      this.setOverlayStatus("Request failed. Thread preserved for retry or follow-up.", ctx);
      notify(ctx, errorMsg, "error");
      await this.disposeBtwSession();
    } finally {
      this.syncUi(ctx);
    }
  }

  // ── Shutdown ─────────────────────────────────────────────────────────────

  async shutdown(): Promise<void> {
    await this.disposeBtwSession();
    this.dismissOverlay();
  }
}
