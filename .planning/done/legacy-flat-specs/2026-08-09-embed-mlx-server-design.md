# Local Embedding Server — Phase 1 Swift MLX Production Server

## Context

Phase 0 (`.planning/specs/2026-08-08-embedding-server-benchmark-design.md`,
shipped in PR #1128) benchmarked LM Studio, llama.cpp, and MLX-native (Python,
via `mlx-embeddings`) across three candidate models on two real corpora
(this repo's `docs/`, and an external Obsidian vault with mixed
Chinese/English content).

Results:

- **BGE-M3 via LM Studio** was the best-quality combination on both corpora
  (repo-docs: recall@5=0.903, mrr=0.782; study-news: recall@5=0.793,
  mrr=0.692).
- **MLX-native was consistently ~2x faster** on single-call latency, but
  showed a real, persistent recall gap vs. LM Studio for BGE-M3
  (repo-docs: recall@5=0.706–0.739 depending on run; study-news:
  recall@5=0.601–0.606). The original write-up guessed this was a hardcoded
  `max_length=512` truncation bug in the Python harness. That hypothesis was
  tested directly (made `max_length` per-model configurable, re-ran BGE-M3 at
  its real 8192-token context on both corpora) and **falsified** — recall was
  unchanged within noise. The true cause is undetermined, most likely an
  implementation/pooling/quantization difference between the
  `mlx-community/bge-m3-mlx-8bit` conversion and whatever LM Studio's backend
  uses internally.
- A second, real bug surfaced during that investigation:
  `mlx_native.embed_batch` padded and ran attention over an entire input list
  in one call. At the corrected context length, embedding all 1683
  study-news chunks in one un-batched call caused a Metal OOM (~107GB
  allocation attempt). Fixed with fixed-size micro-batching (32) in the
  Python harness — this is a hard requirement for any production embedding
  server handling arbitrary-sized input, not just a harness quirk.
- llama.cpp produced zero usable comparative data across every run (the
  standalone `llama-server` process was unstable under real load). Given the
  production target is Swift MLX, this was not retested further.
- Repo precedent (`project_ltx_swift_native_port` memory): Python is
  dev-only, Swift-native is production, repo-wide.

