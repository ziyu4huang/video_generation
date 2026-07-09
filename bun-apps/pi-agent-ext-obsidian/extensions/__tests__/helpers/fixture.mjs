/**
 * Test fixture helper: creates a temp vault directory seeded with a controlled
 * set of notes, returns its path. Teardown is the caller's responsibility
 * (pass the returned path to rmFixture).
 *
 * Used by tests that need a real filesystem (safeNotePath, appendUnderHeading,
 * findBacklinks, findTagNotes). Pure-logic tests (buildMatcher, fuzzyMatch,
 * computeFieldLabels) don't need this.
 */
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** Seed notes for the standard fixture. Keys = vault-relative paths. */
export const FIXTURE_NOTES = {
	// Plain note, no frontmatter
	"Inbox/plain.md": "# Plain Title\n\nSome body text with #inline-tag here.\n",
	// Flow-style frontmatter tags + H1
	"Zettelkasten/flow.md":
		"---\nid: 202601010000\ncreated: 2026-01-01\ntags: [zettel, alpha, beta]\nsources: []\n---\n\n# Flow Note\n\nBody mentions obsidian and agent.\n",
	// Block-style frontmatter tags (YAML block list)
	"Zettelkasten/block.md":
		"---\nid: 202601010001\ncreated: 2026-02-02\ntags:\n  - zettel\n  - gamma\nsources: []\n---\n\n# Block Note\n\nLinks to [[Flow Note]] and [[Zettelkasten/block|alias]].\n",
	// Unterminated frontmatter (no closing ---) — must NOT be treated as frontmatter
	"Zettelkasten/broken-fm.md":
		"---\nid: 202601010002\ncreated: 2026-03-03\ntags: [zettel]\n\n# Broken FM\n\nNo closing fence.\n",
	// No H1
	"Design/no-h1.md": "Just body, no heading. Contains package word.\n",
	// Heavily linked note (backlink target)
	"Zettelkasten/hub.md":
		"---\ncreated: 2026-04-04\ntags: [hub]\n---\n\n# Hub\n\nReferenced by many.\n",
};

/** Create a temp vault seeded with FIXTURE_NOTES (or a custom set). Returns abs path. */
export async function makeFixture(notes = FIXTURE_NOTES) {
	const dir = await mkdtemp(join(tmpdir(), "pio-test-"));
	for (const [rel, content] of Object.entries(notes)) {
		const abs = join(dir, rel);
		await mkdir(join(abs, ".."), { recursive: true });
		await writeFile(abs, content, "utf8");
	}
	return dir;
}

/** Remove a fixture directory. No-op if path is empty. */
export async function rmFixture(dir) {
	if (dir) await rm(dir, { recursive: true, force: true });
}
