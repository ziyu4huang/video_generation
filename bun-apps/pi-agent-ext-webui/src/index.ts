/**
 * pi-agent-ext-webui — the webui extension's public surface (architecture v2).
 *
 * The v1 entry was a no-op (`export {};`) still claiming the extension "lands
 * in tickets 02/04", while package.json `main`/`types` pointed at its compiled
 * dist. v2 makes it a real lib entry re-exporting the wiring + config surface
 * the extension entry (`extensions/webui.ts`) and embedding hosts consume.
 * The extension itself stays registered via `extensions/webui.ts` (the
 * canonical single entry per package — never register src/index.ts as the
 * extension entry).
 */
export { wireWebui } from "./webui-wiring.js";
export type {
  HitlResponse,
  RenderHostEvents,
  WebuiDeps,
  WebuiHost,
  WebuiServer,
  WebuiSessionCtx,
  WebuiSocket,
  WebuiUi,
  WebuiWiring,
} from "./webui-wiring.js";
export type { WebFrame } from "./protocol.js";
export { isWebuiDisabled, resolveWebuiEnabled } from "./webui-config.js";
export { resolvePort } from "./port-resolver.js";
