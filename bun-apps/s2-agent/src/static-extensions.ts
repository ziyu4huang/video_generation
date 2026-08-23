/**
 * The "default-on" extension set — statically imported (native `import`, not
 * jiti-loaded `-e <path>.ts`) so it survives `bun build --compile`. These are
 * deliberately ABSENT from run-dir/manifest.json's `extensions` array — keeping
 * both a static import and a dynamic `-e` entry for the same extension would
 * double-register it, since a jiti-loaded module and a natively-imported module
 * are not guaranteed to be the same module identity (and pi does NOT dedup a
 * static factory against a `-e` path — only `-e` against `-e` by resolved path).
 *
 * Loaded via MainOptions.extensionFactories in EVERY mode (source/bundle/
 * binary) for consistency — not just in binary mode as a compile workaround.
 *
 * Hoisted out of cli.ts so ext-doctor.ts can check these too, without cli.ts's
 * doctor-intercept/patch side effects running.
 *
 * MUST be static ESM `import` (not `require()`): only a literal `import` is
 * inlined by Bun's bundler into the compiled output — `require()` (even with
 * a literal specifier) is left as a genuine runtime call and crashes the
 * compiled binary with "Cannot find module" (confirmed empirically; the
 * $bunfs virtual filesystem has no such relative path). The unavoidable cost:
 * a literal `import` also makes TypeScript's checker traverse and type-check
 * the FULL internals of the imported file. s2-agent-ext-hermes-memory and
 * s2-agent-ext-web-access had never been reached by any static type-checker
 * before (previously jiti-loaded only), so this surfaced pre-existing, unrelated
 * type errors in their own source, silenced at the time with `// @ts-nocheck`.
 *
 * hermes-memory's share is now FIXED, not silenced: both suppressions are gone
 * and the package type-checks clean. Both errors were one inference problem
 * each — a `: ToolDefinition` annotation that discarded the TypeBox schema, and
 * a details generic inferred from the first `return` — not deep type debt.
 *
 * That claim was written one file early. grill-decision-tool.ts kept its
 * directive for weeks after the errors under it were fixed by unrelated store
 * refactors, and nothing caught the drift: `tsc --noEmit` is green whether a
 * suppression is load-bearing or inert, so a stale one emits no signal at all.
 * hermes-memory now carries tests/no-ts-nocheck.test.ts, which fails if any
 * source file's PROLOGUE (the only place the checker honors the directive)
 * contains it. Prefer that shape over re-asserting cleanliness in a comment.
 *
 * web-access is down to ONE suppressed file, its `index.ts`. Five of the six
 * are fixed and checked; fixing them surfaced three live ReferenceErrors that
 * `@ts-nocheck` had been hiding, so the suppressions were never cosmetic.
 *
 * index.ts is a structural problem, not a type-debt one: its 49 errors cluster
 * in the inline handler bodies passed to `pi.registerTool` / `pi.registerCommand`
 * — 20 in fetch_content, 12 in web_search, 5 in the /websearch command. Since
 * those handlers are anonymous closures inside `export default function (pi)`,
 * the directive cannot be scoped narrower than the whole file. Giving each tool
 * its own module is the fix, and two of them close over nothing from the
 * enclosing scope, so they move for free. See that file's header for the
 * measured table.
 *
 * (An earlier revision of this comment blamed a ~1,660-line `openCuratorBrowser`
 * for 43 of the 49. That was a measurement error — the function is 246 lines and
 * has none of them.)
 *
 * The ordering is tests-before-type-fixes, and it is not a preference: null
 * guards change runtime paths, and this package had 694 test lines against
 * 14,394 source lines. curation-shape.ts is the first increment — five pure
 * helpers that were closure-nested (hence unreachable by both the checker and
 * any test file) hoisted into a checked module with 28 tests.
 *
 * UNIFORM ENTRY CONVENTION: every extension is registered from
 * `s2-agent-ext-<X>/extensions/<X>.ts`. Three packages (power-tool,
 * hermes-memory, web-access) keep their implementation at `src/index.ts` /
 * root `index.ts` (also their package.json `main` for programmatic use) and
 * expose a 1-line re-export shim at `extensions/<X>.ts` as the registered
 * entry, so the registration path is uniform without disturbing the lib.
 *
 * Relative (not package-specifier) paths: relative imports bypass each
 * package's `exports` map resolution entirely (some packages' `exports` only
 * declares the root "." entry pointing at a `dist/index.js` build output that
 * isn't present in this checkout). This works uniformly across all entries
 * regardless of each package's own exports map.
 *
 * TWO groups, added at different times:
 *   - Group A (original "general productivity" 5): ext-task, hermes-memory,
 *     superpowers, wayfind, web-access.
 *   - Group B (migrated from dynamic `-e`): obsidian, btw, file2md,
 *     workflow, knowledge-card, power-tool. These were PREVIOUSLY in manifest.extensions
 *     (jiti `-e` paths) — which works in source/bundle mode but NOT in `--exe`
 *     mode (binary mode emits zero `-e` flags; the .ts paths don't exist in
 *     the compiled $bunfs virtual FS). Migrating them to static imports makes
 *     the single-exe build bundle them by default. They were removed from
 *     manifest.extensions AND (for workflow) manifest.lazyExtensions at the
 *     same time to avoid the static+dynamic double-registration noted above.
 */

