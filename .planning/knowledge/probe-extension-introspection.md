# Probe-extension introspection (candidate skill)

## Trigger / symptom
Need to verify what a REAL pi session sees (tool list, loaded skills, spawn argv, system prompt options) — but the CLI is interactive/model-gated and test suites only assert their own fakes. Questions like "is tool X actually on the session surface?" or "did skill Y actually load?" end up answered by assumption.

## Lesson
A throwaway extension file + one CLI run answers these questions OFFLINE and authoritatively. Key events: `session_start` (fires before any provider call; ctx has tools via pi.getAllTools()), `before_agent_start` (the ONLY event carrying assembled systemPromptOptions incl. loaded skills). Exit from inside the hook (`process.exit(0)`) so no model call is ever made. Run via `bun cli.ts -e /tmp/probe.ts -p x` with a background + poll-for-marker guard (macOS has no `timeout`).

## Proposed procedure
1. Write /tmp/probe.ts: default-export factory registering the hook; filter for the names in question; `process.stderr.write("[PROBE-...] ...")` then `process.exit(0)`.
2. Tool surface: hook session_start, read `pi.getAllTools().map(t => t.name)`.
3. Skill loading: hook before_agent_start, read `event.systemPromptOptions.skills` (filePath/baseDir identify the source dir).
4. Spawn argv: monkey-patch node:child_process spawn BEFORE the tool runs; collect args; kill spawned children instantly. (Caveat: if the target uses Bun.spawn or a wrapper, capture silently misses — fall back to behavioral proof: check the observable side effect, e.g. a report landing in the persistence mirror.)
5. Provider pitfalls (all hit live): user-level `defaultProvider` in ~/.pi/agent/settings.json silently hijacks provider-less `--model` (fix: explicit `--provider`); models.json ids must match what the server actually serves; weak models ignore tool-call instructions — use a stronger local model and imperative prompts.
6. Guard loop: `cmd > /tmp/out 2>&1 & for i in $(seq 1 N); do sleep 5; grep -q MARKER /tmp/out && break; kill -0 $PID || break; done; kill -9 $PID`.

## Evidence
2026-08-18 (video_generation): [PROBE-TOOLS] total=75 found=[webui_report,webui_present,webui,archify_render] settled a wrongly-scoped ticket (#1600); [PROBE-PT-SKILLS] matched=3/53 proved skill loading end-to-end (#1599); the L2 run proved subagent->webui_report->mirror publish live (#1603). All offline except the final L2 run.

## Candidate skill-name
probe-extension-introspection
