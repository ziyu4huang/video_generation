/**
 * Tool-naming contract gate (self-arc-20 ticket 03) — turns the
 * `extension-naming` SKILL.md convention (bun-apps/s2-agent-ext-devops/
 * skills/extension-naming/SKILL.md — the declared single source of truth)
 * into an enforced workspace gate, sibling of seam-contract / routing-contract.
 *
 * Convention under enforcement (per the SKILL.md canonical table):
 *   - Agent tool  : snake_case, `verb_object` (optionally `ns_verb`)   ⚠ outliers exist
 *   - Help companion: `<tool>_help`, always paired with its base tool  ✅ consistent
 *   - Skill (dir + SKILL.md name): kebab-case                          ✅ consistent
 *
 * STATIC SCOPE (no runtime import of any package). Tool names are extracted
 * from `registerTool(<object-literal>` call sites: the first `name: "<literal>"`
 * field inside the call's object is the tool name (repo style puts `name`
 * first — devops.ts, file2md.ts, obsidian.ts, …). Two classes are OUTSIDE
 * static reach and deliberately exempt rather than half-checked:
 *   1. FACTORY-registered tools — `pi.registerTool(makeFlux2Tool())` style,
 *      where the literal lives inside a src factory (flux2/flux2_help, webui,
 *      krea2, ltx, movie, power-tool's browser, hermes's memory). Their names
 *      are constants in their own packages; review + the SKILL.md history
 *      table own them.
 *   2. EXTERNAL dynamic tools — zai-mcp's names come from each MCP server's
 *      listTools(); "not ours to rename" per the SKILL.md.
 * hermes registers some tools via a defs list (`id: "skill_manage"` in
 * src/tools/skill-tool.ts) rather than an inline `name:` — its companion
 * `skill_manage_help` IS visible to the scanner, so DYNAMIC_TOOL_BASES below
 * pins the base that static extraction cannot see.
 *
 * Invariants:
 *  1. GROUNDED — the literal-name inventory stays substantial (≥40 distinct
 *     names across the ext layer). A refactor that breaks the extractor must
 *     fail loud here, never vacuously pass.
 *  2. TOOL-NAME CONVENTION — every extracted literal name matches
 *     snake_case `verb_object`/`ns_verb` (≥1 underscore), except the
 *     documented BASELINE_OUTLIERS (pre-convention bare nouns, each of which
 *     MUST also appear in the SKILL.md outlier line — the prose stays the
 *     single source of truth; this gate keeps it honest). A NEW
 *     non-conforming name fails: renaming/extending the baseline is the
 *     contract-maintenance act, and wire renames need the PR #1738
 *     legacy-name pattern (SKILL.md rename history).
 *  3. HELP PAIRING — every extracted `<x>_help` has a base `<x>` in the
 *     inventory OR in DYNAMIC_TOOL_BASES.
 *  4. SKILL-DIR KEBAB-CASE — every ext package's skills dir is kebab-case.
 *     kebab-case (lowercase alphanumerics separated by single hyphens).
 *
 * Run: bun run test:tool-naming   (from bun-apps/)
 */
import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), ".."); // bun-apps/
const EXT_PATTERN = /^s2-agent-ext-/;
const NAMING_SKILL = join(
	ROOT,
	"s2-agent-ext-devops",
	"skills",
	"extension-naming",
	"SKILL.md",
);

/** Extract the literal tool names from one source file: for each
 * `registerTool(`, scan the call's object (paren-depth tracked, string-aware)
 * and take the FIRST `name: "<literal>"`. Test files/fixtures excluded by the
 * walk. Mirrors /tmp prototyper validated against the live tree (45 names,
 * 2026-09-09). */
function extractToolNames(src: string): string[] {
	const names: string[] = [];
	const re = /registerTool\s*\(/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(src))) {
		let i = m.index + m[0].length;
		let depth = 1;
		while (i < src.length && depth > 0) {
			const ch = src[i]!;
			if (ch === "(") depth++;
			else if (ch === ")") {
				depth--;
				if (depth === 0) break;
			} else if (ch === '"' || ch === "'" || ch === "`") {
				const q = ch;
				i++;
				while (i < src.length && src[i] !== q) {
					if (src[i] === "\\") i++;
					i++;
				}
			} else {
				const nm = /^name\s*:\s*["']([^"']+)["']/.exec(src.slice(i, i + 600));
				if (nm) {
					names.push(nm[1]!);
					i += nm[0].length;
				}
			}
			i++;
		}
	}
	return names;
}

function walkSources(dir: string, out: string[]): void {
	let entries: ReturnType<typeof readdirSync>;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const ent of entries) {
		if (ent.name === "node_modules" || ent.name === "dist" || ent.name === "__tests__" || ent.name === "fixtures") continue;
		const p = join(dir, ent.name);
		if (ent.isDirectory()) walkSources(p, out);
		else if (/\.(ts|tsx)$/.test(ent.name) && !/\.test\./.test(ent.name)) out.push(p);
	}
}

