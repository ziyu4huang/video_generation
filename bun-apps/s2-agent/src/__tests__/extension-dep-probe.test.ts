/**
 * extension-dep-probe — one implementation of "is my dependency available?",
 * shared, instead of a private copy per extension.
 *
 * WHY THIS GATE EXISTS
 * --------------------
 * obsidian and file2md each grew their own copy of a startup dependency probe,
 * and both copies were wrong in the same way: they walked the filesystem for
 * `node_modules/<pkg>`, which answers a question about LAYOUT rather than about
 * availability. Each mode that does not use node_modules therefore needed its
 * own special case, and only the `bun build --compile` one was ever written.
 * When #1738 put obsidian into the sh base set, every deployed session opened
 * with a red "pi-obsidian: missing npm packages" error — the packages were
 * there all along, served by the host's injected require.
 *
 * Two copies meant two places to fix and two places to forget. This test makes
 * the third copy impossible: the probe lives in `@repo/s2-agent-core-runtime`
 * (a host module, so it costs a deployed extension nothing) and nothing else
 * may reimplement it.
 *
 * Scope note: this scans extension SOURCE only. core-runtime's own definition
 * is the one legal home and is excluded by construction (it is not an
 * extension package).
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const BUN_APPS = join(import.meta.dirname, "..", "..", "..");

/** Every `bun-apps/s2-agent-ext-*` directory. */
function extensionPackages(): string[] {
	return readdirSync(BUN_APPS)
		.filter((n) => n.startsWith("s2-agent-ext-"))
		.filter((n) => {
			try {
				return statSync(join(BUN_APPS, n)).isDirectory();
			} catch {
				return false;
			}
		})
		.sort();
}

/** `.ts` files under a package, skipping node_modules and build output. */
function sourceFiles(root: string): string[] {
	const out: string[] = [];
	const walk = (dir: string): void => {
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}
		for (const name of entries) {
			if (name === "node_modules" || name === "dist" || name === "build" || name === ".git") continue;
			const full = join(dir, name);
			let st: ReturnType<typeof statSync>;
			try {
				st = statSync(full);
			} catch {
				continue;
			}
			if (st.isDirectory()) walk(full);
			else if (name.endsWith(".ts")) out.push(full);
		}
	};
	walk(root);
	return out;
}

/**
 * A local definition of the probe. Matches a `function`/`const` declaration
 * whose name is one of the known spellings — the two that existed, plus the
 * shared names, so a copy-paste of the CURRENT helper is caught too.
 */
const PRIVATE_DEFINITION =
	/(?:^|\n)\s*(?:export\s+)?(?:async\s+)?(?:function|const|let|var)\s+_?(missingDeps|missingExtDeps|findMonorepoRoot|findWorkspaceRoot|isDeployedExtDir)\b/;

/**
 * The node_modules walk itself: an existence check on
 * `<dir>/node_modules/<pkg>/package.json`. This is the ACTUAL defect — a probe
 * under a name nobody thought to list above is still the same bug.
 *
 * Deliberately shaped to the CALL, not to the two words. file2md imports its
 * mupdf wasm blob through a relative `../../node_modules/mupdf/...` specifier
 * and explains why in a comment that names package.json — a legitimate
 * build-time asset import that a looser pattern flags forever.
 */
const NODE_MODULES_WALK =
	/(?:existsSync|statSync|lstatSync)\s*\(\s*(?:path\.)?(?:join|resolve)\s*\([^)]*["'`]node_modules["'`][^)]*["'`]package\.json["'`]/;

/**
 * Build-time deploy scripts that audit a REAL filesystem tree (the staged
 * deploy), where node_modules genuinely exists — not a runtime availability
 * probe, which is what this guard bans. Same carve-out spirit as the mupdf
 * asset import: a legitimate build-time use a code-shaped pattern flags
 * forever. Keep this list short and justified.
 */
const BUILD_TIME_ALLOWLIST = new Set(["s2-agent-ext-devops/src/deploy/lib/offline-gate.ts"]);

/** Strip line and block comments so prose never trips a code-shaped pattern. */
function stripComments(src: string): string {
	return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

describe("the dependency probe has exactly one implementation", () => {
	test("no s2-agent-ext-* package defines its own", () => {
		const offenders: string[] = [];
		for (const pkg of extensionPackages()) {
			for (const file of sourceFiles(join(BUN_APPS, pkg))) {
				const src = stripComments(readFileSync(file, "utf8"));
				if (PRIVATE_DEFINITION.test(src)) offenders.push(file.slice(BUN_APPS.length + 1));
			}
		}
		expect(
			offenders,
			`These files define a dependency probe locally. Import { missingExtDeps, findWorkspaceRoot } ` +
				`from "@repo/s2-agent-core-runtime" instead — see src/ext-deps.ts for why a private copy ` +
				`is always wrong in at least one deploy mode.`,
		).toEqual([]);
	});

	test("no s2-agent-ext-* package hand-rolls the node_modules walk", () => {
		const offenders: string[] = [];
		for (const pkg of extensionPackages()) {
			for (const file of sourceFiles(join(BUN_APPS, pkg))) {
				// A test may legitimately construct a node_modules fixture; the
				// probe itself is what must not be reimplemented.
				if (file.endsWith(".test.ts")) continue;
				if (BUILD_TIME_ALLOWLIST.has(file.slice(BUN_APPS.length + 1))) continue;
				const src = stripComments(readFileSync(file, "utf8"));
				if (NODE_MODULES_WALK.test(src)) offenders.push(file.slice(BUN_APPS.length + 1));
			}
		}
		expect(
			offenders,
			`These files look for node_modules/<pkg>/package.json by hand. In a compiled binary and ` +
				`in an sh deploy there is no node_modules to find, so the check reports every dependency ` +
				`as missing. Use missingExtDeps() from "@repo/s2-agent-core-runtime".`,
		).toEqual([]);
	});

	test("the guard can actually fail", () => {
		// Falsification: both patterns must match the code they are meant to ban.
		expect(PRIVATE_DEFINITION.test("export function missingDeps(deps, from) {}")).toBe(true);
		expect(PRIVATE_DEFINITION.test("function _findMonorepoRoot(from) {}")).toBe(true);
		expect(NODE_MODULES_WALK.test('existsSync(join(dir, "node_modules", pkg, "package.json"))')).toBe(true);
		// ...and must not match ordinary code that merely mentions the words.
		expect(PRIVATE_DEFINITION.test("const missing = missingExtDeps(deps, dir);")).toBe(false);
		expect(NODE_MODULES_WALK.test('const p = join(root, "node_modules");')).toBe(false);
		// The mupdf asset import must stay legal.
		expect(
			NODE_MODULES_WALK.test('import w from "../../node_modules/mupdf/dist/mupdf-wasm.wasm" with { type: "file" };'),
		).toBe(false);
		// Comments never count as code.
		expect(stripComments('// existsSync(join(d, "node_modules", p, "package.json"))\ncode')).not.toMatch(
			NODE_MODULES_WALK,
		);
	});
});
