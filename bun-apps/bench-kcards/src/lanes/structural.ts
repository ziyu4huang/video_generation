/**
 * lanes/structural.ts — bench lane 1c: structural compliance of the vault's
 * paper cards, deterministic and offline (effort 2026-09-10-bench-kcards).
 *
 * Checks per `Paper - *.md` card (design review §3 lane 1c):
 *  - frontmatter: id `^\d{12}$`, created YYYY-MM-DD, non-empty tags starting
 *    with `zettel`, non-empty sources;
 *  - house sections 核心想法 / 證據・脈絡 / 連結 present;
 *  - every `[[wiki-link]]` resolves to an existing vault note;
 *  - every numeric bullet in 證據 carries an evidence anchor
 *    (Table N / Figure N / Abstract + optional page);
 *  - sources format `arXiv:<id>`.
 *
 * Pure read-only: operates on any vault path (the sandbox copy in tests).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface StructuralViolation {
	card: string;
	check: string;
	detail: string;
}

export interface StructuralResult {
	cardsChecked: number;
	violations: StructuralViolation[];
	pass: boolean;
}

const SECTION_REQUIREMENTS = ["## 核心想法", "## 證據", "## 連結"] as const;

function parseFrontmatter(md: string): { data: Record<string, string>; body: string } {
	const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(md);
	if (!m) return { data: {}, body: md };
	const data: Record<string, string> = {};
	for (const line of m[1]!.split("\n")) {
		const kv = /^([A-Za-z_-]+)\s*:\s*(.*)$/.exec(line);
		if (kv) data[kv[1]!] = kv[2]!.trim();
	}
	return { data, body: md.slice(m[0]!.length) };
}

function existsNote(vaultPath: string, link: string): boolean {
	const base = link.split(/[#|]/)[0]!.trim();
	if (!base) return false;
	const direct = join(vaultPath, base.endsWith(".md") ? base : `${base}.md`);
	if (existsSync(direct)) return true;
	// Obsidian resolves by basename anywhere in the vault — scan Zettelkasten + Tags.
	for (const dir of ["Zettelkasten", "Tags", "Design"]) {
		const abs = join(vaultPath, dir);
		if (!existsSync(abs)) continue;
		const hit = searchBasename(abs, base);
		if (hit) return true;
	}
	return false;
}

function searchBasename(dir: string, base: string): boolean {
	for (const ent of readdirSyncSafe(dir)) {
		const p = join(dir, ent.name);
		if (ent.isDirectory()) {
			if (searchBasename(p, base)) return true;
		} else if (ent.name === base || ent.name === `${base}.md`) return true;
	}
	return false;
}

function readdirSyncSafe(dir: string): import("node:fs").Dirent[] {
	try {
		return readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
}

/** Run the structural lane over every `Paper - *.md` card in `vaultPath`. */
export function runStructuralLane(vaultPath: string): StructuralResult {
	const zkDir = join(vaultPath, "Zettelkasten");
	const violations: StructuralViolation[] = [];
	let cardsChecked = 0;
	if (!existsSync(zkDir)) return { cardsChecked: 0, violations: [{ card: "*", check: "vault", detail: "no Zettelkasten dir" }], pass: false };

	for (const ent of readdirSync(zkDir, { withFileTypes: true })) {
		if (!ent.isFile() || !ent.name.startsWith("Paper - ") || !ent.name.endsWith(".md")) continue;
		cardsChecked++;
		const card = ent.name;
		const md = readFileSync(join(zkDir, ent.name), "utf8");
		const { data, body } = parseFrontmatter(md);

		if (!/^\d{12}$/.test(data.id ?? "")) {
			violations.push({ card, check: "id-format", detail: `id "${data.id}" is not ^\\d{12}$` });
		}
		if (!/^\d{4}-\d{2}-\d{2}$/.test(data.created ?? "")) {
			violations.push({ card, check: "created-format", detail: `created "${data.created}" is not YYYY-MM-DD` });
		}
		const tags = (data.tags ?? "").replace(/[\[\]]/g, "").split(",").map((t) => t.trim()).filter(Boolean);
		if (tags.length === 0 || tags[0] !== "zettel") {
			violations.push({ card, check: "tags", detail: `tags must start with "zettel": "${data.tags}"` });
		}
		const sourcesRaw = (data.sources ?? "").replace(/[\[\]"']/g, "").trim();
		if (!/^arXiv:\d{4}\.\d{4,5}$/.test(sourcesRaw)) {
			violations.push({ card, check: "sources-format", detail: `sources "${data.sources}" is not ["arXiv:<id>"]` });
		}

		for (const section of SECTION_REQUIREMENTS) {
			if (!body.includes(section)) {
				violations.push({ card, check: "section", detail: `missing section ${section}` });
			}
		}

		for (const m of body.matchAll(/\[\[([^\]]+)\]\]/g)) {
			const link = m[1]!.split(/[#|]/)[0]!.trim();
			if (!existsNote(vaultPath, link)) {
				violations.push({ card, check: "wiki-link", detail: `unresolved link [[${link}]]` });
			}
		}

		// Evidence anchors: numeric bullets in the 證據 section must name their
		// anchor — either on the bullet itself or inherited from the nearest
		// preceding header/bold line (house convention: "**主要結果（Table 3，
		// 第 6 頁）**" anchors every bullet under it). Meta notes (grounding
		// 註記 / file2md 轉換 lines) are exempt — they annotate the pipeline,
		// not the paper.
		const evidenceStart = body.indexOf("## 證據");
		const linksStart = body.indexOf("## 連結");
		if (evidenceStart !== -1) {
			const evidence = body.slice(evidenceStart, linksStart === -1 ? body.length : linksStart);
			let currentAnchor = false;
			for (const line of evidence.split("\n")) {
				const trimmed = line.trim();
				const isHeader = /^#{1,3} /.test(trimmed) || /^\*\*[^*]+\*\*/.test(trimmed);
				if (isHeader) {
					// header/bold line: refresh the section-level anchor context
					if (/(Table|Figure|Abstract|第\s*\d+\s*頁|p\.\s*\d+)/i.test(trimmed)) currentAnchor = true;
					continue;
				}
				if (!trimmed.startsWith("-")) continue;
				if (/(Table|Figure|Abstract|第\s*\d+\s*頁|p\.\s*\d+)/i.test(line)) {
					currentAnchor = true;
					continue;
				}
				if (!/\d/.test(line)) continue;
				if (/（grounding 註記|grounding 標記|file2md 轉換|修正記錄/.test(line)) continue;
				if (!currentAnchor) {
					violations.push({
						card,
						check: "evidence-anchor",
						detail: `numeric bullet without anchor (own or inherited): ${trimmed.slice(0, 80)}`,
					});
				}
			}
		}
	}
	return { cardsChecked, violations, pass: violations.length === 0 };
}
