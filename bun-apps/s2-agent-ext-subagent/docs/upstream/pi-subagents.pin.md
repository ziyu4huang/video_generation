# Upstream: pi-subagents (selective port — NOT wholesale upstream)

pi-subagents @ 0.37.1 (051c586, 2026-07-27) — selective port source for the watchdog subset only.
local checkout: /Users/huangziyu/proj/pi-subagents  (origin: git@github.com:nicobailon/pi-subagents.git)
current origin HEAD reviewed: 165ec10 (v0.45.1, 2026-08-09)
ported to us: 2026-07-29, commit 6216515b (#937)

Ported files (verbatim/simplified logic — NOT a tree sync):
  - src/watchdog/lsp-diagnostics.ts  <- pi-subagents/src/watchdog/lsp-diagnostics.ts
      (verbatim logic; WatchdogLsp* types inlined vs upstream's ./types.ts import)
  - src/watchdog/repo-diff.ts        <- pi-subagents/src/watchdog/change-signature.ts
      (simplified port + our own curation layer: MAX_ENTRIES, large-file guard, DiffForReview)

Package-body upstream (SEPARATE): s2-agent-ext-workflow (#789) — NOT pi-subagents.

sync mechanism: manual selective port.
applied 2026-08-09: lsp-diagnostics.ts e4f0782 "avoid LSP shutdown write race" fix (terminating guard; kill() idempotent; shutdown-catch + failProtocol route through kill()).
still NOT ported (optional, feature work — gated on upstream watchdog scaffolding we lack):
  - pi-subagents/src/watchdog/scope.ts (scope-monitor cadence)
  - pi-subagents/src/watchdog/permission-arbiter.ts (child tool permissions)
