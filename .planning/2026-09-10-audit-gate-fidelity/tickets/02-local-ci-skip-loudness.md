---
type: task
status: open
---

# 02 — local-ci-skip-loudness: name-resolved gates report skip-with-reason

## Question

When devops `local_ci` resolves a gate by script NAME and the script is
absent, should the outcome stay silent? No — it must say `skipped: no
<name> script` so lint gaps are visible at merge time.

## What to build

In `bun-apps/s2-agent-ext-devops` (the `local_ci` tool / `local-ci-cli.ts`
path and its library in `src/`): wherever a per-package gate is resolved by
script name from package.json, an absent script currently results in the gate
being silently omitted from the run. Change the outcome shape so each
package's gate report has an explicit state — ran (with command + exit) or
skipped-with-reason (`no "check" script in package.json`) — and the summary
line surfaces skipped-gate counts, so the systemic "lint silently skipped for
19/26 packages" class is visible in every local CI run. Keep the CLI
contract: throw-free, JSON on stdout, exit codes 0/1/2 unchanged; `--dry-run`
shows the would-be skip map. Pin with a unit test using a fixture package.json
missing `check`: the outcome contains the skip-with-reason entry and the
summary counts it. This touches devops src/ → per D5, redeploy + qualify
sweep applies after merge.

## Acceptance

- [ ] local_ci outcome reports every name-resolved gate as ran or
      skipped-with-reason — no gate disappears silently
- [ ] Summary surfaces skipped-gate counts; exit-code semantics unchanged
      (0/1/2, throw-free JSON)
- [ ] `--dry-run` shows the would-be skip map
- [ ] Unit test pins the fixture-without-check behavior
- [ ] devops canonical gates green (`bun run check && typecheck && test`);
      redeploy + qualify sweep noted for post-merge per D5
