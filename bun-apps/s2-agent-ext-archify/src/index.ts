// Lib face — the tool factories as a programmatic surface (sibling precedent:
// `main` points here; the registration entry stays extensions/archify.ts).
export { validateTool } from "./validate.ts";
export { makeRenderTool } from "./render.ts";
export { makeDeltaTool } from "./delta.ts";
export { makeExportPptxTool } from "./export-pptx.ts";
export { deckLintTool } from "./deck-lint-tool.ts";
export type { OpenBus } from "./open-announce.ts";
