# Findings: `bun run schema-cost` from repo root fails (execute agent 1)

Status: **done** — closed 2026-08-22; follow-up resolved via `findings-schema-cost-inventory.md`.

## TL;DR

- Repo root has NO `schema-cost` script — the bun workspace root is `bun-apps/` (CLAUDE.md § Repo mechanics).
- `schema-cost` script is defined only in `bun-apps/s2-agent-ext-power-tool/package.json` (grep -rl: single match).
- CLAUDE.md: the schema-cost canary is the CLI subcommand `bun-apps/s2-agent/src/cli/commands/schema-cost.ts`.

## Verified invocations

- `bun run --cwd bun-apps/s2-agent-ext-power-tool schema-cost`
- `s2-agent cli tools-metrics --schema-cost` (via `bun-apps/s2-agent/src/cli/commands/tools-metrics.ts`)
- `bun scripts/check-schema-cost.ts [--baseline <path>] [--threshold <pct>]` (CI gate shim)
