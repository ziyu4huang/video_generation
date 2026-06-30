/**
 * P0.1 snapshot — exact original implementation of searchVault + obsidian_search
 * tool registration, captured 2026-06-26 from packages/pi-obsidian/extensions/obsidian.ts
 * (function at lines 172-198, tool registration at lines 579-607).
 *
 * Purpose: a byte-for-byte regression baseline. After each phase, the substring
 * default path MUST reproduce the output captured in search-baseline.txt.
 * Keep this file until the stability plan (plan/pi-obsidian-stability-and-features.md)
 * Track A is complete; do not delete.
 */

// ---- function searchVault (original, lines 172-198) ----
async function searchVault(
	vaultPath: string,
	query: string,
	opts: { caseSensitive?: boolean; max?: number },
): Promise<{ file: string; line: number; text: string }[]> {
	const needle = opts.caseSensitive ? query : query.toLowerCase();
	const files = await listNotes(vaultPath, "");
	const results: { file: string; line: number; text: string }[] = [];
	const max = opts.max ?? 50;
	for (const f of files) {
		let content: string;
		try {
			content = await readFile(join(vaultPath, f), "utf8");
		} catch {
			continue;
		}
		const lines = content.split("\n");
		for (let i = 0; i < lines.length; i++) {
			const hay = opts.caseSensitive ? lines[i] : lines[i].toLowerCase();
			if (hay.includes(needle)) {
				results.push({ file: f, line: i + 1, text: lines[i].trim() });
				if (results.length >= max) return results;
			}
		}
	}
	return results;
}

// ---- tool registration obsidian_search (original, lines 579-607) ----
pi.registerTool({
	name: "obsidian_search",
	label: "Obsidian Search",
	description:
		"Full-text search across all notes in the vault. Returns matching file:line snippets. Case-insensitive by default.",
	parameters: Type.Object({
		query: Type.String({ description: "Search string." }),
		caseSensitive: Type.Optional(Type.Boolean({ description: "Default false." })),
		max: Type.Optional(Type.Number({ description: "Max matches to return. Default 50." })),
	}),
	async execute(_id, params, _s, _u, ctx) {
		const v = await getVault(ctx.cwd);
		const matches = await searchVault(v.path, params.query, {
			caseSensitive: params.caseSensitive,
			max: params.max,
		});
		return {
			content: [
				{
					type: "text",
					text: matches.length
						? `${matches.length} match(es) for "${params.query}":\n` +
							matches.map((m) => `${m.file}:${m.line}: ${m.text}`).join("\n")
						: `No matches for "${params.query}" in vault "${v.name}".`,
				},
			],
			details: { vault: v.name, query: params.query, matches },
		};
	},
});

/* ---- Observed baseline properties (the contract a backward-compatible
   refactor must preserve for the substring default path) ----
   1. Default case-insensitive: query lowercased, each line lowercased before includes().
   2. Traversal order: files returned by listNotes (sorted alphabetically, recursive).
      Within a file: top-to-bottom by line number.
   3. Match granularity: any line where the (lowercased) needle is a substring.
   4. Result fields: { file, line, text } where text = the line TRIMMED.
   5. Hard cap: stops at `max` (default 50) matches; early-returns mid-file.
   6. Frontmatter, tags, titles are NOT special — all matched as ordinary lines.
   7. Read failures (per file) are silently skipped.
*/
