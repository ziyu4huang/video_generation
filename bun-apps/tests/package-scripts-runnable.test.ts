/**
 * Package-script runnability guard.
 *
 * THE PATTERN THIS EXISTS TO BREAK
 *   Same rot class as bun-apps/tests/ci-workflow-references.test.ts, different
 *   host: a package.json script that nobody executes. Nothing typechecks a
 *   script body, so a script can name a binary the package cannot resolve and
 *   sit there looking like a gate for months. Both confirmed instances were
 *   found the day scripts/ci-local.sh first ran the whole matrix:
 *
 *     - perf-harness's `check` was `tsc --noEmit` with NO devDependencies at
 *       all. Under the workspace's isolated linker a package resolves only what
 *       it declares, so the script exited 127 (`tsc: command not found`) the
 *       instant anyone ran it.
 *     - s2-agent-core-runtime's `check` was `biome check .` without
 *       `@biomejs/biome` declared. Same 127.
 *
 *   Only 3 of the 10 packages that define a `check` script chain it into their
 *   CI test command, so neither had an executor. A gate that exits 127 is worse
 *   than no gate: `bun run check` "failing" reads as a lint problem, not as a
 *   missing dependency, and green-by-never-running reads as green.
 *
 * A SECOND, QUIETER FAILURE
 *   s2-agent-core-runtime was extracted from s2-agent-ext-subagent by #1251
 *   and its biome.json did not come along. `biome check .` with no config falls
 *   back to biome's OWN defaults (tabs, 80 columns) rather than this repo's
 *   (spaces, width 2, 120 columns), so it reported 27 files as
 *   format-violations that were correctly formatted for this repo. Restoring
 *   the config took 31 errors to 6. A missing config does not fail loudly — it
 *   silently grades against the wrong rubric.
 *
 * WHY `bunx` IS NOT AN ESCAPE HATCH
 *   The original version of this guard exempted `bunx`-prefixed calls, on the
 *   grounds that they resolve without a declaration. They do — over the NETWORK.
 *   `bunx tsc --noEmit` in a package with no `typescript` devDependency prints
 *   "Resolving dependencies / Resolved, downloaded and extracted / Saved
 *   lockfile" and takes ~0.95s; the same call in a package that declares it
 *   takes ~0.05s and touches nothing. So the exemption bought three things, all
 *   bad: a network round-trip inside a gate, a version nobody pinned (whatever
 *   the registry serves today), and a lockfile WRITE as a side effect of a
 *   read-only typecheck. Measured 2026-08-16: s2-agent's `typecheck` was killed
 *   mid-run (exit 137 at 866ms) during a run_local_ci matrix, which reads as a
 *   typecheck failure and is not one.
 *
 *   A declared dependency makes `bunx X` and `X` identical, so the scripts now
 *   just say `tsc` and this guard covers both spellings.
 *
 * WHAT IS ASSERTED
 *   1. Every provider-backed binary a package script invokes is provided by a
 *      dependency that package declares — whether called bare or via
 *      `bunx`/`npx`.
 *   2. Every package whose scripts run `biome` has a biome.json.
 *   3. Those biome.json files agree on the repo's formatting convention, so no
 *      two packages silently format to different rules.
 *
 * STATIC ONLY: reads package.json / biome.json as data. No node_modules probe
 * (that would be install-state-coupled, and a P1 hit for the portability audit)
 * and no script execution.
 *
 * Run: bun run test:scripts   (from bun-apps/)
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const BUN_APPS = resolve(import.meta.dir, "..");

/**
 * Binaries that only exist on PATH because some package puts them there, mapped
 * to the dependency that provides them. A bare call to one of these in a script
 * is a claim that the package declares that dependency.
 *
 * Deliberately NOT here: `bun`, `bunx`, `node`, `git`, `bash`, and friends —
 * those come from the environment, not from a dependency, so a bare call to
 * them declares nothing.
 */
const BIN_PROVIDER: Record<string, string> = {
	biome: "@biomejs/biome",
	tsc: "typescript",
	tsserver: "typescript",
	tsx: "tsx",
	vitest: "vitest",
	eslint: "eslint",
	prettier: "prettier",
	esbuild: "esbuild",
};

