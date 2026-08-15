/**
 * Cross-extension seam-contract guard (ADR-wayfind-0004; generalized ticket 03).
 *
 * The `__pi*` family is a set of process-singleton keys on `globalThis` (jiti-
 * safe) that wire the coexistence between extensions: the status composite
 * widget, yield-coordination flags, and the plan coordinator's published reads.
 * Each key's string is duplicated across its publisher + consumer(s) with NO
 * compile-time link, and each side's own tests mock its own literal — so a
 * rename in the publisher compiles clean, stays green, and breaks consumers
 * ONLY in production. This guard turns that silent drift loud.
 *
 * Invariants:
 *  1. NO ORPHANS — every `__pi*` token referenced in production source (as a
 *     quoted string literal OR a property access) is a registered SEAM_KEY.
 *     A rename creates a new token → orphan → loud fail. Adding a new `__pi*`
 *     key without registering it here fails too — that registration IS the
 *     contract being maintained.
 *  2. NO DEAD KEYS — every registered SEAM_KEY is actually referenced in
 *     production source (the spec stays honest; a removed key must be dropped
 *     from SEAM_KEYS).
 *  3. STATUS-WIDGET SHAPE — for the one OBJECT-valued key, every method a
 *     consumer declares on its structural view is a public method of the
 *     publisher's widget class. (Function-valued keys need no shape guard:
 *     TS signatures are erased at runtime, and every consumer already
 *     defensively checks `typeof === 'function'` → graceful fallback, never a
 *     silent break. The dominant drift vector for them is the key rename,
 *     caught by invariant 1.)
 *  4. NO SELF-ONLY SEAMS — every cross-package SEAM_KEY is referenced by ≥2
 *     distinct packages (publisher + consumer). A key green-lit by its own
 *     publisher alone (constant-def + self-check) is rejected, closing the
 *     self-reference loophole that let the dead __piWayfindActive seam pass.
 *     Intra-package keys (crossPackage:false) are exempt.
 *
 * Static source analysis only — NO runtime import of any package (respects
 * ADR-wayfind-0004's decoupling + the jiti constraint). Reads source as text; skips
 * comment lines + `__tests__`/`fixtures` so prose mentions like `__piPlan*`
 * (which match neither a quoted literal nor a `.property` access) are excluded.
 *
 * Run: bun run test:seam   (from bun-apps/)
 */
import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// Relative path, NOT the "@repo/…" bare specifier: this gate must stay immune
// to bun-apps/node_modules/@repo/* link state. The Bun runtime (1.3.14)
// rewrites those workspace links to a dangling form on bun invocations inside
// bun-apps/ — a mid-CI bun-spawned step could otherwise ENOENT this import and
// fail the gate spuriously (observed 2026-08-15: local_ci's seam gate red while
// the same gate passed standalone). core-interface is a src-entry package
// (exports["."] → ./src/index.ts), so the relative import is the same module
// the specifier resolves to, with no node_modules indirection.
import { SEAM_KEY_ENTRIES } from "../pi-agent-ext-core-interface/src/index.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), ".."); // bun-apps/
const EXTS = readdirSync(ROOT)
	.filter((d) => d.startsWith("pi-agent-ext-") && existsSync(join(ROOT, d, "package.json")));

/**
 * The canonical `__pi*` seam-key contract. The registry now lives in
 * `@repo/pi-agent-ext-core-interface` (`SEAM_KEY_ENTRIES`, single source of
 * truth) — aliased into `SEAM_KEYS` below; a key belongs iff it is a
 * process-global coordination/data surface. Value-shape noted per key; only the
 * object-valued status widget also carries a SHAPE invariant (see spec below).
 *
 * `crossPackage` is the per-key topology that drives the NO SELF-ONLY SEAMS
 * invariant (invariant 4):
 *  - true  = the seam is INTENDED to cross package boundaries — its publisher
 *            and consumer live in DIFFERENT packages, so it MUST be referenced
 *            by ≥2 distinct packages (publisher + consumer). Closes the
 *            self-reference loophole (a key green-lit by its own publisher's
 *            constant-def + self-check alone).
 *  - false = intentionally INTRA-package (publisher + sole consumer in the
 *            same package, e.g. goal⇄loop within core-task) — exempt from the
 *            ≥2 requirement.
 */
type SeamKey = { key: string; crossPackage: boolean };

// Aliased from the core-interface registry so the scanner + the
// `findSelfOnlySeams` predicate keep their `SeamKey` element shape
// ({ key, crossPackage }). 8 keys: 7 legacy + __piKnowledgePipeline.
const SEAM_KEYS: readonly SeamKey[] = SEAM_KEY_ENTRIES;
const SEAM_KEY_SET = new Set<string>(SEAM_KEYS.map((s) => s.key));

// ─── source scan ────────────────────────────────────────────────────────────

/** Reference forms that count as REAL usage (vs prose):
 *  - a quoted string literal (the constant definition), or
 *  - a `.property` access (read / assign on globalThis).
 *  Prose like `__piPlan*` matches neither → correctly excluded. */
