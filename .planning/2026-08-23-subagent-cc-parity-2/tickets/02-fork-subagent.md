# Ticket 02 — fork subagents (prompt-borne parent-context inheritance)

Status: done (2026-08-23) · Phase 2 (after 01) · SUPERSEDES teams-parity D10 (via map D2/D3)

Implementation note — the no-fork-recursion flag travels as an AMBIENT
AsyncLocalStorage scope (`runAsForkChild`/`isForkChild`, core-runtime
fork-transcript.ts), not through SpawnSubagentOptions: the bridged
spawn_subagent definition the child receives is the parent's closure, so there
is no per-child options object it could read. The scope wraps the fork child's
entire spawn, so grandchildren inherit it too.

## Scope

Add `fork: true` to `spawn_subagent`: the child inherits the parent
conversation as context. Per map D2/D3:

- Prompt-borne inheritance via compaction-aware transcript projection — pi's
  `createAgentSession` has no `initialMessages`, so the transcript is an
  instructions-prefix block, not a session continuation (recorded divergence,
  spec.md §3).
- Background DEFAULT true (CC behavior; explicit `background: false` allowed).
- No further forks from a fork child; no `name` on a fork.

## Approach

1. Capture `ctx.sessionManager` at `session_start` in
   `extensions/subagent.ts` into a holder (same pattern as the existing
   model/tool holders); pass a `getParentTranscript(): string | undefined`
   getter into `createSubagentTool`.
2. New `bun-apps/s2-agent-core-runtime/src/fork-transcript.ts`:
   `buildForkTranscript(entries, leafId, capChars)` using pi's exported
   `buildContextEntries` + `sessionEntryToContextMessages`
   (`@earendil-works/pi-coding-agent` root re-exports, `dist/index.d.ts:19`),
   rendering user/assistant text turns into a compact
   `## Parent conversation (context only, do not continue it)` block with a
   hard char cap (default ~24k chars, env-tunable), truncating OLDEST-first
   with a `[... earlier turns truncated ...]` marker. Pure function —
   unit-testable without a session.
3. Schema: `fork: Type.Optional(Type.Boolean())` in
   `src/subagent-tool-schema.ts` (near `name:`), description citing CC
   semantics + our divergence. Validation: `fork`+`name` → error;
   `fork`+`agentType` → error (CC forks are untyped); `fork` implies
   background default true.
4. Dispatch: prepend the transcript block in `src/subagent-tool-run.ts` — it
   composes FIRST, before agent-prompt, env-hints, and the abort-safety footer
   (which keeps the last word, per the composition discipline at :459-463).
5. No-fork-recursion: when the spawning context is itself a fork child, the
   injected spawn tool rejects `fork: true` with an actionable message. Plumb
   an `isForkChild`/`forkDepth` flag through spawn options that the child's
   extensionTools-bridged spawn tool reads.

## Cross-link obligation

Append the reciprocal line to
`.planning/2026-08-22-subagent-teams-parity/map.md` Cross-effort links
(D10 superseded-in-part-by this effort) in this ticket's PR, per
`.planning/CONVENTIONS.md`.

## Files

- New: `bun-apps/s2-agent-core-runtime/src/fork-transcript.ts`
- `bun-apps/s2-agent-core-runtime/src/spawn-subagent.ts` (options)
- `bun-apps/s2-agent-ext-subagent/src/subagent-tool-schema.ts`,
  `src/subagent-tool-run.ts`, `src/subagent-tool.ts`, `extensions/subagent.ts`
- spec.md §2 fork row + §3 divergence row — same PR (map D8)

## Risks

- Transcript token cost on long parent sessions — cap + oldest-first
  truncation; ticket 01's measured session sizes set the default cap.
- Parent entries include tool-call noise — project only user/assistant text.
- `sessionManager` unavailable in detached-resume hosts → `fork` errors, never
  silently degrades to an empty transcript.

## Verification

- New `tests/fork-transcript.test.ts` (pure projection: compaction respected,
  cap, truncation marker) and `tests/fork-subagent.test.ts` (schema
  rejections, composition order, no-fork-recursion guard, background default)
  using the fake-dispatch seams from `tests/named-live-agent.test.ts`.
- Full gates in s2-agent-ext-subagent AND s2-agent-core-runtime (peer-dep
  surface), plus ultracode's gates since core-runtime changed.
