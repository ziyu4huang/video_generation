/**
 * Pi extension entry point.
 *
 * Loaded by Pi via the `pi.extensions` manifest in package.json. Kept thin: all
 * logic lives in `src/` (loaded as TS — no dist/ build since the src-entry
 * migration). The default factory wires skill discovery + the
 * using-superpowers bootstrap.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import superpowersPiExtension from "../src/index.js";

export default function extension(pi: ExtensionAPI): void {
  superpowersPiExtension(pi);
}
