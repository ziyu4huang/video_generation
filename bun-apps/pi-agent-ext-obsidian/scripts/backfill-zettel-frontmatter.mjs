/**
 * P1 backfill: run the distill auto-repair over an existing vault's notes that
 * pre-date the schema (study-news zettel/ has 0% id, 1% sources). Dogfoods the
 * newly-added repairZettelFrontmatter so the distill backstop is exercised on
 * real notes, not just unit fixtures.
 *
 *   bun scripts/backfill-zettel-frontmatter.mjs <vault> [folder] [source]
 *   default folder = "zettel", default source = "study-news"
 */
import { readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import {
	repairZettelFrontmatter,
	validateZettelNotes,
	getIndex,
	dropIndex,
} from "../extensions/obsidian.ts";

const vault = process.argv[2] ?? "/Users/huangziyu/proj/study-news";
const folder = process.argv[3] ?? "zettel";
const defaultSource = process.argv[4] ?? "study-news";

function listNotes(vault, folder) {
	let dir;
	try {
		dir = readdirSync(join(vault, folder), { withFileTypes: true });
	} catch {
		console.error(`folder "${folder}" not found in ${vault}`);
		return [];
	}
	return dir
		.filter((d) => d.isFile() && extname(d.name) === ".md")
		.map((d) => `${folder}/${d.name}`);
}

const notes = listNotes(vault, folder);
console.log(`Scanning ${notes.length} notes in ${vault}/${folder}`);

// Before
process.env.OB_INDEX_POLL_MS = "0";
let before;
try {
	before = await validateZettelNotes(vault, notes);
} catch (e) {
	console.error("validate before failed:", e);
	process.exit(1);
}
console.log(`BEFORE: ${before.valid}/${notes.length} pass schema (id/created/tags/sources)`);

// Repair
const repair = await repairZettelFrontmatter(vault, notes, [defaultSource]);
const fixed = repair.notes.filter((n) => n.repaired.length > 0);
console.log(`REPAIR: filled missing keys on ${fixed.length} note(s), ${repair.totalRepaired} keys total`);
for (const n of fixed) console.log(`  + ${n.path}  (${n.repaired.join(", ")})`);
const errs = repair.notes.filter((n) => n.error);
if (errs.length) for (const e of errs) console.log(`  ! ${e.path}: ${e.error}`);

// After
let after;
try {
	dropIndex(vault);
	after = await validateZettelNotes(vault, notes);
} catch (e) {
	console.error("validate after failed:", e);
	process.exit(1);
}
console.log(`AFTER:  ${after.valid}/${notes.length} pass schema`);
const stillBad = after.notes.filter((n) => !n.ok);
if (stillBad.length) {
	console.log("Still failing (tags[0]!=zettel or unresolved links — not auto-repairable):");
	for (const n of stillBad) console.log(`  - ${n.path}: ${n.errors.join("; ")}`);
}
console.log(before.valid < after.valid ? "✓ improved" : "(no change)");
