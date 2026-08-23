# embed-mlx-server — Targeted Simplification

## Context

`swift/embed-mlx-server` shipped in Phase 1 (PR #1167, see
`2026-08-09-embed-mlx-server-design.md`). It is ~570 lines of source across 7
library files and 3 CLI files, with 19 tests, and runs in production as a
launchd service on port 8090.

A review pass for simplification found the codebase already tight and
well-factored. There is no architectural problem to solve. What it does carry
is a narrow band of mechanical boilerplate and one duplicated startup path.
This spec covers only those.

**Baseline before any change: 19 tests, 0 failures.**

## Goal

Remove boilerplate and one duplication without changing behavior, without
changing the wire protocol, and without weakening the explanatory comments
that encode why the code is shaped the way it is.

## Non-goals

Explicitly out of scope, each for a stated reason:

- **Removing the `ServerConfig` struct.** It is constructed then immediately
  destructured at both call sites and never passed as a unit, so it is a
  candidate — but removing it narrows the library's public API, which is a
  larger blast radius than this pass wants.
- **Merging the library/CLI target split.** The split is what lets
  `HTTPServerTests` exercise the routes headlessly via `HummingbirdTesting`
  with a fake backend, no model and no GPU. Collapsing it trades real
  testability for a lower file count.
- **The known `qwen3-embedding-0.6b` HTTP 500 defect.** Reproducible on
  ad-hoc instances of this same binary, not yet root-caused. It is a real
  bug, tracked separately; a behavior-preserving refactor must not be the
  vehicle for a behavior fix.
- **Comment removal of any kind.** The comments encoding the MLX
  default-repo trap, the mask-vs-EOS pooling bug, the `validate()`
  respawn-loop rationale, and the Hummingbird 2 MiB upload cap are the
  institutional memory of this package. They are most of what "quality"
  means here.

## Changes

### 1. Wire-format types become `internal`

**File:** `Sources/EmbedMLXServer/OpenAIEmbeddingsSchema.swift`

`EmbeddingsRequest`, `EmbeddingObject`, `EmbeddingsUsage`,
`EmbeddingsResponse`, and `ErrorResponse` are declared `public`. Swift does
not synthesize public memberwise initializers, so each one carries a
hand-written `public init` that must be maintained in lockstep with its
stored properties — about 23 lines of pure boilerplate.

Verified by grep: the `EmbedMLXServerCLI` target references none of these
types. They are the HTTP route's internal wire format, not library API.

Dropping `public` lets Swift synthesize the initializers and deletes the
hand-written ones. `Input.init(from:)` and `Input.encode(to:)` stay — those
implement the OpenAI string-or-array polymorphism and are real logic.

Secondary benefit: the library stops advertising five types as public
surface that no consumer uses.

**Fenced by:** `OpenAIEmbeddingsSchemaTests` (4 tests) and `HTTPServerTests`
(5 tests). Both use `@testable import`, which reaches internal declarations,
so they compile and pass unchanged.

### 2. `EmbeddingEngine.embed` uses `stride`

**File:** `Sources/EmbedMLXServer/EmbeddingEngine.swift`

The micro-batch walk is a hand-rolled `var start` loop with a trailing
`start = end` mutation. Replacing it with `stride(from:to:by:)` drops it from
11 lines to 8 and removes the manual index mutation, which is the classic
off-by-one surface.

Micro-batching itself is a hard requirement, not an optimization — embedding
an unbounded list in one padded batch caused a real ~107GB Metal allocation
attempt in the Phase 0 Python harness. The refactor preserves the batching
semantics exactly; only the iteration mechanics change.

**Fenced by:** `EmbeddingEngineTests` already pins all four boundaries —
input that is an exact multiple of the batch size, input with a partial
trailing batch, empty input, and single-item input.

### 3. Shared model-load path extracted

**New file:** `Sources/EmbedMLXServerCLI/EngineLoader.swift`

`Serve.run()` and `SelfTestCommand.run()` both execute the same sequence:
`setbuf(stdout, nil)`, print a loading line, `MLXEmbeddingBackend.load`, then
construct an `EmbeddingEngine`. The shared path moves into an `EngineLoader`
helper parameterized by command name.

It belongs in the CLI target, not the library: `setbuf(stdout, nil)` and the
`[embed-mlx-server <cmd>]` log prefix are presentation concerns, and the
library deliberately keeps I/O policy out of its surface.

**This change is roughly line-count neutral** — it adds a ~14-line file and
removes ~10 lines across two call sites. Its justification is coupling, not
brevity: if `self-test`'s load path drifts from `serve`'s, the self-test
silently stops validating what production actually runs.

**Fenced by:** no unit test — this is CLI wiring, which the existing suite
does not cover. Verified by running `self-test` against the real model and
confirming both cases still pass.

## Acceptance

1. `swift test` stays at 19 tests, 0 failures, with no test file edited.
2. `swift build -c release` succeeds.
3. `embed-mlx-server self-test` passes both the english and chinese cases
   against the real `mlx-community/bge-m3-mlx-8bit` model.
4. `/v1/embeddings` responses are byte-identical in shape to before.
