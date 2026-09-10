/**
 * lanes/query-gates.ts — bench lanes 2c (tag recall) and 2d (retrieval MRR),
 * deterministic given a CONVERGED sandbox vault (see converge-sandbox.ts).
 *
 *  - 2c tag recall@5: `retrieveRecords` queried with a card's own topical
 *    tags must surface that card's graph note in the top 5 (threshold
 *    ≥ 0.90 across cards).
 *  - 2d retrieval MRR: `embedQuery` per golden question, cosine-ranked
 *    against the sandbox semantic index; the paper's graph note is the
 *    relevant item (threshold MRR ≥ 0.70, hit@3 ≥ 0.85).
 *  - bite check (mutation): with the paper notes' vectors removed from the
 *    index, MRR must COLLAPSE (< 0.20) — proving the gate can fail.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { retrieveRecords } from "@repo/s2-agent-ext-knowledge-card/src/retrieve.ts";
import { embedQuery } from "@repo/s2-agent-ext-knowledge-card/src/semantic.ts";

export interface PaperNoteMapEntry {
	/** Card file name, e.g. "Paper - ReCite ….md". */
	cardFile: string;
	/** Card title (H1 text). */
	title: string;
	/** Graph-note path inside the vault, e.g. "Zettelkasten/knowledge-graph/generic-paper-recite". */
	graphNote: string;
	/** The card's topical tags (frontmatter tags minus `zettel`). */
	tags: string[];
}

/** Build arxivId → graph-note info by scanning sandbox cards + graph notes. */
export function buildNoteMap(vaultPath: string, arxivIds: string[]): Record<string, PaperNoteMapEntry> {
	const zk = join(vaultPath, "Zettelkasten");
	const kg = join(zk, "knowledge-graph");
	const map: Record<string, PaperNoteMapEntry> = {};
	for (const name of readdirSafe(zk)) {
		if (!name.startsWith("Paper - ") || !name.endsWith(".md")) continue;
		const md = readFileSync(join(zk, name), "utf8");
		const src = /sources:\s*\["arXiv:([^\]]+)"\]/.exec(md)?.[1];
		if (!src || !arxivIds.includes(src)) continue;
		const title = /^#\s+(.+?)\s*$/m.exec(md)?.[1] ?? name;
		const tags = (/^tags:\s*\[(.*?)\]/m.exec(md)?.[1] ?? "")
			.split(",")
			.map((t) => t.trim())
			.filter((t) => t && t !== "zettel");
		// find the graph note whose summary/content carries this title
		let graphNote = "";
		for (const g of readdirSafe(kg)) {
			if (!g.endsWith(".md")) continue;
			const gmd = readFileSync(join(kg, g), "utf8");
			if (gmd.includes(title)) {
				graphNote = `Zettelkasten/knowledge-graph/${g.replace(/\.md$/, "")}`;
				break;
			}
		}
		map[src] = { cardFile: name, title, graphNote, tags };
	}
	return map;
}

function readdirSafe(dir: string): string[] {
	try {
		return readdirSync(dir).filter((n) => !n.startsWith("."));
	} catch {
		return [];
	}
}

export interface TagRecallResult {
	cardsChecked: number;
	hits: number;
	recallAt5: number;
	misses: { title: string; top5: string[] }[];
}

/** 2c — query `retrieveRecords` with each card's tags; the card's graph note must appear in the top 5. */
export async function tagRecall(vaultPath: string, noteMap: Record<string, PaperNoteMapEntry>): Promise<TagRecallResult> {
	let hits = 0;
	const misses: { title: string; top5: string[] }[] = [];
	const entries = Object.values(noteMap).filter((e) => e.graphNote);
	for (const entry of entries) {
		const res = await retrieveRecords({ vaultPath, tags: entry.tags, topK: 5 });
		const top5 = res.cards.map((c) => (c as { path?: string; name?: string; id?: string }).path ?? (c as { name?: string }).name ?? (c as { id?: string }).id ?? "");
		const found = top5.some((p) => p && entry.graphNote.includes(p.split("/").pop() ?? "\u0000"));
		if (found) hits++;
		else misses.push({ title: entry.title, top5 });
	}
	return { cardsChecked: entries.length, hits, recallAt5: entries.length === 0 ? 0 : hits / entries.length, misses };
}

