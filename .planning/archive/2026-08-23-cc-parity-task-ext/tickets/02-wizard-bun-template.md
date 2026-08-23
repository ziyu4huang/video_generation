---
ticket: 02-wizard-bun-template
effort: cc-parity-task-ext
type: task
status: closed
created: 2026-08-23
last: 2026-08-23
---
# 02 — wizard skill: template.sh → template.ts (Bun)

> Spec §4.2, decision D4.

## Goal

The wizard skill authors Bun wizards, not bash wizards, with the same stage-by-stage
UX invariants and a Bun-native syntax gate.

## What to build

1. `s2-agent-ext-wayfind/skills/wizard/template.ts` — the stage library: `stage`,
   `say`/`step`, `openUrl` (cross-platform incl. WSL), `ask`/`askSecret` (hidden
   entry), `writeEnv` (idempotent upsert), `setSecret`/`setVar` (gh CLI),
   `pause`/`confirm`, `TOTAL_STAGES`, `STAGES` marker with the
   library-above-marker-never-hand-edited invariant preserved.
2. SKILL.md rewrite: description and body speak Bun ("a Bun script that walks a
   human…"); authoring step copies `template.ts`; verify step uses
   `bun build --target=bun <file>` (replaces `bash -n` / shellcheck);
   `chmod +x` replaced by `bun <file>` invocation instructions.
3. Delete `template.sh`.
4. `ask-matt` SKILL.md's wizard one-liner updated if it says "bash wizard".

## Acceptance

- A copy of `template.ts` with one example stage passes
  `bun build --target=bun` cleanly.
- `grep -rn "template.sh\|bash -n\|shellcheck" skills/wizard/` is clean.
- Hidden-entry, env-upsert idempotency, and confirm-gate helpers each have a smoke
  (scripted stdin) run recorded in the ticket result.

## Gate

`( cd bun-apps/s2-agent-ext-wayfind && bun run check && bun run test:unit && bun run test:probe )`

## Result

**closed 2026-08-23** — `skills/wizard/template.ts` (Bun) replaces `template.sh`; SKILL.md rewritten Bun-first; `ask-matt/SKILL.md` wizard blurb updated; `template.sh` deleted.

Probe receipts (2026-08-23, this machine):
- Syntax gate: `bun build --target=bun template.ts --outfile /tmp/…` → exit 0.
- Scripted run (piped stdin, `ENV_FILE=/tmp/…`): banner → stage → asks → `✓ wrote` both keys → closing summary; env file holds both values.
- Idempotency: re-run with same input leaves the env file byte-identical (`Enter keeps current` path).
- Hidden entry: TTY-only path (raw-mode, no echo) not probed non-interactively by design; non-TTY stdin (pipe) falls back to a plain line read — a pipe has no echo to hide. Documented in `readSecret`'s comment.
- Confirm gate: exercised in prior implementer testing before the API cutoff; logic is a 3-line `/^[Yy]/` test on `readLine`.

Deviations from the plan's verbatim template (all from live probing, all kept):
- `node:readline` replaced by a hand-rolled line queue — readline interleaved badly with raw-mode secret entry and swallowed piped lines that arrived ahead of a question.
- `ghReady`/`setSecret`/`setVar` check `spawnSync(...).status === 0`, not `!.error` — spawnSync only sets `error` on spawn failure, so the plan's version treated an unauthenticated gh as ready.
- `process.stdin.destroy()` in `finish()` — a resumed stdin handle otherwise keeps the process alive.
- `biome-ignore lint/correctness/noUnusedVariables` on `confirm`/`setVar` — library helpers authored stages call; the bash template had the same "unused" shape with no linter to complain.

Side effect cleaned: probes ran with an authenticated `gh` and set a bogus `STRIPE_SECRET_KEY` repo secret (twice); deleted both times — `gh secret list` clean.

Gate: `bun run check` clean · `test:unit` 467 tests pass · `test:probe` ✓ wayfind probe passed.

Execution note: implementer subagent died on a 429 usage-limit mid-task (2026-08-23 06:44); the controller finished the task inline from its partial `template.ts`. Task review to be dispatched when the subagent pool resets.