/**
 * Words that, immediately before a binary name, mean it is not an invocation of
 * that binary at all — `bun run tsc` runs a SCRIPT named tsc, not the compiler.
 *
 * `bunx`/`npx` are deliberately absent: they DO invoke the binary, just with a
 * network fallback when undeclared, which is exactly what this guard forbids.
 */
const NOT_AN_INVOCATION = new Set(["bun", "run", "pnpm", "yarn"]);

/** Runner prefixes that invoke the binary but tolerate a missing declaration. */
const NETWORK_RUNNERS = new Set(["bunx", "npx"]);

interface Pkg {
	name: string;
	dir: string;
	json: Record<string, unknown>;
}

function packages(): Pkg[] {
	return readdirSync(BUN_APPS, { withFileTypes: true })
		.filter((e) => e.isDirectory() && e.name !== "node_modules")
		.map((e) => ({ name: e.name, dir: join(BUN_APPS, e.name), json: {} as Record<string, unknown> }))
		.filter((p) => existsSync(join(p.dir, "package.json")))
		.map((p) => ({ ...p, json: JSON.parse(readFileSync(join(p.dir, "package.json"), "utf8")) }))
		.sort((a, b) => a.name.localeCompare(b.name));
}

function declaredDeps(p: Pkg): Set<string> {
	const deps = (p.json.dependencies ?? {}) as Record<string, string>;
	const dev = (p.json.devDependencies ?? {}) as Record<string, string>;
	return new Set([...Object.keys(deps), ...Object.keys(dev)]);
}

interface ProviderCall {
	pkg: string;
	script: string;
	bin: string;
	provider: string;
	body: string;
	/** Called through `bunx`/`npx` rather than bare. Still needs the declaration. */
	viaRunner: boolean;
}

/**
 * Every invocation of a provider-backed binary in one package's scripts.
 * Split out from the filesystem walk so the vacuity guard can feed it a
 * synthetic script map and pin the tokenizer's prefix handling directly.
 */
export function scanScripts(pkg: string, scripts: Record<string, string>): ProviderCall[] {
	const out: ProviderCall[] = [];
	for (const [script, body] of Object.entries(scripts)) {
		// Shell operators separate commands; a binary is only "invoked" as a
		// command word, so split on them and inspect each segment's words.
		for (const seg of body.split(/&&|\|\||;|\|/)) {
			const words = seg.trim().split(/\s+/).filter((w) => w !== "");
			words.forEach((w, i) => {
				const provider = BIN_PROVIDER[w];
				if (provider === undefined) return;
				const prev = i > 0 ? words[i - 1] : undefined;
				if (prev !== undefined && NOT_AN_INVOCATION.has(prev)) return;
				out.push({
					pkg,
					script,
					bin: w,
					provider,
					body,
					viaRunner: prev !== undefined && NETWORK_RUNNERS.has(prev),
				});
			});
		}
	}
	return out;
}

/** Every provider-backed binary invocation across every package script. */
function providerCalls(): ProviderCall[] {
	return packages().flatMap((p) => scanScripts(p.name, (p.json.scripts ?? {}) as Record<string, string>));
}

/** Packages whose scripts run biome at all (bare or via bunx). */
function biomeUsers(): Pkg[] {
	return packages().filter((p) => {
		const scripts = (p.json.scripts ?? {}) as Record<string, string>;
		return Object.values(scripts).some((b) => /(^|\s)(bunx\s+|npx\s+)?biome(\s|$)/.test(b));
	});
}

