/**
 * Session builder: full control.
 *
 * Demonstrates pinning the model + thinking explicitly from the shared config,
 * and restricting the toolset to read-only — but still uses the SAME auth /
 * settings / model registry as every other mode (via createSharedSession).
 */
import { createSharedSession } from "./shared.ts";

export async function buildFullControlSession() {
  // Same shared services; this mode only narrows the available tools.
  return createSharedSession({
    tools: ["read", "bash"],
  });
}
