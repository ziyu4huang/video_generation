---
ticket: 01-connected-gate
effort: webui-present-adoption
type: task
status: closed
created: 2026-08-16
last: 2026-08-16
blocked-by: none
blocking: [02, 03]
---
# 01 — Connected-gate + disconnect auto-release
Implement spec §C1. Touch: present-tool.ts (gate at call + release on
disconnect), webui-wiring.ts (clientCount signal), tests. Acceptance: no-client
call → immediate `{skipped:"no_client"}`; disconnect mid-wait →
`{cancelled:true,reason:"no_client"}`; with-client flow byte-identical to today.

## Result
01: connected-gate (call-time skip + mid-wait 1→0 release, optional seams, ungated fallback); gate 469 pass / 0 fail.
