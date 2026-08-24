/**
 * `schema-cost` — estimate the per-request API schema token cost of every
 * registered tool, WITHOUT booting the full interactive agent.
 *
 * The agent sends each tool's `description` + the JSON Schema of its TypeBox
 * `parameters` in the API `tools` array on every request. This module measures
 * that cost so it can be ranked, baselined, and (selectively) reduced.
 *
 * Two collection paths:
 *   1. **Built-ins** via `createCodingTools(cwd)` (read/bash/edit/write) — the
 *      always-present baseline, no extension loading.
 *   2. **Extensions** via a *capturing mock API*: each `ExtensionFactory` is
 *      `(pi: ExtensionAPI) => void`, and every repo extension registers its
 *      tools with `pi.registerTool(def)` at load time. We invoke the factory
 *      with a Proxy whose `registerTool` captures the definition — no runner,
 *      no `bindCore`, no model/services required. (The runtime's `getAllTools`
 *      is a throwing stub until `runner.initialize()`, which needs the full
 *      agent services; the mock-API path sidesteps that entirely.)
 *
 * Token estimate: `(description.length + JSON.stringify(parameters).length) / 4`
 * — the standard ~4-chars-per-token heuristic for English text + JSON. It's an
 * ESTIMATE (real cost depends on the provider's tokenizer), but it ranks tools
 * correctly and is deterministic + offline, which is what we need to track cost
 * across changes. Mirrors the approach `inspect_context` reports in-agent.
 */
import { createCodingTools } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { resolve, relative, isAbsolute, join } from "node:path";

// --- pure core delegated to the schema-cost submodule ----------------------
// The static schema-cost accounting (estimateToolCost + formatting + types)
// lives in `@repo/s2-agent-ext-power-tool/schema-cost` (a zero-dep internal
// submodule). This command keeps ONLY the pi-coupled collection half
// (capturing mock API, repo discovery, builtin loading via createCodingTools)
// and delegates the pure accounting to that submodule. The parity contract
// (src/schema-cost/__tests__/estimate.test.ts) guarantees identical numbers.
//
// Note on the token ratio: the submodule defaults to 4 (matching this static
// instrument). The live `inspect_context` (same package, src/index.ts) uses
// 3.7 — a known inconsistency; standardizing is a future cleanup, not this cycle.
import {
	estimateToolCost as _estimateToolCost,
	checkToolContract as _checkToolContract,
	formatReport as _formatReport,
	formatJson as _formatJson,
} from "@repo/s2-agent-ext-power-tool/schema-cost";

// `ToolCost` / `SchemaCostReport` are imported for INTERNAL type annotations only
// (collectBuiltinToolCosts/collectExtensionToolCosts/buildSchemaCostReport).
// The @deprecated `export type { ToolCost, SchemaCostReport }` re-export alias
// that used to live here was removed in the gating-field migration (Task 5):
// consumers now import these types from
// `@repo/s2-agent-ext-power-tool/schema-cost` directly. (The value delegates
// below — estimateToolCost/checkToolContract/formatSchemaCostReport/
// formatSchemaCostJson — are retained: they back the command's own unit test
// and the two estimate/check helpers are used internally by the collection
// logic, so they are not pure re-export scaffolding.)
import type { ToolCost, SchemaCostReport } from "@repo/s2-agent-ext-power-tool/schema-cost";

/** @deprecated delegate — import from `@repo/s2-agent-ext-power-tool/schema-cost`
 *  directly. Kept as an alias so existing imports from this module stay valid. */
export const estimateToolCost = _estimateToolCost;
export const checkToolContract = _checkToolContract;

// --- capturing mock API ------------------------------------------------------

/**
 * A permissive mock `ExtensionAPI`: every property access returns a callable.
 * `registerTool` captures the definition; `on` swallows event handlers (some
 * extensions register tools at load, others in `session_start` — load-time
 * capture covers the repo's extensions, which all register eagerly); everything
 * else is a no-op so factories that call `defineFlag`/`getFlag`/etc. don't throw;
 * `events` returns undefined (no bus) so host-fn registration is skipped, not thrown.
 */
