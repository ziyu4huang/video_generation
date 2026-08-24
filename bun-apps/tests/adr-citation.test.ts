/**
 * ADR identity + citation guard.
 *
 * This repo is deliberately multi-context: every context owns its own
 * `docs/adr/` and numbers from 0001 (see `docs/agents/domain.md`). The cost is
 * that a bare "ADR-0001" names SIX different documents, "ADR-0004" names five,
 * and every number in use collides at least twice. There is no unambiguous ADR
 * number in this repo.
 *
 * That is not hypothetical. PR #1323 read a planning doc's bare "ADR-0001",
 * resolved it to `s2-agent-ext-hermes-memory/docs/adr/0001-leanrag-selective-port.md`
 * — which says nothing about dependency direction — concluded the dep-guard had
 * produced a false positive, and allowlisted a real ADR violation. Separately,
 * five wayfind files and one superpowers file cite an "ADR-0001" that has never
 * existed in their context at all.
 *
 * The fix is a globally-unique ID per ADR, derived from its path and declared
 * in the ADR itself:
 *
 *     bun-apps/s2-agent/docs/adr/0001-extensions-...    →  ADR-s2-agent-0001
 *     bun-apps/s2-agent-ext-wayfind/docs/adr/0004-...   →  ADR-wayfind-0004
 *
 * Invariants:
 *  1. Every ADR file declares its canonical ID, and it matches its path.
 *  2. IDs are globally unique (guaranteed by 1, asserted independently).
 *  3. Every ADR citation in live source/docs is resolvable: qualified by ID, by
 *     markdown link, by context name, or resolving locally within the citing
 *     file's own context. A citation to a number the context does not own is a
 *     dangling reference and fails here.
 *
 * `.planning/` is out of scope by design: those are dated snapshots of what was
 * believed at the time, and rewriting them would falsify the record. Invariants
 * 1–3 are what protect a reader who follows a sloppy planning citation — the
 * ADR they land on says which one it is.
 *
 * Run: bun run test:adr   (from bun-apps/)
 */
import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const BUN_APPS = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = resolve(BUN_APPS, ".."); // repo root — ADRs are cited from docs/ and .github/ too

/** Never descend into these. `.pi` is runtime state (sessions, subagent
 * worktrees) — a concurrent session's worktree duplicates every ADR file and
 * red-flagged this guard on 2026-08-22 while its PR's own CI ran. `worktrees`
 * is the same class for the claude-code harness: a stale session worktree under
 * `.claude/worktrees/` re-flagged it on 2026-08-24. */
const SKIP_DIRS = new Set([
	"node_modules", ".git", "venv", "dist", "build", "mlx-models",
	"__fixtures__", "coverage", ".planning", "vaults_root", ".agents", "output",
	".pi", "worktrees",
]);

// ─── ADR discovery ──────────────────────────────────────────────────────────

export interface Adr {
	/** Directory that OWNS the ADR — the parent of `docs/adr/`. */
	contextDir: string;
	/** Globally-unique citation slug, e.g. "wayfind", "monorepo". */
	slug: string;
	/** Zero-padded number as it appears in the filename. */
	num: string;
	/** Canonical ID, e.g. "ADR-wayfind-0004". */
	id: string;
	/** Repo-relative path to the ADR file. */
	path: string;
}

/**
 * Pure: the citation slug for an ADR-owning context directory.
 *
 * `bun-apps` itself is the monorepo-level context; every other owner is a
 * package directory, and `s2-agent-ext-` is dropped because it carries no
 * information (all of them have it).
 */
export function contextSlug(contextDirName: string): string {
	if (contextDirName === "bun-apps") return "monorepo";
	return contextDirName.replace(/^s2-agent-ext-/, "");
}

/** Every `docs/adr/NNNN-*.md` in the repo, with its derived identity. */
function discoverAdrs(): Adr[] {
	const out: Adr[] = [];
	const walk = (dir: string, depth: number) => {
		if (depth > 6) return;
		let entries: ReturnType<typeof readdirSync>;
		try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
		for (const ent of entries) {
			if (!ent.isDirectory() || SKIP_DIRS.has(ent.name)) continue;
			const p = join(dir, ent.name);
			if (ent.name === "adr" && dir.endsWith(`${"/"}docs`)) {
				const contextDir = dirname(dir); // strip the trailing /docs
				const slug = contextSlug(contextDir.split("/").pop() as string);
				for (const f of readdirSync(p).sort()) {
					const m = /^(\d{4})-.*\.md$/.exec(f);
					if (!m) continue;
					const num = m[1] as string;
					out.push({ contextDir, slug, num, id: `ADR-${slug}-${num}`, path: relative(ROOT, join(p, f)) });
				}
				continue;
			}
			walk(p, depth + 1);
		}
	};
	walk(ROOT, 0);
	return out.sort((a, b) => a.id.localeCompare(b.id));
}

