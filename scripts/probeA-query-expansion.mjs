// Phase 3 — Probe A: LLM query-expansion through the faithful gate.
// For each of the 25 eval queries, gemma expands query -> topic/root-cause keywords
// (extracted from content OR reasoning_content — gemma is a thinking model). The
// candidateRetrieve runs REAL retrieveRecords with tags = original ∪ expansion.
// GATE (from harness): drift-guard ✓ + ≥0.88 recall + zero-regression.

import { runGate, q2t } from "./recall-eval-harness.mjs";
import { retrieveRecords } from "../bun-apps/s2-agent-ext-knowledge-card/src/retrieve.ts";
import { resolveVault } from "../bun-apps/s2-agent-ext-obsidian/extensions/obsidian.ts";
import { resolve } from "node:path";
import { writeFileSync, readFileSync, existsSync } from "node:fs";

const REPO = resolve(import.meta.dirname, "..");
const CACHE = resolve(REPO, ".planning/recall-regime-change-eval/probes/probeA-expansions.json");
const FOLDER = "Zettelkasten/knowledge-graph";
const MODEL = "google/gemma-4-26b-a4b-qat";

// Instruction-echo + common-word stopwords (gemma echoes the prompt — filter hard).
const STOP = new Set(["the","and","for","with","that","this","are","was","were","only","into","about","from","each","then","than","when","what","which","have","has","they","them","their","will","can","may","might","must","all","any","some","out","off","over","your","you","not","but","its","our","his","her","she","him","get","got","run","set","put","new","old","one","two","use","used","using","also","would","should","could","keyword","keywords","lowercase","comma","separated","reply","list","term","terms","topic","root","cause","search","developer","user","query","goal","constraint","type","types","synonym","synonyms","card","title","nothing","only","problem","suspected","likely","framework","mechanism","behavior","unexpected","goalgenerate","goalextract","goallist","topicterms","causeterms","cardtitle","etc","items","output","format","question","answer","description","above","below","backticks","highlight","exactly"]);

// Extract keywords from gemma's response. gemma is a thinking model: the real
// high-signal keywords are BACKTICK-quoted in reasoning_content (e.g. `pytest`,
// `cache`, `stale`), while prose echoes instructions. Prioritize backtick terms,
// then individual prose words; filter instruction-echoes + common words hard.
function parseKeywords(text) {
  if (!text) return [];
  const tokens = [];
  // 1. backtick-quoted phrases first (high signal — gemma marks real keywords)
  for (const m of text.matchAll(/`([^`]+)`/g)) {
    for (const w of m[1].split(/[^a-zA-Z0-9]+/)) tokens.push(w.toLowerCase());
  }
  // 2. individual prose words (fallback breadth)
  for (const w of text.split(/[^a-zA-Z0-9]+/)) tokens.push(w.toLowerCase());
  const out = [];
  for (const w of tokens) {
    if (w.length >= 3 && w.length <= 24 && !STOP.has(w) && !/^\d/.test(w) && !out.includes(w)) out.push(w);
  }
  return out.slice(0, 15);
}

async function expand(query) {
  const body = {
    model: MODEL,
    messages: [
      {
        role: "user",
        content:
          `A developer searches a knowledge base with: "${query}". ` +
          `List 8-12 lowercase comma-separated search KEYWORDS (topic terms + likely root-cause terms + synonyms a card TITLE would contain). ` +
          `Reply with ONLY the comma-separated keywords, nothing else.`,
      },
    ],
    temperature: 0.2,
    max_tokens: 400, // thinking model — leave room for reasoning + final content
  };
  const res = await fetch("http://localhost:1234/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await res.json();
  const m = j.choices?.[0]?.message ?? {};
  const kws = parseKeywords(m.content || "") ;
  const fromReasoning = parseKeywords(m.reasoning_content || "");
  // union: prefer content, backfill from reasoning; keep original query tokens too
  const merged = [...new Set([...kws, ...fromReasoning])].slice(0, 12);
  return { keywords: merged, content: m.content || "", reasoning: m.reasoning_content || "", tokens: j.usage };
}

async function buildExpansions() {
  if (existsSync(CACHE)) {
    console.log(`(using cached expansions: ${CACHE})`);
    return JSON.parse(readFileSync(CACHE, "utf8"));
  }
  const queries = JSON.parse(readFileSync(resolve(REPO, "scripts/real-retrieval-eval.json"), "utf8")).queries;
  const expansions = {};
  let totTok = 0;
  for (let i = 0; i < queries.length; i++) {
    const e = await expand(queries[i].q);
    expansions[i] = { q: queries[i].q, ...e };
    totTok += e.tokens?.total_tokens ?? 0;
    console.log(`  [${i}] "${queries[i].q.slice(0, 45)}..." -> ${e.keywords.slice(0, 6).join(", ")}${e.keywords.length > 6 ? "…" : ""}`);
  }
  writeFileSync(CACHE, JSON.stringify(expansions, null, 2));
  console.log(`(cached ${Object.keys(expansions).length} expansions, ${totTok} tokens total)`);
  return expansions;
}

const expansions = await buildExpansions();
const vault = (await resolveVault(REPO)).path;

// candidateRetrieve: tags = ORIGINAL query tokens ∪ gemma expansion, real retrieveRecords.
const candidateRetrieve = async (q, idx) => {
  const base = q2t(q);
  const extra = expansions[idx]?.keywords ?? [];
  const tags = [...new Set([...base, ...extra])].slice(0, 20);
  return (
    await retrieveRecords({ vaultPath: vault, folder: FOLDER, tags, topK: 4, bodyMatch: true, slugDom: true })
  ).cards;
};

await runGate({
  label: "Probe A — gemma query-expansion (tags ∪ expansion, bodyMatch+slugDom)",
  candidateRetrieve,
  cost: { note: "expansion pre-computed + cached; steady-state = tag-lookup ms (see Phase 1 latency)", perQueryExpansionTokens: "~265" },
});
