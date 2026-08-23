import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
// pi's OWN frontmatter parser — the exact code path that loads skills at
// runtime. Re-implementing the parse here (or using a different YAML lib)
// would let the checker and the runtime disagree; the 2026-08-23 incident
// (s2-agent-model-catalog-update shipped with `Triggers: "…"` inside an
// unquoted description — YAML read a nested mapping and pi surfaced a
// "[Skill conflicts]" startup warning from the DEPLOYED dist, with every
// package-local suite green) is exactly that divergence.
import { parseFrontmatter } from "../s2-agent/node_modules/@earendil-works/pi-coding-agent/dist/utils/frontmatter.js";

/**
 * Run: bun run test:skill-frontmatter   (from bun-apps/)
 *
 * Cross-package skill frontmatter guard. Every s2-agent-ext-* package ships
 * skills, and skills load in THREE places — source mode, the run-dir
 * manifest, and the deployed dist ext/<name>/skills/ — none of which is
 * owned by any single package's test suite. That is why this lives in
 * bun-apps/tests/ (same reasoning as skill-reference.test.ts): it is the only
 * place all packages' skills are visible at once.
 *
 * What it pins, per SKILL.md:
 *  - the frontmatter parses under pi's parser (a throw = the skill never
 *    registers; pi reports it as a startup warning, not an error, so nothing
 *    else goes red — not even the deploy E2E, whose boot probe exits 0
 *    through skill conflicts);
 *  - `description` is a non-empty string (pi's own registration requirement);
 *  - `name`, when present, equals the skill directory (otherwise the
 *    advertised name and the /slash path disagree across runtimes).
 */

const BUN_APPS = join(import.meta.dir, "..");

interface SkillFile {
	pkg: string;
	dirName: string;
	path: string;
}

function isFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

/** Every SKILL.md across every extension package's skills/ tree. */
function allSkillFiles(): SkillFile[] {
	const files: SkillFile[] = [];
	for (const pkg of readdirSync(BUN_APPS, { withFileTypes: true })) {
		if (!pkg.isDirectory() || pkg.name === "node_modules") continue;
		if (!pkg.name.startsWith("s2-agent-ext-")) continue;
		const skillsDir = join(BUN_APPS, pkg.name, "skills");
		let entries: string[];
		try {
			entries = readdirSync(skillsDir);
		} catch {
			continue; // package ships no skills
		}
		for (const dirName of entries) {
			const path = join(skillsDir, dirName, "SKILL.md");
			if (isFile(path)) files.push({ pkg: pkg.name, dirName, path });
		}
	}
	return files;
}

describe("every extension skill's frontmatter parses under pi's runtime parser", () => {
	test("scans the whole workspace (a zero-file scan proves nothing)", () => {
		// Floor, not a pin: skills get added; the point is the sweep never
		// silently becomes a no-op after a layout move.
		expect(allSkillFiles().length).toBeGreaterThanOrEqual(50);
	});

	test("parses + non-empty description + name matches the skill dir", () => {
		const failures: string[] = [];
		for (const { pkg, dirName, path } of allSkillFiles()) {
			const label = `${pkg}/skills/${dirName}`;
			try {
				const { frontmatter } = parseFrontmatter(readFileSync(path, "utf8"));
				if (typeof frontmatter.description !== "string" || frontmatter.description.trim() === "") {
					failures.push(`${label}: description missing or empty`);
				}
				if (frontmatter.name !== undefined && frontmatter.name !== dirName) {
					failures.push(`${label}: frontmatter name "${frontmatter.name}" != dir "${dirName}"`);
				}
			} catch (e) {
				// The incident shape: YAML throws mid-description and pi drops the
				// skill at startup with only a warning.
				failures.push(`${label}: frontmatter THROWS — ${(e as Error).message.split("\n")[0]}`);
			}
		}
		// Report ALL failures at once — a one-per-test shape hides every file
		// after the first bad one behind an identical red.
		expect(failures).toEqual([]);
	});
});
