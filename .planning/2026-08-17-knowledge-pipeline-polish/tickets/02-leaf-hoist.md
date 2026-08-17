## Question
L2: hoist embedder/cosine + fence-split leaves to @repo/pi-agent-core-interface and delete hermes-side mirrors?
type: task
blocked by: (none)
Detail per spec: move Embedder type + LM Studio /v1/embeddings fetch + cosine (~60–100) and fence-split (~50) into core-interface; hermes re-imports from core-interface (legal edge; hermes→zk stays seam-only); delete hermes mirrors (store/surreal/embedder.ts 101; card-vectors-cache.ts:59 cosineSimilarity; frontmatter-codec fence-split portion). Behavior tests move/assert unchanged. Gates: core-interface + hermes + zk suites + dep-guard.

## Resolution
DONE (a/b/c). a: leaf hoisted to @repo/pi-agent-core-interface src/embedding-leaf.ts (+11 tests, yaml dep declared — already in workspace lock). b: zk semantic.ts delegates (re-exports leaf; keeps blend engine+cache). c: hermes mirrors DELETED (store/surreal/embedder.ts 101, store/frontmatter-codec.ts 34) + 16 importers repointed + card-vectors-cache local cosineSimilarity → leaf import + sole-source gate re-pointed to the core-interface leaf. Net files: hermes −2, core-interface +2 (leaf+test). Gates: core-interface 37/0, zk 462/0 tsc clean, hermes 1620/0 tsc clean.
