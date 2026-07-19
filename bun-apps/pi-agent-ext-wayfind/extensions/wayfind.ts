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
