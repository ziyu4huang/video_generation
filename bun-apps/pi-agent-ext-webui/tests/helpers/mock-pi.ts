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
export type AnyHandler = (event: any, ctx: any) => any;

export class MockPi {
  /** event name -> registered handlers (in registration order). */
  readonly handlers = new Map<string, AnyHandler[]>();
  /** DELIVERED (non-suppressed) sendUserMessage calls. */
  readonly sent: Array<{ content: unknown; opts?: { deliverAs?: "steer" | "followUp" } }> = [];
  /** Mock session context (the second arg passed to handlers). */
  readonly ctx = {
    abortCalls: 0,
    abort(): void {
      this.abortCalls++;
    },
  };

  on(event: string, handler: AnyHandler): void {
    const list = this.handlers.get(event);
    if (list) list.push(handler);
    else this.handlers.set(event, [handler]);
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
