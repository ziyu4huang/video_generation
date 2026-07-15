/**
 * pi-agent-ext-wayfind — Pi-native port of Matt Pocock's decision-chain skill suite.
 *
 * The default factory registers the slash commands + publishes the coordination
 * seam (globalThis.__piWayfindActive) so pi-agent-ext-planning-with-files can
 * yield its injection/auto-continue during a live grill session — the same
 * process-singleton pattern planning-with-files uses for /goal.
 *
 * Pure TypeScript: no python3, no shell. Loaded by Pi via the `pi.extensions`
 * manifest in package.json; all logic lives in `src/`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { endGrillForSession, registerCommands } from "./commands.js";
import { publishWayfindActive } from "./coordination.js";
import { createRuntimeState, getSessionId } from "./state.js";

export default function wayfindExtension(pi: ExtensionAPI): void {
  const state = createRuntimeState();

  // Publish the coordination seam up-front (inactive until a grill starts).
  // planning-with-files reads globalThis.__piWayfindActive to decide whether to
  // yield during a live grill. The closure reads live RuntimeState, so it always
  // returns the current value without re-publishing on every change.
  publishWayfindActive(state);

  registerCommands(pi, state);

  pi.on("session_shutdown", async (_event, ctx) => {
    // Clear this session's grill + refresh/unpublish the seam, mirroring
    // planning-with-files' session_shutdown cleanup.
    endGrillForSession(state, getSessionId(ctx));
  });
}

// Re-export pure helpers for downstream packages / tests.
export { PKG_NAME, WAYFIND_ACTIVE_KEY } from "./constants.js";
export {
  isWayfindActivePublished,
  publishWayfindActive,
  readPlanIncomplete,
  readPlanSummary,
  unpublishWayfindActive,
} from "./coordination.js";
export { buildGrillPriming, buildPlanSeed, parseGlossary } from "./grill.js";
export {
  createRuntimeState,
  isAnyWayfindSessionActive,
  isGrillActive,
  type RuntimeState,
} from "./state.js";
