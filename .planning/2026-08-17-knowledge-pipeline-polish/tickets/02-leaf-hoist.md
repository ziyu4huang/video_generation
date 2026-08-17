## Question
L2: hoist embedder/cosine + fence-split leaves to @repo/pi-agent-core-interface and delete hermes-side mirrors?
type: task
blocked by: (none)
Detail per spec: move Embedder type + LM Studio /v1/embeddings fetch + cosine (~60–100) and fence-split (~50) into core-interface; hermes re-imports from core-interface (legal edge; hermes→zk stays seam-only); delete hermes mirrors (store/surreal/embedder.ts 101; card-vectors-cache.ts:59 cosineSimilarity; frontmatter-codec fence-split portion). Behavior tests move/assert unchanged. Gates: core-interface + hermes + zk suites + dep-guard.
