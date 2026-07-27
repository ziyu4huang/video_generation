/**
 * Cross-extension seam-contract guard (wayfind ADR-0004).
 *
 * The status-widget seam is a process-singleton on `globalThis` (jiti-safe), but
 * its contract surface — the key string + the consumer-facing method shape — is
 * duplicated across the publisher (core-task) and its consumers (wayfind,
 * power-tool) with NO compile-time link. Each side's own tests mock its own
 * literal, so a rename/reshape in core-task compiles clean, stays green, and
 * breaks consumers ONLY in production. This guard turns that silent drift loud.
 *
 * Invariants (the seam contract):
 *  1. KEY AGREEMENT — the global key appears, identically, in the publisher's
 *     source and every consumer's production source.
 *  2. SHAPE — every method a consumer declares on its structural view of the
 *     widget is a public method of the publisher's widget class.
 *
 * Static source analysis only — NO runtime import of any package (respects
 * ADR-0004's decoupling + the jiti constraint that made the seam globalThis-
 * based in the first place). Reads source as text + brace-counts blocks.
 *
 * GENERALIZATION HOOK (future ticket): the `SEAM` object pins the ONE landed
 * seam today. To cover the full `__pi*` coordination surface, promote `SEAM`
 * to `SEAMS: SeamSpec[]` and iterate both invariants per entry — the publisher/
 * consumer/shape extractors are already seam-agnostic.
 *
 * Run: bun run test:seam   (from bun-apps/)
 */
import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), ".."); // bun-apps/

/** A single cross-extension seam on `globalThis`. */
interface SeamSpec {
	/** The global key string (the silent-drift vector). */
	key: string;
	publisher: { pkg: string; file: string; className: string };
	consumers: { pkg: string; file: string; methods: () => Set<string> }[];
}

/** Read a package production source file (utf8). */
function readPkgFile(pkg: string, rel: string): string {
	return readFileSync(join(ROOT, pkg, rel), "utf8");
}

/** Lines of a brace-delimited block, starting at the first line containing
 *  `open`, counting `{`/`}` until depth returns to 0. Returns the block text. */
function braceBlock(src: string, open: string): string {
	const lines = src.split("\n");
	const start = lines.findIndex((l) => l.includes(open));
	if (start < 0) return "";
	let depth = 0;
	const out: string[] = [];
	for (let i = start; i < lines.length; i++) {
		const line = lines[i] as string;
		depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
		out.push(line);
		if (depth <= 0) break;
	}
	return out.join("\n");
}

/** Public method names declared on a class body (tab-indented `name(` / `name<`),
 *  excluding access-modifier fields. Source-aware, not runtime. */
function extractClassMethods(src: string, className: string): Set<string> {
	const block = braceBlock(src, `class ${className}`);
	const methods = new Set<string>();
	for (const raw of block.split("\n")) {
		const m = raw.match(/^\t([a-zA-Z_]\w*)\s*[(<]/);
		if (m && !/\b(private|protected|readonly|static)\b/.test(raw)) methods.add(m[1] as string);
	}
	return methods;
}

/** Method names declared in a TS `interface Foo { ... }` block (2-space members). */
function extractInterfaceMethods(src: string, ifaceName: string): Set<string> {
	const block = braceBlock(src, `interface ${ifaceName}`);
	const methods = new Set<string>();
	for (const raw of block.split("\n")) {
		const m = raw.match(/^\s{2}([a-zA-Z_]\w*)\s*\(/);
		if (m) methods.add(m[1] as string);
	}
	return methods;
}

/** Method names declared in an inline structural type following `anchor`
 *  (e.g. `g.__piCoreTaskStatusWidget as { inspect?: (...) => ... }`).
 *  Matches optional method-properties `name?: (`. */
function extractInlineTypeMethods(src: string, anchor: string): Set<string> {
	const block = braceBlock(src, anchor);
	const methods = new Set<string>();
	for (const raw of block.split("\n")) {
		const m = raw.match(/([a-zA-Z_]\w*)\??\s*:\s*\(/);
		if (m) methods.add(m[1] as string);
	}
	return methods;
}

const WAYFIND_SRC = "src/index.ts";
const POWER_TOOL_SRC = "src/index.ts";

const SEAM: SeamSpec = {
	key: "__piCoreTaskStatusWidget",
	publisher: { pkg: "pi-agent-ext-core-task", file: "src/shared/status-widget.ts", className: "CoreTaskStatusWidget" },
	consumers: [
		{
			pkg: "pi-agent-ext-wayfind",
			file: WAYFIND_SRC,
			methods: () => extractInterfaceMethods(readPkgFile("pi-agent-ext-wayfind", WAYFIND_SRC), "SharedStatusWidget"),
		},
		{
			pkg: "pi-agent-ext-power-tool",
			file: POWER_TOOL_SRC,
			methods: () => extractInlineTypeMethods(readPkgFile("pi-agent-ext-power-tool", POWER_TOOL_SRC), "__piCoreTaskStatusWidget as {"),
		},
	],
};

describe("cross-extension status-widget seam contract (wayfind ADR-0004)", () => {
	it("extraction is grounded — publisher class + consumer shapes were found, not empty", () => {
		// Guards against a vacuous pass if a refactor shifts indentation/syntax
		// and the extractors silently return empty sets.
		const pubMethods = extractClassMethods(readPkgFile(SEAM.publisher.pkg, SEAM.publisher.file), SEAM.publisher.className);
		assert.ok(
			pubMethods.size >= 3,
			`expected ≥3 public methods on ${SEAM.publisher.className}, got ${[...pubMethods].join(", ") || "(none — extraction miss?"}`,
		);
		for (const c of SEAM.consumers) {
			const ms = c.methods();
			assert.ok(ms.size >= 1, `expected ≥1 declared method in ${c.pkg}'s seam view, got none (extraction miss?)`);
		}
	});

	it("KEY AGREEMENT — the seam key appears, identically, in publisher + every consumer's production source", () => {
		const sites: [string, string, string][] = [
			["publisher (core-task)", SEAM.publisher.pkg, SEAM.publisher.file],
			["consumer (wayfind)", "pi-agent-ext-wayfind", WAYFIND_SRC],
			["consumer (power-tool)", "pi-agent-ext-power-tool", POWER_TOOL_SRC],
		];
		const missing: string[] = [];
		for (const [label, pkg, file] of sites) {
			const src = readPkgFile(pkg, file);
			if (!src.includes(SEAM.key)) missing.push(`  ${label}: ${pkg}/${file} does not reference "${SEAM.key}"`);
		}
		assert.deepEqual(missing, [], missing.length ? `SEAM KEY DRIFT — a site renamed/diverged from "${SEAM.key}":\n${missing.join("\n")}` : "");
	});

	it("SHAPE — every method a consumer declares on the widget is a public method of the publisher's class", () => {
		const pubMethods = extractClassMethods(readPkgFile(SEAM.publisher.pkg, SEAM.publisher.file), SEAM.publisher.className);
		const drift: string[] = [];
		for (const c of SEAM.consumers) {
			for (const m of c.methods()) {
				if (!pubMethods.has(m)) {
					drift.push(`  ${c.pkg} declares "${m}" on the seam, but ${SEAM.publisher.className} no longer defines it (renamed? removed?)`);
				}
			}
		}
		assert.deepEqual(drift, [], drift.length ? `SEAM SHAPE DRIFT — a publisher method rename/removal broke a consumer:\n${drift.join("\n")}` : "");
	});
});
