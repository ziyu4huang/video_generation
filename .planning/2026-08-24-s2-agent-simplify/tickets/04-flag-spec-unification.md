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

## Audit table (2026-08-24, branch s2-agent-simplify-t04-flag-spec)

| Command | Flag | flag-spec group | ParsedArgs field | Semantics |
|---|---|---|---|---|
| tools-metrics | `--since` | META_VALUE | `since` | preserved (space + `=` form; raw string, `parseBoundary` unchanged) |
| tools-metrics | `--until` | META_VALUE | `until` | preserved (idem) |
| tools-metrics | `--cwd` | META_VALUE | `cwdSubstr` | preserved |
| tools-metrics | `--tool` | META_VALUE | `toolFilter` | preserved (raw csv string; command splits) |
| tools-metrics | `--top` | META_NUM (`min:1`) | `top` | preserved via parseNumericFlag (old parseTop also threw on non-positive/non-integer; message text differs) |
| tools-metrics | `--details` | META_BOOL | `details` | preserved (`--details=x` degenerate form no longer counts as true — unobservable in practice) |
| tools-metrics | `--schema-cost` | META_BOOL | `schemaCost` | preserved |
| tools-metrics | `--ext` | META_VALUE | `ext` | preserved (space + `=` form) |
| tools-metrics / agent-trends | `--sessions-dir` | META_VALUE | `sessionsDir` | preserved; agent-trends gains `--flag=value` form (old `flag()` was indexOf-only) |
| tools-metrics / agent-trends | `--json` | ZK_QUERY_BOOL (existing row, comment updated) | `json` | unchanged — both already read `parsed.json` |
| agent-trends | `--all` | META_BOOL | `all` | preserved |
| agent-trends | `--window` | META_NUM (`min:1`) | `window` | default-fallback when absent preserved (`?? DEFAULT_WINDOW`); CHANGED: invalid/non-positive input now fails fast instead of silently using the default (old `num()` swallowed it) |
| agent-trends | `--min-events` | META_NUM (`min:1`) | `minEvents` | idem |
| agent-trends | `--delta` | META_NUM (`min:1`, `integer:false`) | `delta` | idem (fractional pp still accepted) |
| doctor | `--json` | ZK_QUERY_BOOL (existing) | `json` | preserved — bare-token presence, identical to old `rest.includes("--json")` |
| doctor | `--fix` | ZK_QUERY_BOOL (existing, comment updated) | `fix` | preserved — identical to old `rest.includes("--fix")` |

Census `(parsed as any).` re-grep across bun-apps (excl. node_modules, excl. tests): exactly one hit, the known
`s2-agent-ext-web-access/extensions/cli-subcommand.ts:87` (`save`) — no new readers; all new fields are typed on
`ParsedArgs`, none renamed.

Known unobservable deltas: repeated same flag → flag-spec keeps the LAST occurrence (takeFlag returned the FIRST);
`--flag=value` spellings of migrated booleans no longer match (old hasFlag matched the `=` prefix form). Neither form
appears in any script/test in the repo.
