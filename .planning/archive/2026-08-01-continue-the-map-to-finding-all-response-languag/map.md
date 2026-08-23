> STATUS: DONE — archived 2026-08-15 (shipped in main; see git history / PR references in map)
# Map — find all response-language potential issues

## Destination

A prioritized **audit register** of every verifiable code/mechanism defect in the
forced reply-language feature, with evidence + severity. **Finds, does not fix** —
fixes are handed off as separate efforts/tickets.

**Destination pinned by grilling:**
- **Audit only** — catalog issues with severity + evidence; fixes are separate efforts.
- **Complement the existing map** — hunt issues NOT already owned by
  `2026-08-01-look-for-a-lighter-alternative-before-we-commit-/` (ctx.reload
  heaviness + live-session caching). Cross-link, don't duplicate.
- **Verifiable code/mechanism defects only** — provable with code/tests.

## Notes

- **Domain:** forced reply-language feature — `force-response-language` patch
  (`bun-apps/pi-agent/src/patches/`) + `/response-language` command
  (`bun-apps/pi-agent-ext-response-language/`) + `responseLanguage` in
  `~/.pi/agent/settings.json`.
- **Skills every session should consult:** wayfinder, grilling, domain-modeling,
  systematic-debugging, test-driven-development, verification-before-completion.
- **Standing preference:** conversation in 繁體中文; written artifacts in English.
- **Related map:** `2026-08-01-look-for-a-lighter-alternative-before-we-commit-/`
  owns (A) `ctx.reload()` heaviness + (B) live main-session caching. **Do not
  re-derive those here.**
- **Fact freshness:** branch 8 behind `origin/main`; trailing commits are
  wayfind/superpowers refactors not touching response-language code. Holds.

## Decisions so far

_(none yet — destination pinned, frontier ticketing deferred to the next session)_

## Not yet specified

Chart-time-surfaced issues — each graduates into a research ticket next session:

1. **BTW stale-cache leak** — btw seeds its prompt from the main session's *cached*
   `ctx.getSystemPrompt()` (`pi-agent-ext-btw/src/btw/session.ts:86`); a stale main
   cache leaks a stale language block into BTW. **[MITIGATED by #979]** — per-turn
   injection means BTW (which builds its own `AgentSession`) gets the block via its
   own turns regardless of the main-session seed; this candidate is largely resolved.
2. **Duplicate/competing forced blocks** — when BTW inherits a block via the seed
   *and* the constructor wrap re-injects, two `<response_language>` blocks coexist
   (possibly conflicting languages). Verify which wins + whether they accumulate.
3. **Session-type reach gaps** — empirically confirm the block reaches: workflow
   worker, obsidian/zk child, SDK/headless sessions, and sub-model calls inside
   core-task (ask_user_question, goal auditor).
4. **`_systemPromptOverride` precedence** — does a custom-prompt override still get
   the forced block? Precedence correctness.
5. **Invalid/garbage `responseLanguage`** — behavior for malformed `settings.json`
   or bogus tags; sane degradation?
6. **Patch-interaction ordering** — does `force-response-language`'s prototype wrap
   conflict with sibling patches (`ext-api-get-all-tool-definitions`,
   `footer-extension-status-notify`, `ext-context-get-system-prompt-options`)?
7. **Integration-test gap** — current tests are pure-function only; no test that the
   block actually reaches a real session's prompt or changes model output.
8. **Disable-path fallback** — `BUN_PI_FORCE_RESPONSE_LANGUAGE=0` disables
   enforcement; with the prose retired to one-liners, disabling = no enforcement.
   Documented/expected?

## Out of scope

- **Fixes** — audit only; fixes are separate efforts.
- **`ctx.reload()` heaviness + live-session caching** — owned by the existing
  `look-for-a-lighter-alternative` map.
- **Model-obedience reliability** + **"written artifacts stay English" half** —
  behavioral/soft, ruled out by the scope grilling.
- **Upstream `pi-coding-agent` changes.**
