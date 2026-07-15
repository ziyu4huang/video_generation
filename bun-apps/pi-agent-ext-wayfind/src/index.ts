/**
 * pi-agent-ext-wayfind — Pi-native port of Matt Pocock's decision-chain skill suite.
 *
 * Phase 1 scaffold: the factory is a minimal stub that compiles + publishes the
 * coordination global so planning-with-files can detect an (as-yet-inactive) wayfind
 * session. Phase 2 fleshes out registerCommands + the grill/wayfinder lifecycle.
 *
 * Loaded by Pi via the `pi.extensions` manifest in package.json. Kept thin: all
 * logic lives in `src/`, compiled to `dist/` by `tsc`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { WAYFIND_ACTIVE_KEY } from "./constants.js";

export default function wayfindExtension(_pi: ExtensionAPI): void {
  // Publish the coordination seam up-front (inactive): planning-with-files reads
  // globalThis.__piWayfindActive to decide whether to yield during a live grill.
  // Returns false until a grill/wayfinder session activates it (Phase 2).
  (globalThis as Record<string, unknown>)[WAYFIND_ACTIVE_KEY] = () => false;
}

// Re-export pure helpers for downstream packages / tests (filled in across phases).
export { PKG_NAME, WAYFIND_ACTIVE_KEY } from "./constants.js";