// AUTO-GENERATED from run-dir/manifest.json staticExtensions[] — do not edit; run `bun run regen:static` (bun-apps/s2-agent).

import taskExtension from "../../s2-agent-ext-task/extensions/task.ts";
import promptHistoryExtension from "../../s2-agent-ext-prompt-history/extensions/prompt-history.ts";
import hermesMemoryExtension from "../../s2-agent-ext-hermes-memory/extensions/hermes-memory.ts";
import superpowersExtension from "../../s2-agent-ext-superpowers/extensions/superpowers.ts";
import wayfindExtension from "../../s2-agent-ext-wayfind/extensions/wayfind.ts";
import webAccessExtension from "../../s2-agent-ext-web-access/extensions/web-access.ts";
import obsidianExtension from "../../s2-agent-ext-obsidian/extensions/obsidian.ts";
import btwExtension from "../../s2-agent-ext-btw/extensions/btw.ts";
import file2mdExtension from "../../s2-agent-ext-file2md/extensions/file2md.ts";
import subagentExtension from "../../s2-agent-ext-subagent/extensions/subagent.ts";
import ultracodeExtension from "../../s2-agent-ext-ultracode/extensions/ultracode.ts";
import knowledgeCardExtension from "../../s2-agent-ext-knowledge-card/extensions/knowledge-card.ts";
import powerToolExtension from "../../s2-agent-ext-power-tool/extensions/power-tool.ts";
import webuiExtension from "../../s2-agent-ext-webui/extensions/webui.ts";
import hyperframesExtension from "../../s2-agent-ext-hyperframes/extensions/hyperframes.ts";
import archifyExtension from "../../s2-agent-ext-archify/extensions/archify.ts";
import compactExtension from "../../s2-agent-ext-compact/extensions/compact.ts";
import svAnalyzerExtension from "../../s2-agent-ext-sv-analyzer/extensions/sv-analyzer.ts";

export const STATIC_EXTENSION_FACTORIES = [
	// Group A — original "general productivity" set
	{ name: "s2-agent-ext-task", factory: taskExtension },
	{ name: "s2-agent-ext-prompt-history", factory: promptHistoryExtension },
	{ name: "s2-agent-ext-hermes-memory", factory: hermesMemoryExtension },
	{ name: "s2-agent-ext-superpowers", factory: superpowersExtension },
	{ name: "s2-agent-ext-wayfind", factory: wayfindExtension },
	{ name: "s2-agent-ext-web-access", factory: webAccessExtension },
	// Group B — migrated from dynamic `-e` so the single-exe build bundles them
	{ name: "s2-agent-ext-obsidian", factory: obsidianExtension },
	{ name: "s2-agent-ext-btw", factory: btwExtension },
	{ name: "s2-agent-ext-file2md", factory: file2mdExtension },
	// subagent — owns spawn_subagent + list_subagent_runs tools (renamed
	// 2026-08-20, docs/agents/extension-naming.md) + shared singletons; must
	// load before workflow so workflow's /subagents viewer reads a populated registry.
	{ name: "s2-agent-ext-subagent", factory: subagentExtension },
	{ name: "s2-agent-ext-ultracode", factory: ultracodeExtension },
	{ name: "s2-agent-ext-knowledge-card", factory: knowledgeCardExtension },
	// power-tool — always-on agent self-diagnostics suite (the inspect_* tools;
	// roster in its own TOOL_FACTORIES, deliberately not restated here). Active,
	// not lazy, so it belongs inline like the rest of Group B.
	{ name: "s2-agent-ext-power-tool", factory: powerToolExtension },
	// webui — web frontend co-driving one AgentSession with the TUI behind an
	// agentic mutex (Bun.serve WS transport; starts lazily on session_start).
	{ name: "s2-agent-ext-webui", factory: webuiExtension },
	// hyperframes — skills-only carrier: the vendored HyperFrames + media-use
	// skill family ships in skills/ (manifest skills[]); the
	// factory is a no-op that exists so the registration path stays uniform.
	{ name: "s2-agent-ext-hyperframes", factory: hyperframesExtension },
	{ name: "s2-agent-ext-archify", factory: archifyExtension },
	{ name: "s2-agent-ext-compact", factory: compactExtension },
	{ name: "s2-agent-ext-sv-analyzer", factory: svAnalyzerExtension },
];
