/**
 * Monorepo dependency-hygiene guard (ADR-0001).
 *
 * Encodes the architectural invariants of the pi-agent-ext-* layer so the
 * hermes-class inversion (a TIER-0 foundation importing the TIER-1 hub) can
 * never silently return. Scans ACTUAL import statements (excludes comments /
 * string literals), not a naive grep — plus tsconfig `types` edges, which are
 * real dependencies with no import statement to scan.
 *
 * Invariants:
 *  1. Every @repo import is declared in the importing package's package.json
 *     (no hidden / undeclared coupling).
 *  2. Every @repo tsconfig `compilerOptions.types` entry is likewise declared
 *     — a type-only edge with no import statement is still a real dependency.
 *  3. No package imports itself via @repo/ (use relative imports).
 *  4. ADR-0001: knowledge-layer TIER-0 (obsidian, hermes-memory) imports
 *     NOTHING from the TIER-1 hub (knowledge-card) — edges point down only.
 *  5. No extension imports the host (pi-agent) — the host is above all exts.
 *  6. The declared @repo dependency graph is acyclic.
 *
 * Run: bun run test:deps   (from bun-apps/)
 */
import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), ".."); // bun-apps/
const EXTS = readdirSync(ROOT)
	.filter((d) => d.startsWith("pi-agent-ext-") && existsSync(join(ROOT, d, "package.json")));

