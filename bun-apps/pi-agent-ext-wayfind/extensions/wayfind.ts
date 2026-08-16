/**
 * Pi extension entry point.
 *
 * Loaded by Pi via the `pi.extensions` manifest in package.json. Kept thin: all
 * logic lives in `src/`, compiled to `dist/` by `tsc`. The default factory
 * registers the coordination global + (Phase 2+) the slash commands.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import wayfindExtension from "../src/index.js";

export default function extension(pi: ExtensionAPI): void {
  wayfindExtension(pi);
}

/**
 * Gate-Recall Guard probe set (QA-DATA only — NOT part of runtime gating).
 * Consumed by pi-agent-ext-tool-gate/qa/collect-probes.ts. Controls-only
 * (recallFloor 0): wayfind_effort was demoted from core in ticket 02; its
 * keywords are the planning/effort vocabulary, so we assert the predicate
 * fires on its own keyword/requires path, not paraphrased intent.
 */
export const __GATE_PROBES__ = {
  gate: "wayfind_effort",
  recallFloor: 0,
  adversarial: [],
  controls: [
    "what's the effort status for tool-gate",
    "list the open tickets in planning",
    "search the wayfind map for the frontier",
  ],
};