describe("package scripts — every binary is provided by a declared dependency", () => {
	test("no script can exit 127 or fall back to the network (perf-harness / s2-agent class)", () => {
		const broken = providerCalls()
			.filter((c) => !declaredDeps(packages().find((p) => p.name === c.pkg)!).has(c.provider))
			.map((c) => `${c.pkg}: "${c.script}": \`${c.bin}\` needs ${c.provider} — script is \`${c.body}\``);
		expect(
			broken,
			`UNRUNNABLE / NETWORK-DEPENDENT PACKAGE SCRIPT(S): ${broken.join(" | ")} — the script invokes a ` +
				"binary the package does not declare. bun-apps/ uses an ISOLATED linker, so a package " +
				"resolves only what it declares. Called BARE the script exits 127 " +
				'("command not found") — perf-harness\'s `check` and s2-agent-core-runtime\'s `check` ' +
				"both sat broken that way, unnoticed, because only 3 of the 10 `check` scripts are chained " +
				"into a CI command. Called via `bunx`/`npx` it is worse: it silently resolves over the " +
				"NETWORK at an unpinned version and writes a lockfile, inside a gate that is supposed to " +
				"be read-only. Declare the dependency — `bunx` is not an escape hatch.",
		).toEqual([]);
	});

	// Vacuity guard: a tokenizer regression that matched nothing would pass the
	// assertion above forever.
	test("the scanner actually finds binary invocations", () => {
		const calls = providerCalls();
		expect(calls.length).toBeGreaterThanOrEqual(10);
		expect(calls.some((c) => c.bin === "tsc")).toBe(true);
		expect(calls.some((c) => c.bin === "biome")).toBe(true);
	});

	// Pinned on synthetic input so the prefix rules are asserted directly rather
	// than inferred from whatever the real package.json files happen to say.
	test("`bunx` counts as an invocation, `bun run` does not", () => {
		const calls = scanScripts("fixture", {
			bare: "tsc --noEmit",
			viaBunx: "bunx tsc --noEmit",
			viaNpx: "npx biome check .",
			script: "bun run tsc",
			chained: "biome check . && tsc --noEmit",
		});
		const seen = calls.map((c) => `${c.script}:${c.bin}:${c.viaRunner}`).sort();
		expect(seen).toEqual([
			"bare:tsc:false",
			"chained:biome:false",
			"chained:tsc:false",
			"viaBunx:tsc:true",
			"viaNpx:biome:true",
		]);
	});
});

describe("biome — every user has a config, and the configs agree", () => {
	test("no package runs biome against biome's own defaults (the core-runtime class)", () => {
		const missing = biomeUsers()
			.filter((p) => !existsSync(join(p.dir, "biome.json")) && !existsSync(join(p.dir, "biome.jsonc")))
			.map((p) => p.name);
		expect(
			missing,
			`PACKAGE(S) RUNNING biome WITH NO CONFIG: ${missing.join(", ")} — biome falls back to its OWN ` +
				"defaults (tabs, 80 columns), not this repo's (spaces, width 2, 120 columns), so it grades " +
				"correctly-formatted code as violations. s2-agent-core-runtime lost its biome.json when " +
				"#1251 extracted it from s2-agent-ext-subagent, and reported 27 phantom format errors until " +
				"the config was restored. Copy the config from a sibling package.",
		).toEqual([]);
	});

	test("all biome configs agree on the repo's formatting convention", () => {
		const shape = (p: Pkg) => {
			// biome-ignore lint/suspicious/noExplicitAny: a biome config has no static shape here.
			const c = JSON.parse(readFileSync(join(p.dir, "biome.json"), "utf8")) as any;
			return {
				indentStyle: c.formatter?.indentStyle,
				indentWidth: c.formatter?.indentWidth,
				lineWidth: c.formatter?.lineWidth,
				quoteStyle: c.javascript?.formatter?.quoteStyle,
			};
		};
		const users = biomeUsers().filter((p) => existsSync(join(p.dir, "biome.json")));
		const baseline = { indentStyle: "space", indentWidth: 2, lineWidth: 120, quoteStyle: "double" };
		const divergent = users
			.filter((p) => JSON.stringify(shape(p)) !== JSON.stringify(baseline))
			.map((p) => `${p.name} ${JSON.stringify(shape(p))}`);
		expect(
			divergent,
			`DIVERGENT biome FORMATTING CONFIG: ${divergent.join(" | ")} — expected ` +
				`${JSON.stringify(baseline)}. Two packages formatting to different rules means a file moved ` +
				"between them reformats wholesale, which buries the real diff. If the convention is " +
				"changing, change it in every biome.json and here, deliberately — not one package at a time.",
		).toEqual([]);
	});

	// Vacuity guard: an empty user list would pass both assertions above.
	test("biome is actually in use by several packages", () => {
		expect(biomeUsers().length).toBeGreaterThanOrEqual(5);
	});
});
