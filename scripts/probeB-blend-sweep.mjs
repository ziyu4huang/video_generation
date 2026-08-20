// Phase 4 — blend weight sweep. final = α·(lexical rank score) + (1-α)·(cosine, min-max norm).
// Finds the α that maximizes recall with zero regression on the 21 baseline hits.
import { retrieveRecords } from "../bun-apps/s2-agent-ext-knowledge-card/src/retrieve.ts";
import { resolveVault } from "../bun-apps/s2-agent-ext-obsidian/extensions/obsidian.ts";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "..");
const v = (await resolveVault(REPO)).path;
const emb = JSON.parse(readFileSync(resolve(REPO, ".planning/recall-regime-change-eval/probes/probeB-card-embeddings.json"), "utf8"));
const cards = emb.cards, vecs = emb.vectors;
const evalQs = JSON.parse(readFileSync(resolve(REPO, "scripts/real-retrieval-eval.json"), "utf8")).queries;
const q2t = (q) => q.toLowerCase().replace(/[^a-z0-9-]+/g, " ").trim().split(/\s+/).filter((t) => t.length >= 3 && t.length <= 30).slice(0, 10);
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
const norm = (a) => Math.sqrt(dot(a, a)) || 1;
const cos = (a, b) => dot(a, b) / (norm(a) * norm(b));
const qres = await fetch("http://localhost:1234/v1/embeddings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "text-embedding-nomic-embed-text-v1.5", input: evalQs.map((q) => q.q) }) });
const qVecs = (await qres.json()).data.map((d) => d.embedding);
const normPath = (p) => p.replace(/\.md$/, ""); // retrieveRecords returns paths WITHOUT .md
const vecByPath = new Map(cards.map((c, ci) => [normPath(c.path), vecs[ci]]));
const cardByPath = new Map(cards.map((c) => [normPath(c.path), c]));
const semTop = (idx, k) => cards.map((c, ci) => ({ path: c.path, s: cos(qVecs[idx], vecs[ci]) })).sort((a, b) => b.s - a.s).slice(0, k);
const cm = (c, e) => `${c.path} ${c.id} ${c.title}`.toLowerCase().includes(e.toLowerCase());

// baseline hits
const baseHits = new Set();
for (let i = 0; i < evalQs.length; i++) {
  const r = await retrieveRecords({ vaultPath: v, folder: "Zettelkasten/knowledge-graph", tags: q2t(evalQs[i].q), topK: 4, bodyMatch: true, slugDom: true });
  if (r.cards.some((c) => cm(c, evalQs[i].expect))) baseHits.add(i);
}
console.log(`baseline hits: ${baseHits.size} (drift target 21)\n`);
console.log("α (lexical weight) sweep — final = α·lexRank + (1-α)·cosNorm:");
const best = [];
for (const alpha of [0.12, 0.15, 0.18, 0.20, 0.22, 0.25, 0.28]) {
  let hit = 0, regress = 0; const misses = [];
  for (let i = 0; i < evalQs.length; i++) {
    const lex = await retrieveRecords({ vaultPath: v, folder: "Zettelkasten/knowledge-graph", tags: q2t(evalQs[i].q), topK: 12, bodyMatch: true, slugDom: true });
    const sem = semTop(i, 12);
    const lexRank = new Map(lex.cards.map((c, r) => [normPath(c.path), (12 - r) / 12]));
    const candPaths = new Set([...lex.cards.map((c) => normPath(c.path)), ...sem.map((s) => normPath(s.path))]);
    // only score candidates we have vectors for (guard against any path drift)
    const scoreable = [...candPaths].filter((p) => vecByPath.has(p));
    const cosines = scoreable.map((p) => cos(qVecs[i], vecByPath.get(p)));
    const cmin = Math.min(...cosines), cmax = Math.max(...cosines), crange = cmax - cmin || 1;
    const scored = scoreable.map((p) => {
      const lr = lexRank.has(p) ? lexRank.get(p) : 0;
      const cn = (cos(qVecs[i], vecByPath.get(p)) - cmin) / crange;
      return { c: cardByPath.get(p), s: alpha * lr + (1 - alpha) * cn };
    }).sort((a, b) => b.s - a.s).slice(0, 4);
    const isHit = scored.some((x) => cm(x.c, evalQs[i].expect));
    if (isHit) hit++; else misses.push(evalQs[i].expect);
    if (baseHits.has(i) && !isHit) regress++;
  }
  console.log(`  α=${alpha.toFixed(2)}: recall ${hit}/25 (${(hit / 25).toFixed(2)})  regress=${regress}  misses:[${misses.join(", ") || "none"}]`);
  best.push({ alpha, hit, regress });
}
const winners = best.filter((b) => b.regress === 0).sort((a, b) => b.hit - a.hit);
console.log(`\nBest zero-regress: α=${winners[0]?.alpha} → ${winners[0]?.hit}/25 (${((winners[0]?.hit ?? 0) / 25).toFixed(2)})`);
