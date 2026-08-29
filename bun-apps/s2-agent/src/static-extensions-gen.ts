/**
 * Pure source generator for src/static-extensions.ts — PR A of Phase D
 * (.planning/s2-agent-optimization/plans/2026-08-20-phase-d-scaffold-codegen.md).
 *
 * The HEADER below is the canonical home of the file's history/invariant
 * documentation: buildStaticExtensionsSource() emits it VERBATIM (byte-for-byte
 * the pre-codegen file's lines 1-87), so editing the narrative means editing it
 * here, then `bun run regen:static`.
 *
 * Entries may be bare suffixes ("task") or full package names
 * ("s2-agent-ext-task") — the manifest currently carries full names. Both
 * normalize to the same output; the suffix is the derived key everywhere
 * (import path, row name, binding, ROW_COMMENTS).
 */

export interface StaticExtGenInput {
	/** Ordered package dir entries — manifest.staticExtensions verbatim. */
	staticExtensions: string[];
}

/** The 87-line doc-block header of static-extensions.ts, verbatim. */
const HEADER = [
	"/**",
	" * The \"default-on\" extension set — statically imported (native `import`, not",
	" * jiti-loaded `-e <path>.ts`) so it survives `bun build --compile`. These are",
	" * deliberately ABSENT from src/run-dir/manifest.json's `extensions` array — keeping",
	" * both a static import and a dynamic `-e` entry for the same extension would",
	" * double-register it, since a jiti-loaded module and a natively-imported module",
	" * are not guaranteed to be the same module identity (and pi does NOT dedup a",
	" * static factory against a `-e` path — only `-e` against `-e` by resolved path).",
	" *",
	" * Loaded via MainOptions.extensionFactories in EVERY mode (source/bundle/",
	" * binary) for consistency — not just in binary mode as a compile workaround.",
	" *",
	" * Hoisted out of cli.ts so ext-doctor.ts can check these too, without cli.ts's",
	" * doctor-intercept/patch side effects running.",
	" *",
	" * MUST be static ESM `import` (not `require()`): only a literal `import` is",
	" * inlined by Bun's bundler into the compiled output — `require()` (even with",
	" * a literal specifier) is left as a genuine runtime call and crashes the",
	" * compiled binary with \"Cannot find module\" (confirmed empirically; the",
	" * $bunfs virtual filesystem has no such relative path). The unavoidable cost:",
	" * a literal `import` also makes TypeScript's checker traverse and type-check",
	" * the FULL internals of the imported file. s2-agent-ext-hermes-memory and",
	" * s2-agent-ext-web-access had never been reached by any static type-checker",
	" * before (previously jiti-loaded only), so this surfaced pre-existing, unrelated",
	" * type errors in their own source, silenced at the time with `// @ts-nocheck`.",
	" *",
	" * hermes-memory's share is now FIXED, not silenced: both suppressions are gone",
	" * and the package type-checks clean. Both errors were one inference problem",
	" * each — a `: ToolDefinition` annotation that discarded the TypeBox schema, and",
	" * a details generic inferred from the first `return` — not deep type debt.",
	" *",
	" * That claim was written one file early. grill-decision-tool.ts kept its",
	" * directive for weeks after the errors under it were fixed by unrelated store",
	" * refactors, and nothing caught the drift: `tsc --noEmit` is green whether a",
	" * suppression is load-bearing or inert, so a stale one emits no signal at all.",
	" * hermes-memory now carries tests/no-ts-nocheck.test.ts, which fails if any",
	" * source file's PROLOGUE (the only place the checker honors the directive)",
	" * contains it. Prefer that shape over re-asserting cleanliness in a comment.",
	" *",
	" * web-access is down to ONE suppressed file, its `index.ts`. Five of the six",
	" * are fixed and checked; fixing them surfaced three live ReferenceErrors that",
	" * `@ts-nocheck` had been hiding, so the suppressions were never cosmetic.",
	" *",
	" * index.ts is a structural problem, not a type-debt one: its 49 errors cluster",
	" * in the inline handler bodies passed to `pi.registerTool` / `pi.registerCommand`",
	" * — 20 in fetch_content, 12 in web_search, 5 in the /websearch command. Since",
	" * those handlers are anonymous closures inside `export default function (pi)`,",
	" * the directive cannot be scoped narrower than the whole file. Giving each tool",
	" * its own module is the fix, and two of them close over nothing from the",
	" * enclosing scope, so they move for free. See that file's header for the",
	" * measured table.",
	" *",
	" * (An earlier revision of this comment blamed a ~1,660-line `openCuratorBrowser`",
	" * for 43 of the 49. That was a measurement error — the function is 246 lines and",
	" * has none of them.)",
	" *",
	" * The ordering is tests-before-type-fixes, and it is not a preference: null",
	" * guards change runtime paths, and this package had 694 test lines against",
	" * 14,394 source lines. curation-shape.ts is the first increment — five pure",
	" * helpers that were closure-nested (hence unreachable by both the checker and",
	" * any test file) hoisted into a checked module with 28 tests.",
	" *",
	" * UNIFORM ENTRY CONVENTION: every extension is registered from",
	" * `s2-agent-ext-<X>/extensions/<X>.ts`. Three packages (power-tool,",
	" * hermes-memory, web-access) keep their implementation at `src/index.ts` /",
	" * root `index.ts` (also their package.json `main` for programmatic use) and",
	" * expose a 1-line re-export shim at `extensions/<X>.ts` as the registered",
	" * entry, so the registration path is uniform without disturbing the lib.",
	" *",
	" * Relative (not package-specifier) paths: relative imports bypass each",
	" * package's `exports` map resolution entirely (some packages' `exports` only",
	" * declares the root \".\" entry pointing at a `dist/index.js` build output that",
	" * isn't present in this checkout). This works uniformly across all entries",
	" * regardless of each package's own exports map.",
	" *",
	" * TWO groups, added at different times:",
	" *   - Group A (original \"general productivity\" 5): ext-task, hermes-memory,",
	" *     superpowers, wayfind, web-access.",
	" *   - Group B (migrated from dynamic `-e`): obsidian, btw, file2md,",
	" *     workflow, knowledge-card, power-tool. These were PREVIOUSLY in manifest.extensions",
	" *     (jiti `-e` paths) — which works in source/bundle mode but NOT in `--exe`",
	" *     mode (binary mode emits zero `-e` flags; the .ts paths don't exist in",
	" *     the compiled $bunfs virtual FS). Migrating them to static imports makes",
	" *     the single-exe build bundle them by default. They were removed from",
	" *     manifest.extensions at the same time to avoid the static+dynamic",
	" *     double-registration noted above.",
	" */"
].join("\n");

