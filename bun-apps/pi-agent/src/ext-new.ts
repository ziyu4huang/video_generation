/**
 * ext-new — pure scaffold builder for `pi-agent ext new <name>` (PR B, Phase D).
 *
 * This module holds the pure parts (arg parsing, name validation, file
 * templates); runExtNew (Task B3) adds the writer: mkdir + write files,
 * manifest registration (dynamic object entry / static append + regen:static),
 * optional `bun install --cwd bun-apps`, and the next-steps banner.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** Registration modes for the scaffolded package. */
export type ExtNewRegister = "dynamic" | "static" | "none";

export interface ExtNewArgs {
	name: string;
	libFace: boolean;
	register: ExtNewRegister;
	install: boolean;
	/** Package root the new dir is created under (repo-relative or absolute). */
	outRoot: string;
}

const NAME_RE = /^[a-z][a-z0-9-]*$/;

/**
 * Dir names the scaffold must never shadow. The tool always creates
 * `pi-agent-ext-<name>/`, so plain collisions with sibling workspace dirs are
 * the hazard (a `pi-agent` scaffold would nest the pi-agent package itself).
 */
const RESERVED_DIRECTORIES = new Set(["pi-agent", "node_modules", "dist", "docs", "gui-movie-director"]);

/**
 * Valid iff kebab-case suffix (`^[a-z][a-z0-9-]*$`) without the
 * `pi-agent-ext-` prefix (the tool adds it — accepting both spellings would
 * create `pi-agent-ext-pi-agent-ext-foo`) and not a reserved dir name.
 */
export function validateName(name: string): boolean {
	if (!NAME_RE.test(name)) return false;
	if (name.startsWith("pi-agent-ext-")) return false;
	if (RESERVED_DIRECTORIES.has(name)) return false;
	return true;
}

/**
 * Parse `ext new` argv (the tokens after `ext new`). Hidden `--out-root`
 * exists so tests can redirect writes into a temp dir; everything else is the
 * documented surface: `[<name>] [--lib] [--register dynamic|static|none]
 * [--no-install]`. Throws on unknown flags, a missing name, or an invalid name.
 */
export function parseExtNewArgs(argv: string[]): ExtNewArgs {
	const args: ExtNewArgs = {
		name: "",
		libFace: false,
		register: "dynamic",
		install: true,
		outRoot: "bun-apps/",
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]!;
		switch (a) {
			case "--lib":
				args.libFace = true;
				break;
			case "--register": {
				const v = argv[++i];
				if (v !== "dynamic" && v !== "static" && v !== "none") {
					throw new Error(`--register expects dynamic|static|none, got ${JSON.stringify(v ?? "nothing")}`);
				}
				args.register = v;
				break;
			}
			case "--no-install":
				args.install = false;
				break;
			case "--out-root": {
				const v = argv[++i];
				if (v === undefined || v === "") throw new Error("--out-root expects a directory");
				args.outRoot = v;
				break;
			}
			default:
				if (a.startsWith("-")) throw new Error(`unknown flag: ${a}`);
				if (args.name !== "") throw new Error(`unexpected extra argument: ${a}`);
				args.name = a;
		}
	}
	if (args.name === "") throw new Error("missing <name> — usage: ext new <name> [--lib] [--register dynamic|static|none] [--no-install]");
	if (!validateName(args.name)) {
		throw new Error(
			`invalid name ${JSON.stringify(args.name)} — expected a kebab-case suffix (^[a-z][a-z0-9-]*$, no pi-agent-ext- prefix, not a reserved dir name)`,
		);
	}
	return args;
}

/** `<name>` → `BUN_PI_<NAME_SNAKE>` self-gate env var (`foo-bar` → `BUN_PI_FOO_BAR`). */
function envGateName(name: string): string {
	return `BUN_PI_${name.replaceAll("-", "_").toUpperCase()}`;
}

/**
 * Build the scaffold file set: path relative to the new package dir → content.
 * Two layouts (plan Task B1 templates, verbatim):
 *  - default: in-file impl at `extensions/<name>.ts` (prompt-history shape);
 *  - `--lib`: impl in `src/index.ts` + 1-line re-export shim entry
 *    (power-tool/hermes-memory shape), plus `main`/`.` lib-face exports.
 */
