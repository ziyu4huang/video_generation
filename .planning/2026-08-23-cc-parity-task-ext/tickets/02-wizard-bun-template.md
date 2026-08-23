---
ticket: 02-wizard-bun-template
effort: cc-parity-task-ext
type: task
status: open
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
