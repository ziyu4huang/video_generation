# 01 — Apply e4f0782 LSP shutdown-write-race fix

---
status: closed
---

## Context

`bun-apps/pi-agent-ext-subagent/src/watchdog/lsp-diagnostics.ts` is a verbatim-logic
port of `pi-subagents/src/watchdog/lsp-diagnostics.ts` (we inline the `WatchdogLsp*`
types instead of importing `./types.ts`). It was ported at `6216515b` (#937) from
upstream `0.37.1` (`051c586`, 2026-07-27) and is missing upstream commit `e4f0782`
("avoid LSP shutdown write race"):

- Adds a `terminating` boolean field to `JsonRpcLspClient`.
- Guards `kill()` so it is idempotent — a concurrent `shutdown()`/`kill()` cannot double-SIGTERM the child or race a write after exit.
- Routes `shutdown()`'s catch branch and `failProtocol()` through the guarded `kill()` instead of raw `child.kill("SIGTERM")`.

## Work

Port that guard logic into our `lsp-diagnostics.ts`, preserving our inlined-types
structure (do NOT restructure to a separate `./types.ts` import). The fix is ~10 lines:
add `terminating`, make `kill()` idempotent, route `shutdown()`-catch + `failProtocol()`
through `kill()`. Match upstream intent exactly.

Verify: `( cd bun-apps/pi-agent-ext-subagent && bunx tsc --noEmit && bun test )` — green required.

## Resolution (2026-08-09)

Applied upstream commit `e4f0782` "avoid LSP shutdown write race" to
`src/watchdog/lsp-diagnostics.ts`, preserving our inlined-types structure (no
restructure to a separate `./types.ts` import):

- Added a `private terminating = false` field to `JsonRpcLspClient`.
- Made `kill()` idempotent: `if (this.exited || this.terminating) return; this.terminating = true; this.child.kill("SIGTERM");` — a concurrent `shutdown()`/`kill()` can no longer double-SIGTERM the child or race a write after exit.
- Routed `shutdown()`'s catch branch through `kill()` (was raw `child.kill("SIGTERM")`), guarded by `if (!this.terminating)`.
- Routed `failProtocol()` through `kill()` (was raw `child.kill("SIGTERM")`).

Verified: `bunx tsc --noEmit` exit 0; `bun test` → 546 pass / 0 fail (incl. the existing `watchdog-lsp-diagnostics.test.ts`). No regression test added — `JsonRpcLspClient` is not exported, so a direct `kill()`-idempotency test would require exporting the class (public-surface change) or spawning a real child process (brittle); the change mirrors upstream `e4f0782` byte-for-byte in intent.