export function buildScaffoldFiles(name: string, opts: { libFace: boolean }): Record<string, string> {
	const gate = envGateName(name);
	const files: Record<string, string> = {};

	files["package.json"] = opts.libFace
		? `{
	"name": "@repo/pi-agent-ext-${name}",
	"private": true,
	"version": "0.1.0",
	"description": "Pi extension: ${name} (scaffolded by \`pi-agent ext new\` — replace with a real description).",
	"license": "MIT",
	"keywords": ["pi-package", "${name}"],
	"type": "module",
	"main": "./src/index.ts",
	"exports": {
		".": "./src/index.ts",
		"./extensions/*": "./extensions/*",
		"./src/*": "./src/*",
		"./src/*.js": "./src/*.ts"
	},
	"pi": { "extensions": ["./extensions"] },
	"scripts": { "test": "bun test", "typecheck": "tsc --noEmit" },
	"peerDependencies": { "@earendil-works/pi-coding-agent": "0.84.2" },
	"devDependencies": { "@types/bun": "^1.3.14", "typescript": "^7.0.2" }
}
`
		: `{
	"name": "@repo/pi-agent-ext-${name}",
	"private": true,
	"version": "0.1.0",
	"description": "Pi extension: ${name} (scaffolded by \`pi-agent ext new\` — replace with a real description).",
	"license": "MIT",
	"keywords": ["pi-package", "${name}"],
	"type": "module",
	"exports": {
		"./extensions/*": "./extensions/*",
		"./src/*": "./src/*",
		"./src/*.js": "./src/*.ts"
	},
	"pi": { "extensions": ["./extensions"] },
	"scripts": { "test": "bun test", "typecheck": "tsc --noEmit" },
	"peerDependencies": { "@earendil-works/pi-coding-agent": "0.84.2" },
	"devDependencies": { "@types/bun": "^1.3.14", "typescript": "^7.0.2" }
}
`;

	files["tsconfig.json"] = `{
	"compilerOptions": {
		"target": "ESNext",
		"module": "ESNext",
		"moduleResolution": "bundler",
		"moduleDetection": "force",
		"allowImportingTsExtensions": true,
		"types": ["bun"],
		"strict": true,
		"esModuleInterop": true,
		"skipLibCheck": true,
		"resolveJsonModule": true,
		"noEmit": true
	},
	"include": ["src/**/*.ts", "extensions/**/*.ts"]
}
`;

	files["extensions/__tests__/entry-smoke.test.ts"] = `/**
 * entry-smoke — the factory loads, is callable, and honors its self-gate.
 * When the extension registers tools, tighten this into a stealth-trim guard
 * (short routing description, no promptSnippet/promptGuidelines) — see
 * pi-agent-ext-flux2/extensions/__tests__/stealth-trim.test.ts.
 */
import { test, expect } from "bun:test";
import extensionFactory from "../${name}.ts";

function captureTools() {
	const tools: Record<string, Record<string, unknown>> = {};
	const mockPi = {
		registerTool: (t: Record<string, unknown>) => { tools[t.name as string] = t; },
		on(_event: string, _handler: (...args: unknown[]) => void) {},
		getActiveTools: () => [] as string[],
		setActiveTools: (_tools: string[]) => {},
	};
	extensionFactory(mockPi as never);
	return tools;
}

test("factory loads and self-gates on ${gate}=0", () => {
	expect(() => captureTools()).not.toThrow();
	const prev = process.env.${gate};
	process.env.${gate} = "0";
	try {
		expect(() => captureTools()).not.toThrow();
	} finally {
		if (prev === undefined) delete process.env.${gate};
		else process.env.${gate} = prev;
	}
});
`;

	if (opts.libFace) {
		files["extensions/" + name + ".ts"] = `/**
 * ${name} — canonical registration entry. The implementation lives in
 * src/index.ts (also the package.json \`main\` lib face); this file is the
 * single registered entry point and re-exports the default factory.
 */
export { default } from "../src/index.ts";
`;
		files["src/index.ts"] = `import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

/** Self-gate: ${gate}=0 disables the extension entirely. */
const extension: ExtensionFactory = (pi) => {
	if (process.env.${gate} === "0") return;
	// TODO: subscribe to pi.on(...) / register tools.
};

export default extension;
`;
	} else {
		files["extensions/" + name + ".ts"] = `import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

/**
 * ${name} — canonical registration entry (impl in-file). If the package grows a
 * lib face, move the impl to src/index.ts and reduce this file to a 1-line
 * re-export shim (see CLAUDE.md "Extension packages"). Self-gate:
 * ${gate}=0 disables the extension entirely.
 */
const extension: ExtensionFactory = (pi) => {
	if (process.env.${gate} === "0") return;
	// TODO: subscribe to pi.on(...) / register tools.
};

export default extension;
`;
	}

	files["README.md"] = `# @repo/pi-agent-ext-${name}

Pi extension: ${name} (scaffolded by \`pi-agent ext new\` — replace with a real description).

## Develop

\`\`\`bash
bun test --cwd bun-apps/pi-agent-ext-${name}
bun run --cwd bun-apps/pi-agent-ext-${name} typecheck
\`\`\`

## Registration

Registered via \`bun-apps/pi-agent/run-dir/manifest.json\` — see the
\`extensions[]\` array (dynamic) or \`staticExtensions[]\` + \`bun run regen:static\`
(static). The entry point is \`extensions/${name}.ts\`.

## Self-gate

Set \`${gate}=0\` to disable the extension entirely.
`;

	return files;
}

/**
 * Writer half of `ext new` (Task B3): write the scaffold files under
 * `<outRoot>/pi-agent-ext-<name>/`, register in run-dir/manifest.json
 * (dynamic object entry, or static append + `bun run regen:static`), run
 * `bun install --cwd bun-apps` unless suppressed, and print next steps.
 * Returns a process exit code.
 *
 * NOTE on the manifest write-back: it is `JSON.stringify(manifest, null, "\t")
 * + "\n"` — a one-time whole-file normalization from the current 2-space
 * hand formatting to tabs (mixed object/bare-string entries and key order are
 * preserved by JS object semantics). Runtime-only: the committed manifest
 * stays untouched unless the user stages it deliberately.
 */
