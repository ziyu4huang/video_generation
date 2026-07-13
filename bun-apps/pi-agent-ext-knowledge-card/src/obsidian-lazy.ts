/**
 * Lazy pi-obsidian barrel — re-exports obsidian's symbols from a pre-built
 * FULL bundle instead of importing `obsidian.ts` directly.
 *
 * WHY: a static `import … from "@repo/pi-agent-ext-obsidian/extensions/obsidian.ts"`
 * forces jiti (pi's extension loader) to transform obsidian.ts as a transitive
 * dependency of this extension. obsidian.ts re-exports a 138KB obsidian-lib.ts;
 * jiti wraps that transitive module in a `data:text/javascript;base64,…`
 * specifier to apply its alias map, and Bun rejects it with `NameTooLong`.
 * jiti intercepts EVERY import form (static AND dynamic — it rewrites
 * `import()` to `jitiImport()`), so there is no in-graph way around the wrap.
 *
 * FIX: consume a pre-built FULL bundle (`obsidian.bundle.js`). bun build inlines
 * typebox + @earendil-works/* + obsidian-lib into one self-contained .js whose
 * only remaining imports are Node builtins (fs/path/…) — which are NOT in jiti's
 * alias map, so jiti has nothing to rewrite and loads the module NATIVELY (no
 * data-URL wrapper, no size limit). This mirrors how pi-agent-ext-workflow is
 * consumed via compiled output. Rebuild the bundle after editing obsidian:
 *   bun build bun-apps/pi-agent-ext-obsidian/extensions/obsidian.ts \
 *     --target=bun --format=esm \
 *     --outfile bun-apps/pi-agent-ext-obsidian/dist/obsidian.bundle.js
 * See memory `pi-extension-thin-bundle-jiti-nametoolong`.
 */
export {
	resolveVault,
	registerDeterministicHealthCheck,
	parseFrontmatter,
	validateZettelNote,
	ZETTEL_MAX_BYTES,
	getIndex,
	graphDeadLinks,
	graphOrphans,
	invalidateCache,
} from "@repo/pi-agent-ext-obsidian/dist/obsidian.bundle.js";

export type { VaultIndex } from "@repo/pi-agent-ext-obsidian/dist/obsidian.bundle.js";
