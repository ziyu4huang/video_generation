/**
 * Monorepo dependency-hygiene guard (knowledge-layer tier rules).
 *
 * Encodes the architectural invariants of the s2-agent-ext-* layer so the
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
 *  4. Tier rule: knowledge-layer TIER-0 (obsidian, hermes-memory) imports
 *     NOTHING from the TIER-1 hub (knowledge-card) — edges point down only.
 *  5. No extension imports the host (s2-agent) — the host is above all exts.
 *  6. The declared @repo dependency graph is acyclic.
 *  7. No extension in the PORTABLE BASE SET (s2-agent.registry.yaml entries
 *     with a `deploy:` block) declares a
 *     RUNTIME dependency on another extension. Complements
 *     extension-isolation-contract.test.ts invariant (1): that one scans import
 *     statements, this one scans declarations, so a package.json edge added
 *     ahead of the import is caught at the moment it is declared. Scoped to
 *     non-dev fields on purpose — a test-only devDependency between two
 *     extensions (ext-task's ctrl-b notify test) is legitimate; a runtime edge
 *     between two independently-removable extensions is not.
 *
 * Run: bun run test:deps   (from bun-apps/)
 */
import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readJsonc } from "./read-jsonc.ts";
import { parseRegistryBaseSetNames } from "./lib/registry-base-set.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), ".."); // bun-apps/
const EXTS = readdirSync(ROOT)
	.filter((d) => d.startsWith("s2-agent-ext-") && existsSync(join(ROOT, d, "package.json")));

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
				for (const m of raw.matchAll(/(?:from\s+|import\s*\(\s*)["']@repo\/(s2-agent[-\w]*)(?:\/[^"']*)?["']/g)) {
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
 *  (a few ext packages have none). readJsonc, not JSON.parse: tsconfig.json is
 *  JSONC, and one self-documenting tsconfig used to throw here and take three
 *  unrelated assertions in this file down with it. */
function typesRepos(pkg: string): Set<string> {
	const f = join(ROOT, pkg, "tsconfig.json");
	if (!existsSync(f)) return new Set();
	return parseTypesRepos(readJsonc(f));
}

/** All @repo edges a package has: import statements ∪ tsconfig `types`. */
function edges(pkg: string): Set<string> {
	return new Set([...importedRepos(pkg), ...typesRepos(pkg)]);
}

describe("monorepo dependency hygiene guard (knowledge-layer tier rules)", () => {
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

	it("tier rule: knowledge-layer TIER-0 (obsidian, hermes-memory) imports NOTHING from TIER-1 (knowledge-card)", () => {
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
		const TIER0 = ["s2-agent-ext-obsidian", "s2-agent-ext-hermes-memory"];
		const violations: string[] = [];
		for (const pkg of TIER0) {
			const upward = [...edges(pkg)].filter((t) => t === "s2-agent-ext-knowledge-card");
			if (upward.length) violations.push(`  ${pkg} → ${upward.join(", ")} (upward edge; forbidden by the tier rule)`);
		}
		assert.deepEqual(violations, [], violations.length ? "upward edges:\n" + violations.join("\n") : "");
	});

	it("no extension imports the host (s2-agent) — the host sits above all extensions", () => {
		const violations = EXTS.filter((pkg) => edges(pkg).has("s2-agent"));
		assert.deepEqual(violations, [], `extensions importing the host: ${violations.join(", ")}`);
	});

	it("no PORTABLE BASE SET extension declares a runtime dependency on another extension", () => {
		// Base set is DERIVED from s2-agent.registry.yaml (entries carrying a
		// `deploy:` block that is not `enabled: false` — excluded entries have
		// `excludeReason` instead), via the shared scanner in
		// tests/lib/registry-base-set.ts, so promoting an extension into the
		// portable profile enrolls it here automatically. The floor guard is
		// what keeps a silent parse failure from making this vacuous.
		const yamlText = readFileSync(join(ROOT, "s2-agent", "s2-agent.registry.yaml"), "utf8");
		const baseSet = parseRegistryBaseSetNames(yamlText).map((n) => `s2-agent-ext-${n}`);
		assert.ok(baseSet.length >= 10, `parsed only ${baseSet.length} base-set name(s) from s2-agent.registry.yaml`);

		const violations: string[] = [];
		// The sanctioned base-set lib edges, both PURE LIBRARY faces:
		//   knowledge-card consumes obsidian's lib face (the bare specifier
		//   resolves to src/index.ts → src/obsidian-lib.ts, per #1737 — vault
		//   resolution, frontmatter, graph index);
		//   tool-gate consumes power-tool's schema-cost subpath (src/schema-cost
		//   — pure token-accounting, zero runtime deps beyond the typebox host,
		//   per its subpath header "consumable standalone").
		// Neither may import the target's extension entry /extensions/<name>.ts
		// (which would double-register GATE_DEFS and inline the tool factory);
		// that no-entry invariant is enforced by their own tests below.
		const BASE_SET_LIB_EDGES: ReadonlySet<string> = new Set([
			"s2-agent-ext-knowledge-card → s2-agent-ext-obsidian",
			"s2-agent-ext-tool-gate → s2-agent-ext-power-tool",
		]);
		for (const pkg of baseSet) {
			const d = JSON.parse(readFileSync(join(ROOT, pkg, "package.json"), "utf8"));
			for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
				for (const n of Object.keys(d[field] ?? {})) {
					const target = n.replace("@repo/", "");
					if (n.startsWith("@repo/") && baseSet.includes(target) && target !== pkg) {
						const edge = `${pkg} → ${target}`;
						if (BASE_SET_LIB_EDGES.has(edge)) continue;
						violations.push(`  ${edge} (${field}; forbidden — route it through a s2-agent-core-* package or a seam)`);
					}
				}
			}
		}
		assert.deepEqual(violations, [], violations.length ? "base-set runtime edges:\n" + violations.join("\n") : "");
	});

	it("knowledge-card never imports obsidian's extension entry — lib face only", () => {
		// The allowlisted edge above is safe BECAUSE it is pure library reuse
		// through the bare specifier (exports["."] → src/index.ts, #1737).
		// This pins that: any import reaching obsidian's /extensions/
		// registration entry from knowledge-card reverts the edge to forbidden
		// territory and must fail here, not in a deploy smoke.
		const KC = join(ROOT, "s2-agent-ext-knowledge-card");
		const files: string[] = [];
		const walk = (dir: string) => {
			for (const e of readdirSync(dir, { withFileTypes: true })) {
				if (e.name === "node_modules" || e.name === "__tests__") continue;
				const p = join(dir, e.name);
				if (e.isDirectory()) walk(p);
				else if (e.name.endsWith(".ts")) files.push(p);
			}
		};
		walk(join(KC, "src"));
		walk(join(KC, "extensions"));
		const bad: string[] = [];
		const spec = /["']@repo\/s2-agent-ext-obsidian(\/[^"']*)?["']/g;
		for (const f of files) {
			const text = readFileSync(f, "utf8");
			for (const m of text.matchAll(spec)) {
				const sub = m[1] ?? "";
				if (sub.startsWith("/extensions/")) {
					bad.push(`  ${f}: ${m[0]}`);
				}
			}
		}
		assert.deepEqual(bad, [], bad.length ? "non-lib obsidian imports:\n" + bad.join("\n") : "");
	});

	it("tool-gate never imports power-tool's extension entry — schema-cost subpath only", () => {
		// The allowlisted edge above is safe BECAUSE it is pure library reuse
		// through the declared subpath (exports["./schema-cost"] →
		// src/schema-cost/index.ts). This pins that: any import reaching
		// power-tool's /extensions/ registration entry from tool-gate reverts
		// the edge to forbidden territory and must fail here, not in a
		// deploy smoke.
		const TG = join(ROOT, "s2-agent-ext-tool-gate");
		const files: string[] = [];
		const walk = (dir: string) => {
			for (const e of readdirSync(dir, { withFileTypes: true })) {
				if (e.name === "node_modules" || e.name === "__tests__") continue;
				const p = join(dir, e.name);
				if (e.isDirectory()) walk(p);
				else if (e.name.endsWith(".ts")) files.push(p);
			}
		};
		// Scope = the package's RUNTIME surfaces only (src/ + extensions/), the
		// same surfaces the knowledge-card pin walks: the shipped bundle follows
		// extensions/tool-gate.ts, so a qa/-only entry import (qa/evaluate.ts
		// loads the real power-tool factory for the ON/OFF compares) can never
		// reach the dist. tool-gate keeps no src/ dir — guard each walk.
		for (const sub of ["src", "extensions"]) {
			const dir = join(TG, sub);
			if (existsSync(dir)) walk(dir);
		}
		const bad: string[] = [];
		const spec = /["']@repo\/s2-agent-ext-power-tool(\/[^"']*)?["']/g;
		for (const f of files) {
			const text = readFileSync(f, "utf8");
			for (const m of text.matchAll(spec)) {
				const sub = m[1] ?? "";
				if (sub.startsWith("/extensions/")) {
					bad.push(`  ${f}: ${m[0]}`);
				}
			}
		}
		assert.deepEqual(bad, [], bad.length ? "non-schema-cost power-tool imports:\n" + bad.join("\n") : "");
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
				if (!adj.has(m)) continue; // target outside ext set (e.g. s2-agent core) — skip
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
		const t = { compilerOptions: { types: ["bun", "@repo/s2-agent-core-interface"] } };
		assert.deepEqual([...parseTypesRepos(t)], ["s2-agent-core-interface"]);
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
