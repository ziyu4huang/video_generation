> STATUS: DONE — archived 2026-08-15 (triage verdict: per-turn injection #979; /response-language instant)
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

- [01 per-turn injection seams + patchability](tickets/01-per-turn-injection-seams-patchability.md) — winner seam = `_installAgentNextTurnRefresh` (prototype method, constructor-called); cleanly patchable; override/compaction safe.
- [02 cheap-trigger handles on ctx](tickets/02-cheap-trigger-handles-on-ctx.md) — NO cheap prompt-rebuild reachable from `ctx`; `reload()` is the only trigger → Candidate B not viable.
- [03 session-type matrix + core-task/tui](tickets/03-session-type-matrix-core-task-tui.md) — core-task/TUI runs inside the main session (not a separate type); fresh-construction types auto-correct; only the live main session needed the mechanism.
- [04 implement + A/B pick mechanism](tickets/04-implement-and-ab-pick-mechanism.md) — DONE. Candidate A (per-turn injection) wins; `_rebuildSystemPrompt` wrap replaced; command drops `ctx.reload()`. Merged in #979.
- [05 verify all session types + docs](tickets/05-verify-all-session-types-and-docs.md) — DONE. 92+26 tests green, typecheck clean; reach by construction; override/compaction preserved; docs updated. Merged in #979.

**Map complete — destination reached.** The lighter alternative shipped in #979; `/response-language` is now instant (no reload). Deferred prize: the *issue-audit* effort, which now has one fewer candidate (BTW leak mitigated).

## Not yet specified

<!-- both graduated + resolved via tickets 01/03/05: override precedence preserved,
     compaction survived, non-interactive reach confirmed (by construction). -->

## Out of scope

- **Upstream PR to `@earendil-works/pi-coding-agent`** — user ruled it out as a
  fallback; this effort stays in-repo.
- **The "written artifacts stay English" half of the policy** — separate effort.
- **Non-agent CLI / command stdout localization** — not a "reply".
- **Changing the force-injection mechanism's *wording*** (the `<response_language
  priority="forced">` block text) — only the *trigger* / injection point is in
  scope, not the canonical text.
