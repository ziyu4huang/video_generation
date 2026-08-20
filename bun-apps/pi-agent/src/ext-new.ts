/**
 * ext-new — pure scaffold builder for `pi-agent ext new <name>` (PR B, Phase D).
 *
 * This module holds the pure parts (arg parsing, name validation, file
 * templates); runExtNew (Task B3) adds the writer: mkdir + write files,
 * manifest registration (dynamic object entry / static append + regen:static),
 * optional `bun install --cwd bun-apps`, and the next-steps banner.
 */

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
