/**
 * Planner diagnostic (read-only) — decompose the production-lane MRR 0.312
 * on golden-v2 against the REAL vault + its bge-m3 vector cache, and measure
 * counterfactuals for the two proposed levers (CJK bigrams; absolute lexical
 * terms). Replicates retrieveRecords' flat path EXACTLY (bodyMatch+slugDom+
 * semantic, buildRetrieveOptions defaults, KCARD_HIER_DEFAULT=0) with private
 * helpers copied verbatim from src/retrieve.ts. NOT a receipt — the canonical
 * measure stays tests/production.test.ts on the converged sandbox.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { inferQueryTags } from "../../bun-apps/s2-agent-ext-knowledge-card/src/host-fns.ts";
import { readCardMeta } from "../../bun-apps/s2-agent-ext-knowledge-card/src/card-format.ts";

const REPO = new URL(".", import.meta.url).pathname.replace(/\/arc-plan-kcard-retrieval-lift-2\/?$/, "");
const VAULT = join(REPO, "vaults_root", "s2-agent-vault");
const KG = join(VAULT, "Zettelkasten", "knowledge-graph");
const GOLDEN = join(REPO, "bun-apps", "bench-kcards", "fixtures", "golden-v2");
const CACHE = join(VAULT, ".knowledge-semantic", "text-embedding-bge-m3.json");
const ALPHA = 0.18;
const BETA = 0.2;

// ---- verbatim copies of retrieve.ts private helpers (plus bigram extension) ----
const BODY_STOP = new Set([
	"the", "and", "for", "are", "but", "not", "you", "all", "can", "her", "was",
	"one", "our", "out", "day", "get", "has", "him", "his", "how", "man", "new",
	"now", "old", "see", "two", "way", "who", "did", "its", "let", "put", "say",
	"she", "too", "use", "from", "this", "that", "with", "have", "here", "what",
	"when", "where", "which", "will", "your", "他", "的", "是", "了",
	"from", "into", "about", "than", "then", "been", "being", "its", "all", "any",
	"some", "out", "off", "over", "get", "got", "run", "set", "put", "new", "old",
	"one", "two", "use", "used", "using",
]);
const SLUG_STOP = new Set([
	...BODY_STOP,
	"auto", "memory", "gotcha", "lever", "avoid", "pattern", "metric",
	"false", "positive", "note", "card", "zettel", "self", "improve", "reference",
]);
const SLUG_DOM_THRESHOLD = 3;

const cjkBigrams = (s: string): string[] => {
	const out: string[] = [];
	for (const run of s.match(/[\u3400-\u9fff\uf900-\ufaff]+/g) ?? []) {
		if (run.length === 1) out.push(run);
		else for (let i = 0; i + 1 < run.length; i++) out.push(run.slice(i, i + 2));
	}
	return out;
};
const asciiTokens = (s: string): string[] =>
	s.toLowerCase().replace(/[^a-z0-9-]+/g, " ").trim().split(/\s+/).filter(Boolean);

/** V1 tokenizer: current ASCII path verbatim + CJK bigrams appended (dedup), capped. */
function inferQueryTagsV1(query: string, cap = 24): string[] {
	const ascii = inferQueryTags(query);
	const seen = new Set(ascii);
	const bigrams = cjkBigrams(query).filter((b) => !seen.has(b) && seen.add(b));
	return [...ascii, ...bigrams].slice(0, cap);
}
function tokenSetOf(body: string, bigram: boolean): Set<string> {
	const s = new Set(
		asciiTokens(body).filter((t) => t.length >= 3 && !BODY_STOP.has(t)),
	);
	if (bigram) for (const b of cjkBigrams(body)) s.add(b);
	return s;
}
function overlapOf(queryTags: string[], against: Set<string>): number {
	let n = 0;
	for (const t of queryTags) {
		const isCjk = /[\u3400-\u9fff]/.test(t);
		if (!isCjk && (t.length < 3 || BODY_STOP.has(t))) continue;
		if (against.has(t)) n++;
	}
	return n;
}
function bodyTokenOverlap(content: string, queryTags: string[], bigram: boolean): number {
	const body = content.replace(/^---\n[\s\S]*?\n---/, "");
	return overlapOf(queryTags, tokenSetOf(body, bigram));
}
function slugTokenOverlap(slug: string, queryTags: string[]): number {
	const slugSet = new Set(slug.toLowerCase().split("-").filter((t) => t.length >= 3 && !SLUG_STOP.has(t)));
	return overlapOf(queryTags, slugSet);
}
function sharedTags(queryTags: string[], metaTags: Set<string>): number {
	let n = 0;
	for (const t of queryTags) if (t !== "zettel" && metaTags.has(t)) n++;
	return n;
}
const cosine = (a: number[], b: number[]) => {
	let d = 0, na = 0, nb = 0;
	for (let i = 0; i < a.length; i++) { d += a[i]! * b[i]!; na += a[i]! ** 2; nb += b[i]! ** 2; }
	return d / (Math.sqrt(na) * Math.sqrt(nb) || 1);
};
const minMaxNorm = (vals: number[]) => {
	if (!vals.length) return [];
	const min = Math.min(...vals), max = Math.max(...vals), range = max - min || 1;
	return vals.map((v) => (v - min) / range);
};

