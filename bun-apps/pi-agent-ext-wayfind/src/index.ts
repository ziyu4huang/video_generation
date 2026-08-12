/**
 * pi-agent-ext-wayfind — Pi-native port of Matt Pocock's decision-chain skill suite.
 *
 * The default factory registers the slash commands + publishes the
 * grill-specific `globalThis.__piWayfindGrill` reader (consumed by
 * hermes-memory). wayfind does NOT publish a forward coordination seam and
 * there is no plan-coordinator yield: mutual-exclusion between a
 * grill/wayfinder session and /goal or /loop is user-initiated — run one
 * driver at a time. It joins the shared composite status widget by reading
 * core-task's `globalThis` singleton (`__piCoreTaskStatusWidget`) WITHOUT a
 * package dependency (reverses ADR-0002; see docs/adr/0004) — no
 * `ctx.ui.setStatus()` footer line.
 *
 * Pure TypeScript: no python3, no shell. Loaded by Pi via the `pi.extensions`
 * manifest in package.json; all logic lives in `src/`.
 */

import type { ExtensionAPI, ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { endGrillForSession, registerCommands } from "./commands.js";
import { makeWayfindEffortTool } from "./effort-tool.js";
import { WayfindOverlay } from "./overlay.js";
import { readWayfindStatusBar } from "./settings.js";
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
  // Self-gate: BUN_PI_WAYFIND=0 disables the entire extension — no slash
  // commands, no effort tool, no event hooks, and no __piWayfindGrill publish.
  // Mirrors prompt-history's BUN_PI_PROMPT_HISTORY=0 so the core trio
  // (superpowers/wayfind/prompt-history) share one symmetric full-disable knob.
  // Safe: every downstream consumer (hermes-memory's grill-seam, etc.) guards the
  // seam with `typeof === "function"` → disabling degrades features, never crashes.
  if (process.env.BUN_PI_WAYFIND === "0") return;
  const state = createRuntimeState();
  const overlay = new WayfindOverlay();
  // Apply the persisted opt-in default ONCE at startup (the only settings.json
  // read for the status bar). The class itself stays IO-free (test-safe);
  // subsequent toggles go through setStatusBarEnabled in the statusbar command.
  overlay.setStatusBarEnabled(readWayfindStatusBar());
  const widget = readSharedStatusWidget();
  if (widget) {
    overlay.setRefresh(() => widget.update());
    widget.addSection({ id: "wayfind", order: 2, render: (t, w) => overlay.render(t, w) });
  }

  // No forward coordination seam is published: mutual-exclusion between a
  // grill/wayfinder session and /goal or /loop is user-initiated (run one
  // driver at a time). The grill-specific `__piWayfindGrill` reader (read by
  // hermes-memory) is published per-session from the command handlers.
  registerCommands(pi, state, overlay);

  // The bare effort tool (Layer 2): create / validate / status an effort dir's
  // manifest — the mechanical surface the agent calls directly, separate from
  // the reflective /wayfind command flows above.
  pi.registerTool(makeWayfindEffortTool(pi.events));

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.hasUI && widget) {
      widget.setUICtx(ctx.ui);
      widget.update();
    }
  });

  pi.on("turn_end", () => {
    // A one-shot wayfind action's turn just ended → drop its banner so the
    // status bar doesn't keep a stale "charting …" line. Sustained grill flows
    // (grilling/grilling-docs) persist — see overlay.clearTransientUnlessSustained.
    overlay.clearTransientUnlessSustained();
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    // Clear this session's grill + drop the grill seam when no sessions remain,
    // mirroring the plan coordinator's session_shutdown cleanup. Only clears
    // wayfind's own overlay section — NEVER calls widget.dispose(), which would
    // tear down every other package's section too (see status-widget.ts's
    // dispose() doc comment: only pi-agent-ext-core-task's own session_shutdown
    // owns that).
    endGrillForSession(state, getSessionId(ctx));
    overlay.dispose();
  });
}

// Re-export pure helpers for downstream packages / tests.
export { PKG_NAME } from "./constants.js";
export { readPlanIncomplete, readPlanSummary } from "./coordination.js";
export { buildGrillPriming, buildPlanSeed, parseGlossary } from "./grill.js";
export { WayfindOverlay } from "./overlay.js";
export {
  createRuntimeState,
  isGrillActive,
  type RuntimeState,
} from "./state.js";