export function createCapturingApi(source: string, sink: ToolCost[]): object {
	return new Proxy({} as object, {
		get(_t, prop: string) {
			if (prop === "registerTool")
				return (def: unknown) => {
					const cost = estimateToolCost(def, source);
					const c = checkToolContract(def);
					cost.hasExecute = c.hasExecute;
					cost.schemaValid = c.schemaValid;
					sink.push(cost);
				};
			// `on(event, handler)` — swallow; we capture load-time registrations only.
			if (prop === "on") return () => {};
			// `events` (the workflow host-fn bus) → undefined: the mock models an
			// ABSENT bus, so extensions guarding `if (!pi.events) return` take their
			// own no-bus path instead of calling `bus.emit(...)` on a truthy callable.
			if (prop === "events") return undefined;
			// every other method (defineFlag, getFlag, registerCommand, ...) → no-op
			return () => undefined;
		},
	});
}

// --- collection --------------------------------------------------------------

/** Built-in core tools (read/bash/edit/write) via the SDK's own factory. */
export function collectBuiltinToolCosts(cwd: string): ToolCost[] {
	const tools = createCodingTools(cwd) as unknown as Array<{ definition?: unknown } | Record<string, unknown>>;
	const out: ToolCost[] = [];
	for (const t of tools) {
		const def = (t as { definition?: unknown }).definition ?? t;
		const cost = estimateToolCost(def, "(builtin)");
		const c = checkToolContract(def);
		cost.hasExecute = c.hasExecute;
		cost.schemaValid = c.schemaValid;
		out.push(cost);
	}
	return out;
}

/** Load each extension factory + capture its registered tools. */
export async function collectExtensionToolCosts(
	entries: { source: string; path: string }[],
): Promise<{ costs: ToolCost[]; errors: { source: string; error: string }[] }> {
	const costs: ToolCost[] = [];
	const errors: { source: string; error: string }[] = [];
	for (const { source, path } of entries) {
		try {
			const mod = await import(path);
			const factory = mod.default ?? mod.extension;
			if (typeof factory !== "function") {
				errors.push({ source, error: "no default factory export" });
				continue;
			}
			const api = createCapturingApi(source, costs);
			await factory(api);
		} catch (e) {
			errors.push({ source, error: (e as Error).message?.slice(0, 160) ?? String(e) });
		}
	}
	return { costs, errors };
}

/**
 * Entries kept OUTSIDE the manifest derivation: measurable extension files
 * that are not registered anywhere in s2-agent (neither manifest.extensions
 * nor staticExtensions) but are still worth costing.
 */
// Empty today. The movie-director-cost prototype that once lived here was
// deleted (2026-08-10): measuring an extension offline while it never loads is
// what let a phantom `cost` gate inflate savings by ~536 tok/req.
const EXTRA_ENTRIES: { source: string; path: string }[] = [
	// Registry-disabled 2026-08-24 (default-off in dev + deploy after the
	// #1946 half-fix incident) — no longer in run-dir/manifest.json, but its
	// schema mass stays measured while the package exists so a re-enable
	// decision has current numbers (the canary row CLAUDE.md describes).
	{ source: "tool-gate", path: "bun-apps/s2-agent-ext-tool-gate/extensions/tool-gate.ts" },
];

/**
 * Discover extension entry files by DERIVING them from s2-agent's
 * run-dir/manifest.json — the single source of truth for what a s2-agent
 * session loads:
 *   - `extensions[]`       → `bun-apps/<entry>` (dynamic `-e` set)
 *   - `staticExtensions[]` → `bun-apps/<pkg>/extensions/<suffix>.ts` where
 *     suffix = pkg minus the `s2-agent-ext-` prefix (the repo-wide canonical
 *     entry convention, enforced since #675)
 * plus EXTRA_ENTRIES above. Adding/removing an extension in s2-agent needs
 * ZERO edits here. Falls back to EXTRA_ENTRIES only when the manifest is
 * unreadable (e.g. a compiled CLI running outside the repo).
 */
