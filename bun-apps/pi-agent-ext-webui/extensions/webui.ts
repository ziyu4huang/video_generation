/**
 * pi-agent-ext-webui — a web frontend that co-drives one AgentSession with the
 * TUI behind an agentic mutex (specs/04).
 *
 * Registered entry: a thin factory that delegates to the composition root in
 * src/webui-wiring.ts (Task 3b). The wiring builds the WebServer singleton +
 * BroadcastingNotifier + MutexController + WebTransport, wires the inbound
 * dispatch seam, and registers the pi.on handlers (mutex gate, lifecycle,
 * outbound broadcast). Matches the sibling entry convention
 * (`extensions/<X>.ts`), e.g. pi-agent-ext-btw/extensions/btw.ts.
 *
 * `pi: ExtensionAPI` is a structural superset of the narrow {@link WebuiHost}
 * the wiring depends on (it has `on` + the render seams); the cast bypasses
 * TypeScript's fragile overload-to-single-signature assignability check without
 * loosening the wiring's own (testable) type surface. DE-CHAT (event-cards 00):
 * the wiring is one-way — no main composer, no `sendUserMessage`; the inbound
 * frames it still acts on are appexec (HITL respond/cancel) + btw/view traffic.
 */
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { wireWebui, type WebuiHost } from "../src/webui-wiring.js";

const extension: ExtensionFactory = (pi) => {
  wireWebui(pi as unknown as WebuiHost);
};

export default extension;
