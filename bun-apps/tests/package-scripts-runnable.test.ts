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
 *     - pi-agent-ext-core-runtime's `check` was `biome check .` without
 *       `@biomejs/biome` declared. Same 127.
 *
 *   Only 3 of the 10 packages that define a `check` script chain it into their
 *   CI test command, so neither had an executor. A gate that exits 127 is worse
 *   than no gate: `bun run check` "failing" reads as a lint problem, not as a
 *   missing dependency, and green-by-never-running reads as green.
 *
 * A SECOND, QUIETER FAILURE
 *   pi-agent-ext-core-runtime was extracted from pi-agent-ext-subagent by #1251
 *   and its biome.json did not come along. `biome check .` with no config falls
 *   back to biome's OWN defaults (tabs, 80 columns) rather than this repo's
 *   (spaces, width 2, 120 columns), so it reported 27 files as
 *   format-violations that were correctly formatted for this repo. Restoring
 *   the config took 31 errors to 6. A missing config does not fail loudly — it
 *   silently grades against the wrong rubric.
 *
 * WHAT IS ASSERTED
 *   1. Every binary a package script invokes BARE is provided by a dependency
 *      that package declares. (`bunx`/`npx`-prefixed calls are exempt — those
 *      resolve without a declaration.)
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

/** Words that, immediately before a binary name, mean it is NOT a bare call. */
const NOT_BARE = new Set(["bunx", "npx", "bun", "run", "pnpm", "yarn"]);

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

interface BareCall {
	pkg: string;
	script: string;
	bin: string;
	provider: string;
	body: string;
}

/** Every bare invocation of a provider-backed binary, across every package script. */
function bareCalls(): BareCall[] {
	const out: BareCall[] = [];
	for (const p of packages()) {
		const scripts = (p.json.scripts ?? {}) as Record<string, string>;
		for (const [script, body] of Object.entries(scripts)) {
			// Shell operators separate commands; a binary is only "invoked" as a
			// command word, so split on them and inspect each segment's words.
			for (const seg of body.split(/&&|\|\||;|\|/)) {
				const words = seg.trim().split(/\s+/).filter((w) => w !== "");
				words.forEach((w, i) => {
					const provider = BIN_PROVIDER[w];
					if (provider === undefined) return;
					if (i > 0 && NOT_BARE.has(words[i - 1])) return;
					out.push({ pkg: p.name, script, bin: w, provider, body });
				});
			}
		}
	}
	return out;
}

/** Packages whose scripts run biome at all (bare or via bunx). */
function biomeUsers(): Pkg[] {
	return packages().filter((p) => {
		const scripts = (p.json.scripts ?? {}) as Record<string, string>;
		return Object.values(scripts).some((b) => /(^|\s)(bunx\s+|npx\s+)?biome(\s|$)/.test(b));
	});
}

describe("package scripts — every bare binary is provided by a declared dependency", () => {
	test("no script can exit 127 (the perf-harness / core-runtime class)", () => {
		const broken = bareCalls()
			.filter((c) => !declaredDeps(packages().find((p) => p.name === c.pkg)!).has(c.provider))
			.map((c) => `${c.pkg}: "${c.script}": \`${c.bin}\` needs ${c.provider} — script is \`${c.body}\``);
		expect(
			broken,
			`UNRUNNABLE PACKAGE SCRIPT(S): ${broken.join(" | ")} — the script calls a binary bare, but the ` +
				"package does not declare the dependency that provides it. bun-apps/ uses an ISOLATED " +
				"linker, so a package resolves only what it declares: this script exits 127 " +
				'("command not found") for anyone who runs it. perf-harness\'s `check` and ' +
				"pi-agent-ext-core-runtime's `check` both sat broken this way, unnoticed, because only 3 " +
				"of the 10 `check` scripts are chained into a CI command. Either declare the dependency " +
				"or prefix the call with `bunx`.",
		).toEqual([]);
	});

	// Vacuity guard: a tokenizer regression that matched nothing would pass the
	// assertion above forever.
	test("the scanner actually finds bare binary invocations", () => {
		const calls = bareCalls();
		expect(calls.length).toBeGreaterThanOrEqual(10);
		expect(calls.some((c) => c.bin === "tsc")).toBe(true);
		expect(calls.some((c) => c.bin === "biome")).toBe(true);
		// …and it does not mistake a `bunx`-prefixed call for a bare one.
		// pi-agent's `typecheck` is exactly `bunx tsc --noEmit`, so it must not appear.
		expect(calls.filter((c) => c.pkg === "pi-agent" && c.script === "typecheck")).toEqual([]);
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
				"correctly-formatted code as violations. pi-agent-ext-core-runtime lost its biome.json when " +
				"#1251 extracted it from pi-agent-ext-subagent, and reported 27 phantom format errors until " +
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