// ---- load cards (replicating the retrieveRecords scan) ----
interface Card {
	slug: string; id: string; tags: Set<string>; hasCallouts: boolean;
	asciiBody: Set<string>; bigramBody: Set<string>; slugTokens: Set<string>;
	scored: boolean;
}
const cards: Card[] = [];
const contents = new Map<string, string>();
for (const name of readdirSync(KG).sort()) {
	if (!name.endsWith(".md") || /^agg-L\d+-\d+\.md$/.test(name)) continue;
	const abs = join(KG, name);
	const meta = readCardMeta(abs);
	if (!meta) continue;
	const content = readFileSync(abs, "utf8");
	contents.set(name.slice(0, -3), content);
	if (/status:\s*(retired|superseded)/.test(content)) continue;
	cards.push({
		slug: name.slice(0, -3),
		id: meta.source_id ?? name.slice(0, -3),
		tags: meta.tags,
		hasCallouts: meta.hasCallouts,
		asciiBody: tokenSetOf(content.replace(/^---\n[\s\S]*?\n---/, ""), false),
		bigramBody: tokenSetOf(content.replace(/^---\n[\s\S]*?\n---/, ""), true),
		slugTokens: new Set(name.toLowerCase().slice(0, -3).split("-").filter((t) => t.length >= 3 && !SLUG_STOP.has(t))),
		scored: false,
	});
}

// ---- vector cache + query embedding ----
const cache = JSON.parse(readFileSync(CACHE, "utf8")) as { model: string; paths: string[]; vectors: number[][] };
const vecByPath = new Map<string, number[]>();
cache.paths.forEach((p, i) => vecByPath.set(p, cache.vectors[i]!));

async function embedQueries(qs: string[]): Promise<number[][]> {
	const out: number[][] = [];
	for (let i = 0; i < qs.length; i += 16) {
		const res = await fetch("http://127.0.0.1:1234/v1/embeddings", {
			method: "POST", headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "text-embedding-bge-m3", input: qs.slice(i, i + 16) }),
		});
		const j = await res.json();
		for (const d of j.data) out.push(d.embedding);
		process.stdout.write(`\r  embedded ${Math.min(i + 16, qs.length)}/${qs.length}`);
	}
	console.log("");
	return out;
}

