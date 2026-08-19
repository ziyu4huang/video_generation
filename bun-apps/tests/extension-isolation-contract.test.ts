/**
 * Cross-extension isolation contract — the "tight yet swappable" guard for the
 * PORTABLE BASE SET: every extension `pi-agent/deploy-config.yaml` ships in an
 * sh deploy. They coexist every session and share conventions (.planning/
 * layout, ctx.cwd) but must NEVER import each other's code — coupling goes only
 * through Pi's extension API and the guarded globalThis seams. That
 * zero-cross-import invariant is what makes each independently removable, and
 * `rm -rf ext/<name>` is the operation it protects (deploy gate 3's dual-state
 * smoke is the runtime half of the same claim).
 *
 * SCOPE IS DERIVED, NOT HARDCODED: the set comes from deploy-config.yaml, so
 * promoting an extension into the portable profile automatically enrolls it
 * here. (An earlier revision covered only the trio {superpowers, wayfind,
 * prompt-history}; a shared convention that binds three packages and exempts
 * nine is not a contract.)
 *
 * Invariants:
 *  (1) NO CROSS-IMPORTS [static] — scan each base-set package's `src/` +
 *      `extensions/` + root `index.ts` `.ts` for import statements targeting
 *      ANY OTHER base-set package, in EITHER specifier form
 *      (`@repo/pi-agent-ext-<x>` OR a relative `../pi-agent-ext-<x>`).
 *      Matches ONLY import syntax (`from "…"`, `import("…")`, side-effect
 *      `import "…"`) — never prose mentions in comments — so a JSDoc `@see`
 *      cannot false-positive. Relationship to `dep-guard.test.ts`: that guard
 *      scans EVERY `pi-agent-ext-*` for `@repo/` declared-coupling (hidden deps,
 *      self-imports, tier edges, acyclicity) — it does NOT catch relative-path
 *      cross-imports and is not base-set-scoped, so invariant (1) stays here as
 *      the strict, both-specifier-forms version. They are complementary.
 *  (2) STANDALONE LOAD [runtime] — dynamically `import()` each entry factory and
 *      call it with a mock `pi`; assert it does not throw and registers
 *      something. IO-FREE PACKAGES ONLY (see `LOAD_PROBE`): the enabled path of
 *      hermes-memory opens SQLite and writes under $HOME/.pi, webui binds a
 *      port, power-tool reaches for playwright — running those for real is a
 *      side effect, not a test. Their enabled path is covered by the deployed
 *      binary's L1 probe e2e instead.
 *  (3) HONORS DISABLE ENV [runtime] — with `BUN_PI_<NAME>=0` set, call each
 *      factory with a recording mock; assert it registers NOTHING. Restore env.
 *      This one DOES cover the whole base set: the disabled path returns before
 *      any IO by construction, which is exactly the property being asserted.
 *
 * Run: bun test tests/extension-isolation-contract.test.ts
 */
import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), ".."); // bun-apps/

/**
 * Base-set short names parsed out of deploy-config.yaml's `extensions:` block.
 *
 * A hand-rolled line scanner rather than a YAML dependency or an import of
 * pi-agent-ext-devops's `parseShConfig`: this gate must stay immune to
 * `bun-apps/node_modules/@repo/*` link state (same reasoning as
 * seam-contract.test.ts's relative core-interface import), and the shape it
 * needs is one key. The `MIN_EXPECTED` floor below is what keeps a silent parse
 * failure from turning every assertion vacuous.
 */
function parseBaseSetNames(yamlText: string): string[] {
	const names: string[] = [];
	let inExtensions = false;
	for (const raw of yamlText.split("\n")) {
		if (/^extensions:\s*$/.test(raw)) {
			inExtensions = true;
			continue;
		}
		// Any other column-0 key ends the block.
		if (inExtensions && /^\S/.test(raw)) break;
		if (!inExtensions) continue;
		const m = /^\s*-\s*name:\s*(\S+)\s*$/.exec(raw);
		if (m) names.push(m[1] as string);
	}
	return names;
}

/** Floor guard: a parser that silently returns [] would make (1)–(3) vacuous. */
const MIN_EXPECTED = 10;

const BASE_SET_NAMES = parseBaseSetNames(
	readFileSync(join(ROOT, "pi-agent", "deploy-config.yaml"), "utf8"),
);
const BASE_SET = BASE_SET_NAMES.map((n) => `pi-agent-ext-${n}`);

/** short name → `BUN_PI_<SHOUT_CASE>` disable env var. */
function disableEnvFor(name: string): string {
	return `BUN_PI_${name.toUpperCase().replace(/-/g, "_")}`;
}

/**
 * Packages whose ENABLED path is not safe to run in-process (invariant 2 only).
 * Each entry names the side effect, not a preference — a package leaves this
 * list by making its enabled path IO-free, never by asserting it is.
 */
const LOAD_PROBE_SKIP: Record<string, string> = {
	"pi-agent-ext-hermes-memory": "enabled path opens SQLite + writes under $HOME/.pi",
	"pi-agent-ext-webui": "enabled path constructs the Bun.serve WebServer singleton",
	"pi-agent-ext-power-tool": "enabled path monkey-patches the SDK + reaches playwright-core",
	"pi-agent-ext-web-access": "enabled path reads user config + registers background fetch state",
	"pi-agent-ext-subagent": "enabled path touches the run-persistence store on disk",
	"pi-agent-ext-workflow": "enabled path constructs workflow storage under cwd",
	"pi-agent-ext-task": "enabled path restores loop/todo session state from disk",
	"pi-agent-ext-btw": "enabled path registers TUI keybindings against a real host",
};

