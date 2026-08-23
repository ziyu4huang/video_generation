---
name: probe-extension-introspection
description: Use when you must answer authoritatively, offline and without a model call, what a real pi/s2-agent session actually sees — is tool X on the session surface, did skill Y actually load, what was the spawn argv, what system prompt options were assembled. Any question the interactive CLI or a model gate makes you guess at, or that a test suite only asserts against its own fakes.
---

# Probe-extension introspection

A throwaway probe extension plus one CLI run answers "what does a real session actually see" OFFLINE and authoritatively — no interactive boot, no model call. Reading the registry/manifest proves something is *registered*, not *loaded*; the interactive CLI is model-gated and slow; and the test suites assert only their own fakes. The probe sidesteps all three.

## Core pattern

Before: "is tool X on the session surface?" → read the manifest, assume it is loaded, get it wrong when a filter or env var actually excluded it.
After: register a hook, read the live surface from inside a real session start, print what you found, `process.exit(0)` before any provider call.

Key events: `session_start` (fires before any provider call; context has tools via `pi.getAllTools()`), `before_agent_start` (the ONLY event carrying the assembled `systemPromptOptions`, including loaded skills). Exit from inside the hook so no model call is ever made.

## Procedure

1. Write `/tmp/probe.ts`: a default-export factory that registers the hook; filter to the names in question; `process.stderr.write("[PROBE-...] ...")` then `process.exit(0)`.
2. **Tool surface** — hook `session_start`, read `pi.getAllTools().map(t => t.name)`.
3. **Skill loading** — hook `before_agent_start`, read `event.systemPromptOptions.skills` (filePath/baseDir identify the source dir).
4. **Spawn argv** — monkey-patch `node:child_process` `spawn` BEFORE the tool runs; collect args; kill spawned children instantly. (Caveat: if the target uses `Bun.spawn` or a wrapper, capture silently misses — fall back to behavioral proof: check the observable side effect, e.g. a report landing in the persistence mirror.)
5. **Provider pitfalls** (all hit live): a user-level `defaultProvider` in `~/.pi/agent/settings.json` silently hijacks provider-less `--model` (fix: explicit `--provider`); `models.json` ids must match what the server actually serves; weak models ignore tool-call instructions — use a stronger local model and imperative prompts.
6. **Guard loop** (macOS has no `timeout`): `cmd > /tmp/out 2>&1 & for i in $(seq 1 N); do sleep 5; grep -q MARKER /tmp/out && break; kill -0 $PID || break; done; kill -9 $PID`.

## Code example

```ts
// /tmp/probe.ts — thrown away after the run; the tree stays clean.
export default (pi: any) => {
	pi.on("session_start", (ctx: any) => {
		const tools = ctx.tools?.map?.((t: any) => t.name) ?? [];
		const hit = tools.filter((n: string) => n.includes("webui"));
		process.stderr.write(`[PROBE-TOOLS] total=${tools.length} found=[${hit.join(",")}]\n`);
		process.exit(0);
	});
};

// run: bun cli.ts -e /tmp/probe.ts -p x   (guarded, per step 6)
```

## Common mistakes

- Reading the manifest to answer a "does it load" question — registered ≠ loaded; a filter or env var can exclude it.
- Trusting the interactive CLI to tell you — it is model-gated and slow; the probe answers offline.
- Omitting the provider pitfalls — a user-level `defaultProvider` silently overrides a provider-less `--model` and makes the run answer a different session than you thought.
- Running the probe without the guard loop — macOS has no `timeout`, so an unresponsive probe hangs the session.
- Leaving the probe file in the repo — it belongs in `/tmp`; it is disposable.

## Provenance

> Provenance: candidate `.planning/knowledge/probe-extension-introspection.md` (consumed on promotion 2026-08-23); RED baseline 2026-08-23 confirmed no built-in offline session-surface inspector exists, and that the default answer still required hand-reconstructing pi-core's loader. Complements skill-provenance (distinguishes registered from loaded here); complements power-tool's `inspect_context` (live per-request context vs. one-shot surface probe).
