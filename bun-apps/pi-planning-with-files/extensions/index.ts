/**
 * Pi extension entry point.
 *
 * Loaded by Pi via the `pi.extensions` manifest in package.json. Kept thin: all
 * logic lives in `src/`, compiled to `dist/` by `tsc`. The default factory
 * registers the 6 lifecycle events + 5 slash commands.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { planningWithFilesExtension } from "../src/index.js";

export default function extension(pi: ExtensionAPI): void {
  planningWithFilesExtension(pi);
}