/**
 * Exempt from invariant (3): a package whose factory registers NOTHING by
 * design has no registration to gate, and adding a `BUN_PI_*` knob that
 * disables nothing would be a lie the guard then certifies. hyperframes is a
 * skills-only carrier — its payload is wired through deploy-config's `skills:`
 * key, so removing it means removing the skill path, not setting an env var.
 */
const DISABLE_GATE_EXEMPT: Record<string, string> = {
	"pi-agent-ext-hyperframes": "skills-only carrier; the factory is a deliberate no-op",
};

/** Walk a package's `src/` + `extensions/` + root `index.ts` (skip tests/fixtures). */
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
	// web-access keeps its implementation at the package root, not under src/.
	const rootIndex = join(pkgDir, "index.ts");
	if (existsSync(rootIndex)) out.push(rootIndex);
	return out;
}

/** Forbidden specs for a package = every OTHER base-set package, both forms. */
function forbiddenSpecs(self: string): string[] {
	return BASE_SET.filter((p) => p !== self).flatMap((p) => [`@repo/${p}`, p]);
}

/** Recording mock: counts the registration surfaces the base set uses and
 *  no-ops everything else the factories touch. */
function recordingPi(): { pi: any; count: () => number } {
	let calls = 0;
	const bump = () => {
		calls++;
	};
	const pi: any = {
		on: bump,
		registerTool: bump,
		registerCommand: bump,
		registerKeybinding: bump,
		registerRenderer: bump,
		sendUserMessage: () => {},
		notify: () => {},
		setStatus: () => {},
		getAllTools: () => [],
		getCommands: () => [],
		getAllToolDefinitions: () => [],
		appendEntry: () => {},
		events: { on: () => () => {}, emit: () => {} },
	};
	return { pi, count: () => calls };
}

describe("portable base set is derived from deploy-config.yaml", () => {
	it(`parses at least ${MIN_EXPECTED} extensions (a silent [] would void this file)`, () => {
		assert.ok(
			BASE_SET_NAMES.length >= MIN_EXPECTED,
			`parsed only ${BASE_SET_NAMES.length} extension name(s) from deploy-config.yaml: ${BASE_SET_NAMES.join(", ")}`,
		);
	});

	it("every parsed name resolves to a workspace package with the canonical entry", () => {
		const missing = BASE_SET_NAMES.filter(
			(n) => !existsSync(join(ROOT, `pi-agent-ext-${n}`, "extensions", `${n}.ts`)),
		);
		assert.deepEqual(missing, [], `deploy-config names with no extensions/<X>.ts: ${missing.join(", ")}`);
	});
});

describe("cross-extension isolation contract (portable base set)", () => {
	it("(1) NO CROSS-IMPORTS among the base set", () => {
		const violations: string[] = [];
		for (const pkg of BASE_SET) {
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
				? `CROSS-IMPORT VIOLATIONS — portable base-set extensions must couple only via the Pi extension API or a core-* package, never direct imports of each other:\n${violations.join("\n")}`
				: "",
		);
	});

	for (const name of BASE_SET_NAMES) {
		const pkg = `pi-agent-ext-${name}`;
		const entry = join(ROOT, pkg, "extensions", `${name}.ts`);

		it(`(${pkg}) HONORS DISABLE ENV`, async () => {
			const exemption = DISABLE_GATE_EXEMPT[pkg];
			const mod = await import(entry);
			assert.equal(typeof mod.default, "function", `${pkg} entry has no default factory`);
			if (exemption !== undefined) {
				// Assert the exemption is TRUE, not just declared: a no-op factory
				// registers nothing with no env var set. A package that starts
				// registering must lose its exemption and gain a real gate.
				const noop = recordingPi();
				await mod.default(noop.pi);
				assert.equal(noop.count(), 0, `${pkg} is exempt as "${exemption}" but registered something`);
				return;
			}
			const envKey = disableEnvFor(name);
			const saved = process.env[envKey];
			process.env[envKey] = "0";
			try {
				const disabled = recordingPi();
				await mod.default(disabled.pi);
				assert.equal(disabled.count(), 0, `${pkg} registered while ${envKey}=0`);
			} finally {
				if (saved === undefined) delete process.env[envKey];
				else process.env[envKey] = saved;
			}
		});
	}

	for (const name of BASE_SET_NAMES) {
		const pkg = `pi-agent-ext-${name}`;
		const skip = LOAD_PROBE_SKIP[pkg];
		if (skip !== undefined) continue;
		if (DISABLE_GATE_EXEMPT[pkg] !== undefined) continue; // no-op factory: nothing to load-probe

		it(`(${pkg}) STANDALONE LOAD`, async () => {
			const mod = await import(join(ROOT, pkg, "extensions", `${name}.ts`));
			const envKey = disableEnvFor(name);
			const saved = process.env[envKey];
			delete process.env[envKey];
			try {
				const enabled = recordingPi();
				await mod.default(enabled.pi);
				assert.ok(enabled.count() > 0, `${pkg} registered nothing when enabled`);
			} finally {
				if (saved !== undefined) process.env[envKey] = saved;
			}
		});
	}

	it("LOAD_PROBE_SKIP stays honest — every skipped package is in the base set", () => {
		const stale = Object.keys(LOAD_PROBE_SKIP).filter((p) => !BASE_SET.includes(p));
		assert.deepEqual(stale, [], `LOAD_PROBE_SKIP names non-base-set package(s): ${stale.join(", ")}`);
	});

	it("DISABLE_GATE_EXEMPT stays honest — every exemption is in the base set", () => {
		const stale = Object.keys(DISABLE_GATE_EXEMPT).filter((p) => !BASE_SET.includes(p));
		assert.deepEqual(stale, [], `DISABLE_GATE_EXEMPT names non-base-set package(s): ${stale.join(", ")}`);
	});
});