/** The inventory: literal name → one owning file (repo-relative, for messages). */
function buildInventory(): Map<string, string> {
	const inventory = new Map<string, string>();
	for (const ent of readdirSync(ROOT, { withFileTypes: true })) {
		if (!ent.isDirectory() || !EXT_PATTERN.test(ent.name) || !existsSync(join(ROOT, ent.name, "package.json"))) continue;
		const files: string[] = [];
		walkSources(join(ROOT, ent.name), files);
		for (const f of files) {
			const src = readFileSync(f, "utf8");
			if (!src.includes("registerTool")) continue;
			for (const name of extractToolNames(src)) {
				if (!inventory.has(name)) inventory.set(name, f.slice(ROOT.length + 1));
			}
		}
	}
	return inventory;
}

/** snake_case verb_object / ns_verb: lowercase identifier, ≥1 underscore,
 *  no trailing/leading/double underscores. `obsidian_read`, `sync_default_branch`,
 *  `zk_ask` pass; `file2md`, `obsidian` (bare nouns) do not. */
const TOOL_NAME_RE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;

/**
 * Pre-convention bare-noun outliers STILL on the wire (SKILL.md canonical
 * table + outlier line). Renaming any of these is a behavior change (PR #1738
 * legacy-name pattern + a new SKILL.md history row) — NOT a baseline edit.
 */
const BASELINE_OUTLIERS: ReadonlySet<string> = new Set(["file2md", "obsidian"]);

/** `<x>_help` companions whose base tool is registered OUTSIDE the literal
 * scanner's reach (factory/defs-list registration — see module doc). */
const DYNAMIC_TOOL_BASES: ReadonlyMap<string, string> = new Map([
	// hermes: SKILL_MANAGE_TOOL_NAME = "skill_manage" (src/tools/skill-tool.ts),
	// registered from a defs list — only the companion shows up as a literal.
	["skill_manage_help", "registered via hermes tool-def id (src/tools/skill-tool.ts)"],
]);

describe("tool-naming contract (extension-naming SKILL.md → enforced; ticket 03)", () => {
	const inventory = buildInventory();
	const names = [...inventory.keys()].sort();
	const namingSkillSrc = readFileSync(NAMING_SKILL, "utf8");

	it("GROUNDED — the literal inventory stays substantial (≥40 distinct names)", () => {
		assert.ok(
			names.length >= 40,
			`expected ≥40 literal-registered tool names, got ${names.length}. ` +
				"If registration moved off the inline `name:` literal form, update the extractor — never lower this floor.",
		);
	});

	it("every literal-registered tool name matches the snake_case verb_object/ns_verb convention (documented outliers only)", () => {
		const violations = names.filter((n) => !TOOL_NAME_RE.test(n) && !BASELINE_OUTLIERS.has(n));
		assert.deepEqual(
			violations,
			[],
			`non-conforming tool name(s) ${JSON.stringify(violations)}. Either rename to snake_case verb_object ` +
				`(behavior change — PR #1738 legacy-name pattern + SKILL.md history row) or, only for a pre-convention ` +
				`name already on the wire, add it to BASELINE_OUTLIERS with its SKILL.md outlier-line row.`,
		);
	});

	it("every BASELINE_OUTLIERS entry is still on the wire AND named in the SKILL.md outlier line", () => {
		for (const o of BASELINE_OUTLIERS) {
			assert.ok(
				inventory.has(o),
				`baseline outlier "${o}" no longer appears in the literal inventory — remove it from BASELINE_OUTLIERS (dead baseline).`,
			);
			assert.ok(
				namingSkillSrc.includes(`\`${o}\``) || namingSkillSrc.includes(o),
				`baseline outlier "${o}" must be named in the extension-naming SKILL.md (single source of truth).`,
			);
		}
	});

	it("HELP PAIRING — every <x>_help companion has its base tool (literal or documented dynamic)", () => {
		const helpers = names.filter((n) => n.endsWith("_help"));
		assert.ok(helpers.length >= 3, `expected ≥3 _help companions, got ${helpers.length} (grounding)`);
		const orphans = helpers.filter((h) => {
			const base = h.slice(0, -"_help".length);
			return !names.includes(base) && !DYNAMIC_TOOL_BASES.has(h);
		});
		assert.deepEqual(
			orphans,
			[],
			`_help companion(s) without a base tool: ${JSON.stringify(orphans)}. ` +
				`If the base is registered dynamically (factory/defs list), document it in DYNAMIC_TOOL_BASES; otherwise restore the base tool.`,
		);
	});

	it("SKILL-DIR KEBAB-CASE — every s2-agent-ext-*/skills/<dir> is kebab-case", () => {
		const bad: string[] = [];
		let checked = 0;
		for (const ent of readdirSync(ROOT, { withFileTypes: true })) {
			if (!ent.isDirectory() || !EXT_PATTERN.test(ent.name)) continue;
			const skillsDir = join(ROOT, ent.name, "skills");
			if (!existsSync(skillsDir)) continue;
			for (const s of readdirSync(skillsDir, { withFileTypes: true })) {
				if (!s.isDirectory()) continue;
				checked++;
				if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s.name)) bad.push(`${ent.name}/skills/${s.name}`);
			}
		}
		assert.ok(checked >= 30, `expected ≥30 skill dirs across the ext layer, checked ${checked} (grounding)`);
		assert.deepEqual(bad, [], `non-kebab-case skill dir(s): ${JSON.stringify(bad)} — the SKILL.md canonical table requires kebab-case skill names.`);
	});
});
