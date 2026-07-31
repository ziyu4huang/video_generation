# Map — lighter alternative to ctx.reload() in /response-language

## Destination

Replace the heavyweight `ctx.reload()` (a full runtime rebuild — re-imports every
extension, re-runs all lifecycle hooks) in the `/response-language` command with
**the lightest mechanism proven equivalent-or-better across all session types**,
chosen by A/B test. `ctx.reload()` is replaced only if the winner is robust.

**Fallback (user-pinned):** if no lighter in-repo seam is cleanly patchable, keep
`ctx.reload()` and document its cost — no upstream changes, scope stays contained.

## Notes

- **Domain:** pi-agent system-prompt assembly + the `force-response-language`
  patch (`bun-apps/pi-agent/src/patches/force-response-language.ts`) + the
  `/response-language` command (`bun-apps/pi-agent-ext-response-language/`).
- **Skills every session should consult:** wayfinder (this map), grilling,
  domain-modeling, systematic-debugging (A/B debug), test-driven-development,
  verification-before-completion (final cross-session verify).
- **Standing preference:** conversation in 繁體中文; written artifacts in English.
- **Root cause (established by chart-time spike):**
  - The system prompt is **cached** in `_baseSystemPrompt` / `agent.state.systemPrompt`
    (`agent-session.js:643,644,900,905,1778,1779`). `_rebuildSystemPrompt`
    (`agent-session.js:710`) runs only on init, tool-set change
    (`setActiveToolsByName:643`), resource-extend (`extendResourcesFromExtensions:1778`),
    and compaction — **not per turn**.
  - `ctx` (`ExtensionCommandContext`) exposes `getSystemPrompt()`,
    `getSystemPromptOptions()`, `reload()` (heavy), `invalidate()` — **no**
    lightweight "rebuild prompt" handle.
  - **Per-turn seam exists:** `prepareNextTurnWithContext` (`agent-session.js:262-281`)
    sets `context.systemPrompt = _systemPromptOverride ?? _baseSystemPrompt` **every
    turn**. `getSystemPromptOptions()` is another seam (the repo already patches it:
    `ext-context-get-system-prompt-options`). Either could make the forced block
    per-turn with **no trigger at all**.
- **Test matrix (user-declared "all"):** main interactive session, extension
  subagent (subagent subprocess), workflow agent, core-task / TUI session,
  obsidian / zk child. (Fresh-subprocess types may auto-correct on construction —
  ticket 03 confirms.)
- **Fact freshness:** branch is 8 behind `origin/main`; the trailing 8 commits are
  wayfind/superpowers refactors that do **not** touch `agent-session.js` /
  `system-prompt.js` / the patches dir / response-language, so the injection-surface
  facts hold. Re-verify after any rebase.

## Decisions so far

<!-- index — one line per closed ticket -->

_(none yet — charting complete, frontier open)_

## Not yet specified

- **`_systemPromptOverride` (custom-prompt) precedence + compaction interaction:**
  if the mechanism moves to a per-turn seam, the block must still respect
  `_systemPromptOverride` precedence and survive compaction (which reassigns
  `state.systemPrompt` at `agent-session.js:900,905`). Graduates out of ticket 01.
- **Whether the chosen per-turn seam is also reached by non-interactive sessions**
  (workflow agent, obsidian child) — if not, those types may need a different
  (or no) mechanism. Graduates out of tickets 01 + 03.

## Out of scope

- **Upstream PR to `@earendil-works/pi-coding-agent`** — user ruled it out as a
  fallback; this effort stays in-repo.
- **The "written artifacts stay English" half of the policy** — separate effort.
- **Non-agent CLI / command stdout localization** — not a "reply".
- **Changing the force-injection mechanism's *wording*** (the `<response_language
  priority="forced">` block text) — only the *trigger* / injection point is in
  scope, not the canonical text.
