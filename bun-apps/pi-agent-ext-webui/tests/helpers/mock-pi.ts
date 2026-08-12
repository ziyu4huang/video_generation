/**
 * MockPi — a minimal stand-in for pi's ExtensionAPI, for wiring unit tests.
 *
 * Records every `pi.on(event, handler)` registration in a map keyed by event
 * name (so a test can assert the registered event SET, and fire them on
 * demand), and records DELIVERED `sendUserMessage` calls. Crucially,
 * `sendUserMessage` faithfully mirrors the REAL pi input-gate: it fires the
 * registered `input` event handlers synchronously and — if any returns
 * `{ action: "handled" }` — SUPPRESSES the message (does not record it),
 * exactly as agent-session.js short-circuits `prompt()` on a "handled" input
 * result. This lets the wiring's "the input event IS the gate" invariant be
 * exercised with zero live pi / zero Bun.serve.
 *
 * The mock ctx mirrors the slice of ExtensionContext the wiring touches:
 * `abort()`.
 */
import type { RenderHostEvents, WebuiUi } from "../../src/webui-wiring.js";

export type AnyHandler = (event: any, ctx: any) => any;

export class MockPi {
  /** event name -> registered handlers (in registration order). */
  readonly handlers = new Map<string, AnyHandler[]>();
  /** DELIVERED (non-suppressed) sendUserMessage calls. */
  readonly sent: Array<{ content: unknown; opts?: { deliverAs?: "steer" | "followUp" } }> = [];
  /** Tools registered via registerTool (ticket 06 render framework). */
  readonly registeredTools: unknown[] = [];
  /** Shared event bus (ticket 06 render channel "webui:render"). */
  readonly events: RenderHostEvents;
  /** Mock session context (the second arg passed to handlers). Adds a `ui`
   *  stub (ticket 07) recording notify/setStatus for announce assertions. */
  readonly ctx: {
    abortCalls: number;
    abort(): void;
    notifications: Array<{ message: string; type?: string }>;
    statuses: Array<{ key: string; text: string | undefined }>;
    ui: WebuiUi;
  };

  constructor() {
    const channels = new Map<string, Set<(data: unknown) => void>>();
    this.events = {
      on(channel, handler) {
        let set = channels.get(channel);
        if (!set) {
          set = new Set();
          channels.set(channel, set);
        }
        set.add(handler);
        return () => {
          set!.delete(handler);
        };
      },
      emit(channel, data) {
        channels.get(channel)?.forEach((h) => h(data));
      },
    };
    // ticket 07: ctx gains a ui stub that records announce calls. The arrays
    // are captured by the ui closures AND exposed on ctx (same references), so
    // pi.ctx.notifications / pi.ctx.statuses reflect every announce in tests.
    const notifications: Array<{ message: string; type?: string }> = [];
    const statuses: Array<{ key: string; text: string | undefined }> = [];
    this.ctx = {
      abortCalls: 0,
      notifications,
      statuses,
      abort(): void {
        this.abortCalls++;
      },
      ui: {
        notify: (message, type) => {
          notifications.push({ message, type });
        },
        setStatus: (key, text) => {
          statuses.push({ key, text });
        },
      },
    };
  }

  on(event: string, handler: AnyHandler): void {
    const list = this.handlers.get(event);
    if (list) list.push(handler);
    else this.handlers.set(event, [handler]);
  }

  /** Register a tool (ticket 06 render framework registers "webui_render"). */
  registerTool(tool: unknown): void {
    this.registeredTools.push(tool);
  }

  sendUserMessage(
    content: string | unknown[],
    opts?: { deliverAs?: "steer" | "followUp" }
  ): void {
    const text = typeof content === "string" ? content : "";
    // Mirror real pi: fire input handlers; a "handled" verdict suppresses.
    for (const h of this.handlers.get("input") ?? []) {
      const r = h(
        { type: "input", text, source: "extension", streamingBehavior: opts?.deliverAs },
        this.ctx
      );
      if (r?.action === "handled") return; // suppressed — not recorded
    }
    this.sent.push({ content, opts });
  }

  /** Fire every handler registered for `event` with the given payload. */
  emit(event: string, eventObj?: unknown, ctx: unknown = this.ctx): void {
    for (const h of this.handlers.get(event) ?? []) h(eventObj, ctx);
  }

  /** Registered event names (the SET pi.on was called with). */
  registeredEvents(): string[] {
    return [...this.handlers.keys()];
  }

  handlersFor(event: string): AnyHandler[] {
    return this.handlers.get(event) ?? [];
  }
}