const BANNER =
	"// AUTO-GENERATED from src/run-dir/manifest.json staticExtensions[] — do not edit; run `bun run regen:static` (bun-apps/s2-agent).";

/**
 * Per-row comments, keyed by suffix — folded in from the hand-written file
 * (Group A marker into `task`, Group B marker into `obsidian`) so the
 * regeneration preserves them. A suffix missing from the map emits a bare
 * row: adding an extension never requires touching the generator's cosmetics.
 */
const ROW_COMMENTS: Record<string, string> = {
	task: 'Group A — original "general productivity" set',
	obsidian: "Group B — migrated from dynamic `-e` so the single-exe build bundles them",
	subagent:
		"subagent — owns spawn_subagent + list_subagent_runs tools (renamed\n2026-08-20, bun-apps/s2-agent-ext-devops/skills/extension-naming/SKILL.md) + shared singletons; must\nload before workflow so workflow's /subagents viewer reads a populated registry.",
	"power-tool":
		"power-tool — always-on agent self-diagnostics suite (the inspect_* tools;\nroster in its own TOOL_FACTORIES, deliberately not restated here). Active,\nnot lazy, so it belongs inline like the rest of Group B.",
	hyperframes:
		"hyperframes — skills-only carrier: the vendored HyperFrames + media-use\nskill family ships in skills/ (manifest skills[]); the\nfactory is a no-op that exists so the registration path stays uniform.",
};

function camel(kebab: string): string {
	return kebab
		.split("-")
		.map((part, i) => (i === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
		.join("");
}

function suffixOf(entry: string): string {
	return entry.replace(/^s2-agent-ext-/, "");
}

/** Builds the full source text of src/static-extensions.ts. Deterministic. */
export function buildStaticExtensionsSource(input: StaticExtGenInput): string {
	const suffixes = input.staticExtensions.map(suffixOf);
	const imports = suffixes.map(
		(s) => `import ${camel(s)}Extension from "../../s2-agent-ext-${s}/extensions/${s}.ts";`,
	);
	const rows = suffixes.map((s) => {
		const binding = `${camel(s)}Extension`;
		const row = `\t{ name: "s2-agent-ext-${s}", factory: ${binding} },`;
		const comment = ROW_COMMENTS[s];
		if (!comment) return row;
		const commentLines = comment.split("\n").map((line) => `\t// ${line}`);
		return `${commentLines.join("\n")}\n${row}`;
	});
	return [
		HEADER,
		"",
		BANNER,
		"",
		imports.join("\n"),
		"",
		"export const STATIC_EXTENSION_FACTORIES = [",
		rows.join("\n"),
		"];",
		"",
	].join("\n");
}
