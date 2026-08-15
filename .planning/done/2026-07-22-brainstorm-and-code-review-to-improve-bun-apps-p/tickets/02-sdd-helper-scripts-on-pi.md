---
type: research
status: closed
claimed: chart-session-2026-07-22
---

## Question

Do the superpowers SDD helper scripts (`task-brief`, `review-package`, `sdd-workspace`) run on Pi, and what runtime do they need? Determines whether ticket 06 (file-handoff helpers) ports them, wraps them, or replaces them.

## Resolution

All three live in `bun-apps/pi-agent-ext-superpowers/skills/subagent-driven-development/scripts/` and are `#!/usr/bin/env bash`:

| Script | Size | Role |
|---|---|---|
| `task-brief` | 888 B | `task-brief PLAN_FILE N` — extracts task N's full text from the plan to a uniquely-named brief file; prints the path. |
| `review-package` | 1350 B | `review-package BASE HEAD` — writes commit list + `git diff -stat` + full diff to a uniquely-named file; prints the path. |
| `sdd-workspace` | 1102 B | Sets up the `.superpowers/sdd/` workspace (ledger dir, etc.). |

They use only `bash` + `git` + standard coreutils — **both available on Pi (Apple Silicon / macOS)**. They run as-is today.

**Implication for ticket 06:** no port is strictly required — the scripts work. The design decision narrows to: (a) document their Pi invocation paths in the `pi-tools.md` glue and call them from the `subagent`-driving skill text via `bash`; or (b) provide thin in-tool helpers (`subagent` tool params or a small companion tool) that wrap the same logic so the controller doesn't shell out. Option (b) is only worth it if shell-out proves fragile in practice.