export interface MrrResult {
	questions: number;
	mrr: number;
	hitAt3: number;
	/** arxivIds whose note never ranked — empty when the index is healthy. */
	neverRanked: string[];
}

interface SemanticIndex {
	model: string;
	paths: string[];
	vectors: number[][];
}

function loadIndex(vaultPath: string, model = "text-embedding-bge-m3"): SemanticIndex {
	const stem = model.startsWith("text-embedding-") ? model : `text-embedding-${model}`;
	const p = join(vaultPath, ".knowledge-semantic", `${stem}.json`);
	if (!existsSync(p)) throw new Error(`semantic index missing: ${p}`);
	const idx = JSON.parse(readFileSync(p, "utf8")) as SemanticIndex;
	if (!Array.isArray(idx.paths) || !Array.isArray(idx.vectors)) throw new Error(`semantic index malformed: ${p}`);
	return idx;
}

function cosine(a: number[], b: number[]): number {
	let dot = 0;
	let na = 0;
	let nb = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i]! * b[i]!;
		na += a[i]! * a[i]!;
		nb += b[i]! * b[i]!;
	}
	return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

/** 2d — embed each question, cosine-rank the index, MRR of the paper's note. */
export async function retrievalMrr(
	vaultPath: string,
	golden: { arxivId: string; questions: { question: string; answerable: boolean }[] }[],
	noteMap: Record<string, PaperNoteMapEntry>,
): Promise<MrrResult> {
	return mrrAgainstIndex(loadIndex(vaultPath), golden, noteMap);
}

/** The finding-2 bite check: same MRR against an index with the paper notes' vectors REMOVED. */
export async function retrievalMrrAfterRemoval(
	vaultPath: string,
	golden: { arxivId: string; questions: { question: string; answerable: boolean }[] }[],
	noteMap: Record<string, PaperNoteMapEntry>,
): Promise<MrrResult> {
	const idx = loadIndex(vaultPath);
	const paperNotes = new Set(Object.values(noteMap).map((e) => e.graphNote));
	const filtered: SemanticIndex = { model: idx.model, paths: [], vectors: [] };
	for (let i = 0; i < idx.paths.length; i++) {
		if (!paperNotes.has(idx.paths[i]!)) {
			filtered.paths.push(idx.paths[i]!);
			filtered.vectors.push(idx.vectors[i] ?? []);
		}
	}
	return mrrAgainstIndex(filtered, golden, noteMap);
}

async function mrrAgainstIndex(
	idx: SemanticIndex,
	golden: { arxivId: string; questions: { question: string; answerable: boolean }[] }[],
	noteMap: Record<string, PaperNoteMapEntry>,
): Promise<MrrResult> {
	const cache = new Map<string, number[]>();
	const embedWithRetry = async (question: string): Promise<number[]> => {
		const cached = cache.get(question);
		if (cached) return cached;
		let lastError: Error | null = null;
		for (let attempt = 1; attempt <= 3; attempt++) {
			const qv = await embedQuery(question);
			if (qv) {
				cache.set(question, qv);
				return qv;
			}
			lastError = new Error(`embed attempt ${attempt} returned null`);
			await new Promise((r) => setTimeout(r, 250 * attempt));
		}
		throw lastError ?? new Error("embedQuery returned null — is the embedding server (LM Studio :1234) up?");
	};
	const recips: number[] = [];
	const neverRanked: string[] = [];
	for (const paper of golden) {
		const entry = noteMap[paper.arxivId];
		if (!entry || !entry.graphNote) continue;
		for (const q of paper.questions) {
			if (!q.answerable) continue;
			const qv = await embedWithRetry(q.question);
			const ranked = idx.paths
				.map((p, i) => ({ p, score: cosine(qv, idx.vectors[i] ?? []) }))
				.sort((a, b) => b.score - a.score);
			const rank = ranked.findIndex((r) => r.p === entry.graphNote) + 1;
			if (rank === 0) {
				neverRanked.push(paper.arxivId);
				recips.push(0);
			} else {
				recips.push(1 / rank);
			}
		}
	}
	const mrr = recips.length === 0 ? 0 : recips.reduce((a, b) => a + b, 0) / recips.length;
	const hitAt3 = recips.length === 0 ? 0 : recips.filter((r) => r > 0 && 1 / r <= 3).length / recips.length;
	return { questions: recips.length, mrr, hitAt3, neverRanked: [...new Set(neverRanked)] };
}
