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
 * the FULL internals of the imported file. pi-agent-ext-hermes-memory and
 * pi-agent-ext-web-access had never been reached by any static type-checker
 * before (previously jiti-loaded only), so this surfaced ~35 pre-existing,
 * unrelated type errors in their own source. Those specific files now carry a
 * `// @ts-nocheck` (added as part of this change, see each file's own comment)
 * rather than being deep-fixed here — silences without altering runtime
 * behavior (Bun doesn't enforce types).
 *
 * Relative (not package-specifier) paths: pi-agent-ext-superpowers and
 * pi-agent-ext-wayfind's package.json `exports` map only declares the root
 * "." entry, pointing at a `dist/index.js` build output that isn't present in
 * this checkout (no build step has run) — a
 * `@repo/pi-agent-ext-superpowers/extensions/index.ts` subpath specifier
 * can't resolve through that exports map at all. Relative imports bypass
 * `exports` map resolution entirely (same reason the old dynamic `-e
 * <absPath>` mechanism worked via raw filesystem paths), so this works
 * uniformly across all entries regardless of each package's own exports map.
 *
 * TWO groups, added at different times:
 *   - Group A (original "general productivity" 5): goal-todo, hermes-memory,
 *     superpowers, wayfind, web-access.
 *   - Group B (migrated from dynamic `-e`): obsidian, btw, file2md,
 *     workflow, knowledge-card. These were PREVIOUSLY in manifest.extensions
 *     (jiti `-e` paths) — which works in source/bundle mode but NOT in `--exe`
 *     mode (binary mode emits zero `-e` flags; the .ts paths don't exist in
 *     the compiled $bunfs virtual FS). Migrating them to static imports makes
 *     the single-exe build bundle them by default. They were removed from
 *     manifest.extensions AND (for workflow) manifest.lazyExtensions at the
 *     same time to avoid the static+dynamic double-registration noted above.
 */
import goalTodoExtension from "../../pi-agent-ext-goal-todo/extensions/pi-goal-todo-ask.ts";
import hermesMemoryExtension from "../../pi-agent-ext-hermes-memory/src/index.ts";
import superpowersExtension from "../../pi-agent-ext-superpowers/extensions/index.ts";
import wayfindExtension from "../../pi-agent-ext-wayfind/extensions/index.ts";
import webAccessExtension from "../../pi-agent-ext-web-access/index.ts";
import obsidianExtension from "../../pi-agent-ext-obsidian/extensions/obsidian.ts";
import btwExtension from "../../pi-agent-ext-btw/extensions/pi-btw.ts";
import file2mdExtension from "../../pi-agent-ext-file2md/extensions/pi-file2md.ts";
import workflowExtension from "../../pi-agent-ext-workflow/extensions/workflow.ts";
import knowledgeCardExtension from "../../pi-agent-ext-knowledge-card/extensions/pi-knowledge-card.ts";

export const STATIC_EXTENSION_FACTORIES = [
	// Group A — original "general productivity" set
	{ name: "pi-agent-ext-goal-todo", factory: goalTodoExtension },
	{ name: "pi-agent-ext-hermes-memory", factory: hermesMemoryExtension },
	{ name: "pi-agent-ext-superpowers", factory: superpowersExtension },
	{ name: "pi-agent-ext-wayfind", factory: wayfindExtension },
	{ name: "pi-agent-ext-web-access", factory: webAccessExtension },
	// Group B — migrated from dynamic `-e` so the single-exe build bundles them
	{ name: "pi-agent-ext-obsidian", factory: obsidianExtension },
	{ name: "pi-agent-ext-btw", factory: btwExtension },
	{ name: "pi-agent-ext-file2md", factory: file2mdExtension },
	{ name: "pi-agent-ext-workflow", factory: workflowExtension },
	{ name: "pi-agent-ext-knowledge-card", factory: knowledgeCardExtension },
];