// ---- golden set + note map (buildNoteMap replica) ----
const golden = readdirSync(GOLDEN).filter((f) => f.endsWith(".json")).sort().map((f) => {
	const g = JSON.parse(readFileSync(join(GOLDEN, f), "utf8"));
	return { ...g, arxivId: g.arxivId.replace(/^arXiv:/, "") };
});
const noteMap: Record<string, string> = {};
for (const g of golden) {
	const title = g.title as string;
	const hit = cards.find((c) => (contents.get(c.slug) ?? "").includes(title));
	noteMap[g.arxivId] = hit ? `Zettelkasten/knowledge-graph/${hit.slug}` : "";
}
const questions = golden.flatMap((g) =>
	g.questions.filter((q: { answerable: boolean }) => q.answerable)
		.map((q: { question: string }) => ({ q: q.question, arxivId: g.arxivId, target: noteMap[g.arxivId] })),
);
console.log(`cards=${cards.length} questions=${questions.length} mappedTargets=${Object.values(noteMap).filter(Boolean).length}/13`);

const qvecs = await embedQueries(questions.map((x) => x.q));

// ---- lane simulation ----
function simulate(qv: number[], queryTags: string[], targetPath: string, opts: {
	bigramBody: boolean; absSlug: boolean; absBody: boolean; pureCosine: boolean;
}) {
	// lexical scan
	const scored: { id: string; path: string; _score: number }[] = [];
	const per = new Map<string, { shared: number; bodyOv: number; slugOv: number }>();
	for (const c of cards) {
		const shared = sharedTags(queryTags, c.tags);
		const slugOv = slugTokenOverlap(c.slug, queryTags);
		if (shared <= 0 && !(slugOv > 0)) continue;
		const content = contents.get(c.slug)!;
		const bodyOv = bodyTokenOverlap(content, queryTags, opts.bigramBody);
		if (shared <= 0 && bodyOv <= 0 && slugOv <= 0) continue;
		per.set(c.slug, { shared, bodyOv, slugOv });
		const callout = c.hasCallouts ? 0.5 : 0;
		scored.push({
			id: c.id, path: `Zettelkasten/knowledge-graph/${c.slug}`,
			_score: slugOv >= SLUG_DOM_THRESHOLD ? slugOv * 4 + callout : shared * 2 + bodyOv + callout,
		});
	}
	scored.sort((a, b) => b._score - a._score || a.id.localeCompare(b.id));
	const lexPool = scored.slice(0, 12);
	// semantic top-12
	const sem = [...vecByPath.entries()]
		.map(([p, v]) => ({ p, cos: cosine(qv, v) }))
		.sort((a, b) => b.cos - a.cos);
	const semTop = sem.slice(0, 12).map((s) => s.path);
	const targetRankCos = sem.findIndex((s) => s.p === targetPath) + 1;
	// union + blend
	const union = [...new Set([...lexPool.map((c) => c.path), ...semTop])];
	const cosNorm = minMaxNorm(union.map((p) => {
		const v = vecByPath.get(p);
		return v ? cosine(qv, v) : -1;
	}));
	const lexRank = new Map(lexPool.map((c, r) => [c.path, (12 - r) / 12]));
	const blended = union
		.map((p, i) => {
			const c = per.get(p.split("/").pop()!) ?? { shared: 0, bodyOv: 0, slugOv: 0 };
			let s = opts.pureCosine
				? cosNorm[i]!
				: ALPHA * (lexRank.get(p) ?? 0) + (1 - ALPHA) * (cosNorm[i] ?? 0);
			if (opts.absSlug && c.slugOv >= 3) s += BETA * (Math.min(c.slugOv, 3) / 3);
			if (opts.absBody) s += BETA * (Math.min(c.bodyOv, 3) / 3);
			return { p, s, id: p.split("/").pop()! };
		})
		.sort((a, b) => b.s - a.s || a.id.localeCompare(b.id));
	const rank = blended.findIndex((x) => x.p === targetPath) + 1;
	return {
		rank, targetRankCos, lexPoolSize: scored.length,
		inLexPool: lexPool.some((c) => c.path === targetPath),
		inSemTop: semTop.includes(targetPath),
		targetLexRank: scored.findIndex((c) => c.path === targetPath) + 1,
		targetShared: per.get(targetPath.split("/").pop() ?? "")?.shared ?? 0,
		targetBodyOv: per.get(targetPath.split("/").pop() ?? "")?.bodyOv ?? 0,
	};
}

