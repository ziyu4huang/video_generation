# @repo/pi-agent-ext-response-language

Live, immediate control of the agent's reply language via the `/response-language`
slash command. Pairs with the **`force-response-language`** patch in
[`bun-apps/pi-agent/src/patches/`](../pi-agent/src/patches/force-response-language.ts),
which does the actual forced injection.

## What it does

- **`/response-language`** — show the current `responseLanguage`.
- **`/response-language zh-TW`** — set it (BCP-47 tag). Persists to
  `~/.pi/agent/settings.json` and triggers a prompt rebuild, so the **next**
  reply already uses the new language. No restart, no hand-editing.
- Invalid input (spaces, punctuation) is rejected with a warning.

## How the forced injection works

The `force-response-language` patch wraps `AgentSession.prototype._rebuildSystemPrompt`
to **prepend** a `<response_language priority="forced">` block (mapped from the
BCP-47 tag, pi-owned wording) ahead of every rebuilt system prompt. Because every
session type — main, subagent subprocess, workflow agent, obsidian/zk child —
constructs an `AgentSession`, the block reaches all of them by construction. The
setting is read fresh on each rebuild, which is what makes the slash command's
live switch work.

Disable the injection for debugging with `BUN_PI_FORCE_RESPONSE_LANGUAGE=0`.

## Layout

- `extensions/response-language.ts` — the registered `/response-language` command (thin entry).
- `src/command.ts` — pure command decision logic (`parseLanguageArg`, `decideCommand`).
- `src/settings.ts` — pure settings merge/validation + IO wrappers.
- `tests/` — unit tests for the pure logic + an entry smoke test.
