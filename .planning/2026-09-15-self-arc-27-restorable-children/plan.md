# plan.md — adjudication cover (arc-25/26 precedent)

The canonical wayfinder map lives at `map.md` — the arc-ledger guard
(`arc-ledger.ts:168-170`) and `effort-audit.ts:296-299` require the map BY
NAME (arc-26 planner-audit lesson, measured RED 1/13 on a plan.md-only tree).
This file is the short adjudication cover the task brief asked for by path.

## Deliverable

- **`.planning/2026-09-15-self-arc-27-restorable-children/map.md`** — strict
  wayfinder map (house shape, front-matter `status: active` matching ledger
  row 27): falsifiable Destination · measured Context (every anchor
  file:line-read at `bf9a2c2b` against the installed pi 0.85.1 dist) · Scope
  IN/OUT with reasons · tickets t01 (journal write side) → t02 (restore read
  side + assembleSession seam) → t03 (deployed restart-survival receipt) →
  t04 (close-out), each with file surfaces, tests, and verification clauses ·
  Decisions D1–D11 (dated) · Frontier · Fog of war · successor sketch ·
  cross-effort links (Builds-on arc-25 D8 charter + arc-26).

## Adjudicated decisions (carried into the map)

| Question (from the directive) | Verdict | Anchor |
|---|---|---|
| Journal location | `~/.pi/subagents/sessions/<name>.jsonl` — reuses the `SUBAGENT_HOME_RELATIVE_DIR` root + atomic tmp+rename + injectable-home conventions of `subagent-run-persistence.ts` | map D1/D2 |
| Journal schema | RAW pi JSONL `FileEntry[]` (header first) — parseable by pi's own `parseSessionEntries`/`_loadEntries` (header→sessionId+leaf; corrupt lines skipped by pi itself; version migration is pi's) | map D1 |
| Write hook | `LiveAgent.send()` existing settle-`finally`; journal constructed by `spawnLiveAgentFirstExchange` (the only layer that knows the name); best-effort, never fails an exchange | map D3 |
| Restore trigger | Automatic-on-name-match + cwd guard (journal header `cwd` === dispatch cwd), with DUAL notice: parent output line `[restored from journal: …]` + one-time child first-exchange preamble. NO `resume` param → ZERO schema delta | map D2/D4 |
| Injection seam | ONE optional field `SessionAssemblyOptions.sessionEntries?` consumed at `agent.ts:451` → `SessionManager.inMemory(runCwd, undefined, entries)`; threaded spawnLiveAgentFirstExchange → OpenLiveAgentOptions → assembly | map D5 |
| Robustness | Missing/corrupt/headerless/read-throw/cwd-mismatch → fresh child silently; journal-safe name charset `/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/` (name is free-form today — measured) | map D6 |
| Cleanup | Journals SURVIVE dispose/LRU/session_shutdown (eviction+restore compose); last-N=200 retention mirrors runs; viewer/forget UX charted, not built | map D7 |
| Unnamed children | NOT journaled (their runs/ record is already durable write-once; directive lean adopted) | Scope OUT |
| Detached-resume | Different mechanism (`runs/detached/` manifests, OS subprocess); measured no interplay | Scope OUT |

## Learnings / PB cited at point of use

Learnings #1/#2 (deployed ≠ source, label ≠ bytes → t03 pre-drive greps on
BOTH bundles — the journal code inlines into `ext/subagent/ext.cjs` AND the
core `s2-agent.js`; core cache must MISS via `workspaceSrcDirs`), #6 (every
t03 leg a fresh process). PB-01/02/19 at arc open; PB-08–15, 18 across
t01–t03; PB-03–07, 16, 17 in t04.
