> STATUS: DONE — archived 2026-08-15 (shipped in main; see git history / PR references in map)
# Wayfinder map: 2026-08-01-a-new-pi-agent-ext-response-language-i-don-t-wan

## Destination

The `/response-language` slash command and its pure logic (`command.ts`, `settings.ts`) live inside **`pi-agent-ext-core-task`** as a new `src/response-language/` feature dir following core-task's per-feature `registerX(pi)` pattern; the standalone **`pi-agent-ext-response-language` package is deleted** (dir, manifest block, `bun.lock` workspace, testGate); the `force-response-language` **patch stays in `pi-agent`** (it patches `AgentSession` internals — only the command half moves); core-task's domain framing is settled and the branch divergence with `origin/main` is reconciled so the deletion lands cleanly.

## Notes

Domain: pi extension packaging / entry-point consolidation. Skills every session should consult: `grilling`, `domain-modeling` (core-task `CONTEXT.md` ubiquitous language).

Standing context: the feature is split **by design** — the **patch** (forced injection) lives in `pi-agent/src/patches/` because it monkey-patches SDK internals; the **command** (the user-facing setter) lives in an extension because user commands register via `ExtensionAPI.registerCommand`. Only the command half is moving. The two halves couple through the `responseLanguage` key in `~/.pi/agent/settings.json` — keep that key name. Core-task already accepts self-contained commands "purely for entry-point consolidation" (the `ask-user` merge is the documented precedent in `extensions/core-task.ts`), so response-language joins under the same rationale.

## Decisions so far

<!-- one line per closed ticket: enough to judge relevance, then open the link -->

- [Choose home: core-task](tickets/01-choose-home-core-task.md) — merge the command into `pi-agent-ext-core-task`, not power-tool (diagnostics domain + re-opens the 2026-07 split), not standalone, not pi-agent core (no `registerCommand` path).
- [Touch-point inventory](tickets/02-inventory-touch-points.md) — every file/registration the migration must touch. (Corrected: no divergent duplicate — the package is a byte-identical shared commit on both lines.)
- [Core-task domain framing](tickets/03-core-task-domain-framing.md) — follow the `ask_user_question` precedent: add a `Language — response-language` subsection + relocation note; leave the core domain statement unchanged.
- [Branch divergence strategy](tickets/04-branch-divergence-strategy.md) — base the migration on a fresh branch off `origin/main`; the 3 unpushed superpowers commits ship separately. (Premise corrected: no duplicate exists.)
- [Execute migration](tickets/05-execute-migration.md) — **done**; committed `ef5a840f` on `migrate-response-language-to-core-task` off current `origin/main`. 630 core-task tests + 41 patch tests green; migration-only diff, no patch regression.

## Not yet specified

<!-- fog toward the destination; graduates as the frontier advances -->

- Confirm during execution that moving the command needs no core-task `peerDependencies` change (the command is pure — only `getAgentDir` from the SDK, no TUI/typebox use). Expected no-op; verify in the execute ticket.

## Out of scope

<!-- ruled beyond the destination; never graduates -->

- Moving the `force-response-language` patch out of `pi-agent` — it wraps `AgentSession.prototype._rebuildSystemPrompt`; patches live in pi-agent by necessity. Only the command moves.
- Historical planning artifacts under the other `.planning/2026-08-01-*/` dirs (the efforts that *built* this feature) — leave as history.
- The 3 commits this branch holds ahead of `origin/main` (superpowers `.planning` migration) — a separate effort; ships independently of this migration.
