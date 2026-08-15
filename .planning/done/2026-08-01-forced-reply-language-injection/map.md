> STATUS: DONE — archived 2026-08-15 (shipped in main; see git history / PR references in map)
# Map — forced reply-language injection

## Destination

A `responseLanguage` setting in `~/.pi/agent/settings.json` that pi-agent reads
and injects as a **forced, high-priority system-prompt block into EVERY session**
— main, subagent subprocess, workflow agent, obsidian-child — so the reply-language
rule survives role labels and the model's English default.

**Reframe (vs. the audit's first guess):** the rule already *propagates* to all
sessions via the global `~/.pi/agent/AGENTS.md` context file (`resource-loader.js:86`).
The defect is **enforcement / priority**, not propagation. So this effort
*elevates* the rule to a forced injection — it does not add a new propagation path.

## Notes

- **Domain:** pi-agent system-prompt assembly. Skills: wayfinder, grilling,
  domain-modeling, (later) writing-plans + test-driven-development for the build.
- **This effort overrides "plan, don't do":** the destination is a working
  in-repo feature (user decision: "in home `~/.pi/` settings, force-inject to any
  session/reply/agent"). The final ticket is the implementation.
- **Architecture anchor (from research ticket 01):** `ResourceLoader`
  (`pi-coding-agent/dist/core/resource-loader.js`) is the universal loader; every
  `AgentSession` rebuilds its prompt via `_rebuildSystemPrompt → buildSystemPrompt`
  (`dist/core/agent-session.js:710`, `dist/core/system-prompt.js`). Forcing levers
  that reach every session: `getSystemPrompt()`/`customPrompt` (top, highest
  priority), `appendSystemPromptOverride` (`resource-loader` option), or
  `buildSystemPrompt` itself. This repo already monkey-patches pi-core
  (`bun-apps/pi-agent/src/patches/`), so an in-repo patch is architecturally
  consistent.
- **Scope:** reply-language of LLM agent replies across all session types.
  Non-agent CLI command stdout (e.g. `sessions`, `tools-metrics`) is **out of
  scope** — it is command output, not a "reply".
- **Standing preference:** conversation in 繁體中文; written artifacts in English.
- **Fact freshness:** same branch lag as the audit map; the trailing commits do
  not touch `resource-loader` / `buildSystemPrompt` / the patches dir, so the
  injection-surface facts hold.

## Decisions so far

- [Map the universal injection surface](tickets/01-map-universal-injection-surface.md) — `ResourceLoader` + `buildSystemPrompt` are the universal seam; the global `AGENTS.md` already reaches every session; forcing levers are `customPrompt` / `appendSystemPromptOverride` / `buildSystemPrompt`.
- [Lock the design: shape, force lever, prose back-compat](tickets/02-lock-design-shape-force-prose.md) — D1 `responseLanguage: "zh-TW"` (BCP-47); D2 `customPrompt` top-of-prompt injection **+ a `/response-language` slash command for live immediate control** (no reply inspector); D3 retire the prose, leave a one-line pointer.
- [Implement forced reply-language injection](tickets/03-implement-forced-injection.md) — DONE. `force-response-language` patch wraps `AgentSession.prototype._rebuildSystemPrompt` to prepend a forced block (reads `settings.json` live; reaches every session type); new `pi-agent-ext-response-language` package adds the `/response-language` command; prose retired. 91+26 tests green, typecheck clean, end-to-end wiring proven.

## Not yet specified

- Exact patch location inside the chosen lever (a `bun-apps/pi-agent/src/patches/*` patch on `ResourceLoader` vs `buildSystemPrompt` vs the CLI session wiring) — decided inside the implementation ticket once the lever is chosen.

## Out of scope

- **Non-agent CLI / command stdout localization** — not a "reply"; different effort.
- **Post-turn reply-language policing / a reply inspector** — "force" here means guaranteed high-priority *injection*, not post-hoc enforcement (unless the design grilling explicitly adds it).
- **The "written artifacts stay English" half of the policy** — deferred to a separate effort (the setting could later grow an `artifactLanguage` field, but that is not this map).
- **Upstream PR to `@earendil-works/pi-coding-agent`** — this effort is in-repo; an upstream contribution is a possible follow-up.