const RE_QUOTED = /"__pi[A-Z][A-Za-z0-9]*"/g;
const RE_ACCESS = /\.__pi[A-Z][A-Za-z0-9]*/g;

/** Walk every extension's production `src/` AND `extensions/` (the canonical seam-registration entry where keys are published) and collect each `__pi*` token → the set of packages that reference it. Skips comments + test/fixture dirs. */
function scanSeamReferences(): Map<string, Set<string>> {
	const refs = new Map<string, Set<string>>();
	const note = (tok: string, pkg: string) => {
		if (!refs.has(tok)) refs.set(tok, new Set());
		refs.get(tok)!.add(pkg);
	};
	const walk = (dir: string, pkg: string) => {
		let entries: ReturnType<typeof readdirSync>;
		try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
		for (const ent of entries) {
			if (ent.name === "node_modules" || ent.name === "__tests__" || ent.name === "fixtures") continue;
			const p = join(dir, ent.name);
			if (ent.isDirectory()) { walk(p, pkg); continue; }
			if (!/\.ts$/.test(ent.name) || /\.test\./.test(ent.name)) continue;
			for (const raw of readFileSync(p, "utf8").split("\n")) {
				const t = raw.trim();
				// Skip comment lines (JSDoc '*', '//', '/*') — the historical
				// false positives were prose mentions inside doc comments.
				if (t.startsWith("*") || t.startsWith("//") || t.startsWith("/*")) continue;
				for (const m of raw.matchAll(RE_QUOTED)) note((m[0] as string).slice(1, -1), pkg); // strip quotes
				for (const m of raw.matchAll(RE_ACCESS)) note((m[0] as string).slice(1), pkg); // strip leading '.'
			}
		}
	};
	for (const pkg of EXTS) {
		walk(join(ROOT, pkg, "src"), pkg);
		walk(join(ROOT, pkg, "extensions"), pkg); // canonical seam-registration entry (CLAUDE.md); publish sites live here
	}
	return refs;
}

/** Keys registered as cross-package but referenced by <2 distinct packages —
 *  i.e. only their own publisher (constant-def + self-check) references them,
 *  so the documented cross-package consumer is MISSING. Pure for unit testing. */
function findSelfOnlySeams(seams: readonly SeamKey[], refs: Map<string, Set<string>>): string[] {
	return seams
		.filter((s) => s.crossPackage && (refs.get(s.key)?.size ?? 0) < 2)
		.map((s) => s.key)
		.sort();
}

// ─── shape extraction (status widget only — the one OBJECT-valued key) ───────

function readPkgFile(pkg: string, rel: string): string {
	return readFileSync(join(ROOT, pkg, rel), "utf8");
}

/** Lines of a brace-delimited block, starting at the first line containing
 *  `open`, counting `{`/`}` until depth returns to 0. */
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

