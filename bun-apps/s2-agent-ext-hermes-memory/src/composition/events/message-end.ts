/**
 * composition/events/message-end.ts — slice 08b2-3 of the index.ts decomposition.
 *
 * Extracted VERBATIM (behavior preserved) from index.ts L658-664:
 * - registerMessageEnd ← the `pi.on("message_end", ...)` block, live session
 *   indexing (slice 10 of the original registration sequence).
 *
 * De-closured: every closure variable the body captured from index.ts scope
 * becomes a `ctx` field read on HermesCtx (sessionRepo, perf).
 *
 * The pi message_end event context is renamed `ctx` → `evt` so it cannot
 * shadow the HermesCtx `ctx` param; usage sites are unchanged otherwise.
 *
 * Helpers called directly: scheduleLiveSessionIndex.
 *
 * index.ts still holds its own copy until the rewire slice — this module
 * must typecheck standalone; it is not imported yet.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { HermesCtx } from "../stores.js";
import { scheduleLiveSessionIndex } from "../../handlers/session-live-index.js";

/** ← L658-664: the message_end handler, de-closured onto HermesCtx. */
export function registerMessageEnd(pi: ExtensionAPI, ctx: HermesCtx): void {
  pi.on("message_end", async (_event, evt) => {
    scheduleLiveSessionIndex(ctx.sessionRepo, evt.sessionManager, {
      timed: ctx.perf.timed,
      onError: (err) => console.warn(`⚠️ Live session indexing failed: ${err instanceof Error ? err.message : String(err)}`),
    });
  });
}
