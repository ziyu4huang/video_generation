import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Pi extension entry for the grill-memory package. Kept thin: this package's
 * runtime behavior lives in (a) the `grill-memory` skill (loaded by description)
 * and (b) the `grill_decision` tool + detector yield guard, which live in
 * pi-agent-ext-hermes-memory (the only extension that can reliably write, via
 * its MemoryStore). This entry exists so the Pi manifest is valid and the skill
 * ships; it registers nothing at runtime.
 */
export default function extension(_pi: ExtensionAPI): void {
  // intentionally empty
}
