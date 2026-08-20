/**
 * Locate this extension's deployed/package directory — the `#pi/ext-dir` idiom
 * (see hermes-memory src/git-ops.ts for the reference form).
 *
 * Deliberately NOT `import.meta.url`: bun's cjs bundler folds that into a
 * build-machine path literal — rejected by the sh deploy's relocatability gate
 * — and an unfolded `import.meta` is a SyntaxError inside the loader's
 * indirect cjs eval. Resolution order:
 *   1. sh deploy: `require("#pi/ext-dir")` → the deploy copies runtime data
 *      (`vault-template/`) beside the bundle (`ext/obsidian/vault-template/…`)
 *   2. jiti/source and dist: the package.json `"#pi/ext-dir"` imports entry
 *      (`src/sh-ext-dir.ts`, loaded by jiti as cjs with the REAL `__dirname`)
 *      → the package root, where `vault-template/` lives.
 *   3. native ESM (bun test): unresolvable → undefined; callers fall through
 *      to their own fallback or treat as "not available here".
 */
const EXT_DIR_SPEC = "#pi/ext-dir";

export function shExtDir(): string | undefined {
	try {
		if (typeof require === "function") {
			const mod = require(EXT_DIR_SPEC) as { default?: unknown } | string;
			if (typeof mod === "string") return mod; // sh loader: the deployed ext dir
			if (mod !== null && typeof mod === "object" && typeof mod.default === "string") {
				return mod.default; // jiti/source: package.json "#pi/ext-dir" imports entry
			}
		}
	} catch {
		// Not resolvable here (native ESM / tests) — fall through.
	}
	return undefined;
}
