// Phase 4 — Probe B: semantic seed via LOCAL nomic-embed-text-v1.5 (genuinely NEW
// regime — different model from the RETIRED vault-mind multilingual). Embeddings can
// bridge symptom→cause gaps that keyword expansion cannot ("black image" ≈ "VAE decode
// range" via vector nearness, no exact-vocab guessing).
//
// Sub-tests through the faithful harness:
//   B1. PURE semantic top-4 (cosine only) — isolates the raw embedding signal.
//   B2. BLEND (lexical top-12 ∪ semantic top-12, rerank by cosine) — realistic ship path.
// Drift-guard (real lexical retrieveRecords) must reproduce 0.84 in every run.

import { runGate, q2t } from "./recall-eval-harness.mjs";
import { retrieveRecords } from "../bun-apps/s2-agent-ext-knowledge-card/src/retrieve.ts";
import { resolveVault } from "../bun-apps/s2-agent-ext-obsidian/extensions/obsidian.ts";
import { resolve } from "node:path";
import { writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";

const REPO = resolve(import.meta.dirname, "..");
const FOLDER = "Zettelkasten/knowledge-graph";
const EMBED_CACHE = resolve(REPO, ".planning/recall-regime-change-eval/probes/probeB-card-embeddings.json");
const MODEL = "text-embedding-nomic-embed-text-v1.5";
const vault = (await resolveVault(REPO)).path;
const folderPath = resolve(vault, FOLDER);

// --- read cards: id/title/tags/body-snippet from frontmatter + body ---
function readCards() {
  const cards = [];
  for (const name of readdirSync(folderPath)) {
    if (!name.endsWith(".md")) continue;
    const raw = readFileSync(resolve(folderPath, name), "utf8");
    const fmM = raw.match(/^---\n([\s\S]*?)\n---/);
    const id = fmM?.[1].match(/^id:\s*(.+)$/m)?.[1]?.trim()?.replace(/"/g, "") ?? name.replace(/\.md$/, "");
    const title = raw.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? id;
    const tagsM = fmM?.[1].match(/^tags:\s*\[(.*?)\]/m);
    const tags = tagsM ? tagsM[1].split(",").map((s) => s.trim().replace(/"/g, "")) : [];
    const body = raw.replace(/^---\n[\s\S]*?\n---/, "").slice(0, 800); // body snippet
    const text = `${title}. ${tags.join(" ")}. ${body}`.replace(/\s+/g, " ").trim().slice(0, 1000);
    cards.push({ id, path: `${FOLDER}/${name}`, title, tags, text });
  }
  return cards;
}

// --- embed via LM Studio (batched) ---
async function embed(texts, batchSize = 32) {
  const out = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const res = await fetch("http://localhost:1234/v1/embeddings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, input: batch }),
    });
    const j = await res.json();
    for (const d of j.data) out.push(d.embedding);
    process.stdout.write(`\r  embedded ${Math.min(i + batchSize, texts.length)}/${texts.length}`);
  }
  console.log("");
  return out;
}

const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
const norm = (a) => Math.sqrt(dot(a, a)) || 1;
const cosine = (a, b) => dot(a, b) / (norm(a) * norm(b));

// --- build or load card embeddings ---
let cards = readCards();
let cardVecs;
if (existsSync(EMBED_CACHE)) {
  console.log("(using cached card embeddings)");
  const c = JSON.parse(readFileSync(EMBED_CACHE, "utf8"));
  cards = c.cards;
  cardVecs = c.vectors;
} else {
  console.log(`embedding ${cards.length} cards with ${MODEL}...`);
  cardVecs = await embed(cards.map((c) => c.text));
  writeFileSync(EMBED_CACHE, JSON.stringify({ model: MODEL, cards, vectors: cardVecs }));
  console.log(`(cached ${cards.length} card embeddings, dim ${cardVecs[0].length})`);
}

// --- embed the 25 eval queries ---
const evalQs = JSON.parse(readFileSync(resolve(REPO, "scripts/real-retrieval-eval.json"), "utf8")).queries;
console.log("embedding 25 eval queries...");
const qVecs = await embed(evalQs.map((q) => q.q));

// B1 — PURE semantic top-4 (cosine only). candidateRetrieve ignores tags, ranks by vector.
const semanticTop = (idx, k) => {
  const scored = cards.map((c, ci) => ({ c, s: cosine(qVecs[idx], cardVecs[ci]) }));
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, k).map((x) => x.c);
};

console.log("\n=== B1: PURE semantic top-4 (nomic cosine) ===");
await runGate({
  label: "Probe B1 — pure semantic top-4 (nomic cosine)",
  candidateRetrieve: async (_q, idx) => semanticTop(idx, 4),
  cost: { note: "card embeddings precomputed once (563); query embed ~ms warm; cosine over 563 = sub-ms", model: MODEL },
});

// B2 — BLEND: lexical top-12 (real retrieveRecords) ∪ semantic top-12, rerank by cosine.
console.log("\n=== B2: BLEND lexical top-12 ∪ semantic top-12, rerank by cosine ===");
const vecByPath = new Map(cards.map((c, ci) => [c.path, cardVecs[ci]]));
await runGate({
  label: "Probe B2 — blend lexical∪semantic rerank-by-cosine",
  candidateRetrieve: async (q, idx) => {
    const lex = await retrieveRecords({ vaultPath: vault, folder: FOLDER, tags: q2t(q), topK: 12, bodyMatch: true, slugDom: true });
    const sem = semanticTop(idx, 12);
    const seen = new Map(); // path -> card
    for (const c of [...lex.cards, ...sem]) if (!seen.has(c.path)) seen.set(c.path, c);
    const ranked = [...seen.values()].map((c) => ({ c, s: vecByPath.has(c.path) ? cosine(qVecs[idx], vecByPath.get(c.path)) : -1 }));
    ranked.sort((a, b) => b.s - a.s);
    return ranked.slice(0, 4).map((x) => x.c);
  },
  cost: { note: "lexical retrieve (59ms) + cosine rerank over ≤24 candidates (sub-ms); query embed ~ms warm", model: MODEL },
});
