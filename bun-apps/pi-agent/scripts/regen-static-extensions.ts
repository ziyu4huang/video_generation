/**
 * regen-static-extensions.ts — rewrites src/static-extensions.ts from
 * run-dir/manifest.json staticExtensions[] (PR A, Phase D). Run as
 * `bun run regen:static` from bun-apps/pi-agent.
 *
 * Refuses to write when staticExtensions is empty or missing — a manifest
 * typo must never blank the file.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import manifest from "../run-dir/manifest.json";
import { buildStaticExtensionsSource } from "../src/static-extensions-gen.ts";

const target = join(import.meta.dir, "..", "src", "static-extensions.ts");

const staticExtensions = (manifest as { staticExtensions?: string[] }).staticExtensions;
if (!Array.isArray(staticExtensions) || staticExtensions.length === 0) {
	console.error(
		"[regen:static] refusing to write: manifest.staticExtensions is empty or missing — fix run-dir/manifest.json first",
	);
	process.exit(1);
}

writeFileSync(target, buildStaticExtensionsSource({ staticExtensions }));
console.log(`[regen:static] wrote ${target} (${staticExtensions.length} entries)`);