export function discoverExtensionEntries(cwd: string): { source: string; path: string }[] {
	let manifest: { extensions?: (string | { entry: string })[]; staticExtensions?: string[] } = {};
	try {
		manifest = JSON.parse(
			readFileSync(resolve(cwd, "bun-apps/s2-agent/run-dir/manifest.json"), "utf8"),
		);
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") {
			// manifest absent (e.g. a compiled CLI running outside the repo) —
			// measure extras only. Legitimate: there is simply nothing to derive.
		} else {
			// The manifest EXISTS but is unreadable/malformed. Swallowing this
			// would silently fall back to extras-only and produce a FALSE-GREEN
			// report (undercounting loaded tools — could mask a phantom or
			// understate cost). Surface it loudly instead (audit I-7, 2026-07-25).
			throw new Error(
				`schema-cost: bun-apps/s2-agent/run-dir/manifest.json is unreadable — ` +
				`${(e as Error).message}. Fix the manifest; a silent extras-only ` +
				`fallback would produce a misleading (false-green) report.`,
			);
		}
	}
	const entries: { source: string; path: string }[] = [];
	for (const e of manifest.extensions ?? []) {
		const rel = typeof e === "string" ? e : e.entry;
		const pkg = rel.split("/")[0] ?? "";
		entries.push({ source: pkg.replace(/^s2-agent-ext-/, ""), path: `bun-apps/${rel}` });
	}
	for (const pkg of manifest.staticExtensions ?? []) {
		const suffix = pkg.replace(/^s2-agent-ext-/, "");
		entries.push({ source: suffix, path: `bun-apps/${pkg}/extensions/${suffix}.ts` });
	}
	entries.push(...EXTRA_ENTRIES);
	const out: { source: string; path: string }[] = [];
	const seen = new Set<string>();
	for (const e of entries) {
		const abs = isAbsolute(e.path) ? e.path : resolve(cwd, e.path);
		if (seen.has(abs)) continue;
		seen.add(abs);
		out.push({ source: e.source, path: abs });
	}
	return out;
}

/**
 * Resolve the repo root: walk up from `from` until a dir containing `bun-apps/`
 * is found. Falls back to `from` if none (so the command still runs, just with
 * no extensions discovered).
 */
export function resolveRepoRoot(from: string = process.cwd()): string {
	let dir = resolve(from);
	for (let i = 0; i < 8; i++) {
		if (existsSync(join(dir, "bun-apps"))) return dir;
		const parent = resolve(dir, "..");
		if (parent === dir) break;
		dir = parent;
	}
	return resolve(from);
}

/** Build the full report (built-ins + extensions), sorted by cost desc. */
export async function buildSchemaCostReport(
	cwd?: string,
	entries?: { source: string; path: string }[],
): Promise<SchemaCostReport> {
	const root = cwd ?? resolveRepoRoot();
	const all = collectBuiltinToolCosts(root);
	const ents = entries ?? discoverExtensionEntries(root);
	const { costs, errors } = await collectExtensionToolCosts(ents);
	all.push(...costs);
	all.sort((a, b) => b.approxTokens - a.approxTokens || a.name.localeCompare(b.name));
	return {
		tools: all,
		totalTokens: all.reduce((s, t) => s + t.approxTokens, 0),
		builtinCount: all.filter((t) => t.source === "(builtin)").length,
		extensionCount: all.length - all.filter((t) => t.source === "(builtin)").length,
		errors,
	};
}

// --- formatting (delegated to schema-cost submodule) -----------------------

/**
 * Disambiguated re-exports of the power-tool formatters. NOT deprecated
 * scaffolding — `tools-metrics.ts` declares its own `formatReport` /
 * `formatJson` over a different type (`MetricsReport`), so it imports the
 * schema-cost pair under these names. Importing the bare names there is a
 * silent type collision, not a cleanup.
 */
export const formatSchemaCostReport = _formatReport;
export const formatSchemaCostJson = _formatJson;
