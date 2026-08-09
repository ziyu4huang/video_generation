# embed-mlx-server

OpenAI-compatible local text-embedding server. Native Swift + MLX (no Python at
runtime), serving **BGE-M3** over `POST /v1/embeddings`, installable as a macOS
launchd background service.

Built as Phase 1 of a two-phase effort. Phase 0 (`python/embed-bench/`, PR #1128)
benchmarked LM Studio vs. llama.cpp vs. MLX-native on real corpora to decide the
approach; see `.planning/specs/2026-08-09-embed-mlx-server-design.md` for the
design and `.planning/plans/2026-08-09-embed-mlx-server.md` for the build log.

## Quick start (development)

```bash
# 1. Build. (Then copy MLX's precompiled Metal kernels next to the binary —
#    SwiftPM can't compile Metal shaders itself, so without this every run
#    dies with "Failed to load the default metallib". Same script, same
#    reason, as z-image-director / ltx-video-director / krea2-image-director.)
( cd swift/embed-mlx-server && swift build )
swift/embed-mlx-server/scripts/setup-metallib.sh          # or: setup-metallib.sh release

# 2. Sanity-check the real model end to end (downloads BGE-M3 on first run).
( cd swift/embed-mlx-server && swift run embed-mlx-server self-test )

# 3. Run it in the foreground.
( cd swift/embed-mlx-server && swift run embed-mlx-server serve )
```

`self-test` embeds known near/far sentence pairs in English and Chinese and
checks the near pair scores higher, with a margin. Expected output:

```
[PASS] english: near=0.938... far=0.466... margin=0.472...
[PASS] chinese: near=0.935... far=0.476... margin=0.459...
```

## Deploying as a background service

```bash
# Build release + install binary and mlx.metallib to ~/proj/dist/embed-server/.
# Deliberately outside .build/, so `swift build` or `swift package clean`
# can never break the running service.
swift/embed-mlx-server/scripts/deploy.sh

# Install the LaunchAgent, then start it.
cp swift/embed-mlx-server/scripts/com.video-generation.embed-mlx-server.plist ~/Library/LaunchAgents/
swift/embed-mlx-server/scripts/embed-mlx-server-service.sh start
```

**The checked-in plist hardcodes `/Users/huangziyu/...` in three places**
(`ProgramArguments`, `StandardOutPath`, `StandardErrorPath`) because launchd
does not expand `~` or `$HOME`. On any other machine, edit those paths in the
*copied* file before starting.

`RunAtLoad` is true, so once the plist is installed the service also starts at
login. To opt out entirely, `rm ~/Library/LaunchAgents/com.video-generation.embed-mlx-server.plist`.

Service management (thin `launchctl` wrapper, modeled on the repo's
`scripts/surreal-service.sh`):

```bash
scripts/embed-mlx-server-service.sh start|stop|restart|status|log
```

After a `deploy.sh`, run `... restart` to pick up the new binary.

## API

```bash
curl -s http://127.0.0.1:8090/v1/embeddings \
  -H 'Content-Type: application/json' \
  -d '{"model": "bge-m3", "input": ["hello world", "你好世界"]}'
```

Returns the OpenAI shape — `{"object": "list", "data": [{"object": "embedding",
"embedding": [...], "index": 0}, ...], "model": ..., "usage": {...}}` — with
1024-dimensional vectors. `input` accepts either a single string or an array.

Errors return an OpenAI-style envelope: `400` for a malformed body or an empty
`input`, `500` if inference fails. A bad request never takes the process down.

## Flags

| Flag | Default | Notes |
| --- | --- | --- |
| `--port` | `8090` | 1–65535 |
| `--model` | `mlx-community/bge-m3-mlx-8bit` | any HF repo id with MLX safetensors |
| `--micro-batch-size` | `32` | texts per MLX forward pass |
| `--max-length` | `8192` | BGE-M3's real context window |

Micro-batching is not a tuning knob — it's load-bearing. Embedding an unbounded
list in one padded batch is what caused a ~107GB Metal allocation attempt in the
Phase 0 Python harness.

The default model is **not** `BAAI/bge-m3`: that repo publishes only
`pytorch_model.bin`, and this stack loads safetensors exclusively, so it fails
with `Key ... not found`. `mlx-community/bge-m3-mlx-8bit` is the MLX conversion
Phase 0 already validated.

## Known limitations

- **One model per process.** No hot-swapping; the request's `model` field is
  accepted but ignored, and responses echo the server's configured repo.
- **`usage` is always `{0, 0}`.** Token accounting was never wired up. Matters
  only if you point a client at this that bills or rate-limits on reported usage.
- **No auth, localhost-only.** Same posture as the repo's other local services.
- **Only `/v1/embeddings` is routed.** No `/v1/models`, no health endpoint.
- **`dimensions` / `encoding_format` are ignored** if a client sends them.
- **Quality gap vs. LM Studio is real and unexplained.** Phase 0 measured
  BGE-M3 recall consistently lower through MLX-native than through LM Studio,
  on both corpora. The obvious suspect (a 512-token truncation) was tested and
  ruled out. Most likely a difference in the `mlx-community` conversion or its
  pooling; accepted, not fixed. See the Phase 0 spec.
- **Log file is unrotated** (`~/proj/dist/embed-server/embed-mlx-server.log`).

## Layout

```
Sources/EmbedMLXServer/          # library
  EmbeddingBackend.swift         #   protocol: embed one micro-batch
  EmbeddingEngine.swift          #   splits arbitrary input into micro-batches
  MLXEmbeddingBackend.swift      #   the ONLY MLX-aware file
  OpenAIEmbeddingsSchema.swift   #   pure wire-format Codable types
  HTTPServer.swift               #   Hummingbird route, never imports MLX
  Config.swift                   #   plain data, imports nothing
  SelfTest.swift                 #   near/far quality check
Sources/EmbedMLXServerCLI/       # `serve` and `self-test` subcommands
scripts/                         # setup-metallib, deploy, launchd wrapper + plist
```

`HTTPServer` never imports MLX and `EmbeddingEngine` never imports Hummingbird;
they meet only at `embed(texts:) -> [[Float]]`. That seam is why the HTTP layer
and the batching logic are both unit-testable against a fake backend, with no
GPU: `swift test` runs 19 tests and touches no model.

## Dependency pin

`mlx-swift-lm` is pinned to **exactly 2.31.3**. The 3.x line refactored embedding
model loading behind a `Downloader`/`TokenizerLoader` pair whose HuggingFace
implementations aren't in the tagged tree, and its README references products
that tag doesn't declare. Don't bump it without checking the target tag's actual
source rather than its docs.
