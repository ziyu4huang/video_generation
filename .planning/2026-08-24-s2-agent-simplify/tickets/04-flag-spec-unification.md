# 04 — arg unification into flag-spec

Phase B · risk MED (hidden ext API) · gate: package gates + boot-smoke byte-identical · depends: 03

## Scope

Migrate rest-parsed flags into `cli/flag-spec.ts` rows + typed ParsedArgs fields:

- cli/commands/tools-metrics.ts:359-371 `takeFlag`/`hasFlag` (~15 flags: --since --until --cwd --tool --top --details --sessions-dir --all --window --min-events --delta --json --schema-cost --ext …).
- cli/commands/agent-trends.ts:188-197 `flag`/`has`/`num`.
- cli/commands/doctor.ts:350-351 `parsed.rest.includes("--json"/"--fix")`.

Rules:

- EXACT existing field names (ext cli-subcommand builders read optional ParsedArgs fields — hidden API, map D4).
- Pre-audit: all `(parsed as any).` readers across bun-apps/s2-agent-ext-* (census started in 01) — a renamed/moved row silently drops a flag (unknown-flag skipper swallows it).
- Keep agent-trends' PI_SESSIONS_DIR behavior (03 owns the resolution; this ticket only moves parsing).
- Add a per-flag regression test: each migrated flag parses to the same value shape the hand-rolled parser produced (incl. `--flag=value` forms).
- Help text stays hand-written (map D2).

## Done-when

Package gates green; boot-smoke byte-identical; takeFlag/hasFlag/flag/has/num definitions deleted; per-flag regression test lands; audit table attached to this ticket.
