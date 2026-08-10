/**
 * Cross-extension isolation contract — the "tight yet swappable" guard for the
 * core trio {superpowers, wayfind, prompt-history}. They coexist every session
 * and share conventions (.planning/ layout, ctx.cwd) but must NEVER import each
 * other's code — coupling goes only through Pi's extension API and the guarded
 * globalThis seams. That zero-cross-import invariant is what makes each
 * independently removable / disableable (the BUN_PI_*=0 self-gates added
 * alongside this test).
 *
 * Invariants:
 *  (1) NO CROSS-IMPORTS [static] — scan each trio package's `src/` + `extensions/`
 *      `.ts` for import statements targeting either of the other two, in EITHER
 *      specifier form (`@repo/pi-agent-ext-<x>` OR a relative `../pi-agent-ext-<x>`).
 *      Matches ONLY import syntax (`from "…"`, `import("…")`, side-effect
 *      `import "…"`) — never prose mentions in comments — so a JSDoc `@see`
 *      cannot false-positive. Relationship to `dep-guard.test.ts`: that guard
 *      scans EVERY `pi-agent-ext-*` for `@repo/` declared-coupling (hidden deps,
 *      self-imports, tier edges, acyclicity) — it does NOT catch relative-path
 *      cross-imports and is not trio-scoped, so invariant (1) stays here as the
 *      strict, trio-local, both-specifier-forms version. They are complementary.
 *  (2) STANDALONE LOAD [runtime] — dynamically `import()` each entry factory and
 *      call it with a mock `pi`; assert it does not throw and registers something.
 *  (3) HONORS DISABLE ENV [runtime] — with `BUN_PI_<NAME>=0` set, call each
 *      factory with a recording mock; assert it registers NOTHING. Restore env.
 *
 * Run: bun test tests/extension-isolation-contract.test.ts
 */
import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), ".."); // bun-apps/
const TRIO = ["pi-agent-ext-superpowers", "pi-agent-ext-wayfind", "pi-agent-ext-prompt-history"] as const;
const ENTRY = {
	"pi-agent-ext-superpowers": "extensions/superpowers.ts",
	"pi-agent-ext-wayfind": "extensions/wayfind.ts",
	"pi-agent-ext-prompt-history": "extensions/prompt-history.ts",
} as const;
const DISABLE_ENV = {
	"pi-agent-ext-superpowers": "BUN_PI_SUPERPOWERS",
	"pi-agent-ext-wayfind": "BUN_PI_WAYFIND",
	"pi-agent-ext-prompt-history": "BUN_PI_PROMPT_HISTORY",
} as const;

/** Walk a package's `src/` + `extensions/` `.ts` source (skip tests/fixtures/node_modules). */
function collectTs(pkgDir: string): string[] {
	const out: string[] = [];
	const walk = (dir: string) => {
		let entries: ReturnType<typeof readdirSync>;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const ent of entries) {
			if (ent.name === "node_modules" || ent.name === "__tests__" || ent.name === "fixtures") continue;
			const p = join(dir, ent.name);
			if (ent.isDirectory()) {
				walk(p);
				continue;
			}
			if (/\.ts$/.test(ent.name) && !/\.test\./.test(ent.name)) out.push(p);
		}
	};
	walk(join(pkgDir, "src"));
	walk(join(pkgDir, "extensions"));
	return out;
}

/** Forbidden specs for a package = the OTHER two, in both specifier forms. */
function forbiddenSpecs(self: string): string[] {
	return TRIO.filter((p) => p !== self).flatMap((p) => [`@repo/${p}`, p]);
}

/** Recording mock: counts on/registerTool/registerCommand (the trio's only
 *  registration surfaces) and no-ops everything else the factories touch. */
function recordingPi(): { pi: any; count: () => number } {
	let on = 0;
	let tool = 0;
	let cmd = 0;
	const pi = {
		on: () => {
			on++;
		},
		registerTool: () => {
			tool++;
		},
		registerCommand: () => {
			cmd++;
		},
		sendUserMessage: () => {},
		notify: () => {},
		setStatus: () => {},
		events: { on: () => () => {}, emit: () => {} },
	};
	return { pi, count: () => on + tool + cmd };
}

describe("cross-extension isolation contract (superpowers ↔ wayfind ↔ prompt-history)", () => {
	it("(1) NO CROSS-IMPORTS among the trio", () => {
		const violations: string[] = [];
		for (const pkg of TRIO) {
			const forbidden = forbiddenSpecs(pkg);
			for (const file of collectTs(join(ROOT, pkg))) {
				const lines = readFileSync(file, "utf8").split("\n");
				for (const raw of lines) {
					const t = raw.trim();
					// Skip whole-line comments (JSDoc '*', '//', '/*') — keeps prose
					// mentions (e.g. a `@see` link) from false-positiving.
					if (t.startsWith("*") || t.startsWith("//") || t.startsWith("/*")) continue;
					for (const spec of forbidden) {
						const esc = spec.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
						// Import-statement-only: `from "…<spec>…"`, dynamic `import("…")`,
						// or side-effect `import "…"`. The spec may sit anywhere inside the
						// quoted specifier (incl. a trailing subpath like `/src/state.js`), so
						// both the prefix and suffix are `[^"']*`; a bare string literal not
						// in import syntax never matches.
						const reFrom = new RegExp(`\\bfrom\\s*["'][^"']*${esc}[^"']*["']`);
						const reDyn = new RegExp(`\\bimport\\s*\\(\\s*["'][^"']*${esc}[^"']*["']`);
						const reSideEffect = new RegExp(`\\bimport\\s+["'][^"']*${esc}[^"']*["']`);
						if (reFrom.test(raw) || reDyn.test(raw) || reSideEffect.test(raw)) {
							violations.push(`${pkg}: ${t}`);
						}
					}
				}
			}
		}
		assert.deepEqual(
			violations,
			[],
			violations.length
				? `CROSS-IMPORT VIOLATIONS — the core trio must couple only via the Pi extension API, never direct imports:\n${violations.join("\n")}`
				: "",
		);
	});

	for (const pkg of TRIO) {
		it(`(${pkg}) STANDALONE LOAD + HONORS DISABLE ENV`, async () => {
			const mod = await import(join(ROOT, pkg, ENTRY[pkg]));
			assert.equal(typeof mod.default, "function", `${pkg} entry has no default factory`);
			const envKey = DISABLE_ENV[pkg];
			const saved = process.env[envKey];

			// (2) enabled → loads, runs, registers something.
			delete process.env[envKey];
			const enabled = recordingPi();
			assert.doesNotThrow(() => mod.default(enabled.pi), `${pkg} threw when enabled`);
			assert.ok(enabled.count() > 0, `${pkg} registered nothing when enabled`);

			// (3) disabled → registers nothing.
			process.env[envKey] = "0";
			const disabled = recordingPi();
			mod.default(disabled.pi);
			assert.equal(disabled.count(), 0, `${pkg} registered while ${envKey}=0`);

			if (saved === undefined) delete process.env[envKey];
			else process.env[envKey] = saved;
		});
	}
});
