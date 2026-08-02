/**
 * pi-agent-ext-wayfind — Pi-native port of Matt Pocock's decision-chain skill suite.
 *
 * The default factory registers the slash commands + publishes the coordination
 * seam (globalThis.__piWayfindActive) so the plan coordinator can yield its
 * injection/auto-continue during a live grill session — the same
 * process-singleton pattern the goal side uses for /goal. It joins the shared
 * composite status widget by reading core-task's `globalThis` singleton
 * (`__piCoreTaskStatusWidget`) WITHOUT a package dependency (reverses ADR-0002;
 * see docs/adr/0004) — no `ctx.ui.setStatus()` footer line.
 *
 * Pure TypeScript: no python3, no shell. Loaded by Pi via the `pi.extensions`
 * manifest in package.json; all logic lives in `src/`.
 */

import type { ExtensionAPI, ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { endGrillForSession, registerCommands } from "./commands.js";
import { publishWayfindActive } from "./coordination.js";
import { makeWayfindEffortTool } from "./effort-tool.js";
import { WayfindOverlay } from "./overlay.js";
import { createRuntimeState, getSessionId } from "./state.js";

/**
 * Structural view of core-task's shared status widget, obtained via its
 * `globalThis` singleton WITHOUT a package import (reverses ADR-0002's workspace
 * dependency — see docs/adr/0004). Existence-checked, never `instanceof`: pi
 * loads extensions via jiti, so module identity isn't guaranteed across loaders
 * (same reason core-task's own singleton guard avoids `instanceof`). When
 * core-task isn't loaded this is `undefined` and wayfind's status section simply
 * doesn't render — ADR-0002's accepted no-fallback consequence (core-task is the
 * earliest-loaded core package).
 */
interface SharedStatusWidget {
  addSection(section: { id: string; order?: number; render(theme: Theme, width: number): string[] }): void;
  setUICtx(ctx: ExtensionUIContext): void;
  update(): void;
}

const SHARED_STATUS_WIDGET_GLOBAL = "__piCoreTaskStatusWidget";

function readSharedStatusWidget(): SharedStatusWidget | undefined {
  const w = (globalThis as Record<string, unknown>)[SHARED_STATUS_WIDGET_GLOBAL];
  return w as SharedStatusWidget | undefined;
}

export default function wayfindExtension(pi: ExtensionAPI): void {
  const state = createRuntimeState();
  const overlay = new WayfindOverlay();
  const widget = readSharedStatusWidget();
  if (widget) {
    overlay.setRefresh(() => widget.update());
    widget.addSection({ id: "wayfind", order: 2, render: (t, w) => overlay.render(t, w) });
  }

  // Publish the coordination seam up-front (inactive until a grill starts).
  // The plan coordinator reads globalThis.__piWayfindActive to decide whether
  // to yield during a live grill. The closure reads live RuntimeState, so it
  // always returns the current value without re-publishing on every change.
  publishWayfindActive(state);

  registerCommands(pi, state, overlay);

  // The bare effort tool (Layer 2): create / validate / status an effort dir's
  // manifest — the mechanical surface the agent calls directly, separate from
  // the reflective /wayfind command flows above.
  pi.registerTool(makeWayfindEffortTool());

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.hasUI && widget) {
      widget.setUICtx(ctx.ui);
      widget.update();
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    // Clear this session's grill + refresh/unpublish the seam, mirroring
    // the plan coordinator's session_shutdown cleanup. Only clears wayfind's own
    // overlay section — NEVER calls widget.dispose(), which would tear down
    // every other package's section too (see status-widget.ts's dispose() doc
    // comment: only pi-agent-ext-core-task's own session_shutdown owns that).
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
