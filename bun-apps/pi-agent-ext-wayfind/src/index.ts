/**
 * pi-agent-ext-wayfind — Pi-native port of Matt Pocock's decision-chain skill suite.
 *
 * The default factory registers the slash commands + publishes the coordination
 * seam (globalThis.__piWayfindActive) so the plan coordinator can yield its
 * injection/auto-continue during a live grill session — the same
 * process-singleton pattern the goal side uses for /goal. It also joins
 * the shared composite status widget owned by pi-agent-ext-goal-todo instead of
 * writing an independent ctx.ui.setStatus() footer line.
 *
 * Pure TypeScript: no python3, no shell. Loaded by Pi via the `pi.extensions`
 * manifest in package.json; all logic lives in `src/`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getSharedStatusWidget } from "@repo/pi-agent-ext-goal-todo/src/shared/status-widget.js";
import { endGrillForSession, registerCommands } from "./commands.js";
import { publishWayfindActive } from "./coordination.js";
import { WayfindOverlay } from "./overlay.js";
import { createRuntimeState, getSessionId } from "./state.js";

export default function wayfindExtension(pi: ExtensionAPI): void {
  const state = createRuntimeState();
  const widget = getSharedStatusWidget();
  const overlay = new WayfindOverlay();
  overlay.setRefresh(() => widget.update());
  widget.addSection({ id: "wayfind", order: 2, render: (t, w) => overlay.render(t, w) });

  // Publish the coordination seam up-front (inactive until a grill starts).
  // The plan coordinator reads globalThis.__piWayfindActive to decide whether
  // to yield during a live grill. The closure reads live RuntimeState, so it
  // always returns the current value without re-publishing on every change.
  publishWayfindActive(state);

  registerCommands(pi, state, overlay);

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.hasUI) {
      widget.setUICtx(ctx.ui);
      widget.update();
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    // Clear this session's grill + refresh/unpublish the seam, mirroring
    // the plan coordinator's session_shutdown cleanup. Only clears wayfind's own
    // overlay section — NEVER calls widget.dispose(), which would tear down
    // every other package's section too (see status-widget.ts's dispose() doc
    // comment: only pi-agent-ext-goal-todo's own session_shutdown owns that).
    endGrillForSession(state, getSessionId(ctx));
    overlay.dispose();
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
export { WayfindOverlay } from "./overlay.js";
export {
  createRuntimeState,
  isAnyWayfindSessionActive,
  isGrillActive,
  type RuntimeState,
} from "./state.js";