const ADRS = discoverAdrs();

/**
 * Pure: the ID an ADR file declares about itself, or null.
 *
 * Declared as a `**ID:** \`ADR-<slug>-NNNN\`` line near the top. Scanning only
 * the head keeps a *citation* of another ADR further down the file from being
 * mistaken for the file's own identity.
 */
export function declaredId(source: string): string | null {
	const head = source.split("\n").slice(0, 12).join("\n");
	return /\*\*ID:\*\*\s*`(ADR-[a-z0-9-]+-\d{4})`/.exec(head)?.[1] ?? null;
}

// ─── citation scanning ──────────────────────────────────────────────────────

/**
 * Pure: blank out inline code spans, preserving length so offsets still line up.
 *
 * A doc that shows citation forms by EXAMPLE must not have its examples read as
 * real citations — an example of a markdown link is not a link.
 */
export function stripInlineCode(md: string): string {
	return md.replace(/(`+)(?:[\s\S]*?)\1/g, (m) => " ".repeat(m.length));
}

/** A bare `ADR-NNNN` (NOT the qualified `ADR-<slug>-NNNN` form). */
const BARE_CITATION = /\bADR[-\s](\d{4})\b/g;

export interface Citation { file: string; line: number; num: string; text: string }

/**
 * Pure: is a bare citation on this line already disambiguated by its context?
 *
 * Accepted forms — each names the owning context unambiguously:
 *   - a markdown/path link:  `(./0004-decouple-...md)`, `docs/adr/0004-...`
 *   - the context named next to the number: "wayfind ADR-0004"
 * The qualified `ADR-wayfind-0004` form never matches BARE_CITATION at all,
 * because `[-\s](\d{4})` cannot match across the slug.
 */
export function isQualifiedOnLine(line: string, num: string, slugs: readonly string[]): boolean {
	if (new RegExp(`docs/adr/${num}-|\\./${num}-|/${num}-[\\w-]+\\.md`).test(line)) return true;
	for (const s of slugs) {
		// "wayfind ADR-0004" / "ADR-0004 (wayfind)" / "the wayfind ADR-0004"
		if (new RegExp(`\\b${s}\\b[^.\\n]{0,24}ADR[-\\s]${num}|ADR[-\\s]${num}[^.\\n]{0,24}\\b${s}\\b`).test(line)) return true;
	}
	return false;
}

/** Nearest ancestor context that owns ADRs, or null. */
function nearestContext(fileAbs: string): string | null {
	let d = dirname(fileAbs);
	const owners = new Set(ADRS.map((a) => a.contextDir));
	while (d.startsWith(ROOT)) {
		if (owners.has(d)) return d;
		const up = dirname(d);
		if (up === d) break;
		d = up;
	}
	return null;
}

/** Every bare ADR citation in the live surface (source, docs, skills, CI). */
function scanCitations(): Citation[] {
	const hits: Citation[] = [];
	const walk = (dir: string, depth: number) => {
		if (depth > 10) return;
		let entries: ReturnType<typeof readdirSync>;
		try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
		for (const ent of entries) {
			const p = join(dir, ent.name);
			if (ent.isDirectory()) {
				if (!SKIP_DIRS.has(ent.name)) walk(p, depth + 1);
				continue;
			}
			// `.yml.disabled` is deliberately included: the regression-gates job in
			// .github/workflows/ci.yml.disabled is the source ci-local.ts parses, so
			// its comments are live documentation, not dead config.
			if (!/\.(ts|tsx|js|mjs|md|ya?ml)(\.disabled)?$/.test(ent.name)) continue;
			// This guard itself carries bare citations as deliberate test fixtures;
			// excluding it is not an allowlist for violations — no other file gets
			// an exemption.
			if (p === fileURLToPath(import.meta.url)) continue;
			let src: string;
			try { src = readFileSync(p, "utf8"); } catch { continue; }
			if (!src.includes("ADR")) continue;
			src.split("\n").forEach((line, i) => {
				for (const m of line.matchAll(BARE_CITATION)) {
					hits.push({ file: relative(ROOT, p), line: i + 1, num: m[1] as string, text: line.trim().slice(0, 120) });
				}
			});
		}
	};
	walk(ROOT, 0);
	return hits;
}

// ─── invariants ─────────────────────────────────────────────────────────────

describe("ADR identity + citation guard", () => {
	it("discovery finds the known ADR contexts (guards the walker itself)", () => {
		assert.ok(ADRS.length >= 25, `expected the repo's ADR set, found ${ADRS.length}`);
		const slugs = new Set(ADRS.map((a) => a.slug));
		for (const expected of ["s2-agent", "wayfind", "hermes-memory"]) {
			assert.ok(slugs.has(expected), `context slug "${expected}" not discovered — walker is broken`);
		}
	});

	it("every ADR declares its canonical ID, matching its path", () => {
		const violations: string[] = [];
		for (const adr of ADRS) {
			const got = declaredId(readFileSync(join(ROOT, adr.path), "utf8"));
			if (got === null) violations.push(`  ${adr.path} — declares no **ID:**, expected \`${adr.id}\``);
			else if (got !== adr.id) violations.push(`  ${adr.path} — declares \`${got}\`, path says \`${adr.id}\``);
		}
		assert.deepEqual(violations, [], violations.length ? `ADR identity:\n${violations.join("\n")}` : "");
	});

	it("ADR IDs are globally unique", () => {
		const seen = new Map<string, string[]>();
		for (const a of ADRS) seen.set(a.id, [...(seen.get(a.id) ?? []), a.path]);
		const dupes = [...seen].filter(([, v]) => v.length > 1).map(([k, v]) => `  ${k}: ${v.join(", ")}`);
		assert.deepEqual(dupes, [], dupes.length ? `duplicate ADR IDs:\n${dupes.join("\n")}` : "");
	});

	it("every ADR citation in live source/docs resolves to exactly one ADR", () => {
		const slugs = [...new Set(ADRS.map((a) => a.slug))];
		const violations: string[] = [];
		for (const c of scanCitations()) {
			if (isQualifiedOnLine(c.text, c.num, slugs)) continue;
			const ctx = nearestContext(join(ROOT, c.file));
			const local = ctx ? ADRS.filter((a) => a.contextDir === ctx && a.num === c.num) : [];
			if (local.length === 1) continue; // resolves within its own context
			const global = ADRS.filter((a) => a.num === c.num);
			const why = ctx && local.length === 0
				? `context "${contextSlug(ctx.split("/").pop() as string)}" has no ${c.num} — DANGLING`
				: `${global.length} ADRs share ${c.num} (${global.map((a) => a.id).join(", ")})`;
			violations.push(`  ${c.file}:${c.line} — ${why}\n      ${c.text}`);
		}
		assert.deepEqual(
			violations, [],
			violations.length
				? `unresolvable ADR citations — use the qualified \`ADR-<context>-NNNN\` form or link the file:\n${violations.join("\n")}`
				: "",
		);
	});
});

