/**
 * Config-field parity guard (wayfinder ticket 03 — self-reflection frontier).
 *
 * The footgun: `pi-agent-ext-hermes-memory`'s `loadConfig` is a selective
 * per-field copy (`if (typeof parsed.X === ...) config.X = parsed.X`). A field
 * added to the `MemoryConfig` type (`types.ts`) but omitted from `loadConfig`
 * is SILENTLY DROPPED — a config-file value is ignored, and (because the
 * consumer reads `config.X ?? envOrDefault(...)`) the drop is masked by the
 * fallback. Compiles clean, tests green, breaks only in production when a user
 * sets the field in `hermes-memory-config.json` and nothing happens. This guard
 * turns that silent drop loud.
 *
 * Invariants:
 *  1. NO SILENT DROPS — every top-level field of the config interface is read
 *     as `parsed.<field>` in `loadConfig`, OR is explicitly allowlisted (a
 *     field that is intentionally default-only / derived / computed, never
 *     config-file-settable). Adding a field to the type without copying it in
 *     `loadConfig` (and without allowlisting it) fails here.
 *  2. ALLOWLIST STAYS HONEST — no allowlisted field is actually read as
 *     `parsed.<field>` in `loadConfig`. A field that becomes config-file-settable
 *     must be REMOVED from the allowlist; a stale entry hides nothing but lies.
 *
 * Static source analysis only — NO runtime import of any package (mirrors the
 * seam/routing guards; reads source as text). Scope is a package REGISTRY so
 * adding another config-bearing package (`core-task/ask-user`, …) is a one-line
 * entry, not a new test file.
 *
 * Run: bun run test:config-parity   (from bun-apps/)
 */
import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), ".."); // bun-apps/

/**
 * The registry of config-bearing packages this guard covers. Add a package
 * here when it adopts the `types.ts` config-interface + `loadConfig`
 * selective-copy pattern. `allowlist` names fields intentionally NOT read from
 * the config file (default-only / derived / computed); keep it empty by default
 * — a field belongs here only when a config-file value for it is deliberately
 * meaningless.
 */
const PACKAGES = [
	{
		name: "pi-agent-ext-hermes-memory",
		typeFile: "src/types.ts",
		interfaceName: "MemoryConfig",
		loadConfigFile: "src/config.ts",
		// Repo-local-overlay-sourced (NOT the global config file): these ride the
		// narrow overlay at <cwd>/.agents/memory/config.json (tickets 01/09), never
		// the global hermes-memory-config.json — so a global `parsed.<field>` copy
		// would be wrong (it'd defeat the per-repo opt-in). Read in
		// applyRepoLocalProjectMemoryOverlay (as `overlay.<field>`, not `parsed.<field>`).
		allowlist: ["autoCommitProjectMemory", "projectName", "kgLlmModel"] as string[], // kgLlmModel: deferred — carried via IngestOptions, not loadConfig
	},
] as const;

// ─── source extraction ──────────────────────────────────────────────────────

/** Lines of a brace-delimited block, starting at the first line containing
 *  `open`, counting `{`/`}` until depth returns to 0. (Mirrors seam-contract.) */
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

/** Top-level field names of a `interface <Name> { ... }` block. Matches
 *  `<2-space indent>fieldName:? :` so JSDoc (`/**`, ` *`) and nested-type lines
 *  are excluded. The MemoryConfig body references nested types BY NAME (no
 *  inline `{ ... }`), so brace depth stays flat and this is exact. */
function extractInterfaceFields(src: string, ifaceName: string): string[] {
	const block = braceBlock(src, `interface ${ifaceName}`);
	const fields: string[] = [];
	for (const raw of block.split("\n")) {
		const m = raw.match(/^  ([a-zA-Z_]\w*)\??\s*:/);
		if (m) fields.push(m[1] as string);
	}
	return fields;
}

/** True if `loadConfig` reads the field from the parsed config object. The
 *  selective-copy always takes the form `parsed.<field>` (guarded by a typeof /
 *  validator check). `\b` prevents `parsed.foo` from matching `parsed.foobar`. */
function isReadFromConfig(loadSrc: string, field: string): boolean {
	return new RegExp(`parsed\\.${field}\\b`).test(loadSrc);
}

// ─── the guard ──────────────────────────────────────────────────────────────

describe("config-field parity guard (ticket 03 — no silently-dropped config fields)", () => {
	for (const pkg of PACKAGES) {
		const typeSrc = readFileSync(join(ROOT, pkg.name, pkg.typeFile), "utf8");
		const loadSrc = readFileSync(join(ROOT, pkg.name, pkg.loadConfigFile), "utf8");
		const fields = extractInterfaceFields(typeSrc, pkg.interfaceName);
		const allow = new Set<string>(pkg.allowlist);

		it(`${pkg.name}: every ${pkg.interfaceName} field is read in loadConfig (or explicitly allowlisted)`, () => {
			// Grounding: guard against a vacuous pass if extraction silently misses everything.
			assert.ok(fields.length >= 20, `expected ≥20 fields on ${pkg.interfaceName}, got ${fields.length} (interface extraction miss?)`);
			const dropped = fields.filter((f) => !allow.has(f) && !isReadFromConfig(loadSrc, f));
			const detail = dropped
				.map((f) => `  "${f}" — declared in ${pkg.interfaceName} (${pkg.typeFile}) but never read as parsed.${f} in ${pkg.loadConfigFile}; a config-file value is silently ignored`)
				.join("\n");
			assert.deepEqual(dropped, [], dropped.length
				? `SILENTLY-DROPPED CONFIG FIELDS in ${pkg.name} — declared in the type but never copied in loadConfig. Add the selective-copy line (e.g. \`if (typeof parsed.<field> === "number") config.<field> = parsed.<field>;\`), or add the field to the registry allowlist if it is intentionally default-only/derived:\n${detail}`
				: "");
		});

		it(`${pkg.name}: allowlist stays honest (no allowlisted field is actually read)`, () => {
			const stale = [...allow].filter((f) => isReadFromConfig(loadSrc, f));
			assert.deepEqual(stale, [], stale.length
				? `STALE ALLOWLIST in ${pkg.name} — these fields ARE read as parsed.<field> in loadConfig, so allowlisting them is wrong (remove them from the registry allowlist):\n${stale.map((f) => `  "${f}"`).join("\n")}`
				: "");
		});
	}
});
