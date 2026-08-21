# @repo/s2-agent-ext-compact

Claude Code-style `/compact` for s2-agent: replaces the *summary content* of
the host's built-in compaction via the `session_before_compact` hook. The
summary is produced by one LLM call over deterministic ground truth — a
`<verified-files>` block extracted from actual tool calls, verbatim user
messages, and an inferred session type (implementation / debugging / review /
discussion) — and follows the nine Claude Code sections ("Primary Request and
Intent" … "Optional Next Step"). Cut point, session tree, and failure handling
stay with the host.

**Degradation guarantee:** any failure inside the hook (no model, no API key,
LLM error, thrown exception) emits a `warning` notify and returns `undefined`,
so the host falls back to its built-in compaction. `/compact` never breaks.

## Environment knobs

| Variable | Effect |
| --- | --- |
| `BUN_PI_COMPACT=0` | Disable the extension entirely |
| `COMPACT_MODEL=provider/id[:thinking]` | Override the session model for summarization |
| `COMPACT_MAX_TOKENS_FACTOR` | Fraction of `reserveTokens` for the summary (default 0.8, clamped to [0.1, 1]) |

## A/B replay harness

```bash
bun run --cwd bun-apps/s2-agent-ext-compact ab [--session <path.jsonl>] [--n 5] \
  [--model provider/id] [--out report.json]
```

Offline A/B on real sessions from `~/.pi/agent/sessions`: host built-in
summarizer vs CC-style, same cut point / model / reserveTokens. Prints a
per-session metric table (summary tokens, wall time, usage, cost, compression)
and can emit a JSON report containing a deterministic `factSet` per session for
later blind judging.

## Develop

```bash
bun run --cwd bun-apps/s2-agent-ext-compact test
bun run --cwd bun-apps/s2-agent-ext-compact typecheck
```

## Registration

Registered via `bun-apps/s2-agent/s2-agent.registry.yaml` — one entry
(`load: dynamic` or `load: static`), then `bun run --cwd bun-apps/s2-agent
regen:manifest` (+ `regen:static` for static). The entry point is
`extensions/compact.ts`.

## Further reading

- `CONTEXT.md` — scope, seams, invariants.
- `docs/UPSTREAM-LESSONS.md` — design lessons from pi-smart-compact.
