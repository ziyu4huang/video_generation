import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { validateTool } from "../lib/validate.ts";
import { makeRenderTool } from "../lib/render.ts";
import { makeDeltaTool } from "../lib/delta.ts";
import { makeExportPptxTool } from "../lib/export-pptx.ts";
import type { OpenBus } from "../lib/open-announce.ts";

const extension: ExtensionFactory = (pi) => {
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
