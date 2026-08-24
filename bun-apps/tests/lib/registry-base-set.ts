/**
 * registry-base-set.ts — the ONE reader for "which extensions does the
 * registry ship?", shared by extension-isolation-contract.test.ts and
 * dep-guard.test.ts.
 *
 * Since registry-code-as-config ticket 03 this reads the typed REGISTRY in
 * s2-agent/src/registry-config.ts directly — no more YAML line scanner. The
 * import is RELATIVE and the module is dependency-free by contract (map D4),
 * so these contract suites stay immune to `bun-apps/node_modules/@repo/*`
 * link state (same reasoning as seam-contract.test.ts's relative
 * core-interface import): a fresh clone with no `bun install` still resolves
 * it. The MIN_EXPECTED floors at each call site are what keep a silent import
 * failure from turning every assertion vacuous.
 */
import { shippedEntries } from "../../s2-agent/src/registry-config.ts";

/** Short names (REGISTRY `name` values) of every SHIPPED extension entry. */
export function registryBaseSetNames(): string[] {
	return shippedEntries().map((e) => e.name);
}