// ---- variants ----
const variants = {
	V0_current: { bigramBody: false, absSlug: false, absBody: false, pureCosine: false },
	V0_pureCos: { bigramBody: false, absSlug: false, absBody: false, pureCosine: true },
	V1_bigram: { bigramBody: true, absSlug: false, absBody: false, pureCosine: false },
	V2_bigram_absSlug: { bigramBody: true, absSlug: true, absBody: false, pureCosine: false },
	V3_bigram_absSlug_absBody: { bigramBody: true, absSlug: true, absBody: true, pureCosine: false },
	V4_absOnly_noBigram: { bigramBody: false, absSlug: true, absBody: true, pureCosine: false },
} as const;

const rows = questions.map((x, i) => {
	const tagsV0 = inferQueryTags(x.q);
	const tagsV1 = inferQueryTagsV1(x.q);
	const isPureZh = tagsV0.length === 0;
	const rec: Record<string, unknown> = {
		question: x.q.slice(0, 60), arxivId: x.arxivId, lang: isPureZh ? "zh" : tagsV1.length > tagsV0.length ? "mixed+cjk" : "en-ish",
		nTagsV0: tagsV0.length, nTagsV1: tagsV1.length,
	};
	for (const [name, o] of Object.entries(variants)) {
		const tags = name === "V0_current" || name === "V0_pureCos" || name === "V4_absOnly_noBigram" ? tagsV0 : tagsV1;
		const r = simulate(qvecs[i]!, tags, x.target, o as never);
		rec[name] = { rank: r.rank, cos: r.targetRankCos, lexRank: r.targetLexRank, inSemTop: r.inSemTop, shared: r.targetShared, bodyOv: r.targetBodyOv };
	}
	return rec;
});

const summary = (key: string) => {
	const rs = rows.map((r) => (r[key] as { rank: number }).rank);
	const mrr = rs.reduce((a, b) => a + (b ? 1 / b : 0), 0) / rs.length;
	const hit3 = rs.filter((r) => r && r <= 3).length / rs.length;
	const zero = rs.filter((r) => r === 0).length;
	return `${key}: MRR=${mrr.toFixed(3)} hit@3=${hit3.toFixed(3)} rank0=${zero}/${rs.length}`;
};
console.log("== measured against real-vault cache (planning diagnostic; canonical = sandbox production lane) ==");
for (const k of Object.keys(variants)) console.log(summary(k));
const zh = rows.filter((r) => r.lang === "zh");
const en = rows.filter((r) => r.lang !== "zh");
console.log(`lang split: pure-zh(no ASCII tag)=${zh.length}, with-ASCII=${en.length}`);
console.log(`pure-zh V0 MRR=${(zh.reduce((a, r) => a + ((r.V0_current as { rank: number }).rank ? 1 / (r.V0_current as { rank: number }).rank : 0), 0) / zh.length).toFixed(3)}`);
console.log(`with-ASCII V0 MRR=${(en.reduce((a, r) => a + ((r.V0_current as { rank: number }).rank ? 1 / (r.V0_current as { rank: number }).rank : 0), 0) / en.length).toFixed(3)}`);
const cosRanks = rows.map((r) => (r.V0_current as { cos: number }).cos);
console.log(`target cosine-rank distribution: ≤3:${cosRanks.filter((c) => c > 0 && c <= 3).length} ≤12:${cosRanks.filter((c) => c > 0 && c <= 12).length} ≤50:${cosRanks.filter((c) => c > 0 && c <= 50).length} >50:${cosRanks.filter((c) => c > 50).length}`);
await Bun.write(join(REPO, "output", "arc-plan-kcard-retrieval-lift-2", "diagnostic-rows.json"), JSON.stringify(rows, null, 1));
