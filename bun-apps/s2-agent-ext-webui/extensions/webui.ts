/**
 * s2-agent-ext-webui — a web frontend that co-drives one AgentSession with the
 * TUI behind an agentic mutex (specs/04).
 *
 * Registered entry: a thin factory that delegates to the composition root in
 * src/webui-wiring.ts (Task 3b). The wiring builds the WebServer singleton +
 * BroadcastingNotifier + MutexController + WebTransport, wires the inbound
 * dispatch seam, and registers the pi.on handlers (mutex gate, lifecycle,
 * outbound broadcast). Matches the sibling entry convention
 * (`extensions/<X>.ts`), e.g. s2-agent-ext-btw/extensions/btw.ts.
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
  // Self-gate: BUN_PI_WEBUI=0 disables the entire extension — it registers
  // nothing and publishes no seam. Mirrors prompt-history's
  // BUN_PI_PROMPT_HISTORY=0 so every extension in the portable base set
  // (s2-agent.registry.yaml) shares one symmetric full-disable knob; enforced by
  // tests/extension-isolation-contract.test.ts. Safe: every cross-extension
  // consumer reads its seam defensively, so disabling degrades features,
  // never crashes.
  if (process.env.BUN_PI_WEBUI === "0") return;
  wireWebui(pi as unknown as WebuiHost);
};

export default extension;
