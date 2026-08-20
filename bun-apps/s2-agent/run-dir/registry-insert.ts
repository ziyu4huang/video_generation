/**
 * registry-insert.ts — textual append into s2-agent.registry.yaml's
 * `extensions:` list.
 *
 * TEXT SURGERY on purpose: the registry's comments carry the exclusion
 * rationale (WHY each local extension stays local) — the thing a YAML
 * re-serialisation would destroy. Duplicate-name detection happens BEFORE the
 * insert, in the caller (ext-new reads the file through parseRegistry); this
 * module only places an already-rendered entry.
 */

/**
 * Append `entryYaml` (2-space-indented, no leading/trailing blank lines) after
 * the LAST entry of the `extensions:` block, preserving everything before the
 * insertion point byte-for-byte. Throws if the text has no `extensions:` block
 * — a registry without one is a parse error upstream, not something a writer
 * should invent.
 */
export function appendRegistryExtension(text: string, entryYaml: string): string {
	const lines = text.split("\n");
	const extensionsIdx = lines.findIndex((l) => /^extensions:\s*$/.test(l));
	if (extensionsIdx === -1) {
		throw new Error("registry has no `extensions:` block to append to");
	}

	// The last entry starts at the last `  - name:` line after `extensions:`
	// and before the next column-0 key (e.g. `lazyExtensions:`).
	let lastEntry = -1;
	for (let i = extensionsIdx + 1; i < lines.length; i++) {
		const line = lines[i] as string;
		if (/^\S/.test(line)) break; // next top-level key — block ended
		if (/^  - name: /.test(line)) lastEntry = i;
	}
	if (lastEntry === -1) {
		throw new Error("registry `extensions:` block has no entries to append after");
	}

	// The entry ends at its last content line: blank lines and the next
	// column-0 key both terminate it. Comments above an entry belong to the
	// NEXT entry, so a comment line directly after this entry's last field
	// would be displaced by the insert — callers therefore insert at the last
	// field line, keeping trailing comments attached to the block, not the entry.
	let end = lastEntry;
	for (let i = lastEntry + 1; i < lines.length; i++) {
		const line = lines[i] as string;
		if (line.trim() === "" || /^\S/.test(line)) break;
		end = i;
	}

	lines.splice(end + 1, 0, ...entryYaml.split("\n"));
	return lines.join("\n");
}
