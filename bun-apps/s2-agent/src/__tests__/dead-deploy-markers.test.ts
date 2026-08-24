/**
 * dead-deploy-markers — the precondition that makes Phase 1b's deletions safe.
 *
 * `src/run-dir/resolve.ts` used to branch on a "deploy-bundle" layout, detected by
 * a `.deploy-bundle` marker file sitting next to an `ext-bundles/` directory.
 * Both were written by `scripts/deploy.ts`, which Phase 1a (#1740) deleted
 * along with the four legacy deploy modes. Nothing writes either any more, so
 * the branch was unreachable and went with them.
 *
 * This test is what keeps that true. Reintroducing a writer without also
 * reintroducing the reader would produce a deploy layout that silently
 * resolves as plain source — the failure mode being guarded is not "someone
 * deletes this marker" but "someone revives half of a retired pipeline".
 *
 * Shaped to the WRITE, not to the name: reading, documenting, or asserting
 * about these paths stays legal.
 *
 * Test files are excluded. A test legitimately BUILDS a fixture tree with these
 * names — doctor.test.ts does, to prove the classifier handles a layout it may
 * still meet in the wild — and this file's own falsification block would
 * otherwise flag itself. What must not exist is a writer in the code that
 * ships.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const BUN_APPS = join(import.meta.dirname, "..", "..", "..");

/** Retired layout markers. A revived writer of either is the regression. */
const RETIRED_MARKERS = [".deploy-bundle", "ext-bundles"] as const;

/** Calls that CREATE something at a path. Reads and asserts are not here. */
const WRITE_CALL = "(?:writeFileSync|writeFile|mkdirSync|mkdir|cpSync|copyFileSync|renameSync|createWriteStream|Bun\\.write)";

function sourceFiles(root: string): string[] {
	const out: string[] = [];
	const walk = (dir: string): void => {
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}
		for (const name of entries) {
			if (name === "node_modules" || name === "dist" || name === ".git") continue;
			const full = join(dir, name);
			let st: ReturnType<typeof statSync>;
			try {
				st = statSync(full);
			} catch {
				continue;
			}
			if (st.isDirectory()) walk(full);
			else if (name.endsWith(".test.ts")) continue;
			else if (name.endsWith(".ts") || name.endsWith(".sh") || name.endsWith(".mjs")) out.push(full);
		}
	};
	walk(root);
	return out;
}

/** Drop comments so prose about the retired layout never counts as a writer. */
function stripComments(src: string): string {
	return src
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/(^|[^:])\/\/[^\n]*/g, "$1")
		.replace(/^\s*#(?!!)[^\n]*/gm, ""); // shell comments, keeping the shebang
}

describe("the retired deploy-bundle layout has no writer", () => {
	for (const marker of RETIRED_MARKERS) {
		test(`nothing creates ${marker}`, () => {
			// A write call whose argument list mentions the marker, or a shell
			// redirect / mkdir naming it.
			const patterns = [
				new RegExp(`${WRITE_CALL}\\s*\\([^)]*${marker.replace(".", "\\.")}`),
				new RegExp(`(?:>|mkdir\\s+(?:-p\\s+)?)[^\\n]*${marker.replace(".", "\\.")}`),
			];
			const offenders: string[] = [];
			for (const file of sourceFiles(BUN_APPS)) {
				const src = stripComments(readFileSync(file, "utf8"));
				if (patterns.some((p) => p.test(src))) offenders.push(file.slice(BUN_APPS.length + 1));
			}
			expect(
				offenders,
				`${marker} belongs to the deploy-bundle layout, retired with scripts/deploy.ts in #1740. ` +
					`Its READER is gone too, so a writer alone produces a tree that resolves as plain source. ` +
					`If the layout is genuinely coming back, restore src/run-dir/resolve.ts's branch in the same change.`,
			).toEqual([]);
		});
	}

	test("the guard can actually fail", () => {
		// Falsification, inline: the patterns must match a real writer...
		const writer = 'writeFileSync(join(dir, ".deploy-bundle"), "");';
		expect(new RegExp(`${WRITE_CALL}\\s*\\([^)]*\\.deploy-bundle`).test(writer)).toBe(true);
		expect(/(?:>|mkdir\s+(?:-p\s+)?)[^\n]*ext-bundles/.test("mkdir -p $OUT/ext-bundles")).toBe(true);
		// ...and must not match a reader, which is what every survivor is.
		const reader = 'if (exists(join(selfDir, ".deploy-bundle"))) return "deploy-bundle";';
		expect(new RegExp(`${WRITE_CALL}\\s*\\([^)]*\\.deploy-bundle`).test(reader)).toBe(false);
	});
});
