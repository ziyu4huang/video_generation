/**
 * Cross-extension isolation contract — the "tight yet swappable" guard for the
 * PORTABLE BASE SET: every extension `s2-agent/s2-agent.registry.yaml` ships in
 * an sh deploy. They coexist every session and share conventions (.planning/
 * layout, ctx.cwd) but must NEVER import each other's code — coupling goes only
 * through Pi's extension API and the guarded globalThis seams. That
 * zero-cross-import invariant is what makes each independently removable, and
 * `rm -rf ext/<name>` is the operation it protects (deploy gate 3's dual-state
 * smoke is the runtime half of the same claim).
 *
 * SCOPE IS DERIVED, NOT HARDCODED: the set comes from the registry's `deploy:`
 * blocks, so promoting an extension into the portable profile automatically
 * enrolls it here. (An earlier revision covered only the trio {superpowers,
 * wayfind, prompt-history}; a shared convention that binds three packages and
 * exempts nine is not a contract.)
 *
 * Invariants:
 *  (1) NO CROSS-IMPORTS [static] — scan each base-set package's `src/` +
 *      `extensions/` + root `index.ts` `.ts` for import statements targeting
 *      ANY OTHER base-set package, in EITHER specifier form
 *      (`@repo/s2-agent-ext-<x>` OR a relative `../s2-agent-ext-<x>`).
 *      Matches ONLY import syntax (`from "…"`, `import("…")`, side-effect
 *      `import "…"`) — never prose mentions in comments — so a JSDoc `@see`
 *      cannot false-positive. ONE sanctioned edge is exempt (see
 *      SANCTIONED_EDGES below). Relationship to `dep-guard.test.ts`: that guard
 *      scans EVERY `s2-agent-ext-*` for `@repo/` declared-coupling (hidden deps,
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
import { parseRegistryBaseSetNames } from "./lib/registry-base-set.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), ".."); // bun-apps/

/**
 * Base-set short names parsed out of s2-agent.registry.yaml's `extensions:`
 * block by the shared scanner (tests/lib/registry-base-set.ts) — an entry is
 * in the base set iff its entry carries a `deploy:` block that is not
 * `enabled: false` (entries kept local have `excludeReason` instead). The
 * `MIN_EXPECTED` floor below is what keeps a silent parse failure from
 * turning every assertion vacuous.
 */
const MIN_EXPECTED = 10;

const BASE_SET_NAMES = parseRegistryBaseSetNames(
	readFileSync(join(ROOT, "s2-agent", "s2-agent.registry.yaml"), "utf8"),
);
const BASE_SET = BASE_SET_NAMES.map((n) => `s2-agent-ext-${n}`);

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
	"s2-agent-ext-hermes-memory": "enabled path opens SQLite + writes under $HOME/.pi",
	"s2-agent-ext-webui": "enabled path constructs the Bun.serve WebServer singleton",
	"s2-agent-ext-power-tool": "enabled path monkey-patches the SDK + reaches playwright-core",
	"s2-agent-ext-web-access": "enabled path reads user config + registers background fetch state",
	"s2-agent-ext-subagent": "enabled path touches the run-persistence store on disk",
	"s2-agent-ext-ultracode": "enabled path constructs workflow storage under cwd",
	"s2-agent-ext-task": "enabled path restores loop/todo session state from disk",
	"s2-agent-ext-btw": "enabled path registers TUI keybindings against a real host",
};

/**
 * Exempt from invariant (3): a package whose factory registers NOTHING by
 * design has no registration to gate, and adding a `BUN_PI_*` knob that
 * disables nothing would be a lie the guard then certifies. hyperframes is a
 * skills-only carrier — its payload is wired through deploy-config's `skills:`
 * key, so removing it means removing the skill path, not setting an env var.
 */
const DISABLE_GATE_EXEMPT: Record<string, string> = {
	"s2-agent-ext-hyperframes": "skills-only carrier; the factory is a deliberate no-op",
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

/**
 * The ONE sanctioned cross-import edge among the base set: knowledge-card (the
 * TIER-1 knowledge hub) consumes obsidian's PURE LIBRARY face — the bare
 * specifier resolves to src/index.ts → src/obsidian-lib.ts (#1737; vault
 * resolution, frontmatter, graph index), and knowledge-card's header documents
 * the forward-dep ("the hub asks its forward-dep (pi-obsidian) to serve vault
 * resolution"). This is (from, to) COARSE on purpose: the finer rule — that
 * knowledge-card may import the lib face but NEVER obsidian's /extensions/
 * registration entry (which would double-register GATE_DEFS and the fat tool)
 * — is pinned by dep-guard.test.ts's "lib face only" test, and duplicating it
 * here would mean two copies to keep in lockstep. dep-guard also owns the
 * downward-only ADR-monorepo-0001 invariant (obsidian/hermes import nothing
 * from knowledge-card), which this table cannot express by construction —
 * every other (from, to) pair stays forbidden here.
 */
const SANCTIONED_EDGES: ReadonlySet<string> = new Set([
	"s2-agent-ext-knowledge-card → s2-agent-ext-obsidian",
]);

/** True when `self` importing `target` is a sanctioned lib-face edge. */
function isSanctioned(self: string, target: string): boolean {
	return SANCTIONED_EDGES.has(`${self} → ${target}`);
}

/** Forbidden specs for a package = every OTHER base-set package minus the
 *  sanctioned lib-face edges, both specifier forms. */
function forbiddenSpecs(self: string): string[] {
	return BASE_SET.filter((p) => p !== self && !isSanctioned(self, p)).flatMap((p) => [
		`@repo/${p}`,
		p,
	]);
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

describe("portable base set is derived from s2-agent.registry.yaml", () => {
	it(`parses at least ${MIN_EXPECTED} extensions (a silent [] would void this file)`, () => {
		assert.ok(
			BASE_SET_NAMES.length >= MIN_EXPECTED,
			`parsed only ${BASE_SET_NAMES.length} extension name(s) from s2-agent.registry.yaml: ${BASE_SET_NAMES.join(", ")}`,
		);
	});

	it("every parsed name resolves to a workspace package with the canonical entry", () => {
		const missing = BASE_SET_NAMES.filter(
			(n) => !existsSync(join(ROOT, `s2-agent-ext-${n}`, "extensions", `${n}.ts`)),
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
		const pkg = `s2-agent-ext-${name}`;
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
		const pkg = `s2-agent-ext-${name}`;
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
