/**
 * source-markers.ts — artifact attestation for the deploy pipeline
 * (self-arc-22 t01, F-deploy-1's mechanical learning #1).
 *
 * Arc-19 receipted the failure mode: a fresh-sha deploy served bundles built
 * from bytes that predated the just-merged source, and NOTHING in the pipeline
 * noticed — the version label said one thing, the bytes were another. String
 * literals survive minification, so a bundle built from a package's sources
 * MUST contain that package's distinctive literals; a bundle missing them was
 * built from something else.
 *
 * `deriveSourceMarkers` picks the k longest plain string literals from a
 * source tree (deterministic: same bytes → same markers, unit-pinned);
 * `assertMarkersInArtifact` greps them out of the built artifact and THROWS
 * naming the misses. Builders call the assert right after writing their
 * output — staleness dies at build time, never ships.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface SourceMarkers {
	/** The marker literals (longest first). */
	markers: string[];
	/** The source files the markers were derived from (relative paths). */
	sources: string[];
}

const LITERAL_RE = /"([^"\\\n]{16,})"|'([^'\\\n]{16,})'/g;
/** Keep only plain ASCII literals: minifiers may re-escape anything else, and
 *  template-ish content (`${`) is not a stable single literal. */
const PLAIN = /^[A-Za-z0-9 ._,:;!?()[\]{}<>=+\-*/#|~@%^&"'`]+$/;

function collectLiterals(text: string, into: Map<string, string>): void {
	LITERAL_RE.lastIndex = 0;
	for (let m = LITERAL_RE.exec(text); m; m = LITERAL_RE.exec(text)) {
		const lit = m[1] ?? m[2];
		if (!lit || !PLAIN.test(lit) || lit.includes("${")) continue;
		if (!into.has(lit)) into.set(lit, "");
	}
}

function walkSources(root: string, out: string[]): void {
	let entries: Array<{ name: string; isDirectory: () => boolean }>;
	try {
		entries = readdirSync(root, { withFileTypes: true }) as unknown as Array<{
			name: string;
			isDirectory: () => boolean;
		}>;
	} catch {
		return;
	}
	for (const e of entries) {
		const name = String(e.name);
		const abs = join(root, name);
		if (e.isDirectory()) {
			if (name === "node_modules" || name === "dist") continue;
			walkSources(abs, out);
		} else if (name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts")) {
			out.push(abs);
		}
	}
}

/**
 * Derive the k longest plain string literals from a package's `src/` tree.
 * Test files and declaration files are excluded; the result is deterministic
 * for identical source bytes (sorted by length desc, then lexicographic).
 */
export function deriveSourceMarkers(srcDir: string, k = 3): SourceMarkers {
	const files: string[] = [];
	walkSources(srcDir, files);
	const literals = new Map<string, string>();
	for (const abs of files) collectLiterals(readFileSync(abs, "utf8"), literals);
	const markers = [...literals.keys()]
		.sort((a, b) => b.length - a.length || (a < b ? -1 : 1))
		.slice(0, k);
	return { markers, sources: files.map((f) => f.slice(srcDir.length + 1)).sort() };
}

/**
 * Assert the built artifact contains a QUORUM of the source markers. Throws
 * naming the missing markers and the artifact.
 *
 * Why a quorum (not all): tree-shaking legitimately drops literals that live
 * in unused exports, so a FRESH build can miss a few. A genuinely STALE build
 * (bytes from older sources) misses nearly ALL current markers. minRatio 0.6
 * separates the two with margin; an empty marker set is trivially satisfied.
 */
export function assertMarkersInArtifact(
	artifactText: string,
	markers: string[],
	label: string,
	minRatio = 0.6,
): void {
	if (markers.length === 0) return;
	const present = markers.filter((m) => artifactText.includes(m));
	const ratio = present.length / markers.length;
	if (ratio < minRatio) {
		const missing = markers.filter((m) => !artifactText.includes(m));
		throw new Error(
			`[deploy] artifact attestation FAILED for ${label}: only ${present.length}/${markers.length} source markers found in the built bundle (min ${minRatio}) — the build read stale bytes (F-deploy-1). Missing: ${missing
				.map((m) => JSON.stringify(m.slice(0, 60)))
				.join(", ")}`,
		);
	}
}
