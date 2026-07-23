import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { validateTool } from "../lib/validate.ts";
import { renderTool } from "../lib/render.ts";

const extension: ExtensionFactory = (pi) => {
  pi.registerTool(validateTool);
  pi.registerTool(renderTool);
};

export default extension;