function extractClassMethods(src: string, className: string): Set<string> {
	const block = braceBlock(src, `class ${className}`);
	const methods = new Set<string>();
	for (const raw of block.split("\n")) {
		const m = raw.match(/^\t([a-zA-Z_]\w*)\s*[(<]/);
		if (m && !/\b(private|protected|readonly|static)\b/.test(raw)) methods.add(m[1] as string);
	}
	return methods;
}

function extractInterfaceMethods(src: string, ifaceName: string): Set<string> {
	const block = braceBlock(src, `interface ${ifaceName}`);
	const methods = new Set<string>();
	for (const raw of block.split("\n")) {
		const m = raw.match(/^\s{2}([a-zA-Z_]\w*)\s*\(/);
		if (m) methods.add(m[1] as string);
	}
	return methods;
}

function extractInlineTypeMethods(src: string, anchor: string): Set<string> {
	const block = braceBlock(src, anchor);
	const methods = new Set<string>();
	for (const raw of block.split("\n")) {
		const m = raw.match(/([a-zA-Z_]\w*)\??\s*:\s*\(/);
		if (m) methods.add(m[1] as string);
	}
	return methods;
}

// The status widget is the one object-valued seam → it alone carries a SHAPE
// invariant (consumer-declared methods ⊆ publisher class public methods).
const STATUS_WIDGET = {
	key: "__piCoreTaskStatusWidget",
	publisher: { pkg: "pi-agent-ext-core-task", file: "src/shared/status-widget.ts", className: "CoreTaskStatusWidget" },
	consumers: [
		{ pkg: "pi-agent-ext-wayfind", methods: () => extractInterfaceMethods(readPkgFile("pi-agent-ext-wayfind", "src/index.ts"), "SharedStatusWidget") },
		{ pkg: "pi-agent-ext-power-tool", methods: () => extractInlineTypeMethods(readPkgFile("pi-agent-ext-power-tool", "src/tools/inspect-tui.ts"), "__piCoreTaskStatusWidget as {") },
	],
};

describe("cross-extension __pi* seam contract (ADR-wayfind-0004; generalized ticket 03)", () => {
	const refs = scanSeamReferences();

	it("NO ORPHANS — every __pi* token referenced in production source is a registered SEAM_KEY", () => {
		const orphans = [...refs.keys()].filter((tok) => !SEAM_KEY_SET.has(tok)).sort();
		const detail = orphans.map((tok) => `  "${tok}" referenced in: ${[...(refs.get(tok) ?? [])].sort().join(", ")}`).join("\n");
		assert.deepEqual(orphans, [], orphans.length
			? `ORPHAN __pi* KEYS — a token is referenced in production source but not registered in SEAM_KEYS.\nEither rename it away from the __pi* convention, or register it in SEAM_KEYS (that act IS maintaining the contract):\n${detail}`
			: "");
	});

	it("NO DEAD KEYS — every registered SEAM_KEY is actually referenced in production source", () => {
		const dead = SEAM_KEYS.filter((s) => !refs.has(s.key)).map((s) => s.key);
		assert.deepEqual(dead, [], dead.length
			? `DEAD SEAM_KEYS — registered but unreferenced in production source (remove from SEAM_KEYS, or wire the key):\n${dead.map((k) => `  "${k}"`).join("\n")}`
			: "");
	});

	it("NO SELF-ONLY SEAMS — every cross-package SEAM_KEY is referenced by ≥2 distinct packages (publisher + consumer; closes the self-reference loophole)", () => {
		const selfOnly = findSelfOnlySeams(SEAM_KEYS, refs);
		const detail = selfOnly
			.map((k) => `  "${k}" referenced by: ${(refs.get(k) && [...(refs.get(k) as Set<string>)].sort().join(", ")) || "(nobody)"}`)
			.join("\n");
		assert.deepEqual(selfOnly, [], selfOnly.length
			? `SELF-ONLY SEAM_KEYS — a cross-package seam is referenced by <2 packages (only its own publisher?), so the documented consumer is missing. Either wire the consumer, mark the key crossPackage:false if it is intentionally intra-package, or drop it from SEAM_KEYS:\n${detail}`
			: "");
	});

	it("STATUS-WIDGET SHAPE — every method a consumer declares on the widget is a public method of the publisher's class", () => {
		const pubMethods = extractClassMethods(readPkgFile(STATUS_WIDGET.publisher.pkg, STATUS_WIDGET.publisher.file), STATUS_WIDGET.publisher.className);
		// Grounding: guard against a vacuous pass if a refactor shifts indentation/syntax.
		assert.ok(pubMethods.size >= 3, `expected ≥3 public methods on ${STATUS_WIDGET.publisher.className}, got ${[...pubMethods].join(", ") || "(none — extraction miss?)"}`);
		const drift: string[] = [];
		for (const c of STATUS_WIDGET.consumers) {
			const ms = c.methods();
			assert.ok(ms.size >= 1, `expected ≥1 declared method in ${c.pkg}'s seam view, got none (extraction miss?)`);
			for (const m of ms) {
				if (!pubMethods.has(m)) drift.push(`  ${c.pkg} declares "${m}" on the seam, but ${STATUS_WIDGET.publisher.className} no longer defines it (renamed? removed?)`);
			}
		}
		assert.deepEqual(drift, [], drift.length ? `SEAM SHAPE DRIFT — a publisher method rename/removal broke a consumer:\n${drift.join("\n")}` : "");
	});
});

describe("findSelfOnlySeams predicate (self-reference loophole)", () => {
	const mk = (entries: Array<[string, string[]]>): Map<string, Set<string>> =>
		new Map(entries.map(([k, pkgs]) => [k, new Set(pkgs)]));

	it("rejects a one-sided cross-package seam (publisher + self-read only) — the __piWayfindActive scenario", () => {
		// Publisher's own constant-def + self-check both resolve to ONE package.
		const refs = mk([["__piFakeActive", ["pkgPublisherOnly"]]]);
		const seams: readonly SeamKey[] = [{ key: "__piFakeActive", crossPackage: true }];
		assert.deepEqual(findSelfOnlySeams(seams, refs), ["__piFakeActive"]);
	});

	it("accepts a cross-package seam with a real second-package consumer", () => {
		const refs = mk([["__piFakeActive", ["pkgA", "pkgB"]]]);
		const seams: readonly SeamKey[] = [{ key: "__piFakeActive", crossPackage: true }];
		assert.deepEqual(findSelfOnlySeams(seams, refs), []);
	});

	it("exempts an intentionally intra-package seam even with a single referencing package", () => {
		// e.g. __piKickHeartbeat: goal publishes, loop consumes, both in core-task.
		const refs = mk([["__piIntra", ["onlyPkg"]]]);
		const seams: readonly SeamKey[] = [{ key: "__piIntra", crossPackage: false }];
		assert.deepEqual(findSelfOnlySeams(seams, refs), []);
	});

	it("flags a cross-package seam referenced by nobody", () => {
		const refs = mk([]);
		const seams: readonly SeamKey[] = [{ key: "__piGhost", crossPackage: true }];
		assert.deepEqual(findSelfOnlySeams(seams, refs), ["__piGhost"]);
	});
});