// ─── pure-helper unit tests ─────────────────────────────────────────────────

describe("contextSlug", () => {
	it("maps the monorepo root context to `monorepo`", () => {
		assert.equal(contextSlug("bun-apps"), "monorepo");
	});
	it("drops the uninformative s2-agent-ext- prefix", () => {
		assert.equal(contextSlug("s2-agent-ext-wayfind"), "wayfind");
		assert.equal(contextSlug("s2-agent-ext-hermes-memory"), "hermes-memory");
	});
	it("leaves the host package name alone", () => {
		assert.equal(contextSlug("s2-agent"), "s2-agent");
	});
});

describe("declaredId", () => {
	it("reads the ID from the header", () => {
		assert.equal(declaredId("**ID:** `ADR-wayfind-0004` — cite by ID\n\n# Title"), "ADR-wayfind-0004");
	});
	it("returns null when absent", () => {
		assert.equal(declaredId("# Title\n\nSome prose about ADR-0004."), null);
	});
	it("ignores an ID appearing far below the header (that is a citation, not identity)", () => {
		const src = `# Title\n${"\n".repeat(20)}**ID:** \`ADR-wayfind-0004\``;
		assert.equal(declaredId(src), null);
	});
});

describe("stripInlineCode", () => {
	it("blanks a code span so an EXAMPLE link is not read as a link", () => {
		assert.equal(/\]\(/.test(stripInlineCode("use ``[ADR-0002](./0002-x.md)`` to cite")), false);
	});
	it("leaves a real link outside code spans intact", () => {
		assert.match(stripInlineCode("| [`label`](../real/file.md) |"), /\]\(\.\.\/real\/file\.md\)/);
	});
	it("preserves length so nothing else shifts", () => {
		const src = "a `bc` d";
		assert.equal(stripInlineCode(src).length, src.length);
	});
});

describe("isQualifiedOnLine", () => {
	const slugs = ["wayfind", "monorepo", "subagent"];
	it("accepts a markdown link to the ADR file", () => {
		assert.equal(isQualifiedOnLine("see [ADR-0002](./0002-shared-status-widget.md)", "0002", slugs), true);
	});
	it("accepts a docs/adr path on the same line", () => {
		assert.equal(isQualifiedOnLine("ADR-0001 — bun-apps/docs/adr/0001-strict-downward.md", "0001", slugs), true);
	});
	it("accepts the context named beside the number", () => {
		assert.equal(isQualifiedOnLine("cross-extension seam guard (wayfind ADR-0004)", "0004", slugs), true);
	});
	it("rejects a bare number with no context", () => {
		assert.equal(isQualifiedOnLine("dep-direction (ADR-0001)", "0001", slugs), false);
	});
});
