import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { validateTool } from "../lib/validate.ts";
import { makeRenderTool } from "../lib/render.ts";
import { makeDeltaTool } from "../lib/delta.ts";
import { makeExportPptxTool } from "../lib/export-pptx.ts";
import type { OpenBus } from "../lib/open-announce.ts";

const extension: ExtensionFactory = (pi) => {
  // Self-gate: BUN_PI_ARCHIFY=0 disables the entire extension — it registers
  // nothing. Mirrors btw's BUN_PI_BTW=0 so every extension in the portable
  // base set (s2-agent.registry.yaml) shares one symmetric full-disable knob;
  // enforced by tests/extension-isolation-contract.test.ts. Safe: consumers
  // read the optional webui bus defensively, so disabling degrades, never
  // crashes.
  if (process.env.BUN_PI_ARCHIFY === "0") return;
  // pi.events is typed non-optional in the SDK but may be absent in older
  // hosts / capturing mocks — capture defensively (wayfind precedent).
  const events = (pi as { events?: OpenBus }).events;
  pi.registerTool(validateTool);
  // Tools announce "webui:open" on the shared event bus after a successful
  // render/delta (string-literal channel — no webui dependency here).
  pi.registerTool(makeRenderTool(events));
  pi.registerTool(makeDeltaTool(events));
  // Native-shape PPTX export (no browser, nothing rasterized).
  pi.registerTool(makeExportPptxTool(events));
};

export default extension;
