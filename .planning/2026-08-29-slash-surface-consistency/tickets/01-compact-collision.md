# 01 — /compact collision adjudication

blocking: none (FIRST — its naming outcome feeds 03)

## What

Pi 0.84.4 ships builtin `/compact`; s2-agent-ext-compact registers a command
named `compact` (registry-config.ts:590). Measure which one answers in the TUI
and whether the extension's CC-style semantics survive 0.84.3's
compaction-routing changes.

## Approach

1. Boot `./s2-agent.sh` (or deployed current) with the compact extension
   loaded; probe the command registry (colliding-command-dispatch patch in
   src/patches/ may already arbitrate — READ it first).
2. Record a measurement receipt: winner, dispatch path, semantic differences
   (CC-style vs upstream routing).
3. Decide rename (`/compact-cc`) vs deliberate shadow (documented + tested).

## Measurement receipt (2026-08-29, main `a3720441`, pi-coding-agent 0.84.4)

**The premise is FALSE — there is no command collision.** Verified on this
machine against the 0.84.4 dist actually installed in this worktree:

- `s2-agent-ext-compact` registers NO slash command. Its entry
  (`extensions/compact.ts`) only calls `pi.on("session_before_compact", …)`;
  `grep -rn registerCommand bun-apps/s2-agent-ext-compact/` → zero hits.
  `registry-config.ts:590`'s `name: "compact"` is the EXTENSION load key
  (registry manifest), not a command registration — the audit conflated the
  two surfaces.
- TUI dispatch order (why a hypothetical extension `/compact` could never win
  anyway): `dist/modes/interactive/interactive-mode.js:2481` intercepts
  `/compact` in the editor's `onSubmit` handler and calls
  `handleCompactCommand` → `session.compact()` BEFORE `AgentSession.prompt()`
  is reached — and extension command dispatch lives in `prompt()`
  (`dist/core/agent-session.js:828-835`, `_tryExecuteExtensionCommand`).
  Upstream additionally filters builtin-named extension commands out of the
  palette (`interactive-mode.js:509-512`) and warns via
  `getBuiltInCommandConflictDiagnostics` (`interactive-mode.js:440`).
- CC-style semantics SURVIVED 0.84.3/0.84.4's routing changes:
  `AgentSession.compact()` (`dist/core/agent-session.js:1490-1506`) emits
  `session_before_compact` with the exact event shape the extension consumes
  (`preparation` / `customInstructions` / `signal` / `reason`), adopts a
  handler-returned `compaction` object (`fromExtension = true`), and the
  auto-compaction path emits the same hook at `:1751`. Host owns the cut
  point (`firstKeptEntryId`), extension owns summary content — unchanged
  contract from the #1787 design.
- The `colliding-command-dispatch` patch (`bun-apps/s2-agent/src/patches/`)
  is ORTHOGONAL: it arbitrates extension-vs-extension name collisions
  (`name:1` fallback); it plays no role here because only one side of this
  "collision" is a command at all.

## Decision

**No rename, no shadow — keep the hook rider.** The extension stays a
`session_before_compact` rider: the pi builtin `/compact` is the ONLY
`/compact`, and invoking it (or auto-compaction) routes through the CC-style
summarizer with built-in fallback on every failure mode. Pinned by
`extensions/__tests__/no-command-collision.test.ts` (asserts zero
`registerCommand` calls + exactly one hook subscription, via a recording
Proxy so future pi APIs can't slip past the assertion).

## Done when

- [x] Measurement receipt in the ticket (or map Context) naming the winner
- [x] Decision recorded in map ## Decisions
- [x] Regression test pins the chosen behavior
- [ ] Package gates green (canonical `bun run test` of touched packages)
