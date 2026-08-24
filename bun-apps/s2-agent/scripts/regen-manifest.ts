/**
 * regen-manifest.ts — rewrites src/run-dir/manifest.json from the typed
 * REGISTRY (src/registry-config.ts) via loadRegistry()'s validation. Run as
 * `bun run regen:manifest` from bun-apps/s2-agent. The manifest is a DERIVED
 * artifact; this script plus the freshness test are the only writers that
 * should ever touch it. Refuses to write an empty manifest (same guard shape
 * as regen-static-extensions.ts).
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadRegistry } from "../src/run-dir/registry.ts";
import { buildManifestObject, manifestText } from "../src/run-dir/registry-to-manifest.ts";

const pkgDir = join(import.meta.dir, "..");
const manifestPath = join(pkgDir, "src", "run-dir", "manifest.json");

const registry = loadRegistry({ bunAppsDir: join(pkgDir, "..") });
if (registry.extensions.length === 0) {
	console.error("[regen:manifest] refusing to write: registry has no extensions");
	process.exit(1);
}
writeFileSync(manifestPath, manifestText(buildManifestObject(registry)));
console.log(`[regen:manifest] wrote ${manifestPath} (${registry.extensions.length} extensions)`);