**Decision going into Phase 1**: build a self-built Swift MLX embedding
server rather than launchd-wrapping LM Studio, even though LM Studio
currently measures higher retrieval quality for BGE-M3. Rationale: this is
the original goal (a self-built, controllable, native MLX production
service, not a dependency on a third-party GUI app's black-box backend);
it matches the repo's Swift-native-production convention; and
`mlx-swift-lm`'s `MLXEmbedders` library already has `BAAI/bge-m3`
pre-registered (confirmed via its `embeddings.md` reference doc), so this is
wrapping an existing model implementation, not reimplementing BGE-M3's
architecture from scratch. The BGE-M3 quality gap vs. LM Studio is a known,
accepted, currently-unexplained limitation — not a blocker for Phase 1.

## Scope

Build a standalone Swift package that serves an OpenAI-compatible
`POST /v1/embeddings` endpoint over BGE-M3, running as a macOS launchd
background service. Matches the original requirements gathered in Phase 0's
brainstorming: general local embedding API for other tools, RAG/document
retrieval, and semantic search over this repo's own content.

Out of scope for this spec (see "Out of scope" below): closing the BGE-M3
quality gap, llama.cpp, multi-model support, authentication.

## Architecture

New standalone Swift package, following the repo's existing `swift/*-director`
package conventions (`swift-tools-version: 6.0`, `swift-argument-parser` CLI)
but named for what it actually is — an inference server, not a director:

```
swift/embed-mlx-server/
  Package.swift
  Sources/
    EmbedMLXServer/              # library target
      ModelLoader.swift          # wraps MLXEmbedders.load(hfRepo) -> (model, tokenizer);
                                  # loaded once per process, synchronously at startup
      EmbeddingEngine.swift      # embed(texts: [String]) -> [[Float]]; owns micro-batching
      OpenAIEmbeddingsSchema.swift  # Codable request/response types (OpenAI /v1/embeddings shape)
      HTTPServer.swift           # Hummingbird app; POST /v1/embeddings route only
      Config.swift                # port / model repo id / micro-batch size / max_length
    EmbedMLXServerCLI/
      Serve.swift                 # ArgumentParser: `embed-mlx-server serve --port 8090 --model BAAI/bge-m3`
  scripts/
    deploy.sh                     # swift build -c release; copy binary to ~/proj/dist/embed-server/
    embed-mlx-server-service.sh   # launchctl wrapper (start/stop/restart/status/log),
                                   # modeled on scripts/surreal-service.sh
    com.video-generation.embed-mlx-server.plist  # installed manually to
                                   # ~/Library/LaunchAgents/; ProgramArguments points at
                                   # ~/proj/dist/embed-server/embed-mlx-server (NOT .build/),
                                   # so the running service survives `swift build` / `package clean`
  Tests/
```

Dependencies: `mlx-swift-lm` (for `MLXEmbedders`, which has `BAAI/bge-m3`
pre-registered), `hummingbird` v2 (lightweight, async/await-native HTTP
server — idles at ~5-10MB RAM, much lighter than Vapor; no existing HTTP
server precedent in this repo's `swift/` packages to conflict with), and
`swift-argument-parser` (matching every other `-director` package).

Layering: `HTTPServer` never imports MLX; `EmbeddingEngine` never imports
Hummingbird. The two communicate only through
`embed(texts: [String]) -> [[Float]]`, so either side can be tested without
the other (HTTP routing tested with a fake engine; batching logic tested
with a fake embed function; neither test touches the GPU or loads a real
model).

## Data flow

1. launchd starts the deployed binary per the plist, passing `--port`/`--model`.
2. `ModelLoader` loads BGE-M3 **synchronously at startup**, before the HTTP
   server starts accepting connections — avoids first-request latency spikes
   and concurrent-request load races.
3. `POST /v1/embeddings` arrives; `HTTPServer` decodes the JSON body and
   normalizes `input` (OpenAI's schema allows either a single string or an
   array of strings) into `[String]`.
4. `EmbeddingEngine.embed(texts:)` splits `texts` into fixed-size
   micro-batches (`Config.microBatchSize`, default 32 — same fix and same
   default as the Python harness fix in PR #1128) and, per micro-batch:
   tokenizes (padding is local to that micro-batch only), truncates to
   `Config.maxLength`, runs the forward pass, pools, L2-normalizes. Results
   are collected in input order.
5. `HTTPServer` wraps the flat `[[Float]]` result into an OpenAI-shaped
   response (`{object, data: [{object, embedding, index}], model, usage}`)
   and returns 200.

## Error handling

- Malformed JSON or missing/empty `input` → 400 with an OpenAI-style error
  envelope. A bad request must never crash the process.
- Any exception during inference (should be rare now that micro-batching
  bounds memory, but not impossible) → 500 with an error envelope, logged;
  the process stays alive to serve the next request. Same principle as the
  Phase 0 harness: one failure must not take down the whole service.

## Testing

Same split as Phase 0: TDD for pure logic that could silently produce wrong
results, run-it-to-verify for anything touching the GPU/real model.

- `OpenAIEmbeddingsSchema` — unit tested. Codable round-trip for both
  `input` variants (string and array); response shape matches the OpenAI
  contract.
- `EmbeddingEngine`'s micro-batching split — unit tested, with an injected
  fake embed function (protocol/closure), not a real model. Verifies: text
  count splits into the correct number of batches, the last partial batch
  isn't dropped, and result order matches input order. This is exactly the
  kind of bug (the OOM in PR #1128) that fails silently-looking-correct if
  gotten wrong.
- `HTTPServer` routing — unit tested with Hummingbird's test client and an
  injected fake `EmbeddingEngine`. Verifies request parsing, response
  shape, and error status codes (400/500) without loading a real model.
- `ModelLoader` + real BGE-M3 inference quality — not mocked. Verified via a
  `--self-test` mode: boot a real server, embed a handful of known
  semantically-near/far sentence pairs, assert cosine similarity ranks near
  pairs above far pairs. Matches this repo's existing `--self-test`
  convention (e.g. `run.py --self-test t2i:portrait`).
- launchd integration (plist loads, `scripts/embed-mlx-server-service.sh
  status` reports correctly) — manual verification step in the
  implementation plan, not automated.

## Out of scope

- Closing the BGE-M3 MLX-native-vs-LM-Studio quality gap (undetermined root
  cause; accepted as a known limitation per Phase 0).
- llama.cpp as a backend (dropped after Phase 0's inconclusive, unstable
  results; production target is Swift MLX regardless).
- Multiple simultaneous models / model hot-swapping (BGE-M3 only, for now).
- Authentication / access control (localhost-only service, matches the
  other local services in this repo, e.g. `scripts/surreal-service.sh`).