/** Targets a package's CODE actually imports via @repo/, excluding comments/strings. */
function importedRepos(pkg: string): Set<string> {
	const targets = new Set<string>();
	const walk = (dir: string) => {
		let entries: ReturnType<typeof readdirSync>;
		try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
		for (const ent of entries) {
			if (ent.name === "node_modules" || ent.name === "__tests__" || ent.name === "fixtures" || ent.name === "dist") continue;
			const p = join(dir, ent.name);
			if (ent.isDirectory()) { walk(p); continue; }
			if (!/\.(ts|tsx|mjs|js)$/.test(ent.name) || /\.test\./.test(ent.name)) continue;
			const lines = readFileSync(p, "utf8").split("\n");
			for (const raw of lines) {
				const trimmed = raw.trim();
				// Skip comment lines (JSDoc '*', '//', '/*') — the historical
				// false positives were @example imports inside JSDoc.
				if (trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/*")) continue;
				// Static `from "@repo/X"` and dynamic `import("@repo/X"`.
				for (const m of raw.matchAll(/(?:from\s+|import\s*\(\s*)["']@repo\/(pi-agent[-\w]*)(?:\/[^"']*)?["']/g)) {
					targets.add(m[1] as string);
				}
			}
		}
	};
	walk(join(ROOT, pkg));
	return targets;
}

/** @repo targets declared in a package's package.json (any dep field). */
function declaredRepos(pkg: string): Set<string> {
	const d = JSON.parse(readFileSync(join(ROOT, pkg, "package.json"), "utf8"));
	const out = new Set<string>();
	for (const k of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
		for (const n of Object.keys(d[k] ?? {})) {
			if (n.startsWith("@repo/")) out.add(n.replace("@repo/", ""));
		}
	}
	return out;
}

/**
 * Pure: bare `@repo/*` names listed in a parsed tsconfig's
 * `compilerOptions.types`. Such an entry is a REAL dependency edge that
 * `importedRepos` cannot see — there is no import statement, only a type
 * reference resolved through the target's `exports["."].types`.
 *
 * Field convention for these edges (documented, NOT enforced — the invariant
 * below accepts any dependency field):
 *   - types-only consumers          → devDependencies
 *   - runtime consumers (publishSeam / readSeam / SEAM_KEYS)
 *                                   → dependencies / peerDependencies
 */
function parseTypesRepos(tsconfig: unknown): Set<string> {
	const types = (tsconfig as { compilerOptions?: { types?: unknown } })?.compilerOptions?.types;
	const out = new Set<string>();
	if (!Array.isArray(types)) return out;
	for (const t of types) {
		if (typeof t === "string" && t.startsWith("@repo/")) out.add(t.replace("@repo/", ""));
	}
	return out;
}

/** `@repo/*` tsconfig `types` edges for a package. Missing tsconfig → empty
 *  (a few ext packages have none). */
function typesRepos(pkg: string): Set<string> {
	const f = join(ROOT, pkg, "tsconfig.json");
	if (!existsSync(f)) return new Set();
	return parseTypesRepos(JSON.parse(readFileSync(f, "utf8")));
}

/** All @repo edges a package has: import statements ∪ tsconfig `types`. */
function edges(pkg: string): Set<string> {
	return new Set([...importedRepos(pkg), ...typesRepos(pkg)]);
}

describe("monorepo dependency hygiene guard (ADR-0001)", () => {
	it("every @repo import is declared in its package.json (no hidden coupling)", () => {
		const violations: string[] = [];
		for (const pkg of EXTS) {
			const imp = importedRepos(pkg), dec = declaredRepos(pkg);
			for (const t of imp) if (!dec.has(t)) violations.push(`  ${pkg} imports @repo/${t} — NOT declared in package.json`);
		}
		assert.deepEqual(violations, [], violations.length ? "hidden couplings:\n" + violations.join("\n") : "");
	});

	it("every @repo tsconfig `types` entry is declared in its package.json", () => {
		const violations: string[] = [];
		for (const pkg of EXTS) {
			const dec = declaredRepos(pkg);
			for (const t of typesRepos(pkg)) {
				if (!dec.has(t)) {
					violations.push(`  ${pkg} lists @repo/${t} in tsconfig compilerOptions.types — NOT declared in package.json`);
				}
			}
		}
		assert.deepEqual(violations, [], violations.length ? "undeclared tsconfig type deps:\n" + violations.join("\n") : "");
	});

	it("no package imports itself via @repo/ (use relative imports)", () => {
		const violations = EXTS.filter((pkg) => edges(pkg).has(pkg));
		assert.deepEqual(violations, [], `self-imports: ${violations.join(", ")} (use relative imports instead)`);
	});

	it("ADR-0001: knowledge-layer TIER-0 (obsidian, hermes-memory) imports NOTHING from TIER-1 (knowledge-card)", () => {
		// NO allowlist, deliberately. #1323 added a SANCTIONED_EDGES set for
		// hermes→knowledge-card, reading ticket 20's "hermes→zk is the sanctioned
		// spine direction" as covering this check. That sentence is about the
		// RUNTIME CALL direction — which is why the __piKnowledgePipeline seam
		// exists — not about the static import edge this guard measures. The edge
		// is gone as of the entities.ts move (see
		// docs/adr/0001-strict-downward-edges-knowledge-layer.md § Recurrence),
		// so the exception has nothing left to except.
		//
		// If a future upward edge really is warranted, amend the ADR FIRST and
		// link the amendment here. An allowlist that outruns its ADR turns this
		// guard into a rubber stamp — it silently permitted the very inversion it
		// was written to make impossible.
		const TIER0 = ["pi-agent-ext-obsidian", "pi-agent-ext-hermes-memory"];
		const violations: string[] = [];
		for (const pkg of TIER0) {
			const upward = [...edges(pkg)].filter((t) => t === "pi-agent-ext-knowledge-card");
			if (upward.length) violations.push(`  ${pkg} → ${upward.join(", ")} (upward edge; forbidden by ADR-0001)`);
		}
		assert.deepEqual(violations, [], violations.length ? "upward edges:\n" + violations.join("\n") : "");
	});

	it("no extension imports the host (pi-agent) — the host sits above all extensions", () => {
		const violations = EXTS.filter((pkg) => edges(pkg).has("pi-agent"));
		assert.deepEqual(violations, [], `extensions importing the host: ${violations.join(", ")}`);
	});

	it("the declared @repo dependency graph is acyclic", () => {
		// DFS with white/gray/black coloring over declared-dep edges.
		const adj = new Map<string, Set<string>>();
		for (const pkg of EXTS) adj.set(pkg, declaredRepos(pkg));
		const WHITE = 0, GRAY = 1, BLACK = 2;
		const color = new Map<string, number>();
		let cycle: string[] | null = null;
		const visit = (n: string, path: string[]): boolean => {
			color.set(n, GRAY);
			for (const m of adj.get(n) ?? []) {
				if (!adj.has(m)) continue; // target outside ext set (e.g. pi-agent core) — skip
				if (color.get(m) === GRAY) { cycle = [...path, n, m]; return true; }
				if ((color.get(m) ?? WHITE) === WHITE && visit(m, [...path, n])) return true;
			}
			color.set(n, BLACK);
			return false;
		};
		for (const n of EXTS) if ((color.get(n) ?? WHITE) === WHITE && visit(n, [])) break;
		assert.equal(cycle, null, cycle ? `dependency cycle: ${cycle.join(" → ")}` : "");
	});
});

describe("parseTypesRepos (tsconfig `types` dependency edges)", () => {
	it("extracts @repo entries from compilerOptions.types", () => {
		const t = { compilerOptions: { types: ["bun", "@repo/pi-agent-ext-core-interface"] } };
		assert.deepEqual([...parseTypesRepos(t)], ["pi-agent-ext-core-interface"]);
	});

	it("ignores non-@repo entries", () => {
		assert.deepEqual([...parseTypesRepos({ compilerOptions: { types: ["bun", "node"] } })], []);
	});

	it("returns empty when types is absent, empty, or not an array", () => {
		assert.deepEqual([...parseTypesRepos({ compilerOptions: {} })], []);
		assert.deepEqual([...parseTypesRepos({})], []);
		assert.deepEqual([...parseTypesRepos({ compilerOptions: { types: [] } })], []);
		assert.deepEqual([...parseTypesRepos({ compilerOptions: { types: "bun" } })], []);
	});
});