export async function runExtNew(argv: string[]): Promise<number> {
	let args: ExtNewArgs;
	try {
		args = parseExtNewArgs(argv);
	} catch (e) {
		console.error(`ext new: ${(e as Error).message}`);
		return 1;
	}

	const pkgName = `pi-agent-ext-${args.name}`;
	const pkgDir = join(args.outRoot, pkgName);
	if (existsSync(pkgDir)) {
		console.error(`ext new: target already exists: ${pkgDir}`);
		return 1;
	}

	// Registration — always against the real run-dir manifest, independent of
	// --out-root (the hidden root is a test seam for the file writes only).
	// Checked BEFORE any file write so a refusal leaves no orphan package.
	const manifestPath = join(import.meta.dir, "..", "run-dir", "manifest.json");
	let manifest: { extensions: unknown[]; staticExtensions: string[] };
	try {
		manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
			extensions: unknown[];
			staticExtensions: string[];
		};
	} catch (e) {
		console.error(`ext new: cannot read ${manifestPath} — ${(e as Error).message}`);
		return 1;
	}
	if (manifest.staticExtensions.includes(pkgName) || manifest.extensions.some((e) => parseManifestName(e) === pkgName)) {
		console.error(`ext new: ${pkgName} is already registered in run-dir/manifest.json`);
		return 1;
	}
	const realOutRoot = resolve(args.outRoot) !== resolve(import.meta.dir, "..", "..");
	if (args.register !== "none" && realOutRoot) {
		console.error(
			`ext new: --register requires the default --out-root (bun-apps/) — registration writes the real run-dir/manifest.json, whose consistency tests require the package to exist under bun-apps/`,
		);
		return 1;
	}

	// Write the scaffold (path keys are relative to the package dir).
	for (const [rel, content] of Object.entries(buildScaffoldFiles(args.name, { libFace: args.libFace }))) {
		const target = join(pkgDir, rel);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, content);
	}
	console.log(`ext new: wrote ${pkgDir}`);


	if (args.register === "dynamic") {
		manifest.extensions.push({
			name: pkgName,
			entry: `${pkgName}/extensions/${args.name}.ts`,
			bundleMode: "thin",
			testGate: `bun test --cwd bun-apps/${pkgName}`,
			version: "0.1.0",
		});
		writeFileSync(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);
		console.log(`ext new: registered ${pkgName} in manifest extensions[] (dynamic)`);
	} else if (args.register === "static") {
		manifest.staticExtensions.push(pkgName);
		writeFileSync(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);
		console.log(`ext new: appended ${pkgName} to manifest staticExtensions[]`);
		const piAgentDir = join(import.meta.dir, "..");
		const regen = Bun.spawn(["bun", "run", "--cwd", piAgentDir, "regen:static"], {
			stdio: ["inherit", "inherit", "inherit"],
		});
		if ((await regen.exited) !== 0) {
			console.error(
				`ext new: \`bun run --cwd bun-apps/pi-agent regen:static\` failed (exit ${regen.exitCode}) — run it manually, or src/static-extensions.ts will drift from the manifest`,
			);
			return 1;
		}
	}

	if (args.install) {
		const bunApps = resolve(import.meta.dir, "..", "..");
		if (resolve(args.outRoot) !== bunApps) {
			console.log("ext new: --out-root is outside bun-apps/ — skipping install (test seam)");
		} else {
			console.log("ext new: running bun install --cwd bun-apps …");
			const install = Bun.spawn(["bun", "install", "--cwd", bunApps], {
				stdio: ["inherit", "inherit", "inherit"],
			});
			if ((await install.exited) !== 0) {
				console.error(`ext new: bun install failed (exit ${install.exitCode}) — run it manually`);
				return 1;
			}
		}
	}

	console.log(`
Next steps:
  1. implement the factory:  ${pkgDir}/extensions/${args.name}.ts
  2. verify:                 bun test --cwd bun-apps/${pkgName}
                             bun run --cwd bun-apps/${pkgName} typecheck`);
	if (args.register === "none") {
		console.log(`  3. register manually — either append to run-dir/manifest.json extensions[]:
       { "name": "${pkgName}", "entry": "${pkgName}/extensions/${args.name}.ts", "bundleMode": "thin", "testGate": "bun test --cwd bun-apps/${pkgName}", "version": "0.1.0" }
     or append "${pkgName}" to staticExtensions[] and run: bun run --cwd bun-apps/pi-agent regen:static`);
	}
	return 0;
}

/** Manifest extensions[] mixes object entries and bare "dir/entry.ts" strings. */
function parseManifestName(entry: unknown): string | undefined {
	if (typeof entry === "string") return entry.split("/")[0];
	if (entry && typeof entry === "object" && "name" in entry) {
		return (entry as { name: string }).name;
	}
	return undefined;
}
