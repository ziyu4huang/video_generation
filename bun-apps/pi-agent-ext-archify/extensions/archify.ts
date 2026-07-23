import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { validateTool } from "../lib/validate.ts";

const extension: ExtensionFactory = (pi) => {
  pi.registerTool(validateTool);
};

export default extension;
