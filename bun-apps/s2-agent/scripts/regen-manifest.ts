/**
 * regen-manifest.ts — rewrites run-dir/manifest.json from s2-agent.registry.yaml.
 * Run as `bun run regen:manifest` from bun-apps/s2-agent. The manifest is a
 * DERIVED artifact; this script plus the freshness test are the only writers
 * that should ever touch it. Refuses to write an empty manifest (same guard
 * shape as regen-static-extensions.ts).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseRegistry } from "../run-dir/registry.ts";
import { buildManifestObject, manifestText } from "../run-dir/registry-to-manifest.ts";

const pkgDir = join(import.meta.dir, "..");
const registryPath = join(pkgDir, "s2-agent.registry.yaml");
const manifestPath = join(pkgDir, "run-dir", "manifest.json");

const registry = parseRegistry(readFileSync(registryPath, "utf8"), { bunAppsDir: join(pkgDir, "..") });
if (registry.extensions.length === 0) {
	console.error("[regen:manifest] refusing to write: registry has no extensions");
	process.exit(1);
}
writeFileSync(manifestPath, manifestText(buildManifestObject(registry)));
console.log(`[regen:manifest] wrote ${manifestPath} (${registry.extensions.length} extensions)`);
