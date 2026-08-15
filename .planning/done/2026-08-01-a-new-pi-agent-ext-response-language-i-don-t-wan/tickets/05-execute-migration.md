## Question

Execute the migration: move the command into core-task, register it, delete the standalone package, fix registrations.

type: task
status: closed
claimed: agent:main-session
blocked by: [03-core-task-domain-framing](03-core-task-domain-framing.md), [04-branch-divergence-strategy](04-branch-divergence-strategy.md)

## Acceptance criteria

- [ ] `src/response-language/{command,settings,response-language}.ts` exist under core-task; `registerResponseLanguage(pi)` is called in `extensions/core-task.ts`.
- [ ] Tests relocated to `src/response-language/__tests__/` (import paths fixed); `cd bun-apps/pi-agent-ext-core-task && bun test` passes; `bun run typecheck` passes.
- [ ] `bun-apps/pi-agent-ext-response-language/` dir deleted; its manifest block + `bun.lock` workspace entry gone (`bun install` from `bun-apps/` is clean).
- [ ] `force-response-language` patch untouched in pi-agent; its tests still pass (`cd bun-apps/pi-agent && bun test` for the patches).
- [ ] `CONTEXT.md` updated per [03-core-task-domain-framing](03-core-task-domain-framing.md)'s decision.
- [ ] Branch landed per [04-branch-divergence-strategy](04-branch-divergence-strategy.md)'s chosen strategy.
- [ ] `/response-language [tag]` still works end-to-end (manual smoke: show + set + invalid).

Once 03 + 04 resolve, this ticket is a straight execution plan — hand off to `writing-plans` / `executing-plans`.

## Resolution

Done — committed `ef5a840f` on branch `migrate-response-language-to-core-task` (1 ahead of `origin/main`), based off **current** `origin/main` (`6e4914ab`, the per-turn-injection refactor).

- core-task gained `src/response-language/{command,settings,response-language}.ts` + `__tests__/`; `registerResponseLanguage(pi)` wired into the entry. **630 core-task tests pass**, typecheck clean.
- Standalone `pi-agent-ext-response-language/` deleted; manifest block + `bun.lock` workspace entry removed (`bun install` clean).
- `force-response-language` patch **untouched**; **41 pi-agent patch tests pass**.
- `CONTEXT.md` updated per [03](03-core-task-domain-framing.md): relocation note + `Language — response-language` subsection (per-turn wording, core domain statement unchanged).
- `git diff origin/main` is **migration-only** (renames + metadata deletes); **no patch changes** → no regression.

**Near-miss (recorded for the map):** the branch was initially created **1 commit behind** `origin/main` (the per-turn refactor `6e4914ab`), which would have shipped a stale `await ctx.reload()` handler. Caught by diffing against `origin/main` before committing; reset to the current base and redone. Lesson: after `git checkout -b X origin/main`, verify `HEAD == origin/main` and that no newer commit touched the files being moved.

Manual TUI smoke (`/response-language [tag]` end-to-end) was not run in this agent context; command registration + pure logic + patch injection are all verified green.
