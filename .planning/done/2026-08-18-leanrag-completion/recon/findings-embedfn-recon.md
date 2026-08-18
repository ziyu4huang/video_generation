# Micro-recon: embedFn construction + card-body embed site

Task: locate (a) the exact file:line where a knowledge-card BODY string is
embedded on ingest (insertion point for `augmentEmbedText(body, entitySummary)`),
and (b) whether the query side (`embedQuery`) shares that path.

## grep -rn 'embedFn' results (verbatim)

hermes-memory:
- `bun-apps/pi-agent-ext-hermes-memory/src/composition/tools.ts:60` —
  `embedFn: async (texts: string[]) => defaultEmbedder({ baseUrl: ... })(texts, "text-embedding-nomic-embed-text-v1.5")`
  — constructed here and passed into `registerKnowledgeIngestTool` opts
  (used only for post-ingest hierarchy build, NOT for body embedding).
- `src/handlers/hierarchy-build.ts:24,53,61,67` — embedFn injection into hierarchy build.

knowledge-card:
- `bun-apps/pi-agent-ext-knowledge-card/src/hierarchy.ts:74` (type),
  `hierarchy.ts:196` — `const vectors = texts.length > 0 ? await input.embedFn(texts) : [];`
  (hierarchy clustering path, not the ingest body embed site).
- `src/hierarchy-build.ts:40,186` — embedFn threaded through.

## Findings

(a) **Card body → embedder site**: NOT yet pinned. The body-embed site for
knowledge-card ingest was not reached before budget exhaustion. Candidates not
yet inspected: `knowledge-ingest-tool.ts` (registerKnowledgeIngestTool in
hermes-memory/src/tools/), `buildKnowledgeSemanticOpts`'s `embedder:` factory at
`bun-apps/pi-agent-ext-hermes-memory/src/composition/knowledge-semantic.ts:76-83`
(`return defaultEmbedder({ baseUrl: base })` — this is the embedder handed to
the semantic vector store). The ingest body embed likely lives in the vector
upsert path (vector-store.ts / semantic-search.ts) or inside the ingest tool.
Next step: `grep -n 'embed' bun-apps/pi-agent-ext-hermes-memory/src/tools/knowledge-ingest-tool.ts`
and `src/store/surreal/vector-store.ts`.

(b) **Query side**: does NOT share the embedFn path above. `embedQuery` is a
separate helper from `@repo/pi-agent-core-interface`, called at
`bun-apps/pi-agent-ext-hermes-memory/src/store/semantic-search.ts:314`
(`const qvec = await embedQuery(queryText, { model: modelId, embedder })`)
using the embedder factory from `knowledge-semantic.ts:76`. The `embedFn` in
`composition/tools.ts:60` serves only the LeanRAG hierarchy build (clustering),
while query embedding goes through `embedQuery` + the semantic opts embedder.
Both ultimately wrap `defaultEmbedder` (LM Studio) but via distinct call sites —
an `augmentEmbedText` insertion at the ingest site would NOT automatically
apply to queries.

Status: recon incomplete on (a); (b) answered with file:line evidence above.
